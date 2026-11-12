import type { Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type {
  ChatMessage,
  ParsedToolCall,
  PageWorker,
  ChatExecutionResult,
  OpenAiTool,
} from './types.js';

export interface ParsedMcpMetadata {
  serverName: string;
  toolName: string;
  description: string;
  params: string;
}

export interface ExtractToolCallsResult {
  cleanContent: string;
  toolCalls: ParsedToolCall[];
  parseErrors: Array<{ rawJson: string; error: string }>;
}

export interface ExecuteChatOptions {
  worker: PageWorker;
  messages: ChatMessage[];
  isNewConversation: boolean;
  targetPath?: string;
  tools?: OpenAiTool[];
  thinkingLevel?: string;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

/**
 * 瀏覽器端共用：相容 Trusted Types CSP 的函式反序列化還原器
 */
function browserCompileFn(fnCode: string) {
  const w = window;
  const body = 'return (' + fnCode + ')';
  if (w.trustedTypes) {
    return new Function(w.trustedTypes.createPolicy('evalPolicy', {
      createScript: (scriptString: string) => scriptString,
    }).createScript(body) as unknown as string)();
  }
  return new Function(body)();
}

/**
 * 瀏覽器端共用：檢查 @use_mcp_tool 後方的 JSON 物件括號是否已完整閉合
 */
function browserHasCompleteToolCall(raw: string): boolean {
  const markerIdx = raw.indexOf('@use_mcp_tool');
  if (markerIdx === -1) return false;

  const braceStart = raw.indexOf('{', markerIdx);
  if (braceStart === -1) return false;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = braceStart; i < raw.length; i++) {
    const char = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) return true;
      }
    }
  }
  return false;
}

export abstract class WebAiProvider {
  abstract readonly name: string;
  abstract readonly baseUrl: string;

  protected readonly dirtyPages = new WeakSet<Page>();

  abstract uploadFile(page: Page, filePath: string): Promise<void>;

  abstract navigateConversation(
    page: Page,
    isNewConversation: boolean,
    targetPath?: string
  ): Promise<void>;

  abstract sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: { thinkingLevel?: string; abortSignal?: AbortSignal }
  ): Promise<{ rawText: string; currentPath: string }>;

  abstract stop(worker: PageWorker): Promise<void>;

  public markPageDirty(page: Page): void {
    this.dirtyPages.add(page);
  }

  /**
   * 將共用的 Trusted Types 函式還原器與 hasCompleteToolCall 掛載至頁面 window.__webAiHelpers
   */
  protected async ensureBrowserHelpers(page: Page): Promise<void> {
    await page.evaluate(
      ({ compileCode, hasCompleteToolCallCode }) => {
        const w = window as any;
        if (w.__webAiHelpers) return;

        const body = 'return (' + compileCode + ')';
        const policy = w.trustedTypes
          ? w.__evalPolicy ||
          (w.__evalPolicy = w.trustedTypes.createPolicy('evalPolicy', {
            createScript: (scriptString: string) => scriptString,
          }))
          : null;

        const rehydrate = new Function(
          policy ? (policy.createScript(body) as unknown as string) : body
        )() as (code: string) => (...args: any[]) => any;

        w.__webAiHelpers = {
          rehydrate,
          hasCompleteToolCall: rehydrate(hasCompleteToolCallCode),
        };
      },
      {
        compileCode: browserCompileFn.toString(),
        hasCompleteToolCallCode: browserHasCompleteToolCall.toString(),
      }
    );
  }

  protected async withAbortCheck<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
    stepName = 'operation'
  ): Promise<T> {
    if (signal?.aborted) {
      throw new Error(`Aborted before ${stepName}`);
    }
    if (!signal) return promise;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error(`Aborted during ${stepName}`));
      signal.addEventListener('abort', onAbort, { once: true });

      promise.then(
        (val) => {
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  protected parseMcpTool(item: OpenAiTool): ParsedMcpMetadata {
    const fn = item.function || item;
    const rawName = fn.name || 'unnamed_tool';
    const desc = fn.description || 'No description provided.';
    const params = JSON.stringify(fn.parameters || fn.input_schema || {}, null, 2);

    let serverName = item.server_name || item.serverName || '';
    const toolName = rawName;

    if (!serverName) {
      if (rawName.startsWith('mcp__')) {
        const parts = rawName.split('__');
        if (parts.length >= 3) serverName = parts[1];
      } else if (rawName.includes('__')) {
        const parts = rawName.split('__');
        serverName = parts[0];
      }
    }

    return { serverName, toolName, description: desc, params };
  }

  protected buildToolsAndSystemFileContent(systemPrompt = '', tools?: OpenAiTool[]): string {
    let content = `# SYSTEM INSTRUCTIONS & ENVIRONMENT\n\n${systemPrompt.trim()}\n\n`;

    if (Array.isArray(tools) && tools.length > 0) {
      content += `=======================================================\n`;
      content += `# CONNECTED MCP TOOLS SPECIFICATIONS\n\n`;
      content += `## Universal Tool Calling Format (STRICT REQUIREMENT)\n`;
      content += `When you need to call any tool below, you MUST output a single JSON object prefixed with @use_mcp_tool directly in plain text.\n`;
      content += `CRITICAL: NEVER wrap @use_mcp_tool in markdown code blocks (\`\`\`json or \`\`\`).\n`;
      content += `CRITICAL: Output MUST start immediately with @use_mcp_tool followed by the JSON payload.\n\n`;
      content += `Format Structure:\n`;
      content += `@use_mcp_tool{"server_name":"EXACT_SERVER_NAME_FROM_DEFINITION","tool_name":"EXACT_TOOL_NAME_FROM_DEFINITION","arguments":{"param":"value"}}\n\n`;
      content += `=======================================================\n`;
      content += `## Available Tools Definitions\n\n`;

      for (const item of tools) {
        const parsed = this.parseMcpTool(item);
        content += `### Tool: ${parsed.toolName}\n`;
        content += `- Exact Server Name: ${parsed.serverName}\n`;
        content += `- Exact Tool Name: ${parsed.toolName}\n`;
        content += `- Description: ${parsed.description}\n`;
        content += `- Parameters (JSON Schema):\n${parsed.params}\n\n`;
        content += `-------------------------------------------------------\n`;
      }
    }

    return content;
  }

  protected formatContinuationPrompt(messages: ChatMessage[]): string {
    const trailingToolMessages: ChatMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') {
        trailingToolMessages.unshift(messages[i]);
      } else {
        break;
      }
    }

    if (trailingToolMessages.length > 0) {
      let prompt = '[Tool Execution Result]:\n';
      for (const tm of trailingToolMessages) {
        const contentStr = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content);
        prompt += `\n[Tool Output Data]:\n${contentStr}\n`;
      }
      prompt += '\nPlease proceed with the task based on the above tool execution results. If you need to invoke another tool, strictly output @use_mcp_tool{"server_name": "...", "tool_name": "...", "arguments": {...}}; if the task is complete, summarize and explain to the user directly.';
      return prompt;
    }

    const lastMsg = messages[messages.length - 1];
    let lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');

    const inputMatch = lastText.match(/<user_input[^>]*>([\s\S]*?)<\/user_input>/i);
    if (inputMatch && inputMatch[1].trim()) {
      lastText = inputMatch[1].trim();
    }

    return lastText;
  }

  protected resolveExactToolName(parsedToolName: string, tools?: OpenAiTool[]): string {
    if (!Array.isArray(tools) || tools.length === 0) return parsedToolName;

    for (const t of tools) {
      const name = t.function?.name ?? t.name;
      if (name === parsedToolName) return name;
    }

    for (const t of tools) {
      const name = t.function?.name ?? t.name;
      if (typeof name === 'string' && name.includes(parsedToolName)) {
        return name;
      }
    }

    return parsedToolName;
  }

  public extractToolCalls(
    fullText: string,
    tools?: OpenAiTool[]
  ): ExtractToolCallsResult {
    const toolCalls: ParsedToolCall[] = [];
    const parseErrors: Array<{ rawJson: string; error: string }> = [];
    const marker = '@use_mcp_tool';
    let cleanContent = '';
    let cursor = 0;

    while (cursor < fullText.length) {
      const markerIdx = fullText.indexOf(marker, cursor);
      if (markerIdx === -1) {
        cleanContent += fullText.slice(cursor);
        break;
      }

      cleanContent += fullText.slice(cursor, markerIdx);

      let braceStart = markerIdx + marker.length;
      while (braceStart < fullText.length && /[\s:]/.test(fullText[braceStart])) {
        braceStart++;
      }

      if (fullText.slice(braceStart).startsWith('```')) {
        const fenceEnd = fullText.indexOf('\n', braceStart);
        if (fenceEnd !== -1) {
          braceStart = fenceEnd + 1;
          while (braceStart < fullText.length && /[\s:]/.test(fullText[braceStart])) {
            braceStart++;
          }
        }
      }

      if (braceStart >= fullText.length || fullText[braceStart] !== '{') {
        const snippet = fullText.slice(markerIdx, Math.min(fullText.length, markerIdx + 100));
        parseErrors.push({
          rawJson: snippet,
          error: 'Missing opening brace "{" immediately following @use_mcp_tool',
        });
        cursor = markerIdx + marker.length;
        continue;
      }

      let depth = 0;
      let inString = false;
      let escape = false;
      let braceEnd = -1;

      for (let i = braceStart; i < fullText.length; i++) {
        const char = fullText[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === '\\') {
          escape = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') {
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0) {
              braceEnd = i;
              break;
            }
          }
        }
      }

      if (braceEnd === -1) {
        const brokenJson = fullText.slice(braceStart);
        parseErrors.push({
          rawJson: brokenJson,
          error: 'Unclosed JSON object (missing matching closing "}")',
        });
        cursor = braceStart + 1;
        continue;
      }

      const jsonStr = fullText.slice(braceStart, braceEnd + 1);
      cursor = braceEnd + 1;

      if (fullText.slice(cursor).trimStart().startsWith('```')) {
        const closeFence = fullText.indexOf('```', cursor);
        if (closeFence !== -1) {
          cursor = closeFence + 3;
        }
      }

      try {
        const sanitizedJson = jsonStr.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '/');
        const parsed = JSON.parse(sanitizedJson) as Record<string, unknown>;

        const toolNameRaw = (
          typeof parsed.tool_name === 'string'
            ? parsed.tool_name
            : typeof parsed.name === 'string'
              ? parsed.name
              : ''
        ).trim();

        if (!toolNameRaw) {
          throw new Error('Missing "tool_name" or "name" in payload object');
        }

        const resolvedName = this.resolveExactToolName(toolNameRaw, tools);

        let argsPayload = '{}';
        const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.args;
        if (typeof rawArgs === 'object' && rawArgs !== null) {
          argsPayload = JSON.stringify(rawArgs);
        } else if (typeof rawArgs === 'string') {
          argsPayload = rawArgs;
        }

        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 11)}`,
          name: resolvedName,
          arguments: argsPayload,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('[WebAiProvider] Failed to parse @use_mcp_tool JSON payload:', jsonStr, err);
        parseErrors.push({ rawJson: jsonStr, error: errorMsg });
      }
    }

    return { cleanContent: cleanContent.trim(), toolCalls, parseErrors };
  }

  public async executeChat(params: ExecuteChatOptions): Promise<ChatExecutionResult> {
    const {
      worker,
      messages,
      isNewConversation,
      targetPath,
      tools,
      thinkingLevel,
      abortSignal,
      onTextDelta,
      onReasoningDelta,
    } = params;

    if (abortSignal?.aborted) {
      this.dirtyPages.add(worker.page);
      throw new Error('Chat generation aborted before navigation');
    }

    await this.withAbortCheck(
      this.navigateConversation(worker.page, isNewConversation, targetPath),
      abortSignal,
      'navigation'
    );

    if (abortSignal?.aborted) {
      this.dirtyPages.add(worker.page);
      throw new Error('Chat generation aborted after navigation');
    }

    let promptToSend = '';
    let tempFilePath: string | null = null;

    try {
      if (isNewConversation) {
        const systemMsg = messages
          .filter((m) => m.role === 'system')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n\n');

        const userMsgs = messages.filter((m) => m.role === 'user');
        const realUserPrompts = userMsgs
          .map((m) => {
            let t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const inputMatch = t.match(/<user_input[^>]*>([\s\S]*?)<\/user_input>/i);
            if (inputMatch && inputMatch[1].trim()) t = inputMatch[1].trim();
            return t
              .replace(/\[TASK RESUMPTION\][\s\S]*$/i, '')
              .replace(/\[Task Resumed\][\s\S]*$/i, '')
              .trim();
          })
          .filter((txt) => txt.length > 0);

        let userTask = '';
        if (realUserPrompts.length > 0) {
          userTask = realUserPrompts.join('\n\n');
        } else if (userMsgs.length > 0) {
          userTask = typeof userMsgs[0].content === 'string' ? userMsgs[0].content : JSON.stringify(userMsgs[0].content);
        } else {
          userTask = 'Please proceed with the task.';
        }

        const fileContent = this.buildToolsAndSystemFileContent(systemMsg, tools);

        tempFilePath = path.join(
          os.tmpdir(),
          'Instructions.txt'
        );
        await fs.writeFile(tempFilePath, fileContent, 'utf8');

        if (abortSignal?.aborted) {
          this.dirtyPages.add(worker.page);
          throw new Error('Chat generation aborted before file upload');
        }

        await this.withAbortCheck(
          this.uploadFile(worker.page, tempFilePath),
          abortSignal,
          'file upload'
        );
        this.dirtyPages.add(worker.page);

        if (abortSignal?.aborted) {
          this.dirtyPages.add(worker.page);
          throw new Error('Chat generation aborted after file upload');
        }

        promptToSend = `I have uploaded the full system instructions and callable MCP Tools specifications into the attachment file above.\nPlease read the rules and tool definitions in the attachment carefully.\n[CRITICAL EXECUTION RULES]: When you need to call a tool, directly output @use_mcp_tool{"server_name": "...", "tool_name": "...", "arguments": {...}} in plain text. Paths MUST strictly use forward slashes (/), and NEVER wrap it inside markdown code blocks.\nPlease execute the following task:\n\n${userTask}`;
      } else {
        promptToSend = this.formatContinuationPrompt(messages);
      }

      const maxParseRetries = 2;
      let retryCount = 0;

      while (true) {
        if (abortSignal?.aborted) {
          this.dirtyPages.add(worker.page);
          throw new Error('Chat generation aborted before prompt submission');
        }

        console.log(
          `[${this.name}] Worker #${worker.id} sending message (${isNewConversation && retryCount === 0 ? 'new session' : 'continuation'
          }): "${promptToSend.substring(0, 50).replace(/\n/g, ' ')}..."`
        );

        let accumulatedMainRaw = '';
        let streamedLength = 0;
        const PREFIX_TRIGGER = '@use_mcp';
        const PREFIX_LOWER = PREFIX_TRIGGER.toLowerCase();

        const handleRawChunk = (delta: string, isReasoning = false) => {
          if (isReasoning) {
            if (onReasoningDelta) {
              onReasoningDelta(delta);
            }
            return;
          }

          accumulatedMainRaw += delta;
          if (!onTextDelta) return;

          const lowerRaw = accumulatedMainRaw.toLowerCase();
          const toolTagIdx = lowerRaw.indexOf(PREFIX_LOWER);

          if (toolTagIdx !== -1) {
            if (streamedLength < toolTagIdx) {
              const chunkToSend = accumulatedMainRaw.slice(streamedLength, toolTagIdx);
              streamedLength = toolTagIdx;
              if (chunkToSend) onTextDelta(chunkToSend);
            }
            return;
          }

          let matchPrefixLen = 0;
          const maxCheck = Math.min(accumulatedMainRaw.length, PREFIX_TRIGGER.length - 1);
          for (let len = maxCheck; len >= 1; len--) {
            if (lowerRaw.endsWith(PREFIX_LOWER.slice(0, len))) {
              matchPrefixLen = len;
              break;
            }
          }

          const safeEnd = accumulatedMainRaw.length - matchPrefixLen;
          if (safeEnd > streamedLength) {
            const chunkToSend = accumulatedMainRaw.slice(streamedLength, safeEnd);
            streamedLength = safeEnd;
            if (chunkToSend) onTextDelta(chunkToSend);
          }
        };

        const { rawText, currentPath } = await this.sendPromptAndObserve(
          worker,
          promptToSend,
          handleRawChunk,
          { thinkingLevel, abortSignal }
        );

        this.dirtyPages.add(worker.page);

        const { cleanContent, toolCalls, parseErrors } = this.extractToolCalls(rawText, tools);

        if (parseErrors.length > 0 && toolCalls.length === 0 && retryCount < maxParseRetries) {
          retryCount++;
          const errorDetails = parseErrors
            .map((e, idx) => `[Error ${idx + 1}]: ${e.error}\nInvalid JSON payload: ${e.rawJson}`)
            .join('\n\n');

          console.warn(
            `[${this.name}] Worker #${worker.id} detected malformed @use_mcp_tool JSON (${retryCount}/${maxParseRetries}). Sending corrective prompt...`
          );

          promptToSend = `[System Notice: Tool Call Format Error]\nFailed to parse your @use_mcp_tool JSON payload:\n${errorDetails}\n\nPlease correct the syntax and invoke the tool again immediately.\nCRITICAL RULES:\n1. Strictly output in plain text: @use_mcp_tool{"server_name": "...", "tool_name": "...", "arguments": {...}}\n2. Must be strictly valid JSON: all property names and string values MUST use double quotes ("..."), and do NOT include trailing commas.\n3. All file paths MUST use forward slashes (/) instead of single backslashes (\\).\n4. Do NOT wrap in markdown code blocks (\`\`\`json or \`\`\`). Output plain text only.`;
          continue;
        }

        if (onTextDelta && toolCalls.length === 0 && streamedLength < cleanContent.length) {
          const remainingChunk = cleanContent.slice(streamedLength);
          if (remainingChunk && !/@use_mcp/i.test(remainingChunk)) {
            onTextDelta(remainingChunk);
            streamedLength = cleanContent.length;
          }
        }

        return {
          rawText,
          currentPath,
          cleanContent,
          toolCalls,
        };
      }
    } finally {
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(() => { });
      }
    }
  }
}
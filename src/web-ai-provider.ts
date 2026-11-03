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
} from './types.ts';

export interface ParsedMcpMetadata {
  serverName: string;
  toolName: string;
  description: string;
  params: string;
}

export abstract class WebAiProvider {
  abstract readonly name: string;
  abstract readonly baseUrl: string;

  abstract uploadFile(page: Page, filePath: string): Promise<void>;

  abstract navigateConversation(
    page: Page,
    isNewConversation: boolean,
    targetPath?: string
  ): Promise<void>;

  abstract sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string) => void
  ): Promise<{ rawText: string; currentPath: string }>;

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
      } else {
        serverName = 'File_System';
      }
    }

    return { serverName, toolName, description: desc, params };
  }

  /**
   * 組合首輪上傳的 System Prompt 與 MCP Tools 規範檔案（切換為 @use_mcp_tool JSON 格式）
   */
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

  /**
   * 多輪接續時格式化工具執行結果
   */
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
        prompt += `\n[Tool Output Data]:\n${tm.content}\n`;
      }
      prompt += '\nPlease proceed with the task based on the above tool execution results. If you need to invoke another tool, strictly output @use_mcp_tool{"server_name": "...", "tool_name": "...", "arguments": {...}}; if the task is complete, summarize and explain to the user directly.';
      return prompt;
    }

    const lastMsg = messages[messages.length - 1];
    return typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');
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

  /**
   * 解析 @use_mcp_tool{...} JSON 格式，並自內容中剝除工具呼叫字串
   */
  public extractToolCalls(
    fullText: string,
    tools?: OpenAiTool[]
  ): { cleanContent: string; toolCalls: ParsedToolCall[] } {
    const toolCalls: ParsedToolCall[] = [];
    const marker = '@use_mcp_tool';
    let cleanContent = '';
    let cursor = 0;

    while (cursor < fullText.length) {
      const markerIdx = fullText.indexOf(marker, cursor);
      if (markerIdx === -1) {
        cleanContent += fullText.slice(cursor);
        break;
      }

      // 保留標記之前的純文字
      cleanContent += fullText.slice(cursor, markerIdx);

      // 尋找 JSON 開頭的左括號 {
      let braceStart = markerIdx + marker.length;
      while (braceStart < fullText.length && /\s/.test(fullText[braceStart])) {
        braceStart++;
      }

      if (braceStart >= fullText.length || fullText[braceStart] !== '{') {
        cursor = markerIdx + marker.length;
        continue;
      }

      // 括號深度計數器（支援字串轉義與巢狀物件）
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
        // 未閉合的 JSON，推進游標避免死循環
        cursor = braceStart + 1;
        continue;
      }

      const jsonStr = fullText.slice(braceStart, braceEnd + 1);
      cursor = braceEnd + 1;

      try {
        // 修復 Windows 路徑單反斜線
        const sanitizedJson = jsonStr.replace(/([^\\])\\([^\/"\\bfnrtu])/g, '$1/$2');
        const parsed = JSON.parse(sanitizedJson) as Record<string, unknown>;

        const toolNameRaw = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
        const resolvedName = this.resolveExactToolName(toolNameRaw, tools);

        let argsPayload = '{}';
        if (typeof parsed.arguments === 'object' && parsed.arguments !== null) {
          argsPayload = JSON.stringify(parsed.arguments);
        } else if (typeof parsed.arguments === 'string') {
          argsPayload = parsed.arguments;
        }

        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 11)}`,
          name: resolvedName,
          arguments: argsPayload,
        });
      } catch (err) {
        console.error('[WebAiProvider] Failed to parse @use_mcp_tool JSON payload:', jsonStr, err);
      }
    }

    return { cleanContent: cleanContent.trim(), toolCalls };
  }

  public async executeChat(params: {
    worker: PageWorker;
    messages: ChatMessage[];
    isNewConversation: boolean;
    targetPath?: string;
    tools?: OpenAiTool[];
    onTextDelta?: (delta: string) => void;
  }): Promise<ChatExecutionResult> {
    const { worker, messages, isNewConversation, targetPath, tools, onTextDelta } = params;

    await this.navigateConversation(worker.page, isNewConversation, targetPath);

    let promptToSend = '';
    let tempFilePath: string | null = null;

    try {
      if (isNewConversation) {
        const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
        const userMsg = messages.filter((m) => m.role === 'user')[0]?.content ?? '';

        const fileContent = this.buildToolsAndSystemFileContent(systemMsg, tools);

        tempFilePath = path.join(
          os.tmpdir(),
          `${this.name}_context_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
        );
        await fs.writeFile(tempFilePath, fileContent, 'utf8');

        await this.uploadFile(worker.page, tempFilePath);

        promptToSend = `I have uploaded the full system instructions and callable MCP Tools specifications into the attachment file above.\nPlease read the rules and tool definitions in the attachment carefully.\n[CRITICAL EXECUTION RULES]: When you need to call a tool, directly output @use_mcp_tool{"server_name": "...", "tool_name": "...", "arguments": {...}} in plain text. Paths MUST strictly use forward slashes (/), and NEVER wrap it inside markdown code blocks.\nPlease execute the following task:\n\n${userMsg}`;
      } else {
        promptToSend = this.formatContinuationPrompt(messages);
      }

      console.log(`[${this.name}] Worker #${worker.id} sending message (${isNewConversation ? 'new session' : 'continuation'}): "${promptToSend.substring(0, 50).replace(/\n/g, ' ')}..."`);

      let accumulatedRaw = '';
      let streamedLength = 0;

      // 即時串流過濾：一旦偵測到 @use_mcp_tool 立即扣住，防止打字機洩漏工具 JSON 到畫面上
      const handleRawChunk = (delta: string) => {
        accumulatedRaw += delta;
        if (!onTextDelta) return;

        const toolTagIdx = accumulatedRaw.search(/@use_mcp_tool/i);
        if (toolTagIdx === -1) {
          const chunkToSend = accumulatedRaw.slice(streamedLength);
          if (chunkToSend) {
            streamedLength = accumulatedRaw.length;
            onTextDelta(chunkToSend);
          }
        } else {
          if (streamedLength < toolTagIdx) {
            const chunkToSend = accumulatedRaw.slice(streamedLength, toolTagIdx);
            streamedLength = toolTagIdx;
            if (chunkToSend) onTextDelta(chunkToSend);
          }
        }
      };

      const { rawText, currentPath } = await this.sendPromptAndObserve(worker, promptToSend, handleRawChunk);
      const { cleanContent, toolCalls } = this.extractToolCalls(rawText, tools);

      return {
        rawText,
        currentPath,
        cleanContent,
        toolCalls,
      };
    } finally {
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    }
  }
}
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

  protected buildToolsAndSystemFileContent(systemPrompt = '', tools?: OpenAiTool[]): string {
    let content = `# SYSTEM INSTRUCTIONS & ENVIRONMENT\n\n${systemPrompt.trim()}\n\n`;

    if (Array.isArray(tools) && tools.length > 0) {
      content += `=======================================================\n`;
      content += `# CONNECTED MCP TOOLS SPECIFICATIONS\n\n`;
      content += `## Universal Tool Calling Format (STRICT REQUIREMENT)\n`;
      content += `When you need to call any tool below, you MUST output a single JSON object prefixed with @use_mcp_tool directly in plain text.\n`;
      content += `CRITICAL: NEVER wrap @use_mcp_tool in markdown code blocks (\`\`\`json or \`\`\`).\n`;
      content += `CRITICAL: If you need to invoke a tool, output @use_mcp_tool directly without intermediate thinking filler in the final text.\n\n`;
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

      console.log(
        `[${this.name}] Worker #${worker.id} sending message (${
          isNewConversation ? 'new session' : 'continuation'
        }): "${promptToSend.substring(0, 50).replace(/\n/g, ' ')}..."`
      );

      let accumulatedRaw = '';
      let streamedLength = 0;
      const PREFIX_TRIGGER = '@use_mcp';
      const PREFIX_LOWER = PREFIX_TRIGGER.toLowerCase();

      const handleRawChunk = (delta: string) => {
        accumulatedRaw += delta;
        if (!onTextDelta) return;

        const lowerRaw = accumulatedRaw.toLowerCase();
        const toolTagIdx = lowerRaw.indexOf(PREFIX_LOWER);

        if (toolTagIdx !== -1) {
          if (streamedLength < toolTagIdx) {
            const chunkToSend = accumulatedRaw.slice(streamedLength, toolTagIdx);
            streamedLength = toolTagIdx;
            if (chunkToSend) onTextDelta(chunkToSend);
          }
          return;
        }

        let matchPrefixLen = 0;
        const maxCheck = Math.min(accumulatedRaw.length, PREFIX_TRIGGER.length - 1);
        for (let len = maxCheck; len >= 1; len--) {
          if (lowerRaw.endsWith(PREFIX_LOWER.slice(0, len))) {
            matchPrefixLen = len;
            break;
          }
        }

        const safeEnd = accumulatedRaw.length - matchPrefixLen;
        if (safeEnd > streamedLength) {
          const chunkToSend = accumulatedRaw.slice(streamedLength, safeEnd);
          streamedLength = safeEnd;
          if (chunkToSend) onTextDelta(chunkToSend);
        }
      };

      const { rawText, currentPath } = await this.sendPromptAndObserve(worker, promptToSend, handleRawChunk);
      const { cleanContent, toolCalls } = this.extractToolCalls(rawText, tools);

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
    } finally {
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    }
  }
}
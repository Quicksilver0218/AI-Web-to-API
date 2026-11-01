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

  protected buildToolsAndSystemFileContent(systemPrompt = '', tools?: OpenAiTool[]): string {
    let content = `# SYSTEM INSTRUCTIONS & ENVIRONMENT\n\n${systemPrompt.trim()}\n\n`;

    if (Array.isArray(tools) && tools.length > 0) {
      content += `=======================================================\n`;
      content += `# CONNECTED MCP TOOLS SPECIFICATIONS\n\n`;
      content += `## Universal Tool Calling Format (STRICT REQUIREMENT)\n`;
      content += `When you need to call any tool below, you MUST output the raw XML tags directly as plain text.\n`;
      content += `CRITICAL: NEVER wrap <use_mcp_tool> in markdown code blocks (\`\`\`xml or \`\`\`).\n`;
      content += `CRITICAL: The arguments tag MUST be written as &lt;arguments&gt; and &lt;/arguments&gt;.\n\n`;
      content += `Format Structure:\n`;
      content += `<use_mcp_tool>\n`;
      content += `<server_name>EXACT_SERVER_NAME_FROM_DEFINITION</server_name>\n`;
      content += `<tool_name>EXACT_TOOL_NAME_FROM_DEFINITION</tool_name>\n`;
      content += `&lt;arguments&gt;\n`;
      content += `{\n  "param": "value"\n}\n`;
      content += `&lt;/arguments&gt;\n`;
      content += `</use_mcp_tool>\n\n`;
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
        prompt += `\n[Tool Output Data]:\n${tm.content}\n`;
      }
      prompt += '\nPlease proceed with the task based on the above tool execution results. If you need to invoke another tool, strictly follow the format and output <use_mcp_tool>; if the task is complete, summarize and explain to the user directly.';
      return prompt;
    }

    const lastMsg = messages[messages.length - 1];
    return typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');
  }

  protected sanitizeMcpText(text: string): string {
    let cleaned = text
      .replace(/```(?:xml)?\s*\n\s*(<use_mcp_tool>)/gi, '$1')
      .replace(/(<\/use_mcp_tool>)\s*\n\s*```/gi, '$1')
      .replace(/&lt;(\/?(?:use_mcp_tool|server_name|tool_name|arguments))&gt;/gi, '<$1>')
      .replace(/<mcp_arguments>/gi, '<arguments>')
      .replace(/<\/mcp_arguments>/gi, '</arguments>')
      .replace(/(<arguments>)\s*```(?:json)?\s*([\s\S]*?)\s*```\s*(<\/arguments>)/gi, '$1\n$2\n$3');

    cleaned = cleaned.replace(
      /(<tool_name>[\s\S]*?<\/tool_name>)\s*(\{[\s\S]*?\})\s*(<\/use_mcp_tool>)/gi,
      '$1\n<arguments>\n$2\n</arguments>\n$3'
    );

    return cleaned;
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
    const sanitized = this.sanitizeMcpText(fullText);
    const toolCalls: ParsedToolCall[] = [];

    const regex = /<use_mcp_tool>([\s\S]*?)<\/use_mcp_tool>/gi;

    const cleanContent = sanitized.replace(regex, (_, inner: string) => {
      const toolMatch = inner.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);
      const argsMatch = inner.match(/<arguments>([\s\S]*?)<\/arguments>/i);

      const toolNameRaw = toolMatch ? toolMatch[1].trim() : '';
      let argsRaw = argsMatch ? argsMatch[1].trim() : '{}';

      argsRaw = argsRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      try {
        const fixedJson = argsRaw.replace(/([^\\])\\([^\/"\\bfnrtu])/g, '$1/$2');
        argsRaw = JSON.stringify(JSON.parse(fixedJson) as Record<string, unknown>);
      } catch {
        // Keep raw string if parsing fails
      }

      const resolvedName = this.resolveExactToolName(toolNameRaw, tools);

      toolCalls.push({
        id: `call_${Math.random().toString(36).substring(2, 11)}`,
        name: resolvedName,
        arguments: argsRaw,
      });

      return '';
    }).trim();

    return { cleanContent, toolCalls };
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

        promptToSend = `I have uploaded the full system instructions and callable MCP Tools specifications into the attachment file above.\nPlease read the rules and tool definitions in the attachment carefully.\n[CRITICAL EXECUTION RULES]: When you need to call a tool, directly output raw <use_mcp_tool> tags as plain text. The arguments tag MUST be written as &lt;arguments&gt; and &lt;/arguments&gt;, paths MUST strictly use forward slashes (/), and NEVER wrap them inside markdown code blocks.\nPlease execute the following task:\n\n${userMsg}`;
      } else {
        promptToSend = this.formatContinuationPrompt(messages);
      }

      console.log(`[${this.name}] Worker #${worker.id} sending message (${isNewConversation ? 'new session' : 'continuation'}): "${promptToSend.substring(0, 50).replace(/\n/g, ' ')}..."`);

      let accumulatedRaw = '';
      let streamedLength = 0;

      const handleRawChunk = (delta: string) => {
        accumulatedRaw += delta;
        if (!onTextDelta) return;

        const toolTagIdx = accumulatedRaw.search(/<use_mcp_tool|&lt;use_mcp_tool/i);
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
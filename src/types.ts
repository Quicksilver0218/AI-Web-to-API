import type { Page } from 'playwright';
import { EventEmitter } from 'events';

export type RoleType = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: RoleType;
  content: string;
  name?: string;
}

export interface OpenAiFunctionDefinition {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

export interface OpenAiTool {
  type?: 'function' | string;
  function?: OpenAiFunctionDefinition;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  server_name?: string;
  serverName?: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface PageWorker {
  id: number;
  page: Page;
  busy: boolean;
  emitter: EventEmitter;
}

export interface ChatExecutionResult {
  rawText: string;
  currentPath: string;
  cleanContent: string;
  toolCalls: ParsedToolCall[];
}

export interface ChatCompletionRequestBody {
  messages?: ChatMessage[];
  model?: string;
  stream?: boolean;
  conversation_id?: string;
  tools?: OpenAiTool[];
  reasoning_effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface ToolCallDelta {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    content?: string;
    tool_calls?: ToolCallDelta[];
  };
  finish_reason: 'stop' | 'tool_calls' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  conversation_id?: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ChatCompletionResponseChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  finish_reason: 'stop' | 'tool_calls';
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  conversation_id: string;
  choices: ChatCompletionResponseChoice[];
}

export interface WindowWithCustomEvents extends Window {
  __pushChunk: (delta: string) => void;
  __pushDone: () => void;
}
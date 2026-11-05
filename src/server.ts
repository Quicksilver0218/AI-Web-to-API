import http, { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import path from 'path';
import type {
  ChatMessage,
  ChatCompletionChunk,
  ChatCompletionResponse,
} from './types.ts';
import { WebAiProvider } from './web-ai-provider.js';
import { PagePool } from './page-pool.js';
import { BROWSER_DATA_PATH } from './utils.js';

export interface ProviderSelection {
  label: string;
  provider: WebAiProvider;
  extensionPath?: string;
}

export interface StartServerConfig {
  port: number;
  poolSize: number;
  headless: boolean;
}

const sessionStore = new Map<string, string>();

function getTaskFingerprint(messages: ChatMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')?.content ?? '';
  return crypto.createHash('sha256').update(firstUserMsg).digest('hex').substring(0, 16);
}

function parseJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      try {
        const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
        resolve(parsed);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', (err: Error) => {
      reject(err);
    });
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function startServer(
  selected: ProviderSelection,
  config: StartServerConfig,
): Promise<void> {
  const { provider, extensionPath } = selected;
  const defaultHomePath = new URL(provider.baseUrl).pathname;

  console.log(`[Startup] Initializing dedicated tab pool for: ${selected.label}...`);

  const pool = new PagePool({
    userDataDir: BROWSER_DATA_PATH,
    headless: config.headless,
    poolSize: config.poolSize,
    initialUrl: provider.baseUrl,
  });

  await pool.init(extensionPath && path.join(import.meta.dirname, extensionPath));
  console.log(`[Startup] ${selected.label} tab pool successfully initialized.`);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 允許跨域自訂 thinking Header
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, thinking');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'POST' && parsedUrl.pathname === '/v1/chat/completions') {
      try {
        const rawBody = await parseJsonBody(req);
        const messages = rawBody.messages ?? [];

        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'messages must be a non-empty array' }));
          return;
        }

        // 讀取 Cline 送來的 'thinking' Header (Node.js 會自動轉為全小寫)
        const rawThinkingHeader = req.headers['thinking'];
        const thinkingVal = (Array.isArray(rawThinkingHeader) ? rawThinkingHeader[0] : rawThinkingHeader ?? 'medium')
          .trim()
          .toLowerCase()
          .replace(/[-_]/g, '');

        const taskKey = getTaskFingerprint(messages);
        const hasHistory = messages.some((m) => m.role === 'assistant' || m.role === 'tool');
        const isNewConversation = !hasHistory;
        const targetPath = isNewConversation ? undefined : sessionStore.get(taskKey);

        const isStream = rawBody.stream === true;
        const modelName = rawBody.model ?? `${provider.name}-playwright-pool`;

        const worker = await pool.acquire();

        try {
          if (isStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            });

            const result = await provider.executeChat({
              worker,
              messages,
              isNewConversation,
              targetPath,
              tools: rawBody.tools,
              thinkingLevel: thinkingVal,
              onReasoningDelta: (delta: string) => {
                const reasoningPayload: ChatCompletionChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        reasoning_content: delta,
                        reasoning: delta,
                      } as unknown as ChatCompletionChunk['choices'][0]['delta'],
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(reasoningPayload)}\n\n`);
              },
              onTextDelta: (delta: string) => {
                const chunkPayload: ChatCompletionChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
              },
            });

            if (result.currentPath && result.currentPath !== defaultHomePath) {
              sessionStore.set(taskKey, result.currentPath);
            }

            if (result.toolCalls.length > 0) {
              for (let i = 0; i < result.toolCalls.length; i++) {
                const tc = result.toolCalls[i];
                const toolPayload: ChatCompletionChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: i,
                            id: tc.id,
                            type: 'function',
                            function: {
                              name: tc.name,
                              arguments: tc.arguments,
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(toolPayload)}\n\n`);
              }

              const finishPayload: ChatCompletionChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              };
              res.write(`data: ${JSON.stringify(finishPayload)}\n\n`);
            } else {
              const finishPayload: ChatCompletionChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
              res.write(`data: ${JSON.stringify(finishPayload)}\n\n`);
            }

            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            const result = await provider.executeChat({
              worker,
              messages,
              isNewConversation,
              targetPath,
              tools: rawBody.tools,
              thinkingLevel: thinkingVal,
            });

            if (result.currentPath && result.currentPath !== defaultHomePath) {
              sessionStore.set(taskKey, result.currentPath);
            }

            const payload: ChatCompletionResponse = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              conversation_id: result.currentPath,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: result.cleanContent || null,
                    ...(result.toolCalls.length > 0
                      ? {
                        tool_calls: result.toolCalls.map((tc) => ({
                          id: tc.id,
                          type: 'function' as const,
                          function: { name: tc.name, arguments: tc.arguments },
                        })),
                      }
                      : {}),
                  },
                  finish_reason: result.toolCalls.length > 0 ? 'tool_calls' : 'stop',
                },
              ],
            };

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
          }
        } finally {
          pool.release(worker);
        }
      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        console.error('[Server Error]:', errMsg);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: errMsg }));
        } else {
          res.end();
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(config.port, () => {
    console.log(`[Ready] Single-provider bridge running at: http://localhost:${config.port}/v1/chat/completions`);
    console.log(`[Ready] Active Provider: ${selected.label}`);
  });
}
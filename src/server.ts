import http, { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import path from 'path';
import type {
  ChatMessage,
  ChatCompletionChunk,
  ChatCompletionResponse,
  PageWorker,
} from './types.ts';
import { WebAiProvider } from './web-ai-provider.js';
import { PagePool } from './page-pool.js';
import { BROWSER_DATA_PATH } from './utils.js';

export interface ProviderSelection {
  name: string;
  provider: WebAiProvider;
  extensionPath?: string;
}

export interface StartServerConfig {
  port: number;
  poolSize: number;
  headless: boolean;
}

const assistantFingerprintStore = new Map<string, string>();

interface RunningTask {
  id: number;
  abortController: AbortController;
  worker: PageWorker | null;
}
let currentRunningTask: RunningTask | null = null;
let taskIdCounter = 0;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as any).text);
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

function getAssistantFingerprints(msg: ChatMessage): string[] {
  const fps: string[] = [];
  const text = extractText(msg.content).trim();
  const toolCalls = (msg as any).tool_calls;

  if (text) {
    fps.push(crypto.createHash('sha256').update(text).digest('hex').substring(0, 16));
  }

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const normalizedToolCalls = toolCalls
      .map((tc) => {
        const fnName = tc.function?.name ?? tc.name ?? '';
        let fnArgs = tc.function?.arguments ?? tc.arguments ?? '';
        if (typeof fnArgs === 'object' && fnArgs !== null) {
          fnArgs = JSON.stringify(fnArgs);
        }
        return `${fnName}:${String(fnArgs).trim()}`;
      })
      .join('|');

    const toolFp = crypto.createHash('sha256').update(normalizedToolCalls).digest('hex').substring(0, 16);
    fps.push(toolFp);

    if (text) {
      const combined = crypto.createHash('sha256').update(`${text}:::${normalizedToolCalls}`).digest('hex').substring(0, 16);
      fps.push(combined);
    }
  }

  return fps;
}

function resolveSessionRouting(messages: ChatMessage[]): { isContinuation: boolean; targetPath?: string } {
  const hasAssistantHistory = messages.some((m) => m.role === 'assistant');

  if (!hasAssistantHistory) {
    console.log(`[Session Routing] No assistant turns in history -> NEW CONVERSATION (Fresh start with System Prompt).`);
    return { isContinuation: false, targetPath: undefined };
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const fps = getAssistantFingerprints(msg);
      for (const fp of fps) {
        if (assistantFingerprintStore.has(fp)) {
          const matchedPath = assistantFingerprintStore.get(fp);
          console.log(`[Session Routing] Matched Assistant Fingerprint [${fp}] -> ${matchedPath}`);
          return { isContinuation: true, targetPath: matchedPath };
        }
      }
    }
  }

  console.log(`[Session Routing] Assistant turn found, but fingerprint not in memory. Continuing on active tab.`);
  return { isContinuation: true, targetPath: undefined };
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

  console.log(`[Startup] Initializing dedicated tab pool for: ${selected.name}...`);

  const pool = new PagePool({
    userDataDir: BROWSER_DATA_PATH,
    headless: config.headless,
    poolSize: config.poolSize,
    initialUrl: provider.baseUrl,
  });

  await pool.init(extensionPath && path.join(import.meta.dirname, extensionPath));
  console.log(`[Startup] ${selected.name} tab pool successfully initialized.`);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      const taskId = ++taskIdCounter;
      const abortController = new AbortController();
      let activeWorker: PageWorker | null = null;
      const socket = req.socket;
      let wakeUpTimer: NodeJS.Timeout | null = null;

      const stopWakeUp = () => {
        if (wakeUpTimer) {
          clearInterval(wakeUpTimer);
          wakeUpTimer = null;
        }
      };

      // 搶佔機制：若客戶端沒有關閉 Socket 就發起新請求（例如點了 Resume），強制中斷舊任務
      if (currentRunningTask) {
        console.warn(`[Server] Overlapping request detected! Preempting previous task #${currentRunningTask.id}...`);
        currentRunningTask.abortController.abort();
        if (currentRunningTask.worker) {
          provider.markPageDirty(currentRunningTask.worker.page);
          await provider.stop(currentRunningTask.worker).catch(() => {});
        }
      }

      const thisTask: RunningTask = {
        id: taskId,
        abortController,
        worker: null,
      };
      currentRunningTask = thisTask;

      const handleClientAbort = () => {
        stopWakeUp();
        if (!abortController.signal.aborted) {
          console.warn(`[Server] Task #${taskId}: Client connection closed prematurely (Cancel pressed). Aborting browser generation...`);
          abortController.abort();
          if (activeWorker) {
            provider.markPageDirty(activeWorker.page);
            provider.stop(activeWorker).catch((err) => {
              console.warn(`[Server] Task #${taskId}: Error calling provider.stop on cancel:`, err);
            });
          }
        }
      };

      res.on('close', handleClientAbort);
      socket.on('close', handleClientAbort);
      req.on('aborted', handleClientAbort);

      try {
        const rawBody = await parseJsonBody(req);
        const messages = rawBody.messages ?? [];

        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'messages must be a non-empty array' }));
          return;
        }

        const { isContinuation, targetPath } = resolveSessionRouting(messages);
        const isNewConversation = !isContinuation;

        console.log(
          `[Session Routing Decision] Task #${taskId} | isNewConversation: ${isNewConversation} | targetPath: ${targetPath ?? (isNewConversation ? 'None (New Session)' : 'Current Active Tab')}`
        );

        const rawThinkingHeader = req.headers['thinking'];
        const thinkingVal = (Array.isArray(rawThinkingHeader) ? rawThinkingHeader[0] : rawThinkingHeader ?? '').trim();

        const isStream = rawBody.stream === true;
        const modelName = rawBody.model ?? `${provider.name}-playwright-pool`;

        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();

          // 核心解決方案：前置準備階段每 400ms 送出零寬度字元 \u200B
          // 讓 Cline 的 for await 立即能被消費並檢查 this.abort，一旦按下 Cancel 可以在 400ms 內中斷 Socket
          wakeUpTimer = setInterval(() => {
            if (res.writableEnded || abortController.signal.aborted || socket.destroyed) {
              stopWakeUp();
              return;
            }
            const invisibleChunk: ChatCompletionChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: { content: '\u200B' },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(invisibleChunk)}\n\n`);
          }, 400);
        }

        activeWorker = await pool.acquire();
        thisTask.worker = activeWorker;

        if (abortController.signal.aborted || socket.destroyed || !socket.writable) {
          stopWakeUp();
          console.warn(`[Server] Task #${taskId}: Connection already aborted before browser execution.`);
          if (activeWorker) {
            provider.markPageDirty(activeWorker.page);
          }
          return;
        }

        try {
          if (isStream) {
            const result = await provider.executeChat({
              worker: activeWorker,
              messages,
              isNewConversation,
              targetPath,
              tools: rawBody.tools,
              thinkingLevel: thinkingVal || undefined,
              abortSignal: abortController.signal,
              onReasoningDelta: (delta: string) => {
                stopWakeUp();
                if (res.writableEnded || abortController.signal.aborted || socket.destroyed) return;
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
                stopWakeUp();
                if (res.writableEnded || abortController.signal.aborted || socket.destroyed) return;
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

            stopWakeUp();

            if (result.currentPath && result.currentPath !== '/') {
              const fps = getAssistantFingerprints({
                role: 'assistant',
                content: result.cleanContent,
                tool_calls: result.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              } as any);

              for (const fp of fps) {
                assistantFingerprintStore.set(fp, result.currentPath);
                console.log(`[Assistant Fingerprint Stored] [${fp}] -> ${result.currentPath}`);
              }
            }

            if (!res.writableEnded && !abortController.signal.aborted && !socket.destroyed) {
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
            }
          } else {
            const result = await provider.executeChat({
              worker: activeWorker,
              messages,
              isNewConversation,
              targetPath,
              tools: rawBody.tools,
              thinkingLevel: thinkingVal || undefined,
              abortSignal: abortController.signal,
            });

            if (result.currentPath && result.currentPath !== '/') {
              const fps = getAssistantFingerprints({
                role: 'assistant',
                content: result.cleanContent,
                tool_calls: result.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              } as any);

              for (const fp of fps) {
                assistantFingerprintStore.set(fp, result.currentPath);
                console.log(`[Assistant Fingerprint Stored] [${fp}] -> ${result.currentPath}`);
              }
            }

            if (!res.writableEnded && !abortController.signal.aborted && !socket.destroyed) {
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
          }
        } finally {
          stopWakeUp();
          if (currentRunningTask === thisTask) {
            currentRunningTask = null;
          }
          pool.release(activeWorker);
          activeWorker = null;
        }
      } catch (err: unknown) {
        stopWakeUp();
        if (currentRunningTask === thisTask) {
          currentRunningTask = null;
        }
        const errMsg = getErrorMessage(err);
        console.error(`[Server Error Task #${taskId}]:`, errMsg);
        if (!res.headersSent && !res.writableEnded && !socket.destroyed) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: errMsg }));
        } else if (!res.writableEnded && !socket.destroyed) {
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
    console.log(`[Ready] Active Provider: ${selected.name}`);
  });
}
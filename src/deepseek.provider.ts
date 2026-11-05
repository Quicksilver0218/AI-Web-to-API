import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

interface WaitForResponseParams {
  prevMaxKey: number;
}

interface ObserveStreamParams {
  itemSelector: string;
  thinkSelector: string;
  prevMaxKey: number;
}

export class DeepSeekProvider extends WebAiProvider {
  readonly name = 'deepseek';
  readonly baseUrl = 'https://chat.deepseek.com/';

  private readonly selectors = {
    PROMPT_INPUT: 'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea',
    FILE_INPUT: 'input[type="file"]',
    UPLOAD_BUTTON: 'div[role="button"]:has(svg), button:has(svg)',
    SEND_BUTTON:
      'div[role="button"]:has(svg):not([aria-disabled="true"]), button:has(svg):not([disabled]), div[class*="send-button"]',
    DEEPTHINK_BUTTON:
      '.ds-toggle-button:has-text("深度思考"), .ds-toggle-button:has-text("DeepThink")',
    RATE_LIMIT_RETRY_BUTTON:
      '.ds-button--warning, div[role="button"].ds-button--warning',
    RESPONSE_CONTAINER: '.ds-markdown.ds-assistant-message-main-content, .ds-markdown:not(.ds-think-content *):not(.ds-think *)',
    THINK_CONTAINER: '.ds-think-content, .ds-think, [class*="think-content"]',
    VIRTUAL_LIST_ITEM: '[data-virtual-list-item-key]',
  } as const;

  /**
   * 根據 thinking Header 切換深度思考 (DeepThink / R1)
   */
  public async setDeepThinkState(page: Page, enable: boolean): Promise<void> {
    try {
      const toggleLocator = page.locator(this.selectors.DEEPTHINK_BUTTON).first();

      if (await toggleLocator.isVisible({ timeout: 2500 })) {
        const ariaPressed = await toggleLocator.getAttribute('aria-pressed');
        const isActive = ariaPressed === 'true';

        console.log(`[DeepSeek] DeepThink Toggle: currently active=${isActive}, target enable=${enable}`);

        if (enable && !isActive) {
          console.log('[DeepSeek] -> Clicking to ENABLE DeepThink...');
          await toggleLocator.scrollIntoViewIfNeeded().catch(() => {});
          await toggleLocator.click({ timeout: 2000 });

          const afterPressed = await toggleLocator.getAttribute('aria-pressed');
          if (afterPressed !== 'true') {
            await toggleLocator.click({ force: true, timeout: 2000 }).catch(() => {});
          }
        } else if (!enable && isActive) {
          console.log('[DeepSeek] -> Clicking to DISABLE DeepThink...');
          await toggleLocator.scrollIntoViewIfNeeded().catch(() => {});
          await toggleLocator.click({ timeout: 2000 });
        } else {
          console.log(`[DeepSeek] DeepThink already in target state.`);
        }
      } else {
        console.warn('[DeepSeek] Could not locate .ds-toggle-button:has-text("深度思考")');
      }
    } catch (err) {
      console.warn('[DeepSeek] setDeepThinkState warning:', err);
    }
  }

  async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[DeepSeek] Uploading attachment file: ${filePath}`);

    const fileInput = page.locator(this.selectors.FILE_INPUT).first();

    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(filePath);
    } else {
      console.log('[DeepSeek] Direct file input not found, falling back to filechooser event...');
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
      const uploadBtn = page.locator(this.selectors.UPLOAD_BUTTON).first();
      await uploadBtn.click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePath);
    }

    console.log('[DeepSeek] Attachment uploaded and parsed.');
  }

  async navigateConversation(page: Page, isNewConversation: boolean, targetPath?: string): Promise<void> {
    if (!isNewConversation && targetPath) {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== targetPath) {
        const targetFullUrl = `https://chat.deepseek.com${targetPath}`;
        console.log(`[DeepSeek] Switching to existing conversation: ${targetFullUrl}`);
        await page.goto(targetFullUrl, { waitUntil: 'domcontentloaded' });
      } else {
        console.log(`[DeepSeek] Tab is already on target conversation (${targetPath}), continuing directly.`);
      }
    } else {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== '/') {
        console.log('[DeepSeek] Opening new conversation home page...');
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      }
    }
  }

  /**
   * 獲取目前 DOM 中最大的 data-virtual-list-item-key，用於鎖定全新訊息回合
   */
  private async getMaxVirtualKey(page: Page): Promise<number> {
    return await page.evaluate((selector: string) => {
      const elements = Array.from(document.querySelectorAll(selector));
      return elements.reduce((max: number, element: Element) => {
        const rawKey = element.getAttribute('data-virtual-list-item-key');
        const num = rawKey !== null ? Number(rawKey) : -1;
        return Number.isNaN(num) ? max : Math.max(num, max);
      }, -1);
    }, this.selectors.VIRTUAL_LIST_ITEM);
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: { thinkingLevel?: string }
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    const normalizedEffort = (options?.thinkingLevel ?? '')
      .trim()
      .toLowerCase()
      .replace(/[-_]/g, '');

    const shouldEnableDeepThink = ['medium', 'high', 'xhigh', 'extrahigh'].includes(normalizedEffort);

    console.log(
      `[DeepSeek] Worker #${id} received effort: "${options?.thinkingLevel ?? 'none'}" -> DeepThink: ${shouldEnableDeepThink}`
    );

    await this.setDeepThinkState(page, shouldEnableDeepThink);

    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    // 記錄發送前的最大 key，確保稍後只監聽比此 key 更大的全新回合
    const prevMaxKey = await this.getMaxVirtualKey(page);
    console.log(`[DeepSeek] Worker #${id} max virtual list key before prompt: ${prevMaxKey}`);

    await input.click();
    await input.fill(prompt);
    await input.dispatchEvent('input');

    const submitPrompt = async () => {
      const sendBtn = page.locator(this.selectors.SEND_BUTTON).last();
      let sent = false;
      if (await sendBtn.isVisible()) {
        try {
          await sendBtn.click({ timeout: 2000 });
          sent = true;
        } catch {
          // Fall back
        }
      }
      if (!sent) {
        await input.press('Enter');
      }
    };

    await submitPrompt();

    // 頻率限制與新回應等待防護
    const maxRateLimitRetries = 5;
    for (let attempt = 1; attempt <= maxRateLimitRetries; attempt++) {
      const waitStatus = await page
        .waitForFunction(
          ({ prevMaxKey }: WaitForResponseParams) => {
            // 1. 檢查頻率限制報錯
            const warningBtn = document.querySelector('.ds-button--warning');
            const hasErrorText = (document.body.innerText || '').includes('消息发送过于频繁');
            if (warningBtn || hasErrorText) {
              return 'rate_limit';
            }

            // 2. 檢查是否有 key > prevMaxKey 的新助理回合掛載（帶有思考或主要回答）
            const elements = Array.from(document.querySelectorAll('[data-virtual-list-item-key]'));
            for (const el of elements) {
              const k = Number(el.getAttribute('data-virtual-list-item-key') || '-1');
              if (k > prevMaxKey) {
                if (el.querySelector('.ds-think-content, .ds-think, .ds-assistant-message-main-content, .ds-loading, .ds-cursor')) {
                  return 'success';
                }
              }
            }

            // 3. 檢查 Stop 按鈕是否已在運行中
            const stopBtn = document.querySelector(
              'div[role="button"]:has(svg rect), button:has(svg rect), [aria-label*="Stop" i], [aria-label*="停止" i], .ds-stop-button'
            );
            if (stopBtn && (stopBtn as HTMLElement).offsetParent !== null) {
              return 'success';
            }

            return false;
          },
          { prevMaxKey },
          { timeout: 8000 }
        )
        .catch(() => null);

      const status = waitStatus ? await waitStatus.jsonValue() : null;

      if (status === 'rate_limit') {
        console.warn(
          `[DeepSeek] Worker #${id} 遇到錯誤「消息发送过于频繁，请稍后重试」。等待 2 秒後重試 (${attempt}/${maxRateLimitRetries})...`
        );
        await page.waitForTimeout(2000);

        const retryBtn = page.locator(this.selectors.RATE_LIMIT_RETRY_BUTTON).last();
        if (await retryBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log(`[DeepSeek] Worker #${id} 點擊重試按鈕 (.ds-button--warning)...`);
          await retryBtn.click();
        } else {
          console.log(`[DeepSeek] Worker #${id} 重新嘗試送出提示詞...`);
          await submitPrompt();
        }

        continue;
      }

      if (status === 'success') {
        break;
      }
    }

    console.log(`[DeepSeek] Worker #${id} new response generation initiated.`);

    let rawFullMainText = '';

    const chunkListener = (rawPayload: string) => {
      let type: 'reasoning' | 'content' = 'content';
      let delta = rawPayload;

      try {
        if (typeof rawPayload === 'string' && rawPayload.startsWith('{"type":')) {
          const parsed = JSON.parse(rawPayload);
          type = parsed.type;
          delta = parsed.delta;
        }
      } catch {
        // Fallback
      }

      if (type === 'reasoning') {
        onRawChunk(delta, true);
      } else {
        rawFullMainText += delta;
        onRawChunk(delta, false);
      }
    };
    emitter.on('chunk', chunkListener);

    let finalMainText = '';

    try {
      finalMainText = await page.evaluate(
        ({ itemSelector, thinkSelector, prevMaxKey }: ObserveStreamParams) => {
          return new Promise<string>((resolve) => {
            const customWindow = window as unknown as WindowWithCustomEvents;

            // 嚴格只認 key > prevMaxKey 的新助理節點，絕不回退到舊回合！
            function getLatestTurnRoot(): HTMLElement | null {
              const elements = Array.from(document.querySelectorAll(itemSelector)) as HTMLElement[];
              if (elements.length === 0) return null;

              // 篩選屬於本輪對話的新節點
              const newItems = elements.filter((el) => {
                const k = Number(el.getAttribute('data-virtual-list-item-key') || '-1');
                return k > prevMaxKey;
              });

              if (newItems.length === 0) return null;

              // 在新節點中找出含有助理內容（思考、回答或 loading 標記）的項目
              const newAssistant = newItems.filter((el) => {
                return (
                  el.querySelector(
                    '.ds-think-content, .ds-think, .ds-assistant-message-main-content, .ds-loading, .ds-cursor'
                  ) !== null
                );
              });

              if (newAssistant.length > 0) {
                newAssistant.sort((a, b) => {
                  const keyA = Number(a.getAttribute('data-virtual-list-item-key') || '-1');
                  const keyB = Number(b.getAttribute('data-virtual-list-item-key') || '-1');
                  return keyA - keyB;
                });
                return newAssistant[newAssistant.length - 1];
              }

              // 若剛掛載尚未渲染出子標籤，先取新節點中的最後一項
              return newItems[newItems.length - 1];
            }

            function isDeepSeekRunning(): boolean {
              const stopBtn = document.querySelector(
                'div[role="button"]:has(svg rect), button:has(svg rect), [aria-label*="Stop" i], [aria-label*="停止" i], .ds-stop-button'
              );
              if (stopBtn && (stopBtn as HTMLElement).offsetParent !== null) {
                return true;
              }

              const loadingEl = document.querySelector(
                '.ds-loading, .ds-cursor, [class*="loading"], [class*="streaming"]'
              );
              if (loadingEl && (loadingEl as HTMLElement).offsetParent !== null) {
                return true;
              }

              return false;
            }

            function hasCompleteToolCall(raw: string): boolean {
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

            function getReactRawMarkdown(container: HTMLElement | null, isThought = false): string | null {
              if (!container) return null;

              const targets: (HTMLElement | null)[] = [
                container,
                container.querySelector('.ds-markdown'),
                container.parentElement,
              ];

              for (const el of targets) {
                if (!el) continue;
                const fiberKey = Object.keys(el).find(
                  (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
                );
                if (!fiberKey) continue;

                let fiber = (el as Record<string, any>)[fiberKey];
                let depth = 0;
                while (fiber && depth < 25) {
                  const props = fiber.memoizedProps;
                  if (props) {
                    if (isThought) {
                      if (typeof props.thinking_content === 'string' && props.thinking_content.trim().length > 0) {
                        return props.thinking_content;
                      }
                      if (typeof props.reasoning_content === 'string' && props.reasoning_content.trim().length > 0) {
                        return props.reasoning_content;
                      }
                      if (typeof props.content === 'string' && props.content.trim().length > 0) {
                        return props.content;
                      }
                      if (typeof props.text === 'string' && props.text.trim().length > 0) {
                        return props.text;
                      }
                    } else {
                      if (typeof props.content === 'string' && props.content.trim().length > 0) {
                        return props.content;
                      }
                      if (typeof props.text === 'string' && props.text.trim().length > 0) {
                        return props.text;
                      }
                      if (typeof props.rawContent === 'string' && props.rawContent.trim().length > 0) {
                        return props.rawContent;
                      }
                      if (props.message && typeof props.message.content === 'string' && props.message.content.trim().length > 0) {
                        return props.message.content;
                      }
                    }
                  }
                  fiber = fiber.return;
                  depth++;
                }
              }
              return null;
            }

            function domToMarkdownFallback(container: HTMLElement | null): string {
              if (!container) return '';
              const clone = container.cloneNode(true) as HTMLElement;

              clone.querySelectorAll('.ds-scroll-area__gutters, [class*="gutter"], button, .actions').forEach((el) => el.remove());

              clone.querySelectorAll('.katex').forEach((katex) => {
                const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
                const rawTex = annotation?.textContent ?? '';
                katex.replaceWith(document.createTextNode(`$${rawTex}$`));
              });

              clone.querySelectorAll('h1').forEach((h) => h.replaceWith(document.createTextNode(`\n\n# ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h2').forEach((h) => h.replaceWith(document.createTextNode(`\n\n## ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h3').forEach((h) => h.replaceWith(document.createTextNode(`\n\n### ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h4, h5, h6').forEach((h) => h.replaceWith(document.createTextNode(`\n\n#### ${h.textContent?.trim() ?? ''}\n\n`)));

              clone.querySelectorAll('li').forEach((li) => {
                const text = li.textContent?.trim() ?? '';
                li.replaceWith(document.createTextNode(`\n- ${text}\n`));
              });

              clone.querySelectorAll('p, .ds-markdown-paragraph').forEach((p) => {
                const text = p.textContent?.trim() ?? '';
                if (text) {
                  p.replaceWith(document.createTextNode(`\n\n${text}\n\n`));
                }
              });

              clone.querySelectorAll('table').forEach((table) => {
                const rows = Array.from(table.querySelectorAll('tr'));
                if (rows.length === 0) return;

                const mdRows: string[] = [];
                let colCount = 0;
                let delimiterSet = false;

                for (let i = 0; i < rows.length; i++) {
                  const cells = Array.from(rows[i].querySelectorAll('th, td'));
                  if (cells.length === 0) continue;

                  const cellTexts = cells.map((c) => {
                    const cClone = c.cloneNode(true) as HTMLElement;
                    cClone.querySelectorAll('code').forEach((cd) => cd.replaceWith(document.createTextNode(`\`${cd.textContent ?? ''}\``)));
                    cClone.querySelectorAll('strong, b').forEach((b) => b.replaceWith(document.createTextNode(`**${b.textContent ?? ''}**`)));
                    return (cClone.textContent ?? '').trim().replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|');
                  });

                  if (i === 0) {
                    colCount = cellTexts.length;
                    mdRows.push(`| ${cellTexts.join(' | ')} |`);
                    if (!delimiterSet) {
                      mdRows.push(`| ${cellTexts.map(() => '---').join(' | ')} |`);
                      delimiterSet = true;
                    }
                  } else {
                    while (colCount > 0 && cellTexts.length < colCount) {
                      cellTexts.push('');
                    }
                    mdRows.push(`| ${cellTexts.join(' | ')} |`);
                  }
                }

                table.replaceWith(document.createTextNode(`\n\n${mdRows.join('\n')}\n\n`));
              });

              const raw = clone.textContent ?? '';
              return raw.replace(/\n{3,}/g, '\n\n').trim();
            }

            // 1. 思考提取：嚴格限定在當前新回合 turnRoot 內部
            function getThoughtText(turnRoot: HTMLElement | null): string {
              if (!turnRoot) return '';
              const thinkEl = turnRoot.querySelector(thinkSelector) as HTMLElement | null;
              if (!thinkEl) return '';

              const rawReact = getReactRawMarkdown(thinkEl, true);
              if (rawReact) return rawReact;

              return domToMarkdownFallback(thinkEl);
            }

            // 2. 主回答提取：嚴格限定在當前新回合 turnRoot 內部；思考階段直接回傳空字串，絕不跨回合讀舊資料！
            function getMainText(turnRoot: HTMLElement | null): string {
              if (!turnRoot) return '';

              // 優先尋找專屬的主回答容器 class
              const mainEl = turnRoot.querySelector(
                '.ds-assistant-message-main-content, .ds-markdown:not(.ds-think-content *):not(.ds-think *)'
              ) as HTMLElement | null;

              // 關鍵：如果主回答容器尚未生成（表示模型還在深度思考中），絕對不能回退到全局查找舊訊息！
              if (!mainEl) return '';

              const rawReact = getReactRawMarkdown(mainEl, false);
              if (rawReact) return rawReact;

              return domToMarkdownFallback(mainEl);
            }

            let lastThoughtLen = 0;
            let lastMainLen = 0;
            let lastChangeTime = Date.now();
            let isDone = false;

            function emitDelta() {
              if (isDone) return;
              const turn = getLatestTurnRoot();
              if (!turn) return;

              // 推送 Thinking 專屬通道
              const currentThought = getThoughtText(turn);
              if (currentThought.length > lastThoughtLen) {
                const thoughtDelta = currentThought.slice(lastThoughtLen);
                lastThoughtLen = currentThought.length;
                lastChangeTime = Date.now();
                customWindow.__pushChunk(
                  JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                );
              }

              // 推送 Content 專屬通道
              const currentMain = getMainText(turn);
              if (currentMain.length > lastMainLen) {
                const mainDelta = currentMain.slice(lastMainLen);
                lastMainLen = currentMain.length;
                lastChangeTime = Date.now();
                customWindow.__pushChunk(
                  JSON.stringify({ type: 'content', delta: mainDelta })
                );
              }
            }

            async function complete() {
              if (isDone) return;
              isDone = true;

              if (observer) observer.disconnect();
              if (pollInterval !== null) clearInterval(pollInterval);

              const turn = getLatestTurnRoot();
              const finalThought = getThoughtText(turn);
              if (finalThought.length > lastThoughtLen) {
                const thoughtDelta = finalThought.slice(lastThoughtLen);
                lastThoughtLen = finalThought.length;
                await customWindow.__pushChunk(
                  JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                );
              }

              const finalMain = getMainText(turn);
              if (finalMain.length > lastMainLen) {
                const mainDelta = finalMain.slice(lastMainLen);
                lastMainLen = finalMain.length;
                await customWindow.__pushChunk(
                  JSON.stringify({ type: 'content', delta: mainDelta })
                );
              }

              await customWindow.__pushDone();
              resolve(finalMain);
            }

            const observer = new MutationObserver(() => {
              emitDelta();
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });

            const pollInterval = window.setInterval(() => {
              if (isDone) return;
              emitDelta();

              const warningBtn = document.querySelector('.ds-button--warning');
              const hasErrorText = (document.body.innerText || '').includes('消息发送过于频繁');
              if ((warningBtn || hasErrorText) && lastThoughtLen === 0 && lastMainLen === 0) {
                if (observer) observer.disconnect();
                clearInterval(pollInterval);
                resolve('__DEEPSEEK_RATE_LIMIT__');
                return;
              }

              const turn = getLatestTurnRoot();
              const currentMain = turn ? getMainText(turn) : '';
              const running = isDeepSeekRunning();

              // 只有當新回合真正輸出了完整的工具呼叫且 Stop 按鈕消失時，才判定完成
              if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                void complete();
                return;
              }

              const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

              // 思考過渡保護：如果目前只有思考內容而還沒有任何主回答，絕不能草率結束
              if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1500) {
                if (lastMainLen === 0) {
                  const isStillThinking = turn?.querySelector('.ds-loading, .ds-cursor, [class*="loading"]') !== null;
                  if (isStillThinking) {
                    return; // 繼續等待主回答生成
                  }
                }
                void complete();
                return;
              }

              if (hasGeneratedAny && Date.now() - lastChangeTime > 20000) {
                void complete();
                return;
              }
            }, 250);

            emitDelta();
          });
        },
        {
          itemSelector: this.selectors.VIRTUAL_LIST_ITEM,
          thinkSelector: this.selectors.THINK_CONTAINER,
          prevMaxKey,
        }
      );
    } finally {
      if (finalMainText.length > rawFullMainText.length && finalMainText !== '__DEEPSEEK_RATE_LIMIT__') {
        const gapRemainder = finalMainText.slice(rawFullMainText.length);
        onRawChunk(gapRemainder, false);
        rawFullMainText = finalMainText;
      }
      emitter.off('chunk', chunkListener);
    }

    if (finalMainText === '__DEEPSEEK_RATE_LIMIT__') {
      console.warn(`[DeepSeek] Worker #${id} 觀察初期遭遇頻率限制，等待 2 秒後點擊重試按鈕...`);
      await page.waitForTimeout(2000);
      const retryBtn = page.locator(this.selectors.RATE_LIMIT_RETRY_BUTTON).last();
      if (await retryBtn.isVisible().catch(() => false)) {
        await retryBtn.click();
      }
      return await this.sendPromptAndObserve(worker, prompt, onRawChunk, options);
    }

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalMainText.trim() ? finalMainText : rawFullMainText;

    console.log(`[DeepSeek] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: resolvedText, currentPath };
  }
}
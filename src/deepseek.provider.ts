import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

interface WaitForResponseParams {
  prevMaxKey: number;
}

interface ObserveStreamParams {
  itemSelector: string;
  thinkSelector: string;
  scrollSelector: string;
  prevMaxKey: number;
  initialThoughtLen: number;
  initialMainLen: number;
}

interface ObserveResult {
  status: 'done' | 'rate_limit' | 'continue';
  text: string;
  thoughtLen: number;
  mainLen: number;
}

export class DeepSeekProvider extends WebAiProvider {
  readonly name = 'deepseek';
  readonly baseUrl = 'https://chat.deepseek.com/';

  private readonly selectors = {
    PROMPT_INPUT: 'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea',
    FILE_INPUT: 'input[type="file"]',
    UPLOAD_BUTTON: 'div[role="button"]:has(svg), button:has(svg)',
    SEND_BUTTON:
      'div[role="button"]:has(svg):not([aria-disabled="true"]).ds-button--primary.ds-button--circle',
    DEEPTHINK_BUTTON:
      '.ds-toggle-button:has-text("深度思考"), .ds-toggle-button:has-text("DeepThink")',
    RATE_LIMIT_RETRY_BUTTON:
      '.ds-button--warning, div[role="button"].ds-button--warning',
    CONTINUE_BUTTON:
      '.ds-button--outlinedNeutral:has-text("继续生成"), .ds-button--outlinedNeutral:has-text("Continue")',
    RESPONSE_CONTAINER:
      '.ds-markdown.ds-assistant-message-main-content, .ds-markdown:not(.ds-think-content *):not(.ds-think *)',
    THINK_CONTAINER: '.ds-think-content, .ds-think, [class*="think-content"]',
    VIRTUAL_LIST_ITEM: '[data-virtual-list-item-key]',
    SCROLL_CONTAINER: '.ds-virtual-list.ds-scroll-area',
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

    const prevMaxKey = await this.getMaxVirtualKey(page);
    console.log(`[DeepSeek] Worker #${id} max virtual list key before prompt: ${prevMaxKey}`);

    await input.click();
    await input.fill(prompt);
    await input.dispatchEvent('input');

    const sendBtn = page.locator(this.selectors.SEND_BUTTON).last();
    let sent = false;
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      try {
        await sendBtn.click({ timeout: 2000 });
        sent = true;
      } catch {
        // Fall back
      }
    }
    if (!sent) {
      await input.focus();
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(600);
    const remainingVal = await input.inputValue().catch(() => '');
    if (remainingVal.trim().length > 0) {
      console.log(`[DeepSeek] Worker #${id} prompt remaining, executing forced submit...`);
      await sendBtn.click({ force: true, timeout: 2000 }).catch(() => {});
      await input.focus();
      await page.keyboard.press('Enter');
    }

    // 發送後立即執行一次置底卷動
    await page
      .evaluate((scrollSelector: string) => {
        const scroller = document.querySelector(scrollSelector);
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight;
        }
      }, this.selectors.SCROLL_CONTAINER)
      .catch(() => {});

    // 1. 送出後的頻率限制檢測
    const maxRateLimitRetries = 20;
    for (let attempt = 1; attempt <= maxRateLimitRetries; attempt++) {
      const waitStatus = await page
        .waitForFunction(
          ({ prevMaxKey }: WaitForResponseParams) => {
            const warningBtn = document.querySelector('.ds-button--warning');
            const hasErrorText = (document.body.innerText || '').includes('消息发送过于频繁');
            if (warningBtn || hasErrorText) {
              return 'rate_limit';
            }

            const elements = Array.from(document.querySelectorAll('[data-virtual-list-item-key]'));
            for (const el of elements) {
              const k = Number(el.getAttribute('data-virtual-list-item-key') || '-1');
              if (k > prevMaxKey) {
                if (
                  el.querySelector(
                    '.ds-think-content, .ds-think, .ds-assistant-message-main-content, .ds-loading, .ds-cursor'
                  )
                ) {
                  return 'success';
                }
              }
            }

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
          `[DeepSeek] Worker #${id} 遇到錯誤「消息发送过于频繁，请稍后重试」。等待 2 秒後點擊重試 (${attempt}/${maxRateLimitRetries})...`
        );
        await page.waitForTimeout(2000);

        const retryBtn = page.locator(this.selectors.RATE_LIMIT_RETRY_BUTTON).last();
        if (await retryBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log(`[DeepSeek] Worker #${id} 點擊重試按鈕 (.ds-button--warning)...`);
          await retryBtn.click();
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
    let currentThoughtLen = 0;
    let currentMainLen = 0;
    const maxObserveLoops = 30;

    try {
      // 2. 串流觀察循環（包含每 2 秒自動卷動邏輯）
      for (let loopAttempt = 0; loopAttempt <= maxObserveLoops; loopAttempt++) {
        const evalResult: ObserveResult = await page.evaluate(
          ({
            itemSelector,
            thinkSelector,
            scrollSelector,
            prevMaxKey,
            initialThoughtLen,
            initialMainLen,
          }: ObserveStreamParams) => {
            return new Promise<ObserveResult>((resolve) => {
              const customWindow = window as unknown as WindowWithCustomEvents;

              function scrollToBottom(): void {
                const scroller = document.querySelector(scrollSelector);
                if (scroller) {
                  scroller.scrollTop = scroller.scrollHeight;
                }
              }

              // 立即置底並啟動每 2 秒一次的自動卷動
              scrollToBottom();
              const scrollInterval = window.setInterval(scrollToBottom, 2000);

              function getLatestTurnRoot(): HTMLElement | null {
                const elements = Array.from(document.querySelectorAll(itemSelector)) as HTMLElement[];
                if (elements.length === 0) return null;

                const newItems = elements.filter((el) => {
                  const k = Number(el.getAttribute('data-virtual-list-item-key') || '-1');
                  return k > prevMaxKey;
                });

                if (newItems.length === 0) return null;

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

                return newItems[newItems.length - 1];
              }

              function isDeepSeekRunning(): boolean {
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

              function hasContinueButton(): boolean {
                const turn = getLatestTurnRoot();
                const roots = turn ? [turn, document.body] : [document.body];
                for (const root of roots) {
                  const btns = Array.from(
                    root.querySelectorAll('button, div[role="button"], .ds-button, .ds-button__content')
                  );
                  const found = btns.some((el) => {
                    const txt = (el.textContent || '').trim();
                    return (
                      (txt.includes('继续生成') || txt.includes('Continue')) &&
                      (el as HTMLElement).offsetParent !== null
                    );
                  });
                  if (found) return true;
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
                        if (
                          props.message &&
                          typeof props.message.content === 'string' &&
                          props.message.content.trim().length > 0
                        ) {
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

                clone
                  .querySelectorAll('.ds-scroll-area__gutters, [class*="gutter"], button, .actions')
                  .forEach((el) => el.remove());

                clone.querySelectorAll('.katex').forEach((katex) => {
                  const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
                  const rawTex = annotation?.textContent ?? '';
                  katex.replaceWith(document.createTextNode(`$${rawTex}$`));
                });

                clone
                  .querySelectorAll('h1')
                  .forEach((h) => h.replaceWith(document.createTextNode(`\n\n# ${h.textContent?.trim() ?? ''}\n\n`)));
                clone
                  .querySelectorAll('h2')
                  .forEach((h) => h.replaceWith(document.createTextNode(`\n\n## ${h.textContent?.trim() ?? ''}\n\n`)));
                clone
                  .querySelectorAll('h3')
                  .forEach((h) => h.replaceWith(document.createTextNode(`\n\n### ${h.textContent?.trim() ?? ''}\n\n`)));
                clone
                  .querySelectorAll('h4, h5, h6')
                  .forEach((h) =>
                    h.replaceWith(document.createTextNode(`\n\n#### ${h.textContent?.trim() ?? ''}\n\n`))
                  );

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
                      cClone
                        .querySelectorAll('code')
                        .forEach((cd) => cd.replaceWith(document.createTextNode(`\`${cd.textContent ?? ''}\``)));
                      cClone
                        .querySelectorAll('strong, b')
                        .forEach((b) => b.replaceWith(document.createTextNode(`**${b.textContent ?? ''}**`)));
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

              function getThoughtText(turnRoot: HTMLElement | null): string {
                if (!turnRoot) return '';
                const thinkEl = turnRoot.querySelector(thinkSelector) as HTMLElement | null;
                if (!thinkEl) return '';

                const rawReact = getReactRawMarkdown(thinkEl, true);
                if (rawReact) return rawReact;

                return domToMarkdownFallback(thinkEl);
              }

              function getMainText(turnRoot: HTMLElement | null): string {
                if (!turnRoot) return '';

                const mainEl = turnRoot.querySelector(
                  '.ds-assistant-message-main-content, .ds-markdown:not(.ds-think-content *):not(.ds-think *)'
                ) as HTMLElement | null;

                if (!mainEl) return '';

                const rawReact = getReactRawMarkdown(mainEl, false);
                if (rawReact) return rawReact;

                return domToMarkdownFallback(mainEl);
              }

              let lastThoughtLen = initialThoughtLen;
              let lastMainLen = initialMainLen;
              let lastChangeTime = Date.now();
              let isDone = false;

              function emitDelta() {
                if (isDone) return;
                const turn = getLatestTurnRoot();
                if (!turn) return;

                const currentThought = getThoughtText(turn);
                if (currentThought.length > lastThoughtLen) {
                  const thoughtDelta = currentThought.slice(lastThoughtLen);
                  lastThoughtLen = currentThought.length;
                  lastChangeTime = Date.now();
                  customWindow.__pushChunk(JSON.stringify({ type: 'reasoning', delta: thoughtDelta }));
                }

                const currentMain = getMainText(turn);
                if (currentMain.length > lastMainLen) {
                  const mainDelta = currentMain.slice(lastMainLen);
                  lastMainLen = currentMain.length;
                  lastChangeTime = Date.now();
                  customWindow.__pushChunk(JSON.stringify({ type: 'content', delta: mainDelta }));
                }
              }

              async function complete() {
                if (isDone) return;
                isDone = true;

                if (observer) observer.disconnect();
                if (pollInterval !== null) clearInterval(pollInterval);
                if (scrollInterval !== null) clearInterval(scrollInterval);

                const turn = getLatestTurnRoot();
                const finalThought = getThoughtText(turn);
                if (finalThought.length > lastThoughtLen) {
                  const thoughtDelta = finalThought.slice(lastThoughtLen);
                  lastThoughtLen = finalThought.length;
                  await customWindow.__pushChunk(JSON.stringify({ type: 'reasoning', delta: thoughtDelta }));
                }

                const finalMain = getMainText(turn);
                if (finalMain.length > lastMainLen) {
                  const mainDelta = finalMain.slice(lastMainLen);
                  lastMainLen = finalMain.length;
                  await customWindow.__pushChunk(JSON.stringify({ type: 'content', delta: mainDelta }));
                }

                await customWindow.__pushDone();
                resolve({
                  status: 'done',
                  text: finalMain,
                  thoughtLen: lastThoughtLen,
                  mainLen: lastMainLen,
                });
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

                // 檢測頻率限制報錯按鈕
                const warningBtn = document.querySelector('.ds-button--warning');
                const hasErrorText = (document.body.innerText || '').includes('消息发送过于频繁');
                if (warningBtn || hasErrorText) {
                  if (observer) observer.disconnect();
                  clearInterval(pollInterval);
                  clearInterval(scrollInterval);
                  resolve({
                    status: 'rate_limit',
                    text: '',
                    thoughtLen: lastThoughtLen,
                    mainLen: lastMainLen,
                  });
                  return;
                }

                const turn = getLatestTurnRoot();
                const currentMain = turn ? getMainText(turn) : '';
                const running = isDeepSeekRunning();
                const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

                // 工具呼叫閉合結束
                if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                  void complete();
                  return;
                }

                // 檢測「继续生成 / Continue」
                if (!running && hasGeneratedAny && hasContinueButton()) {
                  if (observer) observer.disconnect();
                  clearInterval(pollInterval);
                  clearInterval(scrollInterval);
                  resolve({
                    status: 'continue',
                    text: currentMain,
                    thoughtLen: lastThoughtLen,
                    mainLen: lastMainLen,
                  });
                  return;
                }

                // 思考過渡保護
                if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1500) {
                  if (lastMainLen === 0) {
                    const isStillThinking =
                      turn?.querySelector('.ds-loading, .ds-cursor, [class*="loading"]') !== null;
                    if (isStillThinking) {
                      return;
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
            scrollSelector: this.selectors.SCROLL_CONTAINER,
            prevMaxKey,
            initialThoughtLen: currentThoughtLen,
            initialMainLen: currentMainLen,
          }
        );

        // 原地處理：頻率限制重試
        if (evalResult.status === 'rate_limit') {
          console.warn(
            `[DeepSeek] Worker #${id} 遇到頻率限制錯誤。等待 2 秒後點擊重試按鈕...`
          );
          await page.waitForTimeout(2000);
          const retryBtn = page.locator(this.selectors.RATE_LIMIT_RETRY_BUTTON).last();
          if (await retryBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log(`[DeepSeek] Worker #${id} 點擊重試按鈕 (.ds-button--warning)...`);
            await retryBtn.click();
            await page.waitForTimeout(1000);
          }
          continue;
        }

        // 原地處理：繼續生成
        if (evalResult.status === 'continue') {
          console.warn(
            `[DeepSeek] Worker #${id} 遇到「继续生成 (Continue)」。等待 2 秒後點擊繼續 (${loopAttempt + 1}/${maxObserveLoops})...`
          );
          await page.waitForTimeout(2000);

          const continueBtn = page.locator(this.selectors.CONTINUE_BUTTON).last();
          if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log(`[DeepSeek] Worker #${id} 點擊「继续生成」按鈕...`);
            await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
            await continueBtn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(1000);
          } else {
            console.warn(`[DeepSeek] Worker #${id} 「继续生成」按鈕未檢測到，繼續輪詢...`);
          }

          currentThoughtLen = evalResult.thoughtLen;
          currentMainLen = evalResult.mainLen;
          continue;
        }

        finalMainText = evalResult.text;
        break;
      }
    } finally {
      if (finalMainText.length > rawFullMainText.length) {
        const gapRemainder = finalMainText.slice(rawFullMainText.length);
        onRawChunk(gapRemainder, false);
        rawFullMainText = finalMainText;
      }
      emitter.off('chunk', chunkListener);
    }

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalMainText.trim() ? finalMainText : rawFullMainText;

    console.log(`[DeepSeek] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: resolvedText, currentPath };
  }
}
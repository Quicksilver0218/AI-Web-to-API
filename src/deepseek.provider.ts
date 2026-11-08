import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

interface WaitForTurnParams {
  turnSelector: string;
  prevSnapshot: number;
}

interface ObserveStreamParams {
  itemSelector: string;
  thinkSelector: string;
  scrollSelector: string;
  stopSelector: string;
  continueSelector: string;
  actionSelector: string;
  isModelRunningCode: string;
  prevSnapshot: number;
  initialThoughtLen: number;
  initialMainLen: number;
}

interface ObserveResult {
  status: 'done' | 'rate_limit' | 'continue' | 'timeout';
  text: string;
  thoughtLen: number;
  mainLen: number;
}

/**
 * 統一的運行狀態判斷函式（瀏覽器環境執行）
 */
function isModelRunning(
  loadingSelector = '.ds-loading, .ds-cursor, [class*="loading"], [class*="streaming"]'
): boolean {
  const loadingEl = document.querySelector(loadingSelector);
  return loadingEl !== null && (loadingEl as HTMLElement).offsetParent !== null;
}

export class DeepSeekProvider extends WebAiProvider {
  readonly name = 'deepseek';
  readonly baseUrl = 'https://chat.deepseek.com';

  private readonly stoppingPromises = new WeakMap<Page, Promise<void>>();

  private readonly selectors = {
    PROMPT_INPUT: 'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea',
    FILE_INPUT: 'input[type="file"]',
    UPLOAD_BUTTON: 'div[role="button"]:has(svg), button:has(svg)',
    SEND_OR_STOP_BUTTON:
      'div[role="button"]:has(svg):not([aria-disabled="true"]).ds-button--primary.ds-button--circle',
    DEEPTHINK_BUTTON:
      '.ds-toggle-button',
    RATE_LIMIT_RETRY_BUTTON:
      '.ds-button--warning, div[role="button"].ds-button--warning',
    CONTINUE_BUTTON:
      'div[role="button"].ds-button--outlinedNeutral, button.ds-button--outlinedNeutral, .ds-button--outlinedNeutral',
    TURN_ACTIONS:
      '.ds-button--iconLabelTertiary, [aria-label="朗读"], .ds-button--capsule.ds-button--xs',
    RESPONSE_CONTAINER:
      '.ds-markdown.ds-assistant-message-main-content, .ds-markdown:not(.ds-think-content *):not(.ds-think *)',
    THINK_CONTAINER: '.ds-think-content, .ds-think, [class*="think-content"]',
    TURN_ITEM: '[data-virtual-list-item-key]',
    SCROLL_CONTAINER: '.ds-virtual-list.ds-scroll-area',
  } as const;

  public async stop(worker: PageWorker): Promise<void> {
    const existing = this.stoppingPromises.get(worker.page);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        this.dirtyPages.add(worker.page);
        console.log(`[DeepSeek] Worker #${worker.id} waiting up to 5s for isModelRunning before clicking stop...`);

        // 等待外部統一的 isModelRunning 成立（最多 5 秒）
        await worker.page.waitForFunction(isModelRunning, undefined, { timeout: 5000 });

        console.log(`[DeepSeek] Worker #${worker.id} model confirmed running. Clicking SEND_OR_STOP_BUTTON...`);
        const stopBtn = worker.page.locator(this.selectors.SEND_OR_STOP_BUTTON).first();
        await stopBtn.click({ timeout: 2000 });
      } catch (err) {
        console.warn(`[DeepSeek] Worker #${worker.id} stop execution warning:`, err);
      }
    })();

    this.stoppingPromises.set(worker.page, promise);
    try {
      await promise;
    } finally {
      this.stoppingPromises.delete(worker.page);
    }
  }

  public async setThinkingLevel(page: Page, level?: string): Promise<void> {
    const normalized = (level ?? '').trim().toLowerCase().replace(/[-_]/g, '');
    const enable = ['medium', 'high', 'xhigh', 'extrahigh'].includes(normalized);

    try {
      const toggleLocator = page.locator(this.selectors.DEEPTHINK_BUTTON).filter({ hasText: /深度思考|DeepThink/i }).first();

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
        }
      }
    } catch (err) {
      console.warn('[DeepSeek] setThinkingLevel warning:', err);
    }
  }

  async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[DeepSeek] Uploading attachment file: ${filePath}`);

    const fileInput = page.locator(this.selectors.FILE_INPUT).first();

    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(filePath);
    } else {
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
      const uploadBtn = page.locator(this.selectors.UPLOAD_BUTTON).first();
      await uploadBtn.click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePath);
    }

    console.log('[DeepSeek] Attachment uploaded and parsed.');
  }

  async navigateConversation(page: Page, isNewConversation: boolean, targetPath?: string): Promise<void> {
    if (isNewConversation) {
      const items = await page.locator(this.selectors.TURN_ITEM).count().catch(() => 0);
      const hasInputText = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLTextAreaElement | null;
        return el ? el.value.trim().length > 0 : false;
      }, this.selectors.PROMPT_INPUT).catch(() => false);
      const hasFiles = await page.locator('.ds-file-item, [class*="file-item"], .ds-upload-file').count().catch(() => 0);
      const currentUrlObj = new URL(page.url());

      const isDirty = this.dirtyPages.has(page) || items > 0 || hasInputText || hasFiles > 0 || currentUrlObj.pathname !== '/';

      if (isDirty) {
        console.log('[DeepSeek] Page is dirty or starting new session. Force reloading to baseUrl...');
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
        this.dirtyPages.delete(page);
      }
      return;
    }

    if (targetPath && targetPath !== '/') {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== targetPath) {
        const targetFullUrl = `${this.baseUrl}${targetPath}`;
        console.log(`[DeepSeek] Switching to target conversation: ${targetFullUrl}`);
        await page.goto(targetFullUrl, { waitUntil: 'domcontentloaded' });
      } else {
        console.log(`[DeepSeek] Tab is already on target conversation (${targetPath}), continuing directly.`);
      }
    } else {
      console.log(`[DeepSeek] Continuing in current active conversation tab (path: ${new URL(page.url()).pathname}).`);
    }
  }

  private async getTurnSnapshot(page: Page): Promise<number> {
    return await page.evaluate((selector: string) => {
      const elements = Array.from(document.querySelectorAll(selector));
      return elements.reduce((max: number, element: Element) => {
        const rawKey = element.getAttribute('data-virtual-list-item-key');
        const num = rawKey !== null ? Number(rawKey) : -1;
        return Number.isNaN(num) ? max : Math.max(num, max);
      }, -1);
    }, this.selectors.TURN_ITEM);
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    await input.click();

    await input.evaluate((el: HTMLTextAreaElement) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
    await input.fill('');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});

    await input.fill(prompt);
    await input.dispatchEvent('input');

    const sendBtn = page.locator(this.selectors.SEND_OR_STOP_BUTTON).last();
    let sent = false;

    try {
      await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
      if (await sendBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await sendBtn.click({ timeout: 2000 });
        sent = true;
      }
    } catch {
      // Fallback
    }

    if (!sent) {
      await input.focus();
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(600);
    const remainingVal = await input.inputValue().catch(() => '');
    if (remainingVal.trim().length > 0) {
      console.log('[DeepSeek] Prompt remaining in input box, executing forced submit...');
      await sendBtn.click({ force: true, timeout: 2000 }).catch(() => {});
      await input.focus();
      await page.keyboard.press('Enter');
    }
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: { thinkingLevel?: string; abortSignal?: AbortSignal }
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    try {
      if (options?.abortSignal?.aborted) {
        this.dirtyPages.add(page);
        await this.stop(worker);
        return { rawText: '[Generation Aborted by Client]', currentPath: new URL(page.url()).pathname };
      }

      await this.setThinkingLevel(page, options?.thinkingLevel);

      const turnSnapshot = await this.getTurnSnapshot(page);
      console.log(`[DeepSeek] Worker #${id} turn snapshot before prompt: ${turnSnapshot}`);

      await this.submitPrompt(page, prompt);

      await page
        .evaluate((scrollSelector: string) => {
          const scroller = document.querySelector(scrollSelector);
          if (scroller) {
            scroller.scrollTop = scroller.scrollHeight;
          }
        }, this.selectors.SCROLL_CONTAINER)
        .catch(() => {});

      const abortInitialWait = new Promise<void>((_, reject) => {
        if (options?.abortSignal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        options?.abortSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });

      try {
        await Promise.race([
          page.waitForFunction(
            ({ turnSelector, prevSnapshot }: WaitForTurnParams) => {
              const elements = Array.from(document.querySelectorAll(turnSelector));
              const hasNewTurn = elements.some(
                (el) => Number(el.getAttribute('data-virtual-list-item-key') || '-1') > prevSnapshot
              );
              const hasWarning = document.querySelector('.ds-button--warning') !== null;
              return hasNewTurn || hasWarning;
            },
            { turnSelector: this.selectors.TURN_ITEM, prevSnapshot: turnSnapshot },
            { timeout: 30000 }
          ),
          abortInitialWait,
        ]);
      } catch {
        if (options?.abortSignal?.aborted) {
          console.warn(`[DeepSeek] Worker #${id} aborted during initial turn wait. Triggering stop...`);
          await this.stop(worker);
          return { rawText: '[Generation Aborted by Client]', currentPath: new URL(page.url()).pathname };
        }
      }

      console.log(`[DeepSeek] Worker #${id} new model turn detected.`);

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
      const maxRetries = 20;

      try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          if (options?.abortSignal?.aborted) {
            await this.stop(worker);
            finalMainText = '[Generation Aborted by Client]';
            break;
          }

          const evalPromise = page.evaluate(
            ({
              itemSelector,
              thinkSelector,
              scrollSelector,
              stopSelector,
              continueSelector,
              actionSelector,
              isModelRunningCode,
              prevSnapshot,
              initialThoughtLen,
              initialMainLen,
            }: ObserveStreamParams) => {
              return new Promise<ObserveResult>((resolve) => {
                const customWindow = window as unknown as WindowWithCustomEvents;

                // 從傳入的程式碼字串還原出統一的 isModelRunning 函式
                const scriptContent = 'return (' + isModelRunningCode + ')';
                const fn = new Function(
                  window.trustedTypes ?
                      window.trustedTypes.createPolicy('evalPolicy', {
                        createScript: (scriptString: string) => scriptString,
                      }).createScript(scriptContent) as unknown as string
                    : scriptContent
                )();
                const isModelRunning = (): boolean => fn();

                function scrollToBottom(): void {
                  const scroller = document.querySelector(scrollSelector);
                  if (scroller) {
                    scroller.scrollTop = scroller.scrollHeight;
                  }
                }

                scrollToBottom();
                const scrollInterval = window.setInterval(scrollToBottom, 2000);

                function getLatestTurnRoot(): HTMLElement | null {
                  const elements = Array.from(document.querySelectorAll(itemSelector)) as HTMLElement[];
                  if (elements.length === 0) return null;

                  const newItems = elements.filter((el) => {
                    const k = Number(el.getAttribute('data-virtual-list-item-key') || '-1');
                    return k > prevSnapshot;
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

                function clickStopButton(): boolean {
                  const btn = document.querySelector(stopSelector) as HTMLElement | null;
                  if (btn && btn.offsetParent !== null && isModelRunning()) {
                    btn.click();
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
                  const continueBtn = document.querySelector(continueSelector) as HTMLElement | null;
                  return continueBtn !== null && continueBtn.offsetParent !== null;
                }

                function hasActionBar(turnRoot: HTMLElement | null): boolean {
                  if (!turnRoot) return false;
                  const actionEl = turnRoot.querySelector(actionSelector) as HTMLElement | null;
                  return actionEl !== null && actionEl.offsetParent !== null;
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

                async function finish(status: ObserveResult['status'], text: string) {
                  if (isDone) return;
                  isDone = true;

                  if (observer) observer.disconnect();
                  if (pollInterval !== null) clearInterval(pollInterval);
                  if (scrollInterval !== null) clearInterval(scrollInterval);

                  if (status === 'done') {
                    const turn = getLatestTurnRoot();
                    const finalThought = getThoughtText(turn);
                    if (finalThought.length > lastThoughtLen) {
                      const thoughtDelta = finalThought.slice(lastThoughtLen);
                      lastThoughtLen = finalThought.length;
                      customWindow.__pushChunk(JSON.stringify({ type: 'reasoning', delta: thoughtDelta }));
                    }

                    const finalMain = getMainText(turn);
                    if (finalMain.length > lastMainLen) {
                      const mainDelta = finalMain.slice(lastMainLen);
                      lastMainLen = finalMain.length;
                      customWindow.__pushChunk(JSON.stringify({ type: 'content', delta: mainDelta }));
                    }
                  }

                  customWindow.__pushDone();
                  resolve({
                    status,
                    text,
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

                  const warningBtn = document.querySelector('.ds-button--warning');
                  const hasErrorText = (document.body.innerText || '').includes('消息发送过于频繁');
                  if (warningBtn || hasErrorText) {
                    void finish('rate_limit', '');
                    return;
                  }

                  const turn = getLatestTurnRoot();
                  const currentMain = turn ? getMainText(turn) : '';
                  const running = isModelRunning();
                  const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

                  // 情況 1：已輸出完整 MCP 工具呼叫
                  if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                    void finish('done', currentMain);
                    return;
                  }

                  // 情況 2：出現「继续生成 / Continue」
                  if (!running && hasGeneratedAny && hasContinueButton()) {
                    void finish('continue', currentMain);
                    return;
                  }

                  // 情況 3：最新回合出現操作工具列（複製/重試/朗讀）
                  if (hasGeneratedAny && hasActionBar(turn)) {
                    void finish('done', currentMain);
                    return;
                  }

                  // 情況 4：兜底保險（停止運作且靜止超過 1 秒）
                  if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1000) {
                    void finish('done', currentMain);
                    return;
                  }

                  // 情況 5：45 秒超時
                  if (Date.now() - lastChangeTime > 45000) {
                    clickStopButton();
                    void finish('timeout', '[Generation Timeout]: No response received within 45 seconds.');
                    return;
                  }
                }, 200);

                emitDelta();
              });
            },
            {
              itemSelector: this.selectors.TURN_ITEM,
              thinkSelector: this.selectors.THINK_CONTAINER,
              scrollSelector: this.selectors.SCROLL_CONTAINER,
              stopSelector: this.selectors.SEND_OR_STOP_BUTTON,
              continueSelector: this.selectors.CONTINUE_BUTTON,
              actionSelector: this.selectors.TURN_ACTIONS,
              isModelRunningCode: isModelRunning.toString(),
              prevSnapshot: turnSnapshot,
              initialThoughtLen: currentThoughtLen,
              initialMainLen: currentMainLen,
            }
          );

          const abortPromise = new Promise<ObserveResult>((resolve) => {
            if (options?.abortSignal?.aborted) {
              resolve({ status: 'timeout', text: '[Generation Aborted by Client]', thoughtLen: 0, mainLen: 0 });
              return;
            }
            options?.abortSignal?.addEventListener(
              'abort',
              () => resolve({ status: 'timeout', text: '[Generation Aborted by Client]', thoughtLen: 0, mainLen: 0 }),
              { once: true }
            );
          });

          const evalResult = await Promise.race([evalPromise, abortPromise]);

          if (options?.abortSignal?.aborted || evalResult.status === 'timeout') {
            await this.stop(worker);
            finalMainText = evalResult.text;
            break;
          }

          if (evalResult.status === 'rate_limit') {
            console.warn(`[DeepSeek] Worker #${id} Rate limit error occurred. Retry after 2 seconds (${attempt}/${maxRetries})...`);
            await page.waitForTimeout(2000);
            const retryBtn = page.locator(this.selectors.RATE_LIMIT_RETRY_BUTTON).last();
            if (await retryBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await retryBtn.click();
              await page.waitForTimeout(1000);
            }
            continue;
          }

          if (evalResult.status === 'continue') {
            console.warn(`[DeepSeek] Worker #${id} 'Continue' button appeared. Retry after 2 seconds (${attempt}/${maxRetries})...`);
            await page.waitForTimeout(2000);

            const continueBtn = page.locator(this.selectors.CONTINUE_BUTTON).last();
            if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
              await continueBtn.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(1000);
            }

            currentThoughtLen = evalResult.thoughtLen;
            currentMainLen = evalResult.mainLen;
            continue;
          }

          finalMainText = evalResult.text;
          break;
        }

        if (!finalMainText) {
          finalMainText = `[DeepSeek Error]: Maximum retries (${maxRetries}) exceeded without completing response.`;
        }
      } finally {
        if (finalMainText.length > rawFullMainText.length) {
          const gapRemainder = finalMainText.slice(rawFullMainText.length);
          onRawChunk(gapRemainder, false);
          rawFullMainText = finalMainText;
        }
        emitter.off('chunk', chunkListener);
      }

      let currentPath = new URL(page.url()).pathname;
      if (currentPath === '/') {
        await page.waitForFunction(
          () => new URL(window.location.href).pathname.startsWith('/a/chat/s/'),
          { timeout: 3500 }
        ).catch(() => {});
        currentPath = new URL(page.url()).pathname;
      }

      const resolvedText = finalMainText.trim() ? finalMainText : rawFullMainText;
      console.log(`[DeepSeek] Worker #${id} generation completed. Actual URL path: ${currentPath} (Total chars: ${resolvedText.length})`);
      return { rawText: resolvedText, currentPath };
    } catch (err) {
      this.dirtyPages.add(page);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DeepSeek] Worker #${id} unexpected error:`, errorMsg);
      return {
        rawText: `[DeepSeek Error]: ${errorMsg}`,
        currentPath: new URL(page.url()).pathname,
      };
    }
  }
}
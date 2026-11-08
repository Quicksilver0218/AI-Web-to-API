import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.js';

interface WaitForTurnParams {
  turnSelector: string;
  prevCount: number;
}

interface ObserveAiStudioParams {
  turnSelector: string;
  scrollSelector: string;
  prevCount: number;
}

export class AiStudioProvider extends WebAiProvider {
  readonly name = 'aistudio';
  readonly baseUrl = 'https://aistudio.google.com/prompts/new_chat';

  // 記錄已發生過對話的 Page 實例，不依賴 URL 判斷
  private readonly hasChattedPages = new WeakSet<Page>();

  private readonly selectors = {
    PROMPT_INPUT:
      'ms-prompt-input-wrapper textarea, ms-autosize-textarea textarea, textarea[aria-label*="Type something"], textarea',
    RUN_BUTTON:
      'ms-run-button button:not([disabled]), button.run-button:not([disabled]), button[aria-label*="Run"]:not([disabled])',
    STOP_BUTTON:
      'ms-run-button button.stop, ms-run-button button[aria-label*="Stop"], button.stop-button',
    ADD_CHUNK_BUTTON:
      'ms-add-chunk-menu button, button[aria-label*="Insert"], button[aria-label*="Add"]',
    UPLOAD_FILE_MENU_ITEM:
      'button[role="menuitem"]:has-text("Upload"), button[role="menuitem"]:has-text("File"), button[aria-label*="Upload"]',
    WELCOME_DIALOG_BUTTON:
      '#g1-welcome-dialog button[aria-label="Close dialog"], ms-g1-welcome-dialog button.ms-button-primary, #g1-welcome-dialog button:has-text("Continue"), ms-g1-welcome-dialog button:has-text("Continue")',
    TEMPORARY_CHAT_BUTTON:
      'ms-auth-request-dialog button[aria-label="Cancel"], ms-auth-request-dialog button:has-text("Cancel and use Temporary chat"), #mat-mdc-dialog-0 button:has-text("Cancel and use Temporary chat")',
    COPYRIGHT_ACK_BUTTON:
      '#copyright-acknowledgement-dialog button[aria-label="Agree to the copyright acknowledgement"], ms-copyright-acknowledgement-dialog button.ms-button-primary, #copyright-acknowledgement-dialog button:has-text("Acknowledge")',
    PREFERENCE_SKIP_BUTTON:
      'ms-inline-preference-vote button[data-test-id="skip-button"], button[aria-label="Skip preference vote"], ms-inline-preference-vote button:has-text("Skip")',
    VIEW_MORE_ACTIONS_BUTTON:
      '[aria-label="View more actions"], button[aria-label*="more actions" i]',
    RAW_MODE_BUTTON:
      '[data-test-raw-mode], [data-test-id="raw-mode"], button[data-test-raw-mode], [role="menuitem"]:has-text("Raw")',
    RAW_MODE_CHECKMARK:
      '[data-test-raw-mode-checkmark]',
    FILE_INPUT: 'input[type="file"]',
    CHAT_TURN: 'ms-chat-turn',
    MODEL_TURN: 'ms-chat-turn .chat-turn-container.model, ms-chat-turn[data-turn-role="Model"]',
    MODEL_ERROR: '.model-error, [class*="model-error"]',
    THINKING_SELECT: 'mat-select[aria-label="Thinking Level"]',
    THINKING_SELECT_VALUE: '.mat-mdc-select-min-line, .mat-mdc-select-value-text',
    THINKING_PANEL: '.mat-mdc-select-panel[aria-label="Thinking Level"], .mat-mdc-select-panel',
    SCROLL_CONTAINER: 'ms-autoscroll-container',
  } as const;

  /**
   * 將傳入的 thinking 參數對齊為 AI Studio 的 3 種等級
   */
  public mapThinkingLevel(effort?: string): 'Low' | 'Medium' | 'High' | null {
    if (!effort) return null;
    const normalized = effort.trim().toLowerCase().replace(/[-_]/g, '');

    if (['none', 'low'].includes(normalized)) return 'Low';
    if (['medium'].includes(normalized)) return 'Medium';
    if (['high', 'xhigh', 'extrahigh'].includes(normalized)) return 'High';

    return null;
  }

  /**
   * 根據設定切換 AI Studio 的 Thinking Level 下拉選單
   */
  public async setThinkingLevel(page: Page, targetLevel: 'Low' | 'Medium' | 'High'): Promise<void> {
    try {
      const selectLocator = page.locator(this.selectors.THINKING_SELECT).first();
      if (!(await selectLocator.isVisible({ timeout: 2000 }).catch(() => false))) {
        return;
      }

      const currentVal = (
        await selectLocator.locator(this.selectors.THINKING_SELECT_VALUE).innerText().catch(() => '')
      ).trim();

      if (currentVal.toLowerCase() === targetLevel.toLowerCase()) {
        return;
      }

      console.log(`[AI Studio] Changing Thinking Level from "${currentVal}" to "${targetLevel}"...`);
      await selectLocator.scrollIntoViewIfNeeded().catch(() => {});
      await selectLocator.click({ timeout: 2000 });

      const optionLocator = page
        .locator(`${this.selectors.THINKING_PANEL} mat-option`)
        .filter({ hasText: new RegExp(`^\\s*${targetLevel}\\s*$`, 'i') })
        .first();

      if (await optionLocator.isVisible({ timeout: 2500 }).catch(() => false)) {
        await optionLocator.click({ timeout: 2000 });
        console.log(`[AI Studio] Successfully applied Thinking Level: "${targetLevel}"`);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }

      await page.waitForSelector('.cdk-overlay-pane:has(mat-option)', { state: 'detached', timeout: 1500 }).catch(async () => {
        await page.keyboard.press('Escape').catch(() => {});
      });
    } catch (err) {
      console.warn('[AI Studio] setThinkingLevel error:', err);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  public async dismissWelcomeDialogIfPresent(page: Page): Promise<void> {
    const welcomeBtn = page.locator(this.selectors.WELCOME_DIALOG_BUTTON).first();
    try {
      if (await welcomeBtn.isVisible({ timeout: 1000 })) {
        await welcomeBtn.click();
        await welcomeBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissTemporaryChatDialogIfPresent(page: Page): Promise<void> {
    const tempChatBtn = page.locator(this.selectors.TEMPORARY_CHAT_BUTTON).first();
    try {
      if (await tempChatBtn.isVisible({ timeout: 1000 })) {
        await tempChatBtn.click();
        await tempChatBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissCopyrightDialogIfPresent(page: Page): Promise<void> {
    const ackBtn = page.locator(this.selectors.COPYRIGHT_ACK_BUTTON).first();
    try {
      if (await ackBtn.isVisible({ timeout: 1000 })) {
        await ackBtn.click();
        await ackBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissPreferenceVoteIfPresent(page: Page): Promise<void> {
    const skipBtn = page.locator(this.selectors.PREFERENCE_SKIP_BUTTON).first();
    try {
      if (await skipBtn.isVisible({ timeout: 1000 })) {
        await skipBtn.click();
        await skipBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissAllDialogs(page: Page): Promise<void> {
    await this.dismissWelcomeDialogIfPresent(page);
    await this.dismissTemporaryChatDialogIfPresent(page);
    await this.dismissCopyrightDialogIfPresent(page);
    await this.dismissPreferenceVoteIfPresent(page);
  }

  public async ensureRawModeEnabled(page: Page): Promise<void> {
    try {
      const moreActionsLocator = page.locator(this.selectors.VIEW_MORE_ACTIONS_BUTTON);
      if ((await moreActionsLocator.count()) === 0) {
        return;
      }

      const moreActionsBtn = moreActionsLocator.last();
      await moreActionsBtn.waitFor({ state: 'visible', timeout: 2000 });
      await moreActionsBtn.scrollIntoViewIfNeeded().catch(() => {});
      await moreActionsBtn.click({ timeout: 2000 });

      const rawModeBtn = page.locator(this.selectors.RAW_MODE_BUTTON).first();
      await rawModeBtn.waitFor({ state: 'visible', timeout: 2500 });

      const checkmarkInBtn = rawModeBtn.locator(this.selectors.RAW_MODE_CHECKMARK);
      const globalCheckmark = page.locator(this.selectors.RAW_MODE_CHECKMARK);

      const hasCheckmark =
        (await checkmarkInBtn.count()) > 0 ||
        (await globalCheckmark.count()) > 0;

      if (!hasCheckmark) {
        console.log('[AI Studio] Checkmark not found. Enabling Raw Mode...');
        await rawModeBtn.click({ timeout: 2000 });
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch (err) {
      console.warn('[AI Studio] ensureRawModeEnabled notice:', err);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[AI Studio] Uploading attachment file: ${filePath}`);
    await this.dismissAllDialogs(page);

    const directFileInput = page.locator(this.selectors.FILE_INPUT).first();
    if ((await directFileInput.count()) > 0) {
      await directFileInput.setInputFiles(filePath);
      await this.dismissCopyrightDialogIfPresent(page);
    } else {
      const addBtn = page.locator(this.selectors.ADD_CHUNK_BUTTON).first();
      await addBtn.waitFor({ state: 'visible', timeout: 15000 });
      await addBtn.click();

      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 25000 });
      const uploadItem = page.locator(this.selectors.UPLOAD_FILE_MENU_ITEM).first();
      if (await uploadItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await uploadItem.click();
      } else {
        await page.keyboard.press('Enter');
      }

      await this.dismissCopyrightDialogIfPresent(page);
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePath);
      await this.dismissCopyrightDialogIfPresent(page);
    }

    console.log('[AI Studio] Attachment uploaded and mounted.');
  }

  async navigateConversation(
    page: Page,
    isNewConversation: boolean,
    targetPath?: string
  ): Promise<void> {
    if (isNewConversation) {
      const hasChattedInSession = this.hasChattedPages.has(page);
      const existingTurns = await page.locator(this.selectors.CHAT_TURN).count().catch(() => 0);

      if (hasChattedInSession || existingTurns > 0) {
        console.log(`[AI Studio] Resetting page for new session...`);
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
        this.hasChattedPages.delete(page);
      }
      await this.dismissAllDialogs(page);
      await this.ensureRawModeEnabled(page);
    } else {
      await this.dismissAllDialogs(page);
    }
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: { thinkingLevel?: string }
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    await this.dismissAllDialogs(page);

    const targetLevel = this.mapThinkingLevel(options?.thinkingLevel);
    if (targetLevel) {
      await this.setThinkingLevel(page, targetLevel);
    }

    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 20000 });

    const submitPrompt = async () => {
      await input.click();
      await input.fill('');
      await input.fill(prompt);
      await input.dispatchEvent('input');
      await input.dispatchEvent('change');

      await this.dismissAllDialogs(page);

      const runBtn = page.locator(this.selectors.RUN_BUTTON).first();
      let submitted = false;

      try {
        if (await runBtn.isVisible({ timeout: 2000 })) {
          await runBtn.click({ timeout: 2000 });
          submitted = true;
        }
      } catch {
        // Fallback
      }

      if (!submitted) {
        await input.focus();
        await page.keyboard.press('Enter');
      }

      this.hasChattedPages.add(page);

      await page.waitForTimeout(600);
      const remainingVal = await input.inputValue().catch(() => '');
      if (remainingVal.trim().length > 0) {
        console.log(`[AI Studio] Worker #${id} prompt remaining, executing forced submit...`);
        await runBtn.click({ force: true, timeout: 2000 }).catch(() => {});
        await input.focus();
        await page.keyboard.press('Enter');
      }
    };

    let currentTurnCount = await page.locator(this.selectors.MODEL_TURN).count();
    console.log(`[AI Studio] Worker #${id} model turn count before prompt: ${currentTurnCount}`);

    await submitPrompt();

    // 發送後立即執行一次置底雙軌捲動
    await page
      .evaluate((scrollSelector: string) => {
        const scrollTarget = document.querySelector(
          'ms-thought-chunk:last-of-type, .thought-container:last-of-type, mat-expansion-panel:last-of-type, ms-chat-turn:last-of-type'
        );
        if (scrollTarget) {
          scrollTarget.scrollIntoView({ block: 'end', behavior: 'auto' });
        }

        const scroller = document.querySelector(scrollSelector);
        if (scroller && scroller.scrollHeight > scroller.clientHeight) {
          scroller.scrollTop = scroller.scrollHeight;
        }
      }, this.selectors.SCROLL_CONTAINER)
      .catch(() => {});

    await page.waitForFunction(
      ({ turnSelector, prevCount }: WaitForTurnParams) => {
        const turns = document.querySelectorAll(turnSelector);
        return turns.length > prevCount;
      },
      {
        turnSelector: this.selectors.MODEL_TURN,
        prevCount: currentTurnCount,
      },
      { timeout: 30000 }
    );

    console.log(`[AI Studio] Worker #${id} new model turn detected.`);

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
    const maxModelErrorRetries = 3;
    let errorAttempt = 0;

    try {
      while (errorAttempt <= maxModelErrorRetries) {
        finalMainText = await page.evaluate(
          ({ turnSelector, scrollSelector, prevCount }: ObserveAiStudioParams) => {
            return new Promise<string>((resolve) => {
              const customWindow = window as unknown as WindowWithCustomEvents;

              // 雙軌滾動：原生 scrollIntoView 沿祖先鏈置底 + 滾動容器設置 scrollTop
              function scrollToBottom(): void {
                const scrollTarget = document.querySelector(
                  'ms-thought-chunk:last-of-type, .thought-container:last-of-type, mat-expansion-panel:last-of-type, ms-chat-turn:last-of-type .turn-content, ms-chat-turn:last-of-type, .chat-turn-container.model:last-of-type'
                );

                if (scrollTarget) {
                  scrollTarget.scrollIntoView({ block: 'end', behavior: 'auto' });
                }

                const scroller = document.querySelector(scrollSelector);
                if (scroller && scroller.scrollHeight > scroller.clientHeight) {
                  scroller.scrollTop = scroller.scrollHeight;
                }

                if (
                  document.scrollingElement &&
                  document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight
                ) {
                  document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
                }
              }

              scrollToBottom();
              const scrollInterval = window.setInterval(scrollToBottom, 2000);

              function getModelTurns(): HTMLElement[] {
                return Array.from(document.querySelectorAll(turnSelector)) as HTMLElement[];
              }

              function getLatestTurn(): HTMLElement | null {
                const turns = getModelTurns();
                if (turns.length === 0) return null;
                return turns[turns.length - 1];
              }

              function isAiStudioRunning(): boolean {
                const runButtonEl = document.querySelector('ms-run-button');
                if (!runButtonEl) return false;

                if (
                  runButtonEl.querySelector(
                    '.stop, .spin, mat-spinner, mat-progress-spinner, [aria-label*="Stop" i], [aria-label*="Cancel" i]'
                  )
                ) {
                  return true;
                }

                const btn = runButtonEl.querySelector('button');
                if (!btn) return false;

                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const txt = (btn.textContent || '').trim().toLowerCase();

                return (
                  aria.includes('stop') ||
                  aria.includes('cancel') ||
                  txt.includes('stop') ||
                  txt.includes('cancel') ||
                  (btn.disabled && !txt.includes('run'))
                );
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

              // 提取 .model-error 純文字
              function getModelErrorText(turnRoot: HTMLElement | null): string {
                if (!turnRoot) return '';
                const errorEl = turnRoot.querySelector('.model-error, [class*="model-error"]');
                if (!errorEl) return '';
                const clone = errorEl.cloneNode(true) as HTMLElement;
                clone.querySelectorAll('.material-symbols-outlined, mat-icon, button').forEach((el) => el.remove());
                return (clone.innerText || clone.textContent || '').trim();
              }

              // 提取思考文字：支援當前回合或前一回合獨立的 Thinking Turn
              function getThoughtText(): string {
                const turns = getModelTurns();
                if (turns.length === 0) return '';

                const candidateTurns: HTMLElement[] = [];
                for (let i = Math.max(0, prevCount); i < turns.length; i++) {
                  candidateTurns.push(turns[i]);
                }
                if (candidateTurns.length === 0) {
                  candidateTurns.push(turns[turns.length - 1]);
                }

                for (let i = candidateTurns.length - 1; i >= 0; i--) {
                  const tRoot = candidateTurns[i];
                  const thoughtChunks = tRoot.querySelectorAll(
                    'ms-thought-chunk, ms-thought-panel, ms-thought, .thought-container, .thought-chunk'
                  );

                  if (thoughtChunks.length > 0) {
                    const parts: string[] = [];
                    thoughtChunks.forEach((chunk) => {
                      const clone = chunk.cloneNode(true) as HTMLElement;
                      clone
                        .querySelectorAll('mat-expansion-panel-header, button, mat-icon, .actions, .turn-footer')
                        .forEach((el) => el.remove());
                      clone.querySelectorAll('h1, h2, h3, h4, p, span, div').forEach((el) => {
                        const t = el.textContent?.trim();
                        if (t === 'Thinking' || t === 'Thought' || t === 'Thoughts') el.remove();
                      });
                      const txt = (clone.innerText || clone.textContent || '').trim();
                      if (txt) parts.push(txt);
                    });
                    if (parts.length > 0) return parts.join('\n\n').trim();
                  }

                  const panels = tRoot.querySelectorAll('mat-expansion-panel');
                  const parts: string[] = [];
                  panels.forEach((panel) => {
                    const header = panel.querySelector('mat-expansion-panel-header');
                    if (header && /thought|thinking/i.test(header.textContent || '')) {
                      const clone = panel.cloneNode(true) as HTMLElement;
                      clone.querySelector('mat-expansion-panel-header')?.remove();
                      const txt = (clone.innerText || clone.textContent || '').trim();
                      if (txt) parts.push(txt);
                    }
                  });
                  if (parts.length > 0) return parts.join('\n\n').trim();
                }

                return '';
              }

              // 提取主回答文字：始終由最新回合提取，並徹底隔離思考標籤
              function getMainText(): string {
                const turns = getModelTurns();
                if (turns.length === 0) return '';
                const turnRoot = turns[turns.length - 1];

                const turnContent = turnRoot.querySelector('.turn-content') || turnRoot;

                const hasOnlyThinking =
                  turnRoot.querySelector('ms-thought-chunk, .thought-container') !== null &&
                  turnRoot.querySelector('.very-large-text-container, ms-text-chunk, ms-prompt-chunk.text-chunk, pre, textarea') === null;

                if (hasOnlyThinking) return '';

                const clone = turnContent.cloneNode(true) as HTMLElement;

                clone
                  .querySelectorAll(
                    'ms-thought-chunk, ms-thought-panel, ms-thought, mat-expansion-panel, .thought-container, .thought-chunk, .thought-wrapper, [class*="thought-"], [class*="thinking-"], ms-collapsible-container, ms-chat-turn-options, ms-grounding-sources, ms-search-entry-point, ms-hallucinations-disclaimer, mat-expansion-panel-header, .actions, .turn-footer, .author-label, button, mat-icon, .model-error'
                  )
                  .forEach((el) => el.remove());

                clone.querySelectorAll('h1, h2, h3, h4, p, span, div').forEach((el) => {
                  const t = el.textContent?.trim();
                  if (t === 'Thinking' || t === 'Thought' || t === 'Thoughts') el.remove();
                });

                let text = '';
                const textarea = clone.querySelector('textarea');
                if (textarea && textarea.value) {
                  text = textarea.value.trim();
                } else {
                  const pre = clone.querySelector('pre');
                  if (pre && pre.textContent) {
                    text = pre.textContent.trim();
                  } else {
                    text = (clone.innerText || clone.textContent || '').trim();
                  }
                }

                const thought = getThoughtText();
                if (thought && text.startsWith(thought)) {
                  text = text.slice(thought.length).trimStart();
                }

                return text;
              }

              let lastThoughtLen = 0;
              let lastMainLen = 0;
              let lastChangeTime = Date.now();
              let isDone = false;

              function emitDelta(): void {
                if (isDone) return;

                const currentThought = getThoughtText();
                if (currentThought.length > lastThoughtLen) {
                  const thoughtDelta = currentThought.slice(lastThoughtLen);
                  lastThoughtLen = currentThought.length;
                  lastChangeTime = Date.now();
                  customWindow.__pushChunk(
                    JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                  );
                }

                const currentMain = getMainText();
                if (currentMain.length > lastMainLen) {
                  const mainDelta = currentMain.slice(lastMainLen);
                  lastMainLen = currentMain.length;
                  lastChangeTime = Date.now();
                  customWindow.__pushChunk(
                    JSON.stringify({ type: 'content', delta: mainDelta })
                  );
                }
              }

              function finishWithError(): void {
                if (isDone) return;
                isDone = true;
                clearInterval(intervalTimer);
                clearInterval(scrollInterval);
                resolve('__AISTUDIO_MODEL_ERROR__');
              }

              async function finish(): Promise<void> {
                if (isDone) return;
                isDone = true;

                clearInterval(intervalTimer);
                clearInterval(scrollInterval);

                const finalThought = getThoughtText();
                if (finalThought.length > lastThoughtLen) {
                  const thoughtDelta = finalThought.slice(lastThoughtLen);
                  lastThoughtLen = finalThought.length;
                  await customWindow.__pushChunk(
                    JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                  );
                }

                const finalMain = getMainText();
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

              const intervalTimer = window.setInterval(async () => {
                if (isDone) return;

                const skipBtn = document.querySelector(
                  'ms-inline-preference-vote button[data-test-id="skip-button"], button[aria-label="Skip preference vote"]'
                ) as HTMLElement | null;
                if (skipBtn && skipBtn.offsetParent !== null && !skipBtn.hasAttribute('disabled')) {
                  skipBtn.click();
                }

                const turn = getLatestTurn();
                const running = isAiStudioRunning();

                // 錯誤檢查：預設作為回應返回，只有 internal error 和 Permission denied 才重試
                if (!running && turn) {
                  const errorMsg = getModelErrorText(turn);
                  if (errorMsg) {
                    const isRetryableError = /internal\s*error|permission\s*denied/i.test(errorMsg);

                    if (isRetryableError) {
                      finishWithError();
                      return;
                    }

                    // 預設行為：將錯誤文字作為正式回應返回給呼叫端
                    isDone = true;
                    clearInterval(intervalTimer);
                    clearInterval(scrollInterval);
                    await customWindow.__pushChunk(
                      JSON.stringify({ type: 'content', delta: errorMsg })
                    );
                    await customWindow.__pushDone();
                    resolve(errorMsg);
                    return;
                  }
                }

                emitDelta();

                const currentMain = getMainText();

                // 情況 1：已輸出完整 MCP 工具調用
                if (currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                  if (!running || Date.now() - lastChangeTime > 1200) {
                    void finish();
                    return;
                  }
                }

                // 情況 2：模型停止運行，且已產出實質正文（絕不在 lastMainLen === 0 的思考階段早退）
                if (!running && lastMainLen > 0 && Date.now() - lastChangeTime > 1500) {
                  void finish();
                  return;
                }

                // 情況 3：正文產出中的正常停頓防護
                if (lastMainLen > 0 && Date.now() - lastChangeTime > 15000) {
                  void finish();
                  return;
                }

                // 情況 4：兜底超時（45 秒無任何輸出）
                if (Date.now() - lastChangeTime > 45000) {
                  void finish();
                  return;
                }
              }, 150);

              emitDelta();
            });
          },
          {
            turnSelector: this.selectors.MODEL_TURN,
            scrollSelector: this.selectors.SCROLL_CONTAINER,
            prevCount: currentTurnCount,
          }
        );

        if (finalMainText === '__AISTUDIO_MODEL_ERROR__') {
          errorAttempt++;
          if (errorAttempt > maxModelErrorRetries) {
            console.error(`[AI Studio] Worker #${id} Model error persisted after ${maxModelErrorRetries} retries.`);
            const fallbackErrMsg = await page.evaluate((sel: string) => {
              const err = document.querySelector(sel) as HTMLElement | null;
              return err ? (err.innerText || err.textContent || '').replace(/^error\s*/i, '').trim() : '';
            }, this.selectors.MODEL_ERROR).catch(() => '');

            finalMainText = fallbackErrMsg || 'An internal error occurred while generating response in AI Studio.';
            break;
          }

          console.warn(
            `[AI Studio] Worker #${id} 遇到可恢復錯誤（internal error / Permission denied）。等待 2 秒後重新填入並發送最後的 Prompt (${errorAttempt}/${maxModelErrorRetries})...`
          );
          await page.waitForTimeout(2000);
          await this.dismissAllDialogs(page);

          currentTurnCount = await page.locator(this.selectors.MODEL_TURN).count();
          console.log(`[AI Studio] Worker #${id} 重發 Prompt 前 Model Turn 總數: ${currentTurnCount}`);

          await submitPrompt();

          await page.waitForFunction(
            ({ turnSelector, prevCount }: WaitForTurnParams) => {
              const turns = document.querySelectorAll(turnSelector);
              return turns.length > prevCount;
            },
            {
              turnSelector: this.selectors.MODEL_TURN,
              prevCount: currentTurnCount,
            },
            { timeout: 30000 }
          );

          console.log(`[AI Studio] Worker #${id} 重發後檢測到全新 Model Turn，重新進入觀察...`);
          rawFullMainText = '';
          continue;
        }

        break;
      }
    } finally {
      if (finalMainText !== '__AISTUDIO_MODEL_ERROR__' && finalMainText.length > rawFullMainText.length) {
        const gapRemainder = finalMainText.slice(rawFullMainText.length);
        onRawChunk(gapRemainder, false);
        rawFullMainText = finalMainText;
      }

      emitter.off('chunk', chunkListener);
    }

    await this.dismissAllDialogs(page);

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalMainText.trim() ? finalMainText : rawFullMainText;

    console.log(`[AI Studio] Worker #${id} generation completed. Total main chars: ${resolvedText.length}`);
    return { rawText: resolvedText, currentPath };
  }
}
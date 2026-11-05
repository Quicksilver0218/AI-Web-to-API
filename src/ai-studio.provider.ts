import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.js';

interface WaitForTurnParams {
  turnSelector: string;
  prevCount: number;
}

interface ObserveAiStudioParams {
  turnSelector: string;
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
    RERUN_BUTTON: 'button.rerun-button, button[name="rerun-button"], button[aria-label*="Rerun" i]',
    THINKING_SELECT: 'mat-select[aria-label="Thinking Level"]',
    THINKING_SELECT_VALUE: '.mat-mdc-select-min-line, .mat-mdc-select-value-text',
    THINKING_PANEL: '.mat-mdc-select-panel[aria-label="Thinking Level"], .mat-mdc-select-panel',
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
      if (!(await selectLocator.isVisible({ timeout: 2500 }).catch(() => false))) {
        console.log('[AI Studio] Thinking Level selector not found on page, skipping.');
        return;
      }

      const currentVal = (
        await selectLocator.locator(this.selectors.THINKING_SELECT_VALUE).innerText().catch(() => '')
      ).trim();

      if (currentVal.toLowerCase() === targetLevel.toLowerCase()) {
        console.log(`[AI Studio] Thinking Level already set to "${currentVal}".`);
        return;
      }

      console.log(`[AI Studio] Changing Thinking Level from "${currentVal}" to "${targetLevel}"...`);
      await selectLocator.scrollIntoViewIfNeeded().catch(() => {});
      await selectLocator.click({ timeout: 2000 });

      const optionLocator = page
        .locator(`${this.selectors.THINKING_PANEL} mat-option`)
        .filter({ hasText: new RegExp(`^\\s*${targetLevel}\\s*$`, 'i') })
        .first();

      if (await optionLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
        await optionLocator.click({ timeout: 2000 });
        console.log(`[AI Studio] Successfully applied Thinking Level: "${targetLevel}"`);
      } else {
        console.warn(`[AI Studio] Option "${targetLevel}" not visible in dropdown panel.`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch (err) {
      console.warn('[AI Studio] setThinkingLevel error:', err);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  public async dismissWelcomeDialogIfPresent(page: Page): Promise<void> {
    const welcomeBtn = page.locator(this.selectors.WELCOME_DIALOG_BUTTON).first();
    try {
      if (await welcomeBtn.isVisible({ timeout: 1500 })) {
        console.log('[AI Studio] Detected welcome dialog, clicking "Continue"...');
        await welcomeBtn.click();
        await welcomeBtn.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissTemporaryChatDialogIfPresent(page: Page): Promise<void> {
    const tempChatBtn = page.locator(this.selectors.TEMPORARY_CHAT_BUTTON).first();
    try {
      if (await tempChatBtn.isVisible({ timeout: 1500 })) {
        console.log('[AI Studio] Detected Google Drive dialog, clicking "Cancel and use Temporary chat"...');
        await tempChatBtn.click();
        await tempChatBtn.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissCopyrightDialogIfPresent(page: Page): Promise<void> {
    const ackBtn = page.locator(this.selectors.COPYRIGHT_ACK_BUTTON).first();
    try {
      if (await ackBtn.isVisible({ timeout: 1500 })) {
        console.log('[AI Studio] Detected copyright dialog, clicking "Acknowledge"...');
        await ackBtn.click();
        await ackBtn.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }

  public async dismissPreferenceVoteIfPresent(page: Page): Promise<void> {
    const skipBtn = page.locator(this.selectors.PREFERENCE_SKIP_BUTTON).first();
    try {
      if (await skipBtn.isVisible({ timeout: 1500 })) {
        console.log('[AI Studio] Detected preference vote dialog, clicking "Skip"...');
        await skipBtn.click();
        await skipBtn.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
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
      const count = await moreActionsLocator.count();
      if (count === 0) {
        console.log('[AI Studio] "View more actions" button not found.');
        return;
      }

      const moreActionsBtn = moreActionsLocator.last();
      await moreActionsBtn.waitFor({ state: 'visible', timeout: 3000 });
      await moreActionsBtn.scrollIntoViewIfNeeded().catch(() => {});
      await moreActionsBtn.click({ timeout: 2000 });
      console.log('[AI Studio] Opened "View more actions" menu to check Raw Mode status...');

      const rawModeBtn = page.locator(this.selectors.RAW_MODE_BUTTON).first();
      await rawModeBtn.waitFor({ state: 'visible', timeout: 3000 });

      const checkmarkInBtn = rawModeBtn.locator(this.selectors.RAW_MODE_CHECKMARK);
      const globalCheckmark = page.locator(this.selectors.RAW_MODE_CHECKMARK);

      const hasCheckmark =
        (await checkmarkInBtn.count()) > 0 ||
        (await globalCheckmark.count()) > 0;

      if (!hasCheckmark) {
        console.log('[AI Studio] Checkmark [data-test-raw-mode-checkmark] not found. Clicking to enable Raw Mode...');
        await rawModeBtn.click({ timeout: 2000 });
        console.log('[AI Studio] Raw Mode enabled.');
      } else {
        console.log('[AI Studio] Checkmark [data-test-raw-mode-checkmark] detected. Raw Mode already enabled.');
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
        console.log(`[AI Studio] Prior conversation detected (turns: ${existingTurns}, sessionActive: ${hasChattedInSession}). Resetting page for new session...`);
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
        this.hasChattedPages.delete(page);
      } else {
        console.log('[AI Studio] Page is clean and unprompted. Skipping initial page reload.');
      }
    }

    await this.dismissAllDialogs(page);
    await this.ensureRawModeEnabled(page);
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: { thinkingLevel?: string }
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    await this.dismissAllDialogs(page);
    await this.ensureRawModeEnabled(page);

    // 套用 thinking header 對應之 Thinking Level
    const targetLevel = this.mapThinkingLevel(options?.thinkingLevel);
    if (targetLevel) {
      console.log(`[AI Studio] Worker #${id} applying Thinking Level: ${targetLevel} (from: "${options?.thinkingLevel}")`);
      await this.setThinkingLevel(page, targetLevel);
    }

    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 20000 });

    const modelTurns = page.locator(this.selectors.MODEL_TURN);
    const prevCount = await modelTurns.count();
    console.log(`[AI Studio] Worker #${id} model turn count before prompt: ${prevCount}`);

    await input.click();
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
      await input.focus();
      await page.keyboard.press('Enter');
      await runBtn.click({ force: true, timeout: 2000 }).catch(() => {});
    }

    await page.waitForFunction(
      ({ turnSelector, prevCount }: WaitForTurnParams) => {
        const turns = document.querySelectorAll(turnSelector);
        return turns.length > prevCount;
      },
      {
        turnSelector: this.selectors.MODEL_TURN,
        prevCount,
      }
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
      // 具備錯誤偵測與自動點擊 Rerun 重試的觀察循環
      while (errorAttempt <= maxModelErrorRetries) {
        finalMainText = await page.evaluate(
          ({ turnSelector }: ObserveAiStudioParams) => {
            return new Promise<string>((resolve) => {
              const customWindow = window as unknown as WindowWithCustomEvents;

              function getLatestTurn(): HTMLElement | null {
                const turns = document.querySelectorAll(turnSelector);
                if (turns.length === 0) return null;
                return turns[turns.length - 1] as HTMLElement;
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

              function getThoughtText(turnRoot: HTMLElement | null): string {
                if (!turnRoot) return '';
                const thoughtChunks = turnRoot.querySelectorAll(
                  'ms-thought-chunk, ms-thought-panel, ms-thought, .thought-container, .thought-chunk'
                );

                if (thoughtChunks.length > 0) {
                  const parts: string[] = [];
                  thoughtChunks.forEach((chunk) => {
                    const clone = chunk.cloneNode(true) as HTMLElement;
                    clone.querySelectorAll('mat-expansion-panel-header, button, mat-icon, .actions, .turn-footer').forEach((el) => el.remove());
                    clone.querySelectorAll('h1, h2, h3, h4, p, span, div').forEach((el) => {
                      const t = el.textContent?.trim();
                      if (t === 'Thinking' || t === 'Thought' || t === 'Thoughts') el.remove();
                    });
                    const txt = (clone.innerText || clone.textContent || '').trim();
                    if (txt) parts.push(txt);
                  });
                  return parts.join('\n\n').trim();
                }

                const panels = turnRoot.querySelectorAll('mat-expansion-panel');
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
                return parts.join('\n\n').trim();
              }

              function getMainText(turnRoot: HTMLElement | null): string {
                if (!turnRoot) return '';

                const textNode = turnRoot.querySelector('ms-prompt-chunk.text-chunk, ms-text-chunk, ms-prompt-chunk:not(:has(ms-thought-chunk)):not(ms-thought-chunk)');
                
                let targetElement: HTMLElement | null = textNode as HTMLElement | null;
                
                if (!targetElement) {
                  const isThinkingOnly = turnRoot.querySelector('ms-thought-chunk, .thought-container') !== null;
                  if (isThinkingOnly) return '';
                  targetElement = turnRoot;
                }

                const clone = targetElement.cloneNode(true) as HTMLElement;

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

                const thought = getThoughtText(turnRoot);
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
                const turn = getLatestTurn();
                if (!turn) return;

                const currentThought = getThoughtText(turn);
                if (currentThought.length > lastThoughtLen) {
                  const thoughtDelta = currentThought.slice(lastThoughtLen);
                  lastThoughtLen = currentThought.length;
                  lastChangeTime = Date.now();
                  customWindow.__pushChunk(
                    JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                  );
                }

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

              function finishWithError(): void {
                if (isDone) return;
                isDone = true;
                observer.disconnect();
                clearInterval(intervalTimer);
                resolve('__AISTUDIO_MODEL_ERROR__');
              }

              async function finish(): Promise<void> {
                if (isDone) return;
                isDone = true;

                observer.disconnect();
                clearInterval(intervalTimer);

                const turn = getLatestTurn();
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
                const skipBtn = document.querySelector(
                  'ms-inline-preference-vote button[data-test-id="skip-button"], button[aria-label="Skip preference vote"]'
                ) as HTMLElement | null;
                if (skipBtn && skipBtn.offsetParent !== null && !skipBtn.hasAttribute('disabled')) {
                  skipBtn.click();
                }

                // 遇到 Permission denied 等 .model-error 時立即中斷轉由上層重試
                const turn = getLatestTurn();
                if (turn && turn.querySelector('.model-error') && !isAiStudioRunning()) {
                  finishWithError();
                  return;
                }

                emitDelta();
              });

              observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
              });

              const intervalTimer = window.setInterval(() => {
                if (isDone) return;
                emitDelta();

                const turn = getLatestTurn();
                const currentMain = turn ? getMainText(turn) : '';
                const running = isAiStudioRunning();

                // 輪詢檢測 .model-error
                if (!running && turn && turn.querySelector('.model-error')) {
                  finishWithError();
                  return;
                }

                if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                  void finish();
                  return;
                }

                const vote = document.querySelector('ms-inline-preference-vote .inline-preference-options');
                if (vote) {
                  void finish();
                  return;
                }

                const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

                if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1200) {
                  void finish();
                  return;
                }

                if (hasGeneratedAny && Date.now() - lastChangeTime > 12000) {
                  void finish();
                  return;
                }
              }, 250);

              emitDelta();
            });
          },
          {
            turnSelector: this.selectors.MODEL_TURN,
          }
        );

        if (finalMainText === '__AISTUDIO_MODEL_ERROR__') {
          errorAttempt++;
          if (errorAttempt > maxModelErrorRetries) {
            console.error(`[AI Studio] Worker #${id} Model error persisted after ${maxModelErrorRetries} retries.`);
            break;
          }

          console.warn(
            `[AI Studio] Worker #${id} 遇到錯誤「Permission denied / Model error」。等待 2 秒後重試 (${errorAttempt}/${maxModelErrorRetries})...`
          );
          await page.waitForTimeout(2000);

          // 優先點擊該回合專屬的 rerun-button (Rerun this turn)
          const rerunBtn = page
            .locator(this.selectors.MODEL_TURN)
            .last()
            .locator(this.selectors.RERUN_BUTTON)
            .first();

          let retryTriggered = false;
          if (await rerunBtn.isVisible({ timeout: 2000 }).catch(() => false) || (await rerunBtn.count()) > 0) {
            console.log(`[AI Studio] Worker #${id} 點擊 rerun-button (Rerun this turn)...`);
            await rerunBtn.scrollIntoViewIfNeeded().catch(() => {});
            await rerunBtn.click({ force: true, timeout: 2000 }).catch(() => {});
            retryTriggered = true;
          }

          if (!retryTriggered) {
            // 兜底：嘗試點擊主 Run 按鈕
            const mainRunBtn = page.locator(this.selectors.RUN_BUTTON).first();
            if (await mainRunBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              console.log(`[AI Studio] Worker #${id} 點擊主 Run 按鈕重試...`);
              await mainRunBtn.click({ timeout: 2000 }).catch(() => {});
              retryTriggered = true;
            }
          }

          // 重置累積文字，等待模型開始重新生成
          rawFullMainText = '';
          await page.waitForTimeout(1000);
          continue;
        }

        // 成功取得正常回應，跳出循環
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
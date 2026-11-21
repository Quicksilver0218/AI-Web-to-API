import type { Page } from 'playwright';
import { WebAiProvider, type SendPromptOptions } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.js';

interface WaitForTurnParams {
  turnSelector: string;
  prevSnapshot: number;
  upgradeDialogSelector: string;
}

interface ObserveStreamParams {
  turnSelector: string;
  scrollSelector: string;
  stopSelector: string;
  upgradeDialogSelector: string;
  upgradeErrorMessage: string;
  isModelRunningCode: string;
  prevSnapshot: number;
}

interface ObserveResult {
  status: 'done' | 'retryable_error' | 'fatal_error' | 'upgrade_required' | 'timeout';
  text: string;
}


/**
 * 統一的運行狀態判斷函式（瀏覽器環境執行）
 */
function isModelRunning(stopSelector: string): boolean {
  const btn = document.querySelector(stopSelector) as HTMLElement | null;
  if (!btn || btn.offsetParent === null) return false;
  const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
  return text.includes('stop');
}

async function dismissDialogs(page: Page): Promise<void> {
  const dialogSelectors = [
    '#g1-welcome-dialog button[aria-label="Close dialog"], ms-g1-welcome-dialog button.ms-button-primary, #g1-welcome-dialog button:has-text("Continue")',
    'ms-auth-request-dialog button[aria-label="Cancel"], ms-auth-request-dialog button:has-text("Cancel and use Temporary chat")',
    '#copyright-acknowledgement-dialog button[aria-label="Agree to the copyright acknowledgement"], ms-copyright-acknowledgement-dialog button.ms-button-primary, #copyright-acknowledgement-dialog button:has-text("Acknowledge")',
    'ms-inline-preference-vote button[data-test-id="skip-button"], button[aria-label="Skip preference vote"]',
  ];

  for (const selector of dialogSelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await btn.click({ timeout: 5000 }).catch(() => { });
      }
    } catch {
      // 忽略單一彈窗檢查例外
    }
  }
}

export class AiStudioProvider extends WebAiProvider {
  readonly name = 'Google AI Studio';
  readonly baseUrl = 'https://aistudio.google.com/prompts/new_chat';

  private readonly selectors = {
    PROMPT_INPUT:
      'ms-prompt-input-wrapper textarea, ms-autosize-textarea textarea, textarea[aria-label*="Type something"], textarea',
    SEND_OR_STOP_BUTTON:
      'ms-run-button button:not([disabled])[mattooltipclass="run-button-tooltip"].ms-button-primary',
    ADD_CHUNK_BUTTON:
      'ms-add-chunk-menu button, button[aria-label*="Insert"], button[aria-label*="Add"]',
    UPLOAD_FILE_MENU_ITEM:
      'button[role="menuitem"]:has-text("Upload"), button[role="menuitem"]:has-text("File"), button[aria-label*="Upload"]',
    VIEW_MORE_ACTIONS_BUTTON:
      '[aria-label="View more actions"], button[aria-label*="more actions" i]',
    RAW_MODE_BUTTON:
      '[data-test-raw-mode], [data-test-id="raw-mode"], button[data-test-raw-mode], [role="menuitem"]:has-text("Raw")',
    RAW_MODE_CHECKMARK: '[data-test-raw-mode-checkmark]',
    FILE_INPUT: 'input[type="file"]',
    CHAT_TURN: 'ms-chat-turn',
    TURN_ITEM: 'ms-chat-turn .chat-turn-container.model, ms-chat-turn[data-turn-role="Model"]',
    MODEL_ERROR: '.model-error, [class*="model-error"]',
    THINKING_SELECT: 'mat-select[aria-label="Thinking Level"]',
    THINKING_SELECT_VALUE: '.mat-mdc-select-min-line',
    THINKING_PANEL: '.mat-mdc-select-panel[aria-label="Thinking Level"], .mat-mdc-select-panel',
    MODEL_SELECTOR_BUTTON: 'button.model-selector-card.ng-star-inserted',
    MODEL_SELECTOR_NAME: '[data-test-id=model-name]',
    MODEL_PANEL_CLOSE_BUTTON: 'button[aria-label="Close panel"]',
    OUTPUT_LENGTH_INPUT: 'input[name=maxOutputTokens], input[aria-describedby=output-length-hint]',
    SCROLL_CONTAINER: 'ms-autoscroll-container',
    UPGRADE_DIALOG:
      'ms-upgrade-options-dialog, ms-upgrade-options[presentation="dialog"], .upgrade-modal-container',
    UPGRADE_DIALOG_CLOSE_BUTTON:
      'ms-upgrade-options-dialog button[aria-label="close"], ms-upgrade-options-dialog button.close-button, .upgrade-modal-container button[aria-label="close"], .upgrade-modal-container button.close-button',
  } as const;

  private readonly upgradeDialogErrorMessage =
    '[Error]: Paid upgrade dialog ("Go further with AI Studio") detected and closed. Please upgrade your plan, switch to an available model, or configure API billing.';

  private async dismissUpgradeDialog(page: Page): Promise<boolean> {
    try {
      const dialog = page.locator(this.selectors.UPGRADE_DIALOG).first();
      const isDialogVisible = await dialog.isVisible().catch(() => false);
      if (!isDialogVisible) return false;

      console.warn(`[${this.name}] Paid upgrade dialog detected. Clicking close button...`);
      const closeBtn = dialog.locator('button[aria-label="close"], button.close-button').first();
      await closeBtn.click({ timeout: 5000 });

      return true;
    } catch {
      return false;
    }
  }

  protected override async executeStop(worker: PageWorker): Promise<void> {
    await this.stopTemplate(worker, {
      isRunningFn: isModelRunning,
      isRunningArg: this.selectors.SEND_OR_STOP_BUTTON,
      stopButtonSelector: this.selectors.SEND_OR_STOP_BUTTON,
    });
  }

  protected override async setModel(page: Page, model?: string): Promise<void> {
    const targetModel = model?.trim().toLowerCase();
    if (!targetModel) return;

    try {
      const selectorBtn = page.locator(this.selectors.MODEL_SELECTOR_BUTTON).first();
      const isBtnVisible = await selectorBtn
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (!isBtnVisible) {
        console.warn(`[${this.name}] Model selector button not found or not visible.`);
        return;
      }

      const currentModelName = (
        (await selectorBtn
          .locator(this.selectors.MODEL_SELECTOR_NAME)
          .first()
          .textContent({ timeout: 5000 })
          .catch(() => '')) ?? ''
      )
        .trim()
        .toLowerCase();

      if (currentModelName && currentModelName.endsWith(targetModel)) {
        return;
      }

      await selectorBtn.scrollIntoViewIfNeeded().catch(() => { });
      await selectorBtn.click({ timeout: 5000 });

      const closeBtn = page.locator(this.selectors.MODEL_PANEL_CLOSE_BUTTON).first();
      await closeBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });

      const optionSelector = `button[id$=${JSON.stringify(targetModel)}]`;
      const optionLocator = page.locator(optionSelector).first();
      const isOptionVisible = await optionLocator
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (isOptionVisible && !(await optionLocator.isDisabled().catch(() => false))) {
        console.log(`[${this.name}] Selecting model: "${targetModel}"...`);
        await optionLocator.scrollIntoViewIfNeeded().catch(() => { });
        await optionLocator.click({ timeout: 5000 });
        await closeBtn.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => { });
        console.log(`[${this.name}] Successfully applied model: "${targetModel}"`);
      } else {
        if (!isOptionVisible) {
          console.warn(`[${this.name}] Model "${targetModel}" not found (selector: ${optionSelector}). Closing panel...`);
        }
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click({ timeout: 5000 }).catch(() => { });
          await closeBtn.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => { });
        } else {
          await page.keyboard.press('Escape').catch(() => { });
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] setModel error:`, err);
      const closeBtn = page.locator(this.selectors.MODEL_PANEL_CLOSE_BUTTON).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ timeout: 5000 }).catch(() => { });
      } else {
        await page.keyboard.press('Escape').catch(() => { });
      }
    }
  }

  protected override async setThinkingLevel(page: Page, level?: string): Promise<void> {
    if (!level) return;
    let targetLevel: 'low' | 'medium' | 'high';
    const normalized = level.trim().toLowerCase().replace(/[-_]/g, '');
    if (['none', 'low'].includes(normalized))
      targetLevel = 'low';
    else if (['medium'].includes(normalized))
      targetLevel = 'medium';
    else if (['high', 'xhigh', 'extrahigh'].includes(normalized))
      targetLevel = 'high';
    else
      return;

    try {
      const selectLocator = page.locator(this.selectors.THINKING_SELECT).first();
      if (!(await selectLocator.isVisible({ timeout: 5000 }).catch(() => false)))
        return;

      const currentVal = (
        await selectLocator.locator(this.selectors.THINKING_SELECT_VALUE).textContent() ?? ''
      ).trim();

      if (currentVal.toLowerCase() === targetLevel)
        return;

      console.log(`[${this.name}] Changing Thinking Level from "${currentVal}" to "${targetLevel}"...`);
      await selectLocator.scrollIntoViewIfNeeded().catch(() => { });
      await selectLocator.click({ timeout: 5000 });

      const optionLocator = page
        .locator(`${this.selectors.THINKING_PANEL} mat-option`)
        .filter({ hasText: new RegExp(`^\\s*${targetLevel}\\s*$`, 'i') })
        .first();

      if (await optionLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
        await optionLocator.click({ timeout: 5000 });
        console.log(`[${this.name}] Successfully applied Thinking Level: "${targetLevel}"`);
      } else {
        await page.keyboard.press('Escape').catch(() => { });
      }

      await page.waitForSelector('.cdk-overlay-pane:has(mat-option)', { state: 'detached', timeout: 5000 }).catch(async () => {
        await page.keyboard.press('Escape').catch(() => { });
      });
    } catch (err) {
      console.warn(`[${this.name}] setThinkingLevel error:`, err);
      await page.keyboard.press('Escape').catch(() => { });
    }
  }

  protected async ensureOutputLength(page: Page): Promise<void> {
    const targetOutputLength = '1048576';
    try {
      const outputLengthInput = page.locator(this.selectors.OUTPUT_LENGTH_INPUT).first();
      const isOutputLengthVisible = await outputLengthInput
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (!isOutputLengthVisible) {
        console.warn('[' + this.name + '] Output Length input not found or not visible.');
        return;
      }

      const currentVal = (await outputLengthInput.inputValue().catch(() => '')).trim();
      if (currentVal === targetOutputLength) {
        return;
      }

      console.log('[' + this.name + '] Changing Output Length from ' + currentVal + ' to ' + targetOutputLength + '...');
      await outputLengthInput.scrollIntoViewIfNeeded().catch(() => { });
      await outputLengthInput.click({ timeout: 5000 });
      await outputLengthInput.fill('');
      await outputLengthInput.fill(targetOutputLength);
      await outputLengthInput.dispatchEvent('input');
      await outputLengthInput.dispatchEvent('change');
      await outputLengthInput.blur().catch(() => { });
      console.log('[' + this.name + '] Successfully applied Output Length: ' + targetOutputLength);
    } catch (err) {
      console.warn('[' + this.name + '] ensureOutputLength notice:', err);
    }
  }

  protected async ensureRawModeEnabled(page: Page): Promise<void> {
    await this.ensureOutputLength(page);
    try {
      const moreActionsLocator = page.locator(this.selectors.VIEW_MORE_ACTIONS_BUTTON);
      if ((await moreActionsLocator.count()) === 0) return;

      const moreActionsBtn = moreActionsLocator.last();
      await moreActionsBtn.click({ timeout: 5000 });

      const rawModeBtn = page.locator(this.selectors.RAW_MODE_BUTTON).first();
      await rawModeBtn.waitFor({ state: 'visible', timeout: 5000 });

      const checkmarkInBtn = rawModeBtn.locator(this.selectors.RAW_MODE_CHECKMARK);
      const globalCheckmark = page.locator(this.selectors.RAW_MODE_CHECKMARK);

      const hasCheckmark =
        (await checkmarkInBtn.count()) > 0 ||
        (await globalCheckmark.count()) > 0;

      if (!hasCheckmark) {
        console.log(`[${this.name}] Checkmark not found. Enabling Raw Mode...`);
        await rawModeBtn.click({ timeout: 5000 });
      } else {
        await page.keyboard.press('Escape').catch(() => { });
      }
    } catch (err) {
      console.warn(`[${this.name}] ensureRawModeEnabled notice:`, err);
      await page.keyboard.press('Escape').catch(() => { });
    }
  }

  override async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[${this.name}] Uploading attachment file: ${filePath}`);
    await dismissDialogs(page);

    const directFileInput = page.locator(this.selectors.FILE_INPUT).first();
    if ((await directFileInput.count()) > 0) {
      await directFileInput.setInputFiles(filePath);
    } else {
      const addBtn = page.locator(this.selectors.ADD_CHUNK_BUTTON).first();
      await addBtn.waitFor({ state: 'visible', timeout: 15000 });
      await addBtn.click();

      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 25000 });
      const uploadItem = page.locator(this.selectors.UPLOAD_FILE_MENU_ITEM).first();
      if (await uploadItem.isVisible({ timeout: 5000 }).catch(() => false)) {
        await uploadItem.click();
      } else {
        await page.keyboard.press('Enter');
      }

      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(filePath);
    }

    console.log(`[${this.name}] Attachment uploaded and mounted.`);
  }

  override async navigateConversation(
    page: Page,
    isNewConversation: boolean
  ): Promise<void> {
    if (isNewConversation) {
      const existingTurns = await page.locator(this.selectors.CHAT_TURN).count().catch(() => 0);
      const hasInputText = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLTextAreaElement | null;
        return el ? el.value.trim().length > 0 : false;
      }, this.selectors.PROMPT_INPUT).catch(() => false);
      const hasUploadedFiles = await page.locator('ms-prompt-chunk, ms-file-chunk').count().catch(() => 0);

      const isDirty = this.dirtyPages.has(page) || existingTurns > 0 || hasInputText || hasUploadedFiles > 0;

      if (isDirty) {
        console.log(`[${this.name}] Page is dirty or starting new session. Force reloading to baseUrl...`);
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
        this.dirtyPages.delete(page);
      }
      await dismissDialogs(page);
      await this.ensureRawModeEnabled(page);
    } else {
      console.log(`[${this.name}] Continuing in existing conversation tab (no reload).`);
      await dismissDialogs(page);
    }
  }

  private async getTurnSnapshot(page: Page): Promise<number> {
    return await page.locator(this.selectors.TURN_ITEM).count();
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 20000 });

    await input.click();

    await input.evaluate((el: HTMLTextAreaElement) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => { });
    await input.fill('');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => { });
    await page.keyboard.press('Backspace').catch(() => { });

    await input.fill(prompt);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');

    await dismissDialogs(page);

    const sendBtn = page.locator(this.selectors.SEND_OR_STOP_BUTTON).first();
    let sent = false;

    try {
      await sendBtn.click({ timeout: 5000 });
      sent = true;
    } catch {
      // Fallback
    }

    if (!sent) {
      await input.focus();
      await page.keyboard.press('Control+Enter');
    }

    await page.waitForTimeout(600);
    const remainingVal = await input.inputValue().catch(() => '');
    if (remainingVal.trim().length > 0) {
      console.log(`[${this.name}] Prompt remaining in input box, executing forced submit...`);
      await sendBtn.click({ force: true, timeout: 5000 }).catch(() => { });
      await input.focus();
      await page.keyboard.press('Control+Enter');
    }
  }

  private async waitForTurnOrUpgradeDialog(
    page: Page,
    prevSnapshot: number
  ): Promise<'turn' | 'upgrade_dialog'> {
    const handle = await page.waitForFunction(
      ({ turnSelector, prevSnapshot, upgradeDialogSelector }: WaitForTurnParams) => {
        const upgradeEl = document.querySelector(upgradeDialogSelector) as HTMLElement | null;
        if (upgradeEl) {
          const rect = upgradeEl.getBoundingClientRect();
          if (upgradeEl.offsetParent !== null || (rect.width > 0 && rect.height > 0)) {
            return 'upgrade_dialog';
          }
        }

        const dialogActionSelectors = [
          '#g1-welcome-dialog button',
          'ms-g1-welcome-dialog button',
          'ms-auth-request-dialog button',
          '#copyright-acknowledgement-dialog button',
          'ms-copyright-acknowledgement-dialog button',
          'ms-inline-preference-vote button[data-test-id="skip-button"]',
          'button[aria-label="Skip preference vote"]',
        ];
        for (const sel of dialogActionSelectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            el.click();
          }
        }

        if (document.querySelectorAll(turnSelector).length > prevSnapshot) {
          return 'turn';
        }
        return false;
      },
      {
        turnSelector: this.selectors.TURN_ITEM,
        prevSnapshot,
        upgradeDialogSelector: this.selectors.UPGRADE_DIALOG,
      },
      { timeout: 30000 }
    );

    const outcome = await handle.jsonValue().catch(() => 'turn' as const);
    await handle.dispose().catch(() => { });
    return outcome === 'upgrade_dialog' ? 'upgrade_dialog' : 'turn';
  }

  override async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: SendPromptOptions
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    let isWatchingDialogs = true;
    let dialogWatcherPromise: Promise<void> | null = null;

    try {
      await dismissDialogs(page);
      const result = await super.sendPromptAndObserve(worker, prompt, onRawChunk, options);
      if (result)
        return result;

      let turnSnapshot = await this.getTurnSnapshot(page);
      console.log(`[${this.name}] Worker #${id} turn snapshot before prompt: ${turnSnapshot}`);

      await this.submitPrompt(page, prompt);

      if (await this.dismissUpgradeDialog(page)) {
        this.dirtyPages.add(page);
        return {
          rawText: this.upgradeDialogErrorMessage,
          currentPath: this.getCurrentPath(page),
        };
      }

      dialogWatcherPromise = (async () => {
        while (isWatchingDialogs) {
          try {
            await dismissDialogs(page);
          } catch {
            // 忽略輪詢異常
          }
          await page.waitForTimeout(300).catch(() => { });
        }
      })();

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
        .catch(() => { });

      const waitOutcome = await this.waitForTurnOrUpgradeDialog(page, turnSnapshot);
      if (waitOutcome === 'upgrade_dialog' || (await this.dismissUpgradeDialog(page))) {
        this.dirtyPages.add(page);
        return {
          rawText: this.upgradeDialogErrorMessage,
          currentPath: this.getCurrentPath(page),
        };
      }

      console.log(`[${this.name}] Worker #${id} new model turn detected.`);

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
      const maxRetries = 20;

      try {
        let attempt;
        for (attempt = 1; attempt <= maxRetries; attempt++) {
          if (options?.abortSignal?.aborted) {
            await this.stop(worker);
            finalMainText = '[Generation Aborted by Client]';
            break;
          }

          await this.ensureBrowserHelpers(page);

          const evalPromise = page.evaluate(
            ({
              turnSelector,
              scrollSelector,
              stopSelector,
              upgradeDialogSelector,
              upgradeErrorMessage,
              isModelRunningCode,
              prevSnapshot,
            }: ObserveStreamParams) => {
              return new Promise<ObserveResult>(async (resolve) => {
                const customWindow = window as unknown as WindowWithCustomEvents;
                const { rehydrate, hasCompleteToolCall } = (window as any).__webAiHelpers;
                const checkRunning = rehydrate(isModelRunningCode);
                const isModelRunning = (): boolean => checkRunning(stopSelector);

                function dismissDialogsInDom(): void {
                  const inlineSelectors = [
                    '#g1-welcome-dialog button[aria-label="Close dialog"]',
                    'ms-g1-welcome-dialog button.ms-button-primary',
                    'ms-auth-request-dialog button[aria-label="Cancel"]',
                    '#copyright-acknowledgement-dialog button[aria-label="Agree to the copyright acknowledgement"]',
                    'ms-copyright-acknowledgement-dialog button.ms-button-primary',
                    'ms-inline-preference-vote button[data-test-id="skip-button"]',
                    'button[aria-label="Skip preference vote"]',
                  ];
                  for (const sel of inlineSelectors) {
                    const el = document.querySelector(sel) as HTMLElement | null;
                    if (el && el.offsetParent !== null) {
                      el.click();
                    }
                  }
                  const textButtons = document.querySelectorAll(
                    '#g1-welcome-dialog button, ms-auth-request-dialog button, #copyright-acknowledgement-dialog button'
                  );
                  for (const btn of Array.from(textButtons)) {
                    const txt = (btn.textContent || '').trim().toLowerCase();
                    if (txt.includes('continue') || txt.includes('cancel and use temporary chat') || txt.includes('acknowledge')) {
                      (btn as HTMLElement).click();
                    }
                  }
                }

                function scrollToBottom(): void {
                  const scrollTarget = document.querySelector(
                    'ms-thought-chunk:last-of-type, .thought-container:last-of-type, mat-expansion-panel:last-of-type, ms-chat-turn:last-of-type .turn-content, ms-chat-turn:last-of-type, .chat-turn-container.model:last-of-type'
                  ) as HTMLElement | null;

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

                function clickStopButton(): boolean {
                  const btn = document.querySelector(stopSelector) as HTMLElement | null;
                  if (btn && btn.offsetParent !== null && isModelRunning()) {
                    btn.click();
                    return true;
                  }
                  return false;
                }

                function getModelErrorText(turnRoot: HTMLElement | null): string {
                  if (!turnRoot) return '';
                  const errorEl = turnRoot.querySelector('.model-error, [class*="model-error"]');
                  if (!errorEl) return '';
                  const clone = errorEl.cloneNode(true) as HTMLElement;
                  clone.querySelectorAll('.material-symbols-outlined, mat-icon, button').forEach((el) => el.remove());
                  return (clone.innerText || clone.textContent || '').trim();
                }

                function getThoughtText(): string {
                  const turns = getModelTurns();
                  if (turns.length === 0) return '';

                  const candidateTurns: HTMLElement[] = [];
                  for (let i = Math.max(0, prevSnapshot); i < turns.length; i++) {
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

                async function emitDelta() {
                  if (isDone) return;

                  const currentThought = getThoughtText();
                  if (currentThought.length > lastThoughtLen) {
                    const thoughtDelta = currentThought.slice(lastThoughtLen);
                    lastThoughtLen = currentThought.length;
                    lastChangeTime = Date.now();
                    await customWindow.__pushChunk(
                      JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                    );
                  }

                  const currentMain = getMainText();
                  if (currentMain.length > lastMainLen) {
                    const mainDelta = currentMain.slice(lastMainLen);
                    lastMainLen = currentMain.length;
                    lastChangeTime = Date.now();
                    await customWindow.__pushChunk(
                      JSON.stringify({ type: 'content', delta: mainDelta })
                    );
                  }
                }

                async function finish(status: ObserveResult['status'], text: string): Promise<void> {
                  if (isDone) return;
                  isDone = true;

                  clearInterval(intervalTimer);
                  clearInterval(scrollInterval);

                  if (status === 'done') {
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
                  }

                  await customWindow.__pushDone();
                  resolve({ status, text });
                }

                const intervalTimer = window.setInterval(async () => {
                  if (isDone) return;

                  dismissDialogsInDom();

                  const turn = getLatestTurn();
                  const running = isModelRunning();

                  if (!running && turn) {
                    const errorMsg = getModelErrorText(turn);
                    if (errorMsg) {
                      const isRetryable = /internal\s*error/i.test(errorMsg);
                      if (isRetryable) {
                        void finish('retryable_error', errorMsg);
                      } else {
                        void finish('fatal_error', errorMsg);
                      }
                      return;
                    }
                  }

                  await emitDelta();

                  const currentMain = getMainText();
                  const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

                  if (!hasGeneratedAny) {
                    const upgradeEl = document.querySelector(upgradeDialogSelector) as HTMLElement | null;
                    if (upgradeEl) {
                      const rect = upgradeEl.getBoundingClientRect();
                      if (upgradeEl.offsetParent !== null || (rect.width > 0 && rect.height > 0)) {
                        void finish('upgrade_required', upgradeErrorMessage);
                        return;
                      }
                    }
                  }

                  if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                    void finish('done', currentMain);
                    return;
                  }

                  if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1000) {
                    void finish('done', currentMain);
                    return;
                  }

                  if (Date.now() - lastChangeTime > 45000) {
                    clickStopButton();
                    void finish('timeout', '[Generation Timeout]: No response received within 45 seconds.');
                    return;
                  }
                }, 200);

                await emitDelta();
              });
            },
            {
              turnSelector: this.selectors.TURN_ITEM,
              scrollSelector: this.selectors.SCROLL_CONTAINER,
              stopSelector: this.selectors.SEND_OR_STOP_BUTTON,
              upgradeDialogSelector: this.selectors.UPGRADE_DIALOG,
              upgradeErrorMessage: this.upgradeDialogErrorMessage,
              isModelRunningCode: isModelRunning.toString(),
              prevSnapshot: turnSnapshot,
            }
          );

          const abortPromise = new Promise<ObserveResult>((resolve) => {
            if (options?.abortSignal?.aborted) {
              resolve({ status: 'timeout', text: '[Generation Aborted by Client]' });
              return;
            }
            options?.abortSignal?.addEventListener(
              'abort',
              () => resolve({ status: 'timeout', text: '[Generation Aborted by Client]' }),
              { once: true }
            );
          });

          const evalResult = await Promise.race([evalPromise, abortPromise]);

          if (evalResult.status === 'upgrade_required') {
            await this.dismissUpgradeDialog(page);
            this.dirtyPages.add(page);
            finalMainText = evalResult.text;
            break;
          }

          if (options?.abortSignal?.aborted || evalResult.status === 'timeout') {
            await this.stop(worker);
            finalMainText = evalResult.text;
            break;
          }

          if (evalResult.status === 'retryable_error') {
            console.warn(
              `[${this.name}] Worker #${id} Retryable error occurred (${evalResult.text}). Retry after 2 seconds (${attempt}/${maxRetries})...`
            );
            await page.waitForTimeout(2000);
            await dismissDialogs(page);

            turnSnapshot = await this.getTurnSnapshot(page);
            await this.submitPrompt(page, prompt);
            if (await this.dismissUpgradeDialog(page)) {
              this.dirtyPages.add(page);
              finalMainText = this.upgradeDialogErrorMessage;
              break;
            }

            const retryWaitOutcome = await this.waitForTurnOrUpgradeDialog(page, turnSnapshot);
            if (retryWaitOutcome === 'upgrade_dialog' || (await this.dismissUpgradeDialog(page))) {
              this.dirtyPages.add(page);
              finalMainText = this.upgradeDialogErrorMessage;
              break;
            }

            rawFullMainText = '';
            continue;
          }

          finalMainText = evalResult.text;
          break;
        }

        if (!finalMainText) {
          if (attempt > maxRetries)
            finalMainText = `[Error]: Maximum retries (${maxRetries}) exceeded without completing response.`;
        }
      } finally {
        if (finalMainText.length > rawFullMainText.length) {
          const gapRemainder = finalMainText.slice(rawFullMainText.length);
          onRawChunk(gapRemainder, false);
          rawFullMainText = finalMainText;
        }
        emitter.off('chunk', chunkListener);
      }

      await dismissDialogs(page);
      const resolvedText = finalMainText.trim() ? finalMainText : rawFullMainText;

      console.log(`[${this.name}] Worker #${id} generation completed. Total main chars: ${resolvedText.length}`);
      return { rawText: resolvedText, currentPath: this.getCurrentPath(page) };
    } catch (err) {
      this.dirtyPages.add(page);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] Worker #${id} unexpected error:`, errorMsg);
      return {
        rawText: `[Error]: ${errorMsg}`,
        currentPath: this.getCurrentPath(page),
      };
    } finally {
      isWatchingDialogs = false;
      if (dialogWatcherPromise) {
        await dialogWatcherPromise.catch(() => { });
      }
    }
  }
}
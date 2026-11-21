import type { Page } from 'playwright';
import { WebAiProvider, type SendPromptOptions } from '@/core/web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from '@/shared/types.js';

interface WaitForTurnParams {
  turnSelector: string;
  prevSnapshot: number;
}

interface ObserveStreamParams {
  turnSelector: string;
  targetIndex: number;
  stopSelector: string;
  thinkSelector: string;
  isModelRunningCode: string;
}

interface ObserveResult {
  status: 'done' | 'timeout';
  text: string;
}

/**
 * 統一的運行狀態判斷函式（瀏覽器環境執行）
 */
function isModelRunning(stopSelector: string): boolean {
  const btn = document.querySelector(stopSelector) as HTMLElement | null;
  return btn !== null && btn.offsetParent !== null;
}

export class GeminiProvider extends WebAiProvider {
  readonly name = 'Google Gemini';
  readonly baseUrl = 'https://gemini.google.com/app';

  private readonly selectors = {
    PROMPT_INPUT: 'div[contenteditable="true"], div.ql-editor',
    SEND_BUTTON:
      'button[aria-label*="傳送"]:not([disabled]):not([aria-disabled="true"]), button[aria-label*="Send"]:not([disabled]):not([aria-disabled="true"])',
    STOP_BUTTON: 'button[aria-label*="停止"], button[aria-label*="Stop"]',
    RESPONSE_CONTAINER: 'message-content, .model-response-text, [data-test-id="model-turn"]',
    THINK_CONTAINER:
      'gem-thought, expandable-thought, .thought-container, .thought-content, .thought-block, [data-test-id="thought-container"], gem-thought-process, mat-expansion-panel',
    PLUS_BUTTON:
      'button[aria-label*="上載同工具"], button[aria-label*="Tools and upload"], button:has(mat-icon[data-mat-icon-name="plus"])',
    UPLOAD_MENU_ITEM: 'button[data-test-id="local-images-files-uploader-button"]',
    DISCLAIMER_AGREE_BUTTON:
      '[data-test-id="upload-image-agree-button"] button, button[aria-label*="同意"], button[aria-label*="Agree"]',
    ATTACHMENT_PREVIEW: 'uploader-file-preview, .attachment-preview-wrapper, gem-attachment',
    MODEL_PICKER_BUTTON: 'button[data-test-id="bard-mode-menu-button"]',
    MODEL_MENU_ITEM: 'gem-menu-item.ng-star-inserted',
    LIST_VIEW_BUTTON: 'compact-periodic-picker button.list-view-btn, button.compact-btn.list-view-btn',
    PICKER_MENU_OVERLAY:
      '.cdk-overlay-pane:has(gem-menu, gem-menu-item, compact-periodic-picker, [data-test-id="bard-mode-desktop-gem-menu"])',
    PICKER_SECONDARY_TEXT: '.picker-secondary-text',
    THINKING_LEVEL_MENU_ITEM:
      'gem-menu-item[value="thinking_level"], gem-menu-item:has-text("思考水平"), gem-menu-item:has-text("Thinking level")',
    SUBMENU_CONTAINER: '.submenu-container, .cdk-overlay-popover',
  } as const;

  protected override async executeStop(worker: PageWorker): Promise<void> {
    await this.stopTemplate(worker, {
      isRunningFn: isModelRunning,
      isRunningArg: this.selectors.STOP_BUTTON,
      stopButtonSelector: this.selectors.STOP_BUTTON,
    });
  }

  /**
   * 按下 MODEL_PICKER_BUTTON 後有時會彈出元素週期表（compact periodic picker）而非清單。
   * 偵測到清單檢視按鈕時，先切回清單檢視再繼續操作。
   */
  private async ensureListView(page: Page): Promise<void> {
    const listBtn = page.locator(this.selectors.LIST_VIEW_BUTTON).first();
    if (await listBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[${this.name}] Periodic-table picker detected, switching back to list view...`);
      await listBtn.click({ timeout: 5000 });
    }
  }

  protected override async setModel(page: Page, model?: string): Promise<void> {
    const targetModel = model?.trim().toLowerCase();
    if (!targetModel) return;

    try {
      const pickerBtn = page.locator(this.selectors.MODEL_PICKER_BUTTON).first();
      if (!(await pickerBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log(`[${this.name}] Model picker button not found, skipping model setting.`);
        return;
      }

      await pickerBtn.click({ timeout: 5000 });

      await this.ensureListView(page);

      const menuItems = page.locator(this.selectors.MODEL_MENU_ITEM);
      const escaped = targetModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matched = menuItems.filter({ hasText: new RegExp(escaped, 'i') });
      const matchCount = await matched.count();

      if (matchCount > 0 && (await matched.first().isVisible({ timeout: 3000 }).catch(() => false))) {
        console.log(`[${this.name}] Selecting model: "${targetModel}"...`);
        await matched.first().click({ timeout: 5000 });
      } else {
        console.warn(`[${this.name}] Model "${targetModel}" not found, falling back to the first option (Auto)...`);
        await menuItems.first().click({ timeout: 5000 });
      }

      for (let i = 0; i < 3; i++) {
        const isExpanded = (await pickerBtn.getAttribute('aria-expanded')) === 'true';
        const hasOverlay = (await page.locator(this.selectors.PICKER_MENU_OVERLAY).count()) > 0;
        if (isExpanded || hasOverlay)
          await page.keyboard.press('Escape').catch(() => { });
        else
          break;
      }

      console.log(`[${this.name}] Model switch completed. Ready for prompt input.`);
    } catch (err) {
      console.warn(`[${this.name}] setModel warning:`, err);
      await page.keyboard.press('Escape').catch(() => { });
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
      const levelMap: Record<'low' | 'medium' | 'high', { label: string; regex: RegExp }> = {
        low: { label: '低', regex: /^(低|low)$/i },
        medium: { label: '中', regex: /^(中|medium)$/i },
        high: { label: '高', regex: /^(高|high)$/i },
      };
      const target = levelMap[targetLevel];

      const pickerBtn = page.locator(this.selectors.MODEL_PICKER_BUTTON).first();
      if (!(await pickerBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log(`[${this.name}] Model picker button not found, skipping thinking level setting.`);
        return;
      }

      const secondaryTextEl = pickerBtn.locator(this.selectors.PICKER_SECONDARY_TEXT).first();
      if (await secondaryTextEl.isVisible({ timeout: 5000 }).catch(() => false)) {
        const currentText = (await secondaryTextEl.textContent().catch(() => ''))?.trim() ?? '';
        if (target.regex.test(currentText)) {
          console.log(`[${this.name}] Thinking Level already set to "${currentText}". Skipping menu open.`);
          return;
        }
      }

      console.log(`[${this.name}] Switching Thinking Level to "${target.label}" (${targetLevel})...`);
      await pickerBtn.click({ timeout: 5000 });

      // 確保清單檢視（有時會彈出元素週期表）
      await this.ensureListView(page);

      const thinkingItem = page.locator(this.selectors.THINKING_LEVEL_MENU_ITEM).first();

      if (!(await thinkingItem.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.warn(`[${this.name}] "Thinking level" (思考水平) menu item not found.`);
        await page.keyboard.press('Escape').catch(() => { });
        return;
      }

      await thinkingItem.click({ timeout: 5000 }).catch(() => { });

      const submenuItems = page.locator('.submenu-container gem-menu-item, [role="menu"] gem-menu-item');
      const count = await submenuItems.count();
      let targetOptionLocator = null;

      for (let i = 0; i < count; i++) {
        const item = submenuItems.nth(i);
        const labelText = (await item.locator('.label').textContent().catch(() => ''))?.trim() ?? '';
        if (target.regex.test(labelText)) {
          targetOptionLocator = item;
          break;
        }
      }

      if (targetOptionLocator && (await targetOptionLocator.isVisible({ timeout: 5000 }).catch(() => false))) {
        const isSelected =
          (await targetOptionLocator.getAttribute('class'))?.includes('selected') ||
          (await targetOptionLocator.locator('gem-icon[aria-label*="選取"], mat-icon[data-mat-icon-name="check"]').count()) > 0;

        if (isSelected) {
          console.log(`[${this.name}] Option "${target.label}" is already selected.`);
        } else {
          console.log(`[${this.name}] Selecting option "${target.label}"...`);
          await targetOptionLocator.click({ timeout: 5000 });
        }
      } else {
        console.warn(`[${this.name}] Thinking level option "${target.label}" not found in submenu.`);
      }

      for (let i = 0; i < 3; i++) {
        const isExpanded = (await pickerBtn.getAttribute('aria-expanded')) === 'true';
        const hasOverlay = (await page.locator('.cdk-overlay-pane:has(gem-menu)').count()) > 0;
        if (isExpanded || hasOverlay)
          await page.keyboard.press('Escape').catch(() => { });
        else
          break;
      }

      console.log(`[${this.name}] Thinking Level switch completed. Ready for prompt input.`);
    } catch (err) {
      console.warn(`[${this.name}] setThinkingLevel warning:`, err);
      await page.keyboard.press('Escape').catch(() => { });
    }
  }

  override async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[${this.name}] Uploading attachment file: ${filePath}`);

    const plusBtn = page.locator(this.selectors.PLUS_BUTTON).first();
    await plusBtn.waitFor({ state: 'visible', timeout: 15000 });
    await plusBtn.click();

    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 25000 });

    const uploadMenuItem = page.locator(this.selectors.UPLOAD_MENU_ITEM).first();
    await uploadMenuItem.waitFor({ state: 'visible', timeout: 10000 });
    await uploadMenuItem.click();

    const agreeBtn = page.locator(this.selectors.DISCLAIMER_AGREE_BUTTON).first();
    try {
      if (await agreeBtn.isVisible({ timeout: 5000 })) {
        console.log(`[${this.name}] Detected first-time disclaimer dialog, clicking "Agree"...`);
        await agreeBtn.click();
      }
    } catch {
      // Ignore
    }

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    const previewChip = page.locator(this.selectors.ATTACHMENT_PREVIEW).first();
    await previewChip.waitFor({ state: 'visible', timeout: 20000 });
    console.log(`[${this.name}] Attachment successfully uploaded and mounted.`);
  }

  override async navigateConversation(page: Page, isNewConversation: boolean, targetPath?: string): Promise<void> {
    if (isNewConversation) {
      const existingTurns = await page.locator(this.selectors.RESPONSE_CONTAINER).count().catch(() => 0);
      const hasInputText = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el ? (el.innerText || el.textContent || '').trim().length > 0 : false;
      }, this.selectors.PROMPT_INPUT).catch(() => false);
      const hasFiles = await page.locator(this.selectors.ATTACHMENT_PREVIEW).count().catch(() => 0);
      const currentUrlObj = new URL(page.url());

      const isDirty =
        this.dirtyPages.has(page) ||
        existingTurns > 0 ||
        hasInputText ||
        hasFiles > 0 ||
        currentUrlObj.pathname !== '/app';

      if (isDirty) {
        console.log(`[${this.name}] Page is dirty or starting new session. Force reloading to baseUrl...`);
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
        this.dirtyPages.delete(page);
      }
      return;
    }

    if (targetPath && targetPath !== '/app') {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== targetPath) {
        const targetFullUrl = `https://gemini.google.com${targetPath}`;
        console.log(`[${this.name}] Switching to existing conversation: ${targetFullUrl}`);
        await page.goto(targetFullUrl, { waitUntil: 'domcontentloaded' });
      } else {
        console.log(`[${this.name}] Tab is already on target conversation (${targetPath}), continuing directly.`);
      }
    } else {
      console.log(`[${this.name}] Continuing in current active conversation tab (path: ${new URL(page.url()).pathname}).`);
    }
  }

  private async getTurnSnapshot(page: Page): Promise<number> {
    return await page.locator(this.selectors.RESPONSE_CONTAINER).count();
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    await input.click();

    await input.evaluate((el: HTMLElement) => {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => { });
    await input.fill('');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => { });
    await page.keyboard.press('Backspace').catch(() => { });

    await input.fill(prompt);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');

    const sendBtn = page.locator(this.selectors.SEND_BUTTON).first();
    let sent = false;

    try {
      await sendBtn.click({ timeout: 5000 });
      sent = true;
    } catch {
      // Fallback
    }

    if (!sent) {
      await input.focus();
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(600);
    const remainingText = await input.textContent().catch(() => '') ?? '';
    if (remainingText.trim().length > 0) {
      console.log(`[${this.name}] Prompt remaining in editor, executing forced submit...`);
      await sendBtn.click({ force: true, timeout: 5000 }).catch(() => { });
      await input.focus();
      await page.keyboard.press('Enter');
    }
  }

  override async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options: SendPromptOptions
  ) {
    const result = await super.sendPromptAndObserve(worker, prompt, onRawChunk, options);
    if (result)
      return result;

    const { page, emitter, id } = worker;
    try {
      const turnSnapshot = await this.getTurnSnapshot(page);
      console.log(`[${this.name}] Worker #${id} turn snapshot before prompt: ${turnSnapshot}`);

      await this.submitPrompt(page, prompt);

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
            ({ turnSelector, prevSnapshot }: WaitForTurnParams) =>
              document.querySelectorAll(turnSelector).length > prevSnapshot,
            { turnSelector: this.selectors.RESPONSE_CONTAINER, prevSnapshot: turnSnapshot },
            { timeout: 5000 }
          ),
          abortInitialWait,
        ]);
      } catch (waitErr) {
        if (options?.abortSignal?.aborted) {
          console.warn(`[${this.name}] Worker #${id} aborted during initial turn wait. Triggering stop...`);
          await this.stop(worker);
          return { rawText: '[Generation Aborted by Client]', currentPath: this.getCurrentPath(page) };
        }
        throw waitErr;
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

      try {
        if (options?.abortSignal?.aborted) {
          await this.stop(worker);
          finalMainText = '[Generation Aborted by Client]';
        } else {
          await this.ensureBrowserHelpers(page);

          const evalPromise = page.evaluate(
            ({ turnSelector, targetIndex, stopSelector, thinkSelector, isModelRunningCode }: ObserveStreamParams) => {
              return new Promise<ObserveResult>(async (resolve) => {
                const container = document.querySelectorAll(turnSelector)[targetIndex] as HTMLElement | undefined;
                const customWindow = window as unknown as WindowWithCustomEvents;
                const { rehydrate, hasCompleteToolCall, domToMarkdown } = customWindow.__webAiHelpers!;
                const checkRunning = rehydrate<boolean>(isModelRunningCode);
                const isModelRunning = (): boolean => checkRunning(stopSelector);

                function clickStopButton(): boolean {
                  const btn = document.querySelector(stopSelector) as HTMLElement | null;
                  if (btn && btn.offsetParent !== null && isModelRunning()) {
                    btn.click();
                    return true;
                  }
                  return false;
                }

                function getThoughtText(root: HTMLElement | undefined): string {
                  if (!root) return '';
                  const thinkEl = root.querySelector(thinkSelector) as HTMLElement | null;
                  if (!thinkEl) return '';

                  const clone = thinkEl.cloneNode(true) as HTMLElement;
                  clone
                    .querySelectorAll(
                      'button, mat-icon, .mat-mdc-button-touch-target, [hide-from-message-actions], .thought-title, mat-expansion-panel-header'
                    )
                    .forEach((el) => el.remove());

                  clone.querySelectorAll('h1, h2, h3, h4, p, span, div').forEach((el) => {
                    const t = el.textContent?.trim();
                    if (t === 'Thinking Process' || t === '思考過程' || t === 'Thinking' || t === 'Thoughts') {
                      el.remove();
                    }
                  });

                  return domToMarkdown(clone);
                }

                function getMainText(root: HTMLElement | undefined): string {
                  if (!root) return '';
                  const clone = root.cloneNode(true) as HTMLElement;

                  clone
                    .querySelectorAll(
                      `${thinkSelector}, .table-footer, gem-icon-button, gem-popover, button, .mat-mdc-button-touch-target, [hide-from-message-actions], mat-icon`
                    )
                    .forEach((el) => el.remove());

                  return domToMarkdown(clone);
                }

                let lastThoughtLen = 0;
                let lastMainLen = 0;
                let lastChangeTime = Date.now();
                let isDone = false;

                async function emitDelta() {
                  if (!container || isDone) return;

                  const currentThought = getThoughtText(container);
                  if (currentThought.length > lastThoughtLen) {
                    const thoughtDelta = currentThought.slice(lastThoughtLen);
                    lastThoughtLen = currentThought.length;
                    lastChangeTime = Date.now();
                    await customWindow.__pushChunk(
                      JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                    );
                  }

                  const currentMain = getMainText(container);
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

                  if (observer) observer.disconnect();
                  if (pollInterval !== null) clearInterval(pollInterval);

                  if (status === 'done' && container) {
                    const finalThought = getThoughtText(container);
                    if (finalThought.length > lastThoughtLen) {
                      const thoughtDelta = finalThought.slice(lastThoughtLen);
                      lastThoughtLen = finalThought.length;
                      await customWindow.__pushChunk(
                        JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                      );
                    }

                    const finalMain = getMainText(container);
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

                const observer = new MutationObserver(async () => {
                  await emitDelta();
                });

                if (container) {
                  observer.observe(container, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                  });
                }

                const pollInterval = window.setInterval(async () => {
                  if (isDone) return;
                  await emitDelta();

                  const running = isModelRunning();
                  const currentMain = getMainText(container);
                  const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

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
              turnSelector: this.selectors.RESPONSE_CONTAINER,
              targetIndex: turnSnapshot,
              stopSelector: this.selectors.STOP_BUTTON,
              thinkSelector: this.selectors.THINK_CONTAINER,
              isModelRunningCode: isModelRunning.toString(),
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

          if (options?.abortSignal?.aborted || evalResult.status === 'timeout') {
            await this.stop(worker);
          }

          finalMainText = evalResult.text;
        }
      } finally {
        if (finalMainText.length > rawFullMainText.length) {
          const gapRemainder = finalMainText.slice(rawFullMainText.length);
          onRawChunk(gapRemainder, false);
          rawFullMainText = finalMainText;
        }
        emitter.off('chunk', chunkListener);
      }

      let currentPath = this.getCurrentPath(page);
      if (currentPath === '/app') {
        await page
          .waitForFunction(
            () => {
              const p = new URL(window.location.href).pathname;
              return p.startsWith('/app/') && p.length > 5;
            },
            { timeout: 5000 }
          )
          .catch(() => { });
        currentPath = this.getCurrentPath(page);
      }

      const resolvedText = finalMainText.trim() ? finalMainText : rawFullMainText;
      console.log(`[${this.name}] Worker #${id} generation completed. Actual URL path: ${currentPath} (Total chars: ${resolvedText.length})`);
      return { rawText: resolvedText, currentPath };
    } catch (err) {
      this.dirtyPages.add(page);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] Worker #${id} unexpected error:`, errorMsg);
      return {
        rawText: `[Error]: ${errorMsg}`,
        currentPath: this.getCurrentPath(page),
      };
    }
  }
}
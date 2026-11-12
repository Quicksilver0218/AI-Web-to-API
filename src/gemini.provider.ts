import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

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
  readonly name = 'gemini';
  readonly baseUrl = 'https://gemini.google.com/app';

  private readonly stoppingPromises = new WeakMap<Page, Promise<void>>();

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
    PICKER_SECONDARY_TEXT: '.picker-secondary-text',
    THINKING_LEVEL_MENU_ITEM:
      'gem-menu-item[value="thinking_level"], gem-menu-item:has-text("思考水平"), gem-menu-item:has-text("Thinking level")',
    SUBMENU_CONTAINER: '.submenu-container, .cdk-overlay-popover',
  } as const;

  public async isModelRunning(page: Page): Promise<boolean> {
    return await page
      .evaluate(isModelRunning, this.selectors.STOP_BUTTON)
      .catch(() => false);
  }

  public async stop(worker: PageWorker): Promise<void> {
    const existing = this.stoppingPromises.get(worker.page);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        this.dirtyPages.add(worker.page);
        console.log(`[${this.name}] Worker #${worker.id} waiting up to 5s for isModelRunning before clicking stop...`);

        await worker.page.waitForFunction(
          isModelRunning,
          this.selectors.STOP_BUTTON,
          { timeout: 5000 }
        );

        console.log(`[${this.name}] Worker #${worker.id} model confirmed running. Clicking STOP_BUTTON...`);
        const stopBtn = worker.page.locator(this.selectors.STOP_BUTTON).first();
        await stopBtn.click({ timeout: 2000 });
      } catch (err) {
        console.warn(`[${this.name}] Worker #${worker.id} stop execution warning:`, err);
      }
    })();

    this.stoppingPromises.set(worker.page, promise);
    try {
      await promise;
    } finally {
      this.stoppingPromises.delete(worker.page);
    }
  }

  public mapThinkingLevel(effort?: string): 'Low' | 'Medium' | 'High' | null {
    if (!effort) return null;
    const normalized = effort.trim().toLowerCase().replace(/[-_]/g, '');

    if (['none', 'low'].includes(normalized)) return 'Low';
    if (['medium'].includes(normalized)) return 'Medium';
    if (['high', 'xhigh', 'extrahigh'].includes(normalized)) return 'High';

    return null;
  }

  public async setThinkingLevel(page: Page, level?: string): Promise<void> {
    const targetLevel = this.mapThinkingLevel(level);
    if (!targetLevel) return;

    try {
      const levelMap: Record<'Low' | 'Medium' | 'High', { label: string; regex: RegExp }> = {
        Low: { label: '低', regex: /^(低|low)$/i },
        Medium: { label: '中', regex: /^(中|medium)$/i },
        High: { label: '高', regex: /^(高|high)$/i },
      };
      const target = levelMap[targetLevel];

      const pickerBtn = page.locator(this.selectors.MODEL_PICKER_BUTTON).first();
      if (!(await pickerBtn.isVisible({ timeout: 2500 }).catch(() => false))) {
        console.log('[${this.name}] Model picker button not found, skipping thinking level setting.');
        return;
      }

      const secondaryTextEl = pickerBtn.locator(this.selectors.PICKER_SECONDARY_TEXT).first();
      if (await secondaryTextEl.isVisible({ timeout: 1000 }).catch(() => false)) {
        const currentText = (await secondaryTextEl.innerText().catch(() => '')).trim();
        if (target.regex.test(currentText)) {
          console.log(`[${this.name}] Thinking Level already set to "${currentText}". Skipping menu open.`);
          return;
        }
      }

      console.log(`[${this.name}] Switching Thinking Level to "${target.label}" (${targetLevel})...`);

      await pickerBtn.scrollIntoViewIfNeeded().catch(() => {});
      await pickerBtn.click({ timeout: 2000 });
      await page.waitForTimeout(400);

      const thinkingItem = page.locator(this.selectors.THINKING_LEVEL_MENU_ITEM).first();

      if (!(await thinkingItem.isVisible({ timeout: 3000 }).catch(() => false))) {
        console.warn('[${this.name}] "Thinking level" (思考水平) menu item not found.');
        await page.keyboard.press('Escape').catch(() => {});
        return;
      }

      await thinkingItem.hover().catch(() => {});
      await thinkingItem.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);

      const submenuItems = page.locator('.submenu-container gem-menu-item, [role="menu"] gem-menu-item');
      const count = await submenuItems.count();
      let targetOptionLocator = null;

      for (let i = 0; i < count; i++) {
        const item = submenuItems.nth(i);
        const labelText = (await item.locator('.label').innerText().catch(() => '')).trim();
        if (target.regex.test(labelText)) {
          targetOptionLocator = item;
          break;
        }
      }

      if (targetOptionLocator && (await targetOptionLocator.isVisible({ timeout: 2000 }).catch(() => false))) {
        const isSelected =
          (await targetOptionLocator.getAttribute('class'))?.includes('selected') ||
          (await targetOptionLocator.locator('gem-icon[aria-label*="選取"], mat-icon[data-mat-icon-name="check"]').count()) > 0;

        if (isSelected) {
          console.log(`[${this.name}] Option "${target.label}" is already selected.`);
        } else {
          console.log(`[${this.name}] Selecting option "${target.label}"...`);
          await targetOptionLocator.click({ timeout: 2000 });
          await page.waitForTimeout(400);
        }
      } else {
        console.warn(`[${this.name}] Thinking level option "${target.label}" not found in submenu.`);
      }

      for (let i = 0; i < 3; i++) {
        const isExpanded = (await pickerBtn.getAttribute('aria-expanded')) === 'true';
        const hasOverlay = (await page.locator('.cdk-overlay-pane:has(gem-menu)').count()) > 0;
        if (isExpanded || hasOverlay) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(200);
        } else {
          break;
        }
      }

      console.log('[${this.name}] Thinking Level switch completed. Ready for prompt input.');
    } catch (err) {
      console.warn('[${this.name}] setThinkingLevel warning:', err);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  async uploadFile(page: Page, filePath: string): Promise<void> {
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
      if (await agreeBtn.isVisible({ timeout: 2000 })) {
        console.log('[${this.name}] Detected first-time disclaimer dialog, clicking "Agree"...');
        await agreeBtn.click();
      }
    } catch {
      // Ignore
    }

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    const previewChip = page.locator(this.selectors.ATTACHMENT_PREVIEW).first();
    await previewChip.waitFor({ state: 'visible', timeout: 20000 });
    console.log('[${this.name}] Attachment successfully uploaded and mounted.');
  }

  async navigateConversation(page: Page, isNewConversation: boolean, targetPath?: string): Promise<void> {
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
        console.log('[${this.name}] Page is dirty or starting new session. Force reloading to baseUrl...');
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
    }).catch(() => {});
    await input.fill('');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});

    await input.fill(prompt);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');

    const sendBtn = page.locator(this.selectors.SEND_BUTTON).first();
    let sent = false;

    try {
      await sendBtn.waitFor({ state: 'visible', timeout: 4000 });
      await sendBtn.click({ timeout: 2000 });
      sent = true;
    } catch {
      // Fallback
    }

    if (!sent) {
      await input.focus();
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(600);
    const remainingText = await input.innerText().catch(() => '');
    if (remainingText.trim().length > 0) {
      console.log('[${this.name}] Prompt remaining in editor, executing forced submit...');
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
            { timeout: 0 }
          ),
          abortInitialWait,
        ]);
      } catch (waitErr) {
        if (options?.abortSignal?.aborted) {
          console.warn(`[${this.name}] Worker #${id} aborted during initial turn wait. Triggering stop...`);
          await this.stop(worker);
          return { rawText: '[Generation Aborted by Client]', currentPath: new URL(page.url()).pathname };
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
              return new Promise<ObserveResult>((resolve) => {
                const container = document.querySelectorAll(turnSelector)[targetIndex] as HTMLElement | undefined;
                const customWindow = window as unknown as WindowWithCustomEvents;
                const { rehydrate, hasCompleteToolCall } = (window as any).__webAiHelpers;
                const checkRunning = rehydrate(isModelRunningCode);
                const isModelRunning = (): boolean => checkRunning(stopSelector);

                function clickStopButton(): boolean {
                  const btn = document.querySelector(stopSelector) as HTMLElement | null;
                  if (btn && btn.offsetParent !== null && isModelRunning()) {
                    btn.click();
                    return true;
                  }
                  return false;
                }

                function serializeCellContent(cell: Element): string {
                  const cellClone = cell.cloneNode(true) as HTMLElement;

                  cellClone.querySelectorAll('code').forEach((code) => {
                    code.replaceWith(document.createTextNode(`\`${code.textContent ?? ''}\``));
                  });

                  cellClone.querySelectorAll('strong, b').forEach((b) => {
                    b.replaceWith(document.createTextNode(`**${b.textContent ?? ''}**`));
                  });

                  cellClone.querySelectorAll('em, i').forEach((em) => {
                    em.replaceWith(document.createTextNode(`*${em.textContent ?? ''}*`));
                  });

                  const raw = cellClone.textContent ?? '';
                  return raw.trim().replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|');
                }

                function convertTableToMarkdown(table: HTMLTableElement): string {
                  const rows = Array.from(table.querySelectorAll('tr'));
                  if (rows.length === 0) return '';

                  const mdRows: string[] = [];
                  let colCount = 0;
                  let delimiterSet = false;
                  const thead = table.querySelector('thead');

                  for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const cells = Array.from(row.querySelectorAll('th, td'));
                    if (cells.length === 0) continue;

                    const cellTexts = cells.map(serializeCellContent);
                    const isHeader = thead ? thead.contains(row) : i === 0;

                    if (isHeader) {
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

                  return `\n\n${mdRows.join('\n')}\n\n`;
                }

                function domToMarkdown(root: HTMLElement): string {
                  const clone = root.cloneNode(true) as HTMLElement;

                  clone.querySelectorAll('.katex').forEach((katex) => {
                    const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
                    const rawTex = annotation?.textContent ?? '';
                    katex.replaceWith(document.createTextNode(`$${rawTex}$`));
                  });

                  clone.querySelectorAll('table').forEach((table) => {
                    const mdTable = convertTableToMarkdown(table as HTMLTableElement);
                    const wrapper =
                      table.closest('.horizontal-scroll-wrapper') ||
                      table.closest('table-block') ||
                      table;
                    wrapper.replaceWith(document.createTextNode(mdTable));
                  });

                  clone.querySelectorAll('pre').forEach((pre) => {
                    const code = pre.querySelector('code');
                    const content = (code ?? pre).textContent ?? '';
                    pre.replaceWith(document.createTextNode(`\n\`\`\`\n${content}\n\`\`\`\n`));
                  });

                  clone.querySelectorAll('code').forEach((code) => {
                    code.replaceWith(document.createTextNode(`\`${code.textContent ?? ''}\``));
                  });

                  clone.querySelectorAll('b, strong').forEach((b) => {
                    b.replaceWith(document.createTextNode(`**${b.textContent ?? ''}**`));
                  });

                  clone.querySelectorAll('h1').forEach((h) => h.replaceWith(document.createTextNode(`\n\n# ${h.textContent?.trim() ?? ''}\n\n`)));
                  clone.querySelectorAll('h2').forEach((h) => h.replaceWith(document.createTextNode(`\n\n## ${h.textContent?.trim() ?? ''}\n\n`)));
                  clone.querySelectorAll('h3').forEach((h) => h.replaceWith(document.createTextNode(`\n\n### ${h.textContent?.trim() ?? ''}\n\n`)));
                  clone.querySelectorAll('h4, h5, h6').forEach((h) => h.replaceWith(document.createTextNode(`\n\n#### ${h.textContent?.trim() ?? ''}\n\n`)));

                  clone.querySelectorAll('li').forEach((li) => {
                    li.querySelectorAll('p').forEach((p) => {
                      p.replaceWith(document.createTextNode(p.textContent?.trim() ?? ''));
                    });
                    const text = li.textContent?.trim() ?? '';
                    li.replaceWith(document.createTextNode(`\n- ${text}\n`));
                  });

                  clone.querySelectorAll('p').forEach((p) => {
                    const text = p.textContent?.trim() ?? '';
                    if (text) {
                      p.replaceWith(document.createTextNode(`\n\n${text}\n\n`));
                    }
                  });

                  const raw = clone.textContent ?? '';
                  return raw.replace(/\n{3,}/g, '\n\n').trim();
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

                function emitDelta(): void {
                  if (!container || isDone) return;

                  const currentThought = getThoughtText(container);
                  if (currentThought.length > lastThoughtLen) {
                    const thoughtDelta = currentThought.slice(lastThoughtLen);
                    lastThoughtLen = currentThought.length;
                    lastChangeTime = Date.now();
                    customWindow.__pushChunk(
                      JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                    );
                  }

                  const currentMain = getMainText(container);
                  if (currentMain.length > lastMainLen) {
                    const mainDelta = currentMain.slice(lastMainLen);
                    lastMainLen = currentMain.length;
                    lastChangeTime = Date.now();
                    customWindow.__pushChunk(
                      JSON.stringify({ type: 'content', delta: mainDelta })
                    );
                  }
                }

                async function finish(status: ObserveResult['status'], text: string): Promise<void> {
                  if (isDone) return;
                  isDone = true;

                  emitDelta();
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

                const observer = new MutationObserver(() => {
                  emitDelta();
                });

                if (container) {
                  observer.observe(container, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                  });
                }

                const pollInterval = window.setInterval(() => {
                  if (isDone) return;
                  emitDelta();

                  const running = isModelRunning();
                  const currentMain = getMainText(container);
                  const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

                  if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                    void finish('done', currentMain);
                    return;
                  }

                  if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1500) {
                    void finish('done', currentMain);
                    return;
                  }

                  if (hasGeneratedAny && Date.now() - lastChangeTime > 20000) {
                    void finish('done', currentMain);
                    return;
                  }

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

      let currentPath = new URL(page.url()).pathname;
      if (currentPath === '/app') {
        await page
          .waitForFunction(
            () => {
              const p = new URL(window.location.href).pathname;
              return p.startsWith('/app/') && p.length > 5;
            },
            { timeout: 3500 }
          )
          .catch(() => {});
        currentPath = new URL(page.url()).pathname;
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
        currentPath: new URL(page.url()).pathname,
      };
    }
  }
}
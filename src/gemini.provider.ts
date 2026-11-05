import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

interface BrowserEvaluateParams {
  selector: string;
  index: number;
  stopSelector: string;
  thinkSelector: string;
}

interface WaitForFunctionParams {
  selector: string;
  count: number;
}

export class GeminiProvider extends WebAiProvider {
  readonly name = 'gemini';
  readonly baseUrl = 'https://gemini.google.com/app';

  private readonly selectors = {
    PROMPT_INPUT: 'div[contenteditable="true"], div.ql-editor',
    SEND_BUTTON: 'button[aria-label*="傳送"], button[aria-label*="Send"]',
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

  public mapThinkingLevel(effort?: string): 'Low' | 'Medium' | 'High' | null {
    if (!effort) return null;
    const normalized = effort.trim().toLowerCase().replace(/[-_]/g, '');

    if (['none', 'low'].includes(normalized)) return 'Low';
    if (['medium'].includes(normalized)) return 'Medium';
    if (['high', 'xhigh', 'extrahigh'].includes(normalized)) return 'High';

    return null;
  }

  /**
   * 完整設置 Thinking Level，並確保所有浮動選單已完全關閉
   */
  public async setThinkingLevel(page: Page, targetLevel: 'Low' | 'Medium' | 'High'): Promise<void> {
    try {
      const levelMap: Record<'Low' | 'Medium' | 'High', { label: string; regex: RegExp }> = {
        Low: { label: '低', regex: /^(低|low)$/i },
        Medium: { label: '中', regex: /^(中|medium)$/i },
        High: { label: '高', regex: /^(高|high)$/i },
      };
      const target = levelMap[targetLevel];

      const pickerBtn = page.locator(this.selectors.MODEL_PICKER_BUTTON).first();
      if (!(await pickerBtn.isVisible({ timeout: 2500 }).catch(() => false))) {
        console.log('[Gemini] Model picker button not found, skipping thinking level setting.');
        return;
      }

      // 1. 檢查目前按鈕上的副文字（如「高」、「中」、「低」），若已符合則不重複展開
      const secondaryTextEl = pickerBtn.locator(this.selectors.PICKER_SECONDARY_TEXT).first();
      if (await secondaryTextEl.isVisible({ timeout: 1000 }).catch(() => false)) {
        const currentText = (await secondaryTextEl.innerText().catch(() => '')).trim();
        if (target.regex.test(currentText)) {
          console.log(`[Gemini] Thinking Level already set to "${currentText}". Skipping menu open.`);
          return;
        }
      }

      console.log(`[Gemini] Switching Thinking Level to "${target.label}" (${targetLevel})...`);

      // 2. 點擊開啟模式選擇器選單
      await pickerBtn.scrollIntoViewIfNeeded().catch(() => {});
      await pickerBtn.click({ timeout: 2000 });
      await page.waitForTimeout(400);

      // 3. 定位「思考水平」主選單項
      const thinkingItem = page
        .locator('gem-menu-item[value="thinking_level"], gem-menu-item:has-text("思考水平"), gem-menu-item:has-text("Thinking level")')
        .first();

      if (!(await thinkingItem.isVisible({ timeout: 3000 }).catch(() => false))) {
        console.warn('[Gemini] "Thinking level" (思考水平) menu item not found.');
        await page.keyboard.press('Escape').catch(() => {});
        return;
      }

      // 4. 懸停或點擊展開子選單
      await thinkingItem.hover().catch(() => {});
      await thinkingItem.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);

      // 5. 在子選單中嚴格比對 .label 文字（低 / 中 / 高）
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
          console.log(`[Gemini] Option "${target.label}" is already selected.`);
        } else {
          console.log(`[Gemini] Selecting option "${target.label}"...`);
          await targetOptionLocator.click({ timeout: 2000 });
          await page.waitForTimeout(400);
        }
      } else {
        console.warn(`[Gemini] Thinking level option "${target.label}" not found in submenu.`);
      }

      // 6. 確保所有選單浮動層已關閉，避免遮擋接下來的 Prompt 輸入框
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

      console.log(`[Gemini] Thinking Level switch completed. Ready for prompt input.`);
    } catch (err) {
      console.warn('[Gemini] setThinkingLevel warning:', err);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[Gemini] Uploading attachment file: ${filePath}`);

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
        console.log('[Gemini] Detected first-time disclaimer dialog, clicking "Agree"...');
        await agreeBtn.click();
      }
    } catch {
      // Ignore
    }

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    const previewChip = page.locator(this.selectors.ATTACHMENT_PREVIEW).first();
    await previewChip.waitFor({ state: 'visible', timeout: 20000 });
    console.log('[Gemini] Attachment successfully uploaded and mounted.');
  }

  async navigateConversation(page: Page, isNewConversation: boolean, targetPath?: string): Promise<void> {
    if (!isNewConversation && targetPath) {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== targetPath) {
        const targetFullUrl = `https://gemini.google.com${targetPath}`;
        console.log(`[Gemini] Switching to existing conversation: ${targetFullUrl}`);
        await page.goto(targetFullUrl, { waitUntil: 'domcontentloaded' });
      } else {
        console.log(`[Gemini] Tab is already on target conversation (${targetPath}), continuing directly.`);
      }
    } else {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== '/app') {
        console.log('[Gemini] Opening new conversation home page...');
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      }
    }
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string, isReasoning?: boolean) => void,
    options?: { thinkingLevel?: string }
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    // =========================================================================
    // 步驟 1：先設置 Thinking Level（確保面板徹底關閉、不遮擋輸入框）
    // =========================================================================
    const targetLevel = this.mapThinkingLevel(options?.thinkingLevel);
    if (targetLevel) {
      console.log(`[Gemini] Worker #${id} setting Thinking Level before prompt: ${targetLevel}`);
      await this.setThinkingLevel(page, targetLevel);
      await page.waitForTimeout(400);
    }

    // =========================================================================
    // 步驟 2：確認 Thinking Level 已就緒後，再操作輸入框與送出 Prompt
    // =========================================================================
    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    const responseLocator = page.locator(this.selectors.RESPONSE_CONTAINER);
    const targetIndex = await responseLocator.count();

    await input.click();
    await input.fill(prompt);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');

    const activeSendBtn = page
      .locator(
        'button[aria-label*="傳送"]:not([disabled]):not([aria-disabled="true"]), ' +
          'button[aria-label*="Send"]:not([disabled]):not([aria-disabled="true"])'
      )
      .first();

    let sent = false;

    try {
      await activeSendBtn.waitFor({ state: 'visible', timeout: 4000 });
      await activeSendBtn.click({ timeout: 2000 });
      sent = true;
    } catch {
      console.log(`[Gemini] Worker #${id} active send button not ready, trying Enter key fallback...`);
    }

    if (!sent) {
      await input.focus();
      await input.press('Enter');
    }

    await page.waitForTimeout(600);
    const remainingText = await input.innerText();
    if (remainingText.trim().length > 0) {
      console.log(`[Gemini] Worker #${id} prompt still remaining in editor, executing forced submission...`);
      const fallbackBtn = page.locator(this.selectors.SEND_BUTTON).first();
      try {
        await fallbackBtn.click({ force: true, timeout: 2000 });
      } catch {
        await input.focus();
        await page.keyboard.press('Enter');
      }
    }

    await page.waitForFunction(
      ({ selector, count }: WaitForFunctionParams) => document.querySelectorAll(selector).length > count,
      { selector: this.selectors.RESPONSE_CONTAINER, count: targetIndex }
    );

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

    let finalDomText = '';

    try {
      finalDomText = await page.evaluate(
        ({ selector, index, stopSelector, thinkSelector }: BrowserEvaluateParams) => {
          return new Promise<string>((resolve) => {
            const container = document.querySelectorAll(selector)[index] as HTMLElement | undefined;
            const customWindow = window as unknown as WindowWithCustomEvents;

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

            let lastThoughtLen = 0;
            let lastMainLen = 0;
            let lastChangeTime = Date.now();
            let isDone = false;

            function emitDelta() {
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

            function complete() {
              if (isDone) return;
              isDone = true;

              emitDelta();
              if (observer) observer.disconnect();
              if (stopCheckInterval !== null) clearInterval(stopCheckInterval);

              if (container) {
                const finalThought = getThoughtText(container);
                if (finalThought.length > lastThoughtLen) {
                  const thoughtDelta = finalThought.slice(lastThoughtLen);
                  lastThoughtLen = finalThought.length;
                  customWindow.__pushChunk(
                    JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                  );
                }

                const finalMain = getMainText(container);
                if (finalMain.length > lastMainLen) {
                  const mainDelta = finalMain.slice(lastMainLen);
                  lastMainLen = finalMain.length;
                  customWindow.__pushChunk(
                    JSON.stringify({ type: 'content', delta: mainDelta })
                  );
                }
              }

              customWindow.__pushDone();
              resolve(getMainText(container));
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

            const stopCheckInterval = window.setInterval(() => {
              if (isDone) return;
              emitDelta();

              const stopBtn = document.querySelector(stopSelector);
              const isGenerating = stopBtn && (stopBtn as HTMLElement).offsetParent !== null;

              const currentMain = getMainText(container);
              if (!isGenerating && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                complete();
                return;
              }

              const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

              if (!isGenerating && hasGeneratedAny && Date.now() - lastChangeTime > 1500) {
                complete();
                return;
              }

              if (hasGeneratedAny && Date.now() - lastChangeTime > 20000) {
                complete();
                return;
              }
            }, 250);

            emitDelta();
          });
        },
        {
          selector: this.selectors.RESPONSE_CONTAINER,
          index: targetIndex,
          stopSelector: this.selectors.STOP_BUTTON,
          thinkSelector: this.selectors.THINK_CONTAINER,
        }
      );
    } finally {
      if (finalDomText.length > rawFullMainText.length) {
        const gapRemainder = finalDomText.slice(rawFullMainText.length);
        onRawChunk(gapRemainder, false);
        rawFullMainText = finalDomText;
      }
      emitter.off('chunk', chunkListener);
    }

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalDomText.trim() ? finalDomText : rawFullMainText;

    console.log(`[Gemini] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: resolvedText, currentPath };
  }
}
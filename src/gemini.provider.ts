import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.js';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

interface BrowserEvaluateParams {
  selector: string;
  index: number;
  stopSelector: string;
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
    PLUS_BUTTON: 'button[aria-label*="上載同工具"], button[aria-label*="Tools and upload"], button:has(mat-icon[data-mat-icon-name="plus"])',
    UPLOAD_MENU_ITEM: 'button[data-test-id="local-images-files-uploader-button"]',
    DISCLAIMER_AGREE_BUTTON: '[data-test-id="upload-image-agree-button"] button, button[aria-label*="同意"], button[aria-label*="Agree"]',
    ATTACHMENT_PREVIEW: 'uploader-file-preview, .attachment-preview-wrapper, gem-attachment',
  } as const;

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
      // Ignore if disclaimer dialog is absent
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
    onRawChunk: (delta: string) => void
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    const responseLocator = page.locator(this.selectors.RESPONSE_CONTAINER);
    const targetIndex = await responseLocator.count();

    // 1. 填入內容並強制觸發 Angular 內部事件
    await input.click();
    await input.fill(prompt);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await page.waitForTimeout(300);

    // 2. 定位「已啟用」的傳送按鈕（排除 disabled 與 aria-disabled="true"）
    const activeSendBtn = page.locator(
      'button[aria-label*="傳送"]:not([disabled]):not([aria-disabled="true"]), ' +
      'button[aria-label*="Send"]:not([disabled]):not([aria-disabled="true"])'
    ).first();

    let sent = false;

    try {
      // 等待按鈕轉為可點擊狀態（最多等待 4 秒）
      await activeSendBtn.waitFor({ state: 'visible', timeout: 4000 });
      await activeSendBtn.click({ timeout: 2000 });
      sent = true;
    } catch {
      console.log(`[Gemini] Worker #${id} active send button not ready, trying Enter key fallback...`);
    }

    if (!sent) {
      // 點擊無效時聚焦輸入框並使用 Enter 送出
      await input.focus();
      await input.press('Enter');
    }

    // 3. 【防呆二次確認】：檢查輸入框是否已被清空
    await page.waitForTimeout(600);
    const remainingText = await input.innerText();
    if (remainingText.trim().length > 0) {
      console.log(`[Gemini] Worker #${id} prompt still remaining in editor, executing forced submission...`);
      const fallbackBtn = page.locator(this.selectors.SEND_BUTTON).first();
      try {
        await fallbackBtn.click({ force: true, timeout: 2000 });
      } catch {
        await input.focus();
        await page.keyboard.press('Control+Enter');
      }
    }

    // 4. 等待新回覆容器生成（無 timeout 限制）
    await page.waitForFunction(
      ({ selector, count }: WaitForFunctionParams) => document.querySelectorAll(selector).length > count,
      { selector: this.selectors.RESPONSE_CONTAINER, count: targetIndex }
    );

    let rawFullText = '';
    const chunkListener = (delta: string) => {
      rawFullText += delta;
      onRawChunk(delta);
    };
    emitter.on('chunk', chunkListener);

    let finalDomText = '';

    try {
      finalDomText = await page.evaluate(
        ({ selector, index, stopSelector }: BrowserEvaluateParams) => {
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

                let cellTexts = cells.map(serializeCellContent);
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

            function extractCleanText(root: HTMLElement | undefined): string {
              if (!root) return '';
              const clone = root.cloneNode(true) as HTMLElement;

              clone.querySelectorAll(
                '.table-footer, gem-icon-button, gem-popover, button, .mat-mdc-button-touch-target, [hide-from-message-actions], mat-icon'
              ).forEach((el) => el.remove());

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

            let lastLen = 0;
            let isDone = false;
            let stabilityTimer: number | null = null;

            function emitDelta() {
              if (!container) return;
              const currentText = extractCleanText(container);
              if (currentText.length > lastLen) {
                const delta = currentText.slice(lastLen);
                lastLen = currentText.length;
                customWindow.__pushChunk(delta);
              }
            }

            function complete() {
              if (isDone) return;
              isDone = true;
              emitDelta();
              if (observer) observer.disconnect();
              if (stopCheckInterval !== null) clearInterval(stopCheckInterval);
              if (stabilityTimer !== null) clearTimeout(stabilityTimer);
              customWindow.__pushDone();
              resolve(extractCleanText(container));
            }

            const observer = new MutationObserver(() => {
              emitDelta();
              if (stabilityTimer !== null) clearTimeout(stabilityTimer);
              stabilityTimer = window.setTimeout(() => {
                const stopBtn = document.querySelector(stopSelector);
                const isStillGenerating = stopBtn && (stopBtn as HTMLElement).offsetParent !== null;
                if (!isStillGenerating) {
                  complete();
                }
              }, 3500);
            });

            if (container) {
              observer.observe(container, {
                childList: true,
                subtree: true,
                characterData: true,
              });
            }

            emitDelta();

            const stopCheckInterval: number = window.setInterval(() => {
              const stopBtn = document.querySelector(stopSelector);
              const isGenerating = stopBtn && (stopBtn as HTMLElement).offsetParent !== null;
              if (!isGenerating && lastLen > 0) {
                window.setTimeout(complete, 1000);
              }
            }, 300);
          });
        },
        {
          selector: this.selectors.RESPONSE_CONTAINER,
          index: targetIndex,
          stopSelector: this.selectors.STOP_BUTTON,
        }
      );
    } finally {
      emitter.off('chunk', chunkListener);
    }

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalDomText.trim() ? finalDomText : rawFullText;

    console.log(`[Gemini] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: resolvedText, currentPath };
  }
}
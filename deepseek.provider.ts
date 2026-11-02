import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.ts';
import type { PageWorker, WindowWithCustomEvents } from './types.ts';

interface WaitForResponseParams {
  selector: string;
  prevCount: number;
}

interface ObserveStreamParams {
  selector: string;
}

export class DeepSeekProvider extends WebAiProvider {
  readonly name = 'deepseek';
  readonly baseUrl = 'https://chat.deepseek.com/';

  private readonly selectors = {
    PROMPT_INPUT: 'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea',
    FILE_INPUT: 'input[type="file"]',
    UPLOAD_BUTTON: 'div[role="button"]:has(svg), button:has(svg)',
    SEND_BUTTON: 'div[role="button"]:has(svg):not([aria-disabled="true"]), button:has(svg):not([disabled]), div[class*="send-button"]',
    RESPONSE_CONTAINER: '.ds-markdown:not(.ds-think-content .ds-markdown)',
    VIRTUAL_LIST_ITEM: '.ds-virtual-list-visible-items [data-virtual-list-item-key]',
  } as const;

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

    await page.waitForTimeout(2500);
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
   * Helper function to calculate current response turn count from virtual list keys
   */
  private async getVirtualResponseCount(page: Page): Promise<number> {
    return await page.evaluate((selector: string) => {
      const elements = Array.from(document.querySelectorAll(selector));
      const maxKey = elements.reduce((max: number, element: Element) => {
        const rawKey = element.getAttribute('data-virtual-list-item-key');
        const num = rawKey !== null ? Number(rawKey) : 0;
        return Number.isNaN(num) ? max : Math.max(num, max);
      }, 0);

      return maxKey / 2;
    }, this.selectors.VIRTUAL_LIST_ITEM);
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string) => void
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    const prevCount = await this.getVirtualResponseCount(page);
    console.log(`[DeepSeek] Worker #${id} current response count before prompt: ${prevCount}`);

    await input.click();
    await input.fill(prompt);
    await input.dispatchEvent('input');
    await page.waitForTimeout(300);

    const sendBtn = page.locator(this.selectors.SEND_BUTTON).last();
    let sent = false;
    if (await sendBtn.isVisible()) {
      try {
        await sendBtn.click({ timeout: 2000 });
        sent = true;
      } catch {
        // Fall back to keypress if button click is obstructed
      }
    }
    if (!sent) {
      await input.press('Enter');
    }

    await page.waitForFunction(
      ({ selector, prevCount }: WaitForResponseParams) => {
        const elements = Array.from(document.querySelectorAll(selector));
        const maxKey = elements.reduce((max: number, element: Element) => {
          const rawKey = element.getAttribute('data-virtual-list-item-key');
          const num = rawKey !== null ? Number(rawKey) : 0;
          return Number.isNaN(num) ? max : Math.max(num, max);
        }, 0);

        return maxKey / 2 > prevCount;
      },
      { selector: this.selectors.VIRTUAL_LIST_ITEM, prevCount }
    );

    const newCount = await this.getVirtualResponseCount(page);
    console.log(`[DeepSeek] Worker #${id} new response detected. Turn count updated to: ${newCount}`);

    let rawFullText = '';
    const chunkListener = (delta: string) => {
      rawFullText += delta;
      onRawChunk(delta);
    };
    emitter.on('chunk', chunkListener);

    let finalExtractedText = '';

    try {
      finalExtractedText = await page.evaluate(
        ({ selector }: ObserveStreamParams) => {
          return new Promise<string>((resolve) => {
            const customWindow = window as unknown as WindowWithCustomEvents;

            function getLatestContainer(): HTMLElement | null {
              const elements = document.querySelectorAll(selector);
              if (elements.length === 0) return null;
              return elements[elements.length - 1] as HTMLElement;
            }

            // ================= 核心策略 1：從 React Fiber 直接取回未污染的原始 Markdown =================
            function getReactRawMarkdown(container: HTMLElement | null): string | null {
              if (!container) return null;
              const targets = [
                container,
                container.parentElement,
                container.closest('.ds-markdown'),
                container.closest('[data-virtual-list-item-key]'),
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
                  fiber = fiber.return;
                  depth++;
                }
              }
              return null;
            }

            // ================= 核心策略 2：全節點 DOM 逆向解析器（降級防線） =================
            function domToMarkdownFallback(container: HTMLElement | null): string {
              if (!container) return '';
              const clone = container.cloneNode(true) as HTMLElement;

              // 移除滾動條陰影等干擾節點
              clone.querySelectorAll('.ds-scroll-area__gutters, [class*="gutter"]').forEach((el) => el.remove());

              // 還原 KaTeX 公式
              clone.querySelectorAll('.katex').forEach((katex) => {
                const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
                const rawTex = annotation?.textContent ?? '';
                katex.replaceWith(document.createTextNode(`$${rawTex}$`));
              });

              // 還原標題（H1-H6）
              clone.querySelectorAll('h1').forEach((h) => h.replaceWith(document.createTextNode(`\n\n# ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h2').forEach((h) => h.replaceWith(document.createTextNode(`\n\n## ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h3').forEach((h) => h.replaceWith(document.createTextNode(`\n\n### ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h4, h5, h6').forEach((h) => h.replaceWith(document.createTextNode(`\n\n#### ${h.textContent?.trim() ?? ''}\n\n`)));

              // 還原清單項目
              clone.querySelectorAll('li').forEach((li) => {
                const text = li.textContent?.trim() ?? '';
                li.replaceWith(document.createTextNode(`\n- ${text}\n`));
              });

              // 還原段落
              clone.querySelectorAll('p, .ds-markdown-paragraph').forEach((p) => {
                const text = p.textContent?.trim() ?? '';
                if (text) {
                  p.replaceWith(document.createTextNode(`\n\n${text}\n\n`));
                }
              });

              // 還原表格
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

              // 使用 textContent 提取，避免 innerText 的 CSS 樣式坍塌
              const raw = clone.textContent ?? '';
              return raw.replace(/\n{3,}/g, '\n\n').trim();
            }

            function getBestText(): string {
              const container = getLatestContainer();
              if (!container) return '';
              const rawReact = getReactRawMarkdown(container);
              if (rawReact) return rawReact;
              return domToMarkdownFallback(container);
            }

            let lastLen = 0;
            let isDone = false;
            let stabilityTimer: number | null = null;

            function emitDelta() {
              const currentText = getBestText();
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
              if (stabilityTimer !== null) clearTimeout(stabilityTimer);
              customWindow.__pushDone();
              resolve(getBestText());
            }

            const observer = new MutationObserver(() => {
              emitDelta();
              if (stabilityTimer !== null) clearTimeout(stabilityTimer);
              stabilityTimer = window.setTimeout(() => {
                complete();
              }, 3500);
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });

            emitDelta();
          });
        },
        { selector: this.selectors.RESPONSE_CONTAINER }
      );
    } finally {
      emitter.off('chunk', chunkListener);
    }

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalExtractedText.trim() ? finalExtractedText : rawFullText;

    console.log(`[DeepSeek] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: resolvedText, currentPath };
  }
}
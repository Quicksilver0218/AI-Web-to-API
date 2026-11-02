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

    // 1. Get current response count before sending prompt
    const prevCount = await this.getVirtualResponseCount(page);
    console.log(`[DeepSeek] Worker #${id} current response count before prompt: ${prevCount}`);

    // 2. Input and submit prompt
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
        // Fall back to enter key if click is intercepted
      }
    }

    if (!sent) {
      await input.press('Enter');
    }

    // 3. Wait until the virtual item key updates (maxKey / 2 > prevCount)
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

    let finalDomText = '';

    try {
      finalDomText = await page.evaluate(
        ({ selector }: ObserveStreamParams) => {
          return new Promise<string>((resolve) => {
            const customWindow = window as unknown as WindowWithCustomEvents;

            function getLatestContainer(): HTMLElement | null {
              const elements = document.querySelectorAll(selector);
              if (elements.length === 0) return null;
              return elements[elements.length - 1] as HTMLElement;
            }

            // 【關鍵修復】：逆向還原被 KaTeX 渲染破壞的原始文字
            function extractCleanText(element: HTMLElement | null): string {
              if (!element) return '';
              const clone = element.cloneNode(true) as HTMLElement;

              // 尋找所有被轉成 LaTeX 公式的節點
              const katexElements = clone.querySelectorAll('.katex');
              katexElements.forEach((katex) => {
                // KaTeX 會在 <annotation encoding="application/x-tex"> 內保留完整的原始字串
                const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
                const rawTex = annotation?.textContent ?? '';
                // 將公式標籤替換回原本的 $...$ 原始代碼
                katex.replaceWith(document.createTextNode(`$${rawTex}$`));
              });

              return clone.innerText || '';
            }

            let lastLen = 0;
            let isDone = false;
            let stabilityTimer: number | null = null;

            function emitDelta(): void {
              const container = getLatestContainer();
              if (!container) return;
              // 使用逆向還原後的純文字，而不是未處理的 innerText
              const currentText = extractCleanText(container);
              if (currentText.length > lastLen) {
                const delta = currentText.slice(lastLen);
                lastLen = currentText.length;
                customWindow.__pushChunk(delta);
              }
            }

            function complete(): void {
              if (isDone) return;
              isDone = true;
              emitDelta();
              if (observer) observer.disconnect();
              if (stabilityTimer !== null) clearTimeout(stabilityTimer);
              customWindow.__pushDone();

              // 生成完畢後，直接提取當前容器最終完整的 innerText
              const container = getLatestContainer();
              resolve(container ? (container.innerText || '') : '');
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

    // 優先使用 DOM 最終完整文本，若無則回退至串流累積文字
    const resolvedText = finalDomText.trim() ? finalDomText : rawFullText;

    console.log(`[DeepSeek] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: resolvedText, currentPath };
  }
}
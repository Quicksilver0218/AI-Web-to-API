import type { Page } from 'playwright';
import { WebAiProvider } from './web-ai-provider.ts';
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
        console.log(`[Gemini] Tab is already on the target conversation page (${targetPath}), continuing directly.`);
      }
    } else {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== '/app') {
        console.log(`[Gemini] Opening new conversation home page...`);
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

    await input.click();
    await input.fill(prompt);

    const sendBtn = page.locator(this.selectors.SEND_BUTTON).first();
    if (await sendBtn.isVisible()) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // No timeout constraint to prevent false timeouts during long generation
    await page.waitForFunction(
      ({ selector, count }: WaitForFunctionParams) => document.querySelectorAll(selector).length > count,
      { selector: this.selectors.RESPONSE_CONTAINER, count: targetIndex },
      { timeout: 0 }
    );

    let rawFullText = '';
    const chunkListener = (delta: string) => {
      rawFullText += delta;
      onRawChunk(delta);
    };
    emitter.on('chunk', chunkListener);

    try {
      await page.evaluate(
        ({ selector, index, stopSelector }: BrowserEvaluateParams) => {
          return new Promise<void>((resolve) => {
            const container = document.querySelectorAll(selector)[index] as HTMLElement | undefined;
            const customWindow = window as unknown as WindowWithCustomEvents;

            let lastLen = 0;
            let isDone = false;
            let stabilityTimer: number | null = null;

            function emitDelta() {
              if (!container) return;
              const currentText = container.innerText || '';
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
              resolve();
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

    console.log(`[Gemini] Worker #${id} generation completed. Current URL path: ${currentPath}`);
    return { rawText: rawFullText, currentPath };
  }
}
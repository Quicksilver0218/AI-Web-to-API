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
  readonly baseUrl = 'https://aistudio.google.com/prompts/new_chat?model=gemini-3.8-flash';

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
    FILE_INPUT: 'input[type="file"]',
    MODEL_TURN: 'ms-chat-turn .chat-turn-container.model, ms-chat-turn[data-turn-role="Model"]',
  } as const;

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

    await page.waitForTimeout(2500);
    console.log('[AI Studio] Attachment uploaded and mounted.');
  }

  async navigateConversation(
    page: Page,
    isNewConversation: boolean,
    targetPath?: string
  ): Promise<void> {
    if (!isNewConversation && targetPath) {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== targetPath) {
        const targetFullUrl = `https://aistudio.google.com${targetPath}`;
        console.log(`[AI Studio] Switching to existing conversation: ${targetFullUrl}`);
        await page.goto(targetFullUrl, { waitUntil: 'domcontentloaded' });
      }
    } else {
      const currentUrlObj = new URL(page.url());
      if (!currentUrlObj.pathname.includes('/prompts/new_chat')) {
        console.log('[AI Studio] Opening new chat prompt page...');
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      }
    }

    await this.dismissAllDialogs(page);
  }

  async sendPromptAndObserve(
    worker: PageWorker,
    prompt: string,
    onRawChunk: (delta: string) => void
  ): Promise<{ rawText: string; currentPath: string }> {
    const { page, emitter, id } = worker;

    await this.dismissAllDialogs(page);

    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 20000 });

    const modelTurns = page.locator(this.selectors.MODEL_TURN);
    const prevCount = await modelTurns.count();
    console.log(`[AI Studio] Worker #${id} model turn count before prompt: ${prevCount}`);

    await input.click();
    await input.fill(prompt);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await page.waitForTimeout(300);

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
      await page.keyboard.press('Control+Enter');
    }

    await page.waitForTimeout(500);
    const remainingVal = await input.inputValue().catch(() => '');
    if (remainingVal.trim().length > 0) {
      console.log(`[AI Studio] Worker #${id} prompt remaining, executing forced submit...`);
      await input.focus();
      await page.keyboard.press('Control+Enter');
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
      },
      { timeout: 30000 }
    );

    console.log(`[AI Studio] Worker #${id} new model turn detected.`);

    let rawFullText = '';
    const chunkListener = (delta: string) => {
      rawFullText += delta;
      onRawChunk(delta);
    };
    emitter.on('chunk', chunkListener);

    let finalDomText = '';

    try {
      finalDomText = await page.evaluate(
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

              if (
                aria.includes('stop') ||
                aria.includes('cancel') ||
                txt.includes('stop') ||
                txt.includes('cancel')
              ) {
                return true;
              }

              if (btn.disabled && !txt.includes('run')) {
                return true;
              }

              return false;
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

            // 判斷當前內容是否包含表格（包括 DOM 結構或未編譯的 Markdown 管道符號）
            function hasTableContent(turn: HTMLElement | null): boolean {
              if (!turn) return false;
              if (turn.querySelector('table, .table-container') !== null) {
                return true;
              }
              const raw = turn.innerText || turn.textContent || '';
              return raw.includes('|');
            }

            function serializeTableCell(cell: Element): string {
              const clone = cell.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('code, .inline-code').forEach((cd) => {
                const t = cd.textContent?.trim() ?? '';
                if (t && !t.startsWith('`')) {
                  cd.replaceWith(document.createTextNode(`\`${t}\``));
                }
              });
              clone.querySelectorAll('strong, b').forEach((b) => {
                const t = b.textContent?.trim() ?? '';
                if (t && !t.startsWith('**')) {
                  b.replaceWith(document.createTextNode(`**${t}**`));
                }
              });
              clone.querySelectorAll('em, i').forEach((em) => {
                const t = em.textContent?.trim() ?? '';
                if (t && !t.startsWith('*')) {
                  em.replaceWith(document.createTextNode(`*${t}*`));
                }
              });
              const text = (clone.textContent ?? '').trim();
              return text.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|');
            }

            function convertTableToMarkdown(table: HTMLTableElement): string {
              const rows = Array.from(table.querySelectorAll('tr'));
              if (rows.length === 0) return '';

              const rowData: string[][] = [];
              let maxCols = 0;

              for (const row of rows) {
                const cells = Array.from(row.querySelectorAll('th, td'));
                if (cells.length === 0) continue;
                const cellTexts = cells.map(serializeTableCell);
                if (cellTexts.length > maxCols) maxCols = cellTexts.length;
                rowData.push(cellTexts);
              }

              if (rowData.length === 0 || maxCols === 0) return '';

              const mdRows: string[] = [];

              // 表頭
              const headerCells = rowData[0];
              while (headerCells.length < maxCols) headerCells.push('');
              mdRows.push(`| ${headerCells.join(' | ')} |`);

              // 分隔線
              const delimiters = Array(maxCols).fill('---');
              mdRows.push(`| ${delimiters.join(' | ')} |`);

              // 資料列
              for (let r = 1; r < rowData.length; r++) {
                const rowCells = rowData[r];
                while (rowCells.length < maxCols) rowCells.push('');
                mdRows.push(`| ${rowCells.join(' | ')} |`);
              }

              return `\n\n${mdRows.join('\n')}\n\n`;
            }

            function extractCleanText(turnRoot: HTMLElement | null): string {
              if (!turnRoot) return '';
              const clone = turnRoot.cloneNode(true) as HTMLElement;

              // 清理 Thinking 與 UI 雜訊
              clone
                .querySelectorAll(
                  'ms-thought-chunk, ms-thought-panel, ms-thought, mat-expansion-panel, .thought-container, .thought-chunk, .thought-wrapper, [class*="thought-"], [class*="thinking-"], ms-collapsible-container, ms-chat-turn-options, ms-grounding-sources, ms-search-entry-point, ms-hallucinations-disclaimer, mat-expansion-panel-header, .actions, .turn-footer, .author-label, button, mat-icon'
                )
                .forEach((el) => el.remove());

              clone.querySelectorAll('h1, h2, h3, h4, p, span, div').forEach((el) => {
                const t = el.textContent?.trim();
                if (t === 'Thinking' || t === 'Thought' || t === 'Thoughts') {
                  el.remove();
                }
              });

              clone.querySelectorAll('.katex').forEach((katex) => {
                const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
                const rawTex = annotation?.textContent ?? '';
                katex.replaceWith(document.createTextNode(`$${rawTex}$`));
              });

              clone.querySelectorAll('pre').forEach((pre) => {
                const code = pre.querySelector('code');
                const content = (code ?? pre).textContent ?? '';
                pre.replaceWith(document.createTextNode(`\n\`\`\`\n${content.trim()}\n\`\`\`\n`));
              });

              // 將所有 HTML Table 轉換為合規 Markdown
              clone.querySelectorAll('table').forEach((table) => {
                const mdTable = convertTableToMarkdown(table as HTMLTableElement);
                const wrapper = table.closest('.table-container') || table;
                wrapper.replaceWith(document.createTextNode(mdTable));
              });

              clone.querySelectorAll('code, .inline-code').forEach((code) => {
                const text = code.textContent?.trim() ?? '';
                if (text && !text.startsWith('`')) {
                  code.replaceWith(document.createTextNode(`\`${text}\``));
                }
              });
              clone.querySelectorAll('b, strong').forEach((b) => {
                const text = b.textContent?.trim() ?? '';
                if (text && !text.startsWith('**')) {
                  b.replaceWith(document.createTextNode(`**${text}**`));
                }
              });
              clone.querySelectorAll('em, i').forEach((em) => {
                const text = em.textContent?.trim() ?? '';
                if (text && !text.startsWith('*')) {
                  em.replaceWith(document.createTextNode(`*${text}*`));
                }
              });

              clone.querySelectorAll('h1').forEach((h) => h.replaceWith(document.createTextNode(`\n\n# ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h2').forEach((h) => h.replaceWith(document.createTextNode(`\n\n## ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h3').forEach((h) => h.replaceWith(document.createTextNode(`\n\n### ${h.textContent?.trim() ?? ''}\n\n`)));
              clone.querySelectorAll('h4, h5, h6').forEach((h) => h.replaceWith(document.createTextNode(`\n\n#### ${h.textContent?.trim() ?? ''}\n\n`)));

              clone.querySelectorAll('ol, ul').forEach((list) => {
                const isOrdered = list.tagName.toLowerCase() === 'ol';
                const items = Array.from(list.querySelectorAll(':scope > li, :scope > ms-cmark-node > li'));
                const mdItems = items.map((li, idx) => {
                  li.querySelectorAll('p').forEach((p) => {
                    p.replaceWith(document.createTextNode(p.textContent?.trim() ?? ''));
                  });
                  const text = (li.textContent ?? '').trim();
                  const prefix = isOrdered ? `${idx + 1}. ` : '- ';
                  return `${prefix}${text}`;
                });
                list.replaceWith(document.createTextNode(`\n\n${mdItems.join('\n')}\n\n`));
              });

              clone.querySelectorAll('blockquote').forEach((bq) => {
                const text = bq.textContent?.trim() ?? '';
                bq.replaceWith(document.createTextNode(`\n\n> ${text.replace(/\n/g, '\n> ')}\n\n`));
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
            let lastObservedRawLen = 0;
            let lastDomChangeTime = Date.now();
            let isDone = false;

            function updateDomActivity(turn: HTMLElement | null): void {
              if (!turn) return;
              const currentRawLen = (turn.textContent || '').length;
              if (currentRawLen !== lastObservedRawLen) {
                lastObservedRawLen = currentRawLen;
                lastDomChangeTime = Date.now();
              }
            }

            function emitDelta(): void {
              if (isDone) return;
              const turn = getLatestTurn();
              if (!turn) return;

              updateDomActivity(turn);

              // 【核心隔離防護】：一旦偵測到包含表格元素或符號，立即停止發送零碎切片！
              // 整張表格將在 finish() 觸發時一次性原子化推送，徹底根絕字串撕裂
              if (hasTableContent(turn)) {
                return;
              }

              const currentText = extractCleanText(turn);
              if (currentText.length > lastLen) {
                const delta = currentText.slice(lastLen);
                lastLen = currentText.length;
                customWindow.__pushChunk(delta);
              }
            }

            async function finish(): Promise<void> {
              if (isDone) return;
              isDone = true;

              observer.disconnect();
              clearInterval(intervalTimer);

              const turn = getLatestTurn();
              // 最終交付：將已完全固定的表格及後續文字一次性結算送出
              const finalText = extractCleanText(turn);
              if (finalText.length > lastLen) {
                const finalDelta = finalText.slice(lastLen);
                lastLen = finalText.length;
                await customWindow.__pushChunk(finalDelta);
              }
              await customWindow.__pushDone();
              resolve(finalText);
            }

            const observer = new MutationObserver(() => {
              const skipBtn = document.querySelector(
                'ms-inline-preference-vote button[data-test-id="skip-button"], button[aria-label="Skip preference vote"]'
              ) as HTMLElement | null;
              if (skipBtn && skipBtn.offsetParent !== null && !skipBtn.hasAttribute('disabled')) {
                skipBtn.click();
              }

              const turn = getLatestTurn();
              updateDomActivity(turn);
              emitDelta();
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });

            const intervalTimer = window.setInterval(() => {
              if (isDone) return;
              const turn = getLatestTurn();
              updateDomActivity(turn);
              emitDelta();

              const currentRaw = turn ? extractCleanText(turn) : '';
              const running = isAiStudioRunning();

              // 工具呼叫完成立即結束
              if (!running && currentRaw.includes('@use_mcp_tool') && hasCompleteToolCall(currentRaw)) {
                void finish();
                return;
              }

              // A/B 評估對話框出現立即結束
              const vote = document.querySelector('ms-inline-preference-vote .inline-preference-options');
              if (vote) {
                void finish();
                return;
              }

              // 基於實際 DOM 停止生長時間判定完成（無關表格是否凍結）
              if (!running && lastObservedRawLen > 0 && Date.now() - lastDomChangeTime > 1200) {
                void finish();
                return;
              }

              // 兜底超時結束
              if (lastObservedRawLen > 0 && Date.now() - lastDomChangeTime > 4000) {
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
    } finally {
      const resolvedText = finalDomText.trim() ? finalDomText : rawFullText;
      if (resolvedText.length > rawFullText.length) {
        const gapRemainder = resolvedText.slice(rawFullText.length);
        onRawChunk(gapRemainder);
        rawFullText = resolvedText;
      }

      emitter.off('chunk', chunkListener);
    }

    await this.dismissAllDialogs(page);

    const currentUrlObj = new URL(page.url());
    const currentPath = currentUrlObj.pathname;
    const resolvedText = finalDomText.trim() ? finalDomText : rawFullText;

    console.log(`[AI Studio] Worker #${id} generation completed. Total chars: ${resolvedText.length}`);
    return { rawText: resolvedText, currentPath };
  }
}
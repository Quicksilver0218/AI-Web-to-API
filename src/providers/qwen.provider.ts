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
  expandSelector: string;
  thinkSelector: string;
  dualSelector: string;
  errorCardSelector: string;
  isModelRunningCode: string;
}

interface ObserveResult {
  status: 'done' | 'dual_screen' | 'timeout';
  text: string;
}

/**
 * 統一的運行狀態判斷函式（瀏覽器環境執行）
 */
function isModelRunning(stopSelector: string): boolean {
  const btn = document.querySelector(stopSelector) as HTMLElement | null;
  return btn !== null && btn.offsetParent !== null;
}

export class QwenProvider extends WebAiProvider {
  readonly name = 'Qwen';
  readonly baseUrl = 'https://chat.qwen.ai';

  private readonly selectors = {
    PROMPT_INPUT: 'div.message-input-editor textarea',
    SEND_BUTTON:
      'button.send-button:not(.disabled), button[aria-label*="Send"]:not([disabled]), button[aria-label*="傳送"]:not([disabled])',
    STOP_BUTTON: 'button.stop-button',
    TURN_CONTAINER: '.chat-response-message',
    RESPONSE_CONTENT: '.response-message-content',
    // 額度上限或異常錯誤卡片
    ERROR_CARD: 'section.exceed-limit-error-card, [data-testid="exceed-limit-error-card"], [class*="error-card"]',
    // 雙回應 A/B 選擇畫面
    DUAL_MESSAGE_CONTAINER: '.qwen-chat-message-dual-message, .smrm',
    // 展開思考面板的切換元件
    EXPAND_THINKING: '.qwen-chat-status-card div, .qwen-chat-tool-status-card',
    // 思考內容容器（於側邊欄顯示）
    THINK_CONTENT: '.qwen-chat-thinking-and-sources-content-thinking-container',
    MODEL_PICKER_BUTTON: '[role="button"][aria-label="Select Model"]',
    MODEL_MENU: '.wms-list[aria-label="模型"]',
    MODEL_MENU_ITEM: '.wms-list__item',
    THINKING_EFFORT_TRIGGER: '.qwen-thinking-selector .qwen-chat-v2-dropdown-menu-select',
    THINKING_EFFORT_MENU: '[role="menu"]:is([aria-label="Thinking"], [aria-label="思考中"]) .qwen-chat-v2-dropdown-menu-popup-list',
    THINKING_EFFORT_OPTION: '[role="menuitem"]',
    MODE_SELECT_TRIGGER: '[class*="mode-select-open"][role="button"], div.mode-select-open',
    MODE_SELECT_DROPDOWN_MENU: '.mode-select-dropdown-menu',
    UPLOAD_MENU_ITEM: '[role="menuitem"]:has-text("Upload attachment"), [role="menuitem"]:has-text("上傳附件")',
    ATTACHMENT_PREVIEW: '.message-input-column-file',
    UPLOAD_SPIN_ICON: '.file-content-icon .anticon-spin',
    FILE_INPUT: 'input[type="file"]',
  } as const;

  protected override async executeStop(worker: PageWorker): Promise<void> {
    await this.stopTemplate(worker, {
      isRunningFn: isModelRunning,
      isRunningArg: this.selectors.STOP_BUTTON,
      stopButtonSelector: this.selectors.STOP_BUTTON,
    });
  }

  protected override async setModel(page: Page, model?: string): Promise<void> {
    if (!model) return;
    const targetModel = model.trim().toLowerCase().replace(/-/g, '');
    if (!targetModel.startsWith('qwen')) return;

    try {
      const pickerBtn = page.locator(this.selectors.MODEL_PICKER_BUTTON).first();
      if (!(await pickerBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log(`[${this.name}] Model picker button not found, skipping model setting.`);
        return;
      }

      const currentModelText = (
        await pickerBtn.textContent({ timeout: 5000 }).catch(() => '')
      )?.trim().toLowerCase().replace(/-/g, '') ?? '';
      if (currentModelText === targetModel) {
        console.log(`[${this.name}] Model already set to "${currentModelText}". Skipping model selection.`);
        return;
      }

      await pickerBtn.click({ timeout: 5000 });

      const modelMenu = page.locator(this.selectors.MODEL_MENU).first();
      await modelMenu.waitFor({ state: 'visible', timeout: 5000 });

      const menuItems = modelMenu.locator(this.selectors.MODEL_MENU_ITEM);
      const itemCount = await menuItems.count();
      let matchedIndex = -1;
      for (let i = 0; i < itemCount; i++) {
        const itemText = (
          await menuItems.nth(i).textContent({ timeout: 5000 }).catch(() => '')
        )?.trim().toLowerCase().replace(/-/g, '') ?? '';
        if (itemText.includes(targetModel)) {
          matchedIndex = i;
          break;
        }
      }
      const matched = matchedIndex >= 0 ? menuItems.nth(matchedIndex) : null;

      if (matched && (await matched.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log(`[${this.name}] Selecting model: "${targetModel}"...`);
        await matched.first().click({ timeout: 5000 });
      } else {
        console.warn(`[${this.name}] Model "${targetModel}" not found in menu, falling back to the first option...`);
        await menuItems.first().click({ timeout: 5000 });
      }

      for (let i = 0; i < 3; i++) {
        const isExpanded = (await pickerBtn.getAttribute('aria-expanded')) === 'true';
        const hasMenu = (await page.locator(this.selectors.MODEL_MENU).count()) > 0;
        if (isExpanded || hasMenu)
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
    type ThinkingState = 'auto' | 'thinking' | 'fast';

    let target: ThinkingState;
    if (level === undefined || level.trim() === '') {
      target = 'auto';
    } else {
      const normalized = level.trim().toLowerCase().replace(/[-_]/g, '');
      if (['none', 'low', 'fast'].includes(normalized))
        target = 'fast';
      else if (['medium', 'high', 'xhigh', 'extrahigh', 'thinking'].includes(normalized))
        target = 'thinking';
      else
        target = 'auto';
    }

    const optionMap: Record<ThinkingState, { label: string; regex: RegExp }> = {
      auto: { label: 'Auto', regex: /auto|自動/i },
      thinking: { label: 'Thinking', regex: /thinking|思考/i },
      fast: { label: 'Fast', regex: /fast|快速/i },
    };
    const targetOption = optionMap[target];

    try {
      const effortTrigger = page.locator(this.selectors.THINKING_EFFORT_TRIGGER).first();
      if (!(await effortTrigger.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.warn(`[${this.name}] "Thinking effort" trigger not found (model may not support thinking levels).`);
        return;
      }

      const currentText = (await effortTrigger.textContent({ timeout: 5000 }).catch(() => ''))?.trim().toLowerCase() ?? '';
      const currentState: ThinkingState | null =
        /fast|快速/.test(currentText) ? 'fast'
          : /auto|自動/.test(currentText) ? 'auto'
            : /thinking|思考/.test(currentText) ? 'thinking'
              : null;
      if (currentState === target) {
        console.log(`[${this.name}] Thinking level already set to "${targetOption.label}" (${target}). Skipping.`);
        return;
      }

      await effortTrigger.click({ timeout: 5000 });

      const effortMenu = page.locator(this.selectors.THINKING_EFFORT_MENU).first();
      await effortMenu.waitFor({ state: 'visible', timeout: 5000 });

      const options = effortMenu.locator(this.selectors.THINKING_EFFORT_OPTION);
      const count = await options.count();

      let clicked = false;
      for (let i = 0; i < count && !clicked; i++) {
        const option = options.nth(i);
        const optionText = (await option.textContent({ timeout: 5000 }).catch(() => ''))?.trim() ?? '';

        if (targetOption.regex.test(optionText)) {
          console.log(`[${this.name}] Selecting thinking level "${optionText}" (${target})...`);
          await option.click({ timeout: 5000 }).catch(() => { });
          clicked = true;
        }
      }

      if (!clicked)
        console.warn(`[${this.name}] Thinking level option "${targetOption.label}" not found in menu.`);

      for (let i = 0; i < 3; i++) {
        if (await effortMenu.isVisible({ timeout: 1000 }).catch(() => false))
          await page.keyboard.press('Escape').catch(() => { });
        else
          break;
      }

      console.log(`[${this.name}] Thinking level switch completed. Ready for prompt input.`);
    } catch (err) {
      console.warn(`[${this.name}] setThinkingLevel warning:`, err);
      await page.keyboard.press('Escape').catch(() => { });
    }
  }

  override async uploadFile(page: Page, filePath: string): Promise<void> {
    console.log(`[${this.name}] Uploading attachment file: ${filePath}`);

    const trigger = page.locator(this.selectors.MODE_SELECT_TRIGGER).first();
    await trigger.waitFor({ state: 'visible', timeout: 5000 });

    const label = (await trigger.getAttribute('aria-label').catch(() => '')) ?? '';
    const alreadyInUploadMode = /upload|附件|上傳/i.test(label);

    const fileChooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await trigger.click({ timeout: 5000 });

    if (!alreadyInUploadMode) {
      const dropdownMenu = page.locator(this.selectors.MODE_SELECT_DROPDOWN_MENU).first();
      await dropdownMenu.waitFor({ state: 'visible', timeout: 5000 });

      const uploadItem = dropdownMenu.locator(this.selectors.UPLOAD_MENU_ITEM).first();
      await uploadItem.waitFor({ state: 'visible', timeout: 5000 });
      await uploadItem.click({ timeout: 5000 });
    }

    try {
      const chooser = await fileChooser;
      await chooser.setFiles(filePath);
    } catch {
      const fileInput = page.locator(this.selectors.FILE_INPUT).first();
      await fileInput.waitFor({ state: 'attached', timeout: 5000 });
      await fileInput.setInputFiles(filePath);
    }

    const preview = page.locator(this.selectors.ATTACHMENT_PREVIEW).first();
    await preview.waitFor({ state: 'visible', timeout: 20000 });
    console.log(`[${this.name}] Attachment successfully uploaded and mounted.`);
  }

  override async navigateConversation(page: Page, isNewConversation: boolean, targetPath?: string): Promise<void> {
    if (isNewConversation) {
      const existingTurns = await page.locator(this.selectors.TURN_CONTAINER).count().catch(() => 0);

      const hasInputText = await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const value =
            (el as HTMLTextAreaElement).value ??
            (el as HTMLElement).innerText ??
            (el as HTMLElement).textContent ??
            '';
          if (value.trim().length > 0)
            return true;
        }
        return false;
      }, this.selectors.PROMPT_INPUT).catch(() => false);

      const hasFiles = await page.locator(this.selectors.ATTACHMENT_PREVIEW).count().catch(() => 0);

      const isDirty =
        this.dirtyPages.has(page) ||
        existingTurns > 0 ||
        hasInputText ||
        hasFiles > 0;

      if (isDirty) {
        console.log(`[${this.name}] Page is dirty or starting new session. Force reloading to baseUrl...`);
        await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
        this.dirtyPages.delete(page);
      }
      return;
    }

    if (targetPath && targetPath !== '/') {
      const currentUrlObj = new URL(page.url());
      if (currentUrlObj.pathname !== targetPath) {
        const targetFullUrl = `${this.baseUrl}${targetPath}`;
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
    return await page.locator(this.selectors.TURN_CONTAINER).count();
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    const input = page.locator(this.selectors.PROMPT_INPUT).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });

    if (await page.locator(this.selectors.ATTACHMENT_PREVIEW).count()) {
      const spinIcons = page.locator(this.selectors.UPLOAD_SPIN_ICON);
      if ((await spinIcons.count()) > 0) {
        console.log(`[${this.name}] Attachment detected, waiting for upload to complete before sending...`);
        await page
          .waitForFunction(
            (sel: string) =>
              Array.from(document.querySelectorAll(sel)).every(
                (el) => (el as HTMLElement).offsetParent === null
              ),
            this.selectors.UPLOAD_SPIN_ICON,
            { timeout: 30000 }
          )
          .catch(() => { });
      }
    }

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
    const remainingText = await input.inputValue().catch(() => '');
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
    const observeOptions: SendPromptOptions = { ...options, thinkingLevel: options?.thinkingLevel ?? 'auto' };
    const result = await super.sendPromptAndObserve(worker, prompt, onRawChunk, observeOptions);
    if (result)
      return result;

    const { page, emitter, id } = worker;
    try {
      let turnSnapshot = await this.getTurnSnapshot(page);
      console.log(`[${this.name}] Worker #${id} turn snapshot before prompt: ${turnSnapshot}`);

      await this.submitPrompt(page, prompt);

      const abortInitialWait = new Promise<void>((_, reject) => {
        if (options?.abortSignal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        options?.abortSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });

      const waitForNewTurn = async (prevSnapshot: number): Promise<boolean> => {
        try {
          await Promise.race([
            page.waitForFunction(
              ({ turnSelector, prevSnapshot: snap }: WaitForTurnParams) =>
                document.querySelectorAll(turnSelector).length > snap,
              { turnSelector: this.selectors.TURN_CONTAINER, prevSnapshot },
              { timeout: 5000 }
            ),
            abortInitialWait,
          ]);
          return true;
        } catch (waitErr) {
          if (options?.abortSignal?.aborted) {
            console.warn(`[${this.name}] Worker #${id} aborted during turn wait. Triggering stop...`);
            await this.stop(worker);
            return false;
          }
          throw waitErr;
        }
      };

      if (!(await waitForNewTurn(turnSnapshot))) {
        return { rawText: '[Generation Aborted by Client]', currentPath: this.getCurrentPath(page) };
      }

      console.log(`[${this.name}] Worker #${id} new model turn detected.`);

      let rawFullMainText = '';
      let hasEmittedReasoning = false;
      let hasEmittedContent = false;

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
          if (!hasEmittedContent) {
            hasEmittedReasoning = true;
            onRawChunk(delta, true);
          }
        } else {
          // 當 Thinking 結束並直接開始輸出 @use_mcp_tool 時，先送出零寬度字元通知 Cline 結束 Thinking 顯示
          if (hasEmittedReasoning && !hasEmittedContent && delta.trimStart().startsWith('@use_mcp')) {
            onRawChunk('\u200B', false);
          }
          hasEmittedContent = true;
          rawFullMainText += delta;
          onRawChunk(delta, false);
        }
      };
      emitter.on('chunk', chunkListener);

      let finalMainText = '';
      const maxDualRetries = 5;

      const stopAndSendContinue = async (attempt: number): Promise<boolean> => {
        console.log(
          `[${this.name}] Worker #${id} dual-response selection screen detected (${attempt}/${maxDualRetries}). Stopping and sending "Continue"...`
        );

        const running = await page.evaluate(isModelRunning, this.selectors.STOP_BUTTON).catch(() => false);
        if (running) {
          await this.stop(worker);
        } else {
          this.markPageDirty(page);
        }

        await page.waitForTimeout(500);

        if (options?.abortSignal?.aborted) {
          finalMainText = '[Generation Aborted by Client]';
          return false;
        }

        turnSnapshot = await this.getTurnSnapshot(page);
        await this.submitPrompt(page, 'Continue');

        if (!(await waitForNewTurn(turnSnapshot))) {
          finalMainText = '[Generation Aborted by Client]';
          return false;
        }

        rawFullMainText = '';
        hasEmittedReasoning = false;
        hasEmittedContent = false;
        return true;
      };

      try {
        for (let attempt = 1; attempt <= maxDualRetries; attempt++) {
          if (options?.abortSignal?.aborted) {
            await this.stop(worker);
            finalMainText = '[Generation Aborted by Client]';
            break;
          }

          // 若已直接進入選擇畫面，立即按停止並發送 Continue
          const hasDualScreen = await page
            .evaluate((sel: string) => document.querySelector(sel) !== null, this.selectors.DUAL_MESSAGE_CONTAINER)
            .catch(() => false);

          if (hasDualScreen) {
            const continued = await stopAndSendContinue(attempt);
            if (!continued) break;
            continue;
          }

          await this.ensureBrowserHelpers(page);

          const evalPromise = page.evaluate(
            ({
              turnSelector,
              targetIndex,
              stopSelector,
              expandSelector,
              thinkSelector,
              dualSelector,
              errorCardSelector,
              isModelRunningCode,
            }: ObserveStreamParams) => {
              return new Promise<ObserveResult>(async (resolve) => {
                let container = document.querySelectorAll(turnSelector)[targetIndex] as HTMLElement | undefined;
                const customWindow = window as unknown as WindowWithCustomEvents;
                const { rehydrate, hasCompleteToolCall, extractReactBlockMarkdown, domToMarkdown } = customWindow.__webAiHelpers!;
                const checkRunning = rehydrate<boolean>(isModelRunningCode);
                const isModelRunning = (): boolean => checkRunning(stopSelector);

                function tryExpandThinking(root: HTMLElement | undefined): void {
                  if (!root) return;
                  if (document.querySelector(thinkSelector)) return;
                  const el = root.querySelector(expandSelector) as HTMLElement | null;
                  if (el && el.offsetParent !== null) {
                    el.click();
                  }
                }

                function getErrorCardText(turnRoot: HTMLElement | undefined): string {
                  if (!turnRoot) return '';
                  const card = turnRoot.querySelector(errorCardSelector) as HTMLElement | null;
                  if (!card) return '';

                  const clone = card.cloneNode(true) as HTMLElement;
                  clone
                    .querySelectorAll('button, svg, .exceed-limit-error-card-actions, [class*="actions"]')
                    .forEach((el) => el.remove());
                  return (clone.textContent ?? '').trim().replace(/\s+/g, ' ');
                }

                function getThoughtText(): string {
                  const thinkRoot = document.querySelector(thinkSelector);
                  if (!thinkRoot) return '';

                  // 遍歷所有思考階段卡片（.qwen-chat-thinking-status-card），逐張提取標題與原始 Markdown
                  const statusCards = Array.from(thinkRoot.querySelectorAll('.qwen-chat-thinking-status-card'));
                  if (statusCards.length > 0) {
                    const cardParts: string[] = [];

                    for (const card of statusCards) {
                      const phaseId = card.getAttribute('data-phase-id') ?? '';
                      const titleEl = card.querySelector(
                        '.qwen-chat-thinking-status-card-title-text, .qwen-chat-thinking-status-card-title'
                      );
                      const titleText = titleEl?.textContent.trim() ?? '';

                      const mdEl = card.querySelector('.qwen-markdown');
                      let bodyText = '';

                      if (mdEl) {
                        const rawBlockMd = extractReactBlockMarkdown(mdEl, {
                          isThought: true,
                          maxDepth: 10,
                        });

                        if (rawBlockMd !== null && rawBlockMd.trim().length > 0) {
                          bodyText = rawBlockMd.trim();
                        } else {
                          const mdClone = mdEl.cloneNode(true) as HTMLElement;
                          mdClone.querySelectorAll('[role="img"]').forEach((el) => el.remove());
                          bodyText = domToMarkdown(mdClone);
                        }
                      }

                      // 略過僅標示「已經完成思考」的結尾狀態卡，避免在正文開始後觸發多餘的 reasoning delta
                      if (!bodyText && (phaseId.endsWith('_finished') || titleText === '已經完成思考' || titleText === '思考被終止')) {
                        continue;
                      }

                      if (titleText)
                        cardParts.push(`【${titleText}】`);
                      if (bodyText)
                        cardParts.push(bodyText);
                    }

                    if (cardParts.length > 0) {
                      return cardParts.join('\n\n').trim();
                    }
                  }

                  // 若無分段卡片結構，則提取所有 .qwen-markdown 區塊或退回 DOM 轉換
                  const mdBlocks = Array.from(thinkRoot.querySelectorAll('.qwen-markdown'));
                  if (mdBlocks.length > 0) {
                    const parts = mdBlocks
                      .map((mdEl) => {
                        const rawMd = extractReactBlockMarkdown(mdEl, {
                          isThought: true,
                          maxDepth: 10,
                        });
                        if (rawMd !== null && rawMd.trim().length > 0) return rawMd.trim();
                        return domToMarkdown(mdEl as HTMLElement);
                      })
                      .filter((t) => t.length > 0);

                    if (parts.length > 0) return parts.join('\n\n').trim();
                  }

                  const clone = thinkRoot.cloneNode(true) as HTMLElement;
                  clone
                    .querySelectorAll('[role="img"]')
                    .forEach((el) => el.remove());

                  return domToMarkdown(clone);
                }

                function getMainText(turnRoot: HTMLElement | undefined): string {
                  if (!turnRoot) return '';

                  const contentEls = Array.from(turnRoot.querySelectorAll('div.response-message-content')) as HTMLElement[];
                  if (contentEls.length > 0) {
                    const blockTexts = contentEls.map((mainEl) => {
                      const rawReact = extractReactBlockMarkdown(mainEl, {
                        isThought: false,
                        markdownSelector: '.qwen-markdown, [class*="markdown"]',
                        includeChildrenProp: true,
                        maxDepth: 10,
                      });
                      if (rawReact) return rawReact;

                      const elClone = mainEl.cloneNode(true) as HTMLElement;
                      elClone
                        .querySelectorAll('button, .qwen-markdown-code-header, [class*="qwen-markdown-code-header"]')
                        .forEach((node) => node.remove());
                      return domToMarkdown(elClone);
                    });

                    return blockTexts.join('\n').trim();
                  }

                  return '';
                }

                let lastThoughtLen = 0;
                let lastMainLen = 0;
                let lastChangeTime = Date.now();
                let isThinkingEnded = false;
                let isDone = false;

                async function emitDelta() {
                  if (!container || isDone) return;

                  const currentMain = getMainText(container);

                  // 一旦正文開始產生（或已出現 .response-message-content 內容），立即視為 Thinking 已結束
                  if (!isThinkingEnded && (currentMain.length > 0 || lastMainLen > 0)) {
                    isThinkingEnded = true;
                  }

                  if (!isThinkingEnded) {
                    tryExpandThinking(container);

                    const currentThought = getThoughtText();
                    if (currentThought.length > lastThoughtLen) {
                      const thoughtDelta = currentThought.slice(lastThoughtLen);
                      lastThoughtLen = currentThought.length;
                      lastChangeTime = Date.now();
                      await customWindow.__pushChunk(
                        JSON.stringify({ type: 'reasoning', delta: thoughtDelta })
                      );
                    }
                  }

                  if (currentMain.length > lastMainLen) {
                    const mainDelta = currentMain.slice(lastMainLen);
                    lastMainLen = currentMain.length;
                    lastChangeTime = Date.now();
                    await customWindow.__pushChunk(
                      JSON.stringify({ type: 'content', delta: mainDelta })
                    );
                  }
                }

                async function finish(status: ObserveResult['status'], text: string) {
                  if (isDone) return;
                  isDone = true;
                  window.clearInterval(timer);
                  resolve({ status, text });
                }

                const timer = window.setInterval(async () => {
                  if (isDone) return;

                  // 遇到雙回應選擇畫面時，立即回報 dual_screen 由外部執行停止並發送 Continue
                  if (document.querySelector(dualSelector)) {
                    void finish('dual_screen', '');
                    return;
                  }

                  if (!container || !container.isConnected) {
                    container = document.querySelectorAll(turnSelector)[targetIndex] as HTMLElement | undefined;
                  }

                  await emitDelta();
                  try {
                    const running = isModelRunning();
                    if (!isThinkingEnded) {
                      tryExpandThinking(container);
                    }
                    const currentMain = getMainText(container);
                    const hasGeneratedAny = lastThoughtLen > 0 || lastMainLen > 0;

                    // 檢查是否出現額度上限或錯誤提示卡片
                    if (!running) {
                      const errorCardText = getErrorCardText(container);
                      if (errorCardText) {
                        const formattedError = `[Error]: ${errorCardText}`;
                        if (lastMainLen === 0) {
                          await customWindow.__pushChunk(
                            JSON.stringify({ type: 'content', delta: formattedError })
                          );
                        }
                        void finish('done', formattedError);
                        return;
                      }
                    }

                    if (!running && currentMain.includes('@use_mcp_tool') && hasCompleteToolCall(currentMain)) {
                      void finish('done', currentMain);
                      return;
                    }

                    if (!running && hasGeneratedAny && Date.now() - lastChangeTime > 1500) {
                      void finish('done', currentMain);
                      return;
                    }

                    if (!running && Date.now() - lastChangeTime > 5000) {
                      void finish('done', currentMain);
                      return;
                    }
                  } catch {
                    // 忽略單次輪詢例外，繼續觀察
                  }
                }, 200);

                await emitDelta();
              });
            },
            {
              turnSelector: this.selectors.TURN_CONTAINER,
              targetIndex: turnSnapshot,
              stopSelector: this.selectors.STOP_BUTTON,
              expandSelector: this.selectors.EXPAND_THINKING,
              thinkSelector: this.selectors.THINK_CONTENT,
              dualSelector: this.selectors.DUAL_MESSAGE_CONTAINER,
              errorCardSelector: this.selectors.ERROR_CARD,
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

          if (evalResult.status === 'dual_screen') {
            const continued = await stopAndSendContinue(attempt);
            if (!continued) break;
            continue;
          }

          if (options?.abortSignal?.aborted || evalResult.status === 'timeout') {
            await this.stop(worker);
          }

          finalMainText = evalResult.text;
          break;
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
      if (currentPath === '/') {
        await page
          .waitForFunction(
            () => {
              const u = new URL(window.location.href);
              return u.pathname.length > 1 && u.pathname !== '/auth';
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
import { chromium } from 'playwright';
import readline from 'readline';

export async function runLoginFlow(profilePath: string): Promise<void> {
  console.log('[Gemini Login] Launching Chrome window with persistent profile...');

  // 使用持久化目錄啟動真實 Chrome 視窗
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    channel: 'chrome', // 調用本機安裝的真實 Google Chrome，避開 Google 的 bot 阻擋
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());

  // 直接前往 Google 帳號登入入口，登入後自動導回 Gemini
  await page.goto('https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app');

  console.log('\n======================================================');
  console.log('1. Please complete the login process in the opened browser window.');
  console.log('2. Pass any Cloudflare Turnstile or CAPTCHA verification if prompted.');
  console.log('3. Verify that you have reached the main Gemini chat interface.');
  console.log('4. Return to this terminal and press Enter to save the session and exit.');
  console.log('======================================================\n');

  // 等待終端機確認
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('Press Enter after completing login: ', resolve));
  rl.close();

  await context.close();
  console.log(`[Gemini Login] Session successfully saved to: ${profilePath}`);
}
import { chromium } from 'playwright';
import path from 'path';
import readline from 'readline';

const USER_DATA_DIR = path.join(import.meta.dirname, './deepseek_profile');
const DEEPSEEK_URL = 'https://chat.deepseek.com/';

async function launchLoginFlow(): Promise<void> {
  console.log('[DeepSeek Login] Launching Chrome window with persistent profile...');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const existingPages = context.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

  await page.goto(DEEPSEEK_URL, { waitUntil: 'domcontentloaded' });

  console.log('\n======================================================');
  console.log('1. Please complete the login process in the opened browser window.');
  console.log('2. Pass any Cloudflare Turnstile or CAPTCHA verification if prompted.');
  console.log('3. Verify that you have reached the main DeepSeek chat interface.');
  console.log('4. Return to this terminal and press Enter to save the session and exit.');
  console.log('======================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    rl.question('Press Enter after completing login: ', () => {
      resolve();
    });
  });

  rl.close();
  await context.close();
  console.log(`[DeepSeek Login] Session successfully saved to: ${USER_DATA_DIR}`);
}

launchLoginFlow().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[DeepSeek Login] Fatal error:', message);
  process.exit(1);
});
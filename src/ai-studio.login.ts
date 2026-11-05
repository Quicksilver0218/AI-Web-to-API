import { chromium } from 'playwright';
import readline from 'readline';
import { waitForVpnConnection } from './utils.js';

const AISTUDIO_URL = 'https://aistudio.google.com/prompts/new_chat';

export async function runLoginFlow(profilePath: string, extensionPath?: string): Promise<void> {
  console.log('[AI Studio Login] Launching Chromium window with persistent profile...');
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      ...extensionPath ? [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ] : [],
    ],
  });

  const existingPages = context.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

  await waitForVpnConnection(page, 0);

  await page.goto(AISTUDIO_URL, { waitUntil: 'domcontentloaded' });

  console.log('\n======================================================');
  console.log('1. Please sign in with your Google Account in the opened browser.');
  console.log('2. Accept any initial Google AI Studio terms/onboarding popups.');
  console.log('3. Verify that you can see the prompt input area (new_chat).');
  console.log('4. Return to this terminal and press Enter to save the session.');
  console.log('======================================================\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('Press Enter after completing login: ', resolve));
  rl.close();

  await context.close();
  console.log(`[AI Studio Login] Session successfully saved to: ${profilePath}`);
}
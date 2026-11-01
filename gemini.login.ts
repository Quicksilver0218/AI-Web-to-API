import { chromium } from 'playwright';
import path from 'path';
import readline from 'readline';

const USER_DATA_DIR = path.join(import.meta.dirname, './gemini_profile');

async function launchLoginFlow() {
  console.log('正在開啟登入引導視窗...');

  // 使用持久化目錄啟動真實 Chrome 視窗
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome', // 調用本機安裝的真實 Google Chrome，避開 Google 的 bot 阻擋
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());
  
  // 直接前往 Google 帳號登入入口，登入後自動導回 Gemini
  await page.goto('https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app');

  console.log('\n======================================================');
  console.log('1. 請在跳出的瀏覽器視窗中手動輸入 Google 帳號與密碼。');
  console.log('2. 完成 2FA 二步驟驗證（若有勾選「在此裝置記住我」請勾選）。');
  console.log('3. 確認網頁已順利進入 Gemini 對話首頁。');
  console.log('4. 完成後回到此終端機，按下 Enter 鍵保存並關閉。');
  console.log('======================================================\n');

  // 等待終端機確認
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('完成登入後請按 Enter: ', resolve));
  rl.close();

  await context.close();
  console.log('登入狀態已成功持久化保存至 ./gemini_profile！');
}

launchLoginFlow().catch(console.error);
import type { Page } from "playwright";

export async function waitForVpnConnection(page: Page) {
  console.log('Checking VPN connection status...');
  let isVpnConnected = false;
  const ip = await fetch('https://api.ipify.org?format=json').then(res => res.json()).then(data => data.ip);

  for (let i = 0; i < 30; i++) { // 最多等待 30 次（每次 2 秒，共 60 秒）
    try {
      await page.goto('https://api.ipify.org?format=json', { timeout: 5000 });
      if ((await page.evaluate(() => JSON.parse(document.body.innerText))).ip !== ip) {
        isVpnConnected = true;
        break;
      }
    } catch (e) {
      console.log('Retrying...');
    }
    await new Promise(resolve => setTimeout(resolve, 2000)); // 等待 2 秒
  }

  if (!isVpnConnected) {
    throw new Error('VPN connection failed');
  }

  console.log('VPN connected');
}
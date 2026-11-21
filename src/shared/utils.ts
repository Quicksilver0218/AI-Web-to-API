import path from "path";
import type { Page } from "playwright";

export const BROWSER_DATA_PATH = path.join(import.meta.dirname, 'browser_data');

export const BROWSER_OPTIONS = {
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
};

export async function waitForVpnConnection(page: Page, timeout = 60) {
  console.log('Checking VPN connection status...');
  let isVpnConnected = false;
  const ip = await fetch('https://api.ipify.org?format=json').then(res => res.json()).then(data => data.ip);

  for (let i = 0; !timeout || i < timeout / 2; i++) {
    try {
      await page.goto('https://api.ipify.org?format=json', { timeout: 5000 });
      if ((await page.evaluate(() => JSON.parse(document.body.textContent))).ip !== ip) {
        isVpnConnected = true;
        break;
      }
    } catch (e) {
      console.log('Retrying...');
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (!isVpnConnected) {
    throw new Error('VPN connection failed');
  }

  console.log('VPN connected');
}
import path from "path";
import type { Page } from "playwright";

export const BROWSER_DATA_PATH = path.join(import.meta.dirname, 'browser_data');

export async function waitForVpnConnection(page: Page, timeout = 60) {
  console.log('Checking VPN connection status...');
  let isVpnConnected = false;
  const ip = await fetch('https://api.ipify.org?format=json').then(res => res.json()).then(data => data.ip);

  for (let i = 0; !timeout || i < timeout / 2; i++) {
    try {
      await page.goto('https://api.ipify.org?format=json', { timeout: 5000 });
      if ((await page.evaluate(() => JSON.parse(document.body.innerText))).ip !== ip) {
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
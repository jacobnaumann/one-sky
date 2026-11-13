// Renders the social-preview image (public/og.jpg) from the real page.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, timezoneId: 'Europe/Lisbon' })).newPage();
await page.goto((process.argv[2] ?? 'http://localhost:5173/') + '?hq', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__onesky && !document.getElementById('btn-enter').disabled, null, { timeout: 90000 });
await page.evaluate(() => {
  for (const s of ['#btn-enter', '#arrival-fine', '#arrival-eyebrow']) document.querySelector(s).style.display = 'none';
  document.querySelector('.arrival-line').style.marginBottom = '0';
  const g = window.__onesky.globe;
  g.revealAll(); g.autoRotate = false;
  g.flyTo(24, 8, 3.0, 50);
});
await page.waitForTimeout(6000);
await page.screenshot({ path: 'public/og.jpg', type: 'jpeg', quality: 88 });
await browser.close();

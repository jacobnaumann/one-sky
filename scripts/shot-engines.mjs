// Screenshot the home screen in Firefox and WebKit. node scripts/shot-engines.mjs [url]
import { firefox, webkit } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results', { recursive: true });
const url = process.argv[2] ?? 'http://localhost:5173/';
for (const [name, type] of [['firefox', firefox], ['webkit', webkit]]) {
  const b = await type.launch();
  const page = await (await b.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Tokyo' })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__onesky?.sky.online, null, { timeout: 60000 });
  await page.locator('#btn-enter').click();
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('is-hidden'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `test-results/engine-${name}.png` });
  console.log(name, 'errors:', errs.length ? errs.slice(0, 3) : 'none');
  await b.close();
}

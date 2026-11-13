// One visitor, optional JS after entering, then screenshots. node scripts/shot-one.mjs <out-prefix> "<js>" <ms,ms,...> [tz] [WxH]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const [prefix = 'test-results/one', js = '', times = '1500', tz = 'America/Chicago', size = '1440x900', url = 'http://localhost:5173/'] = process.argv.slice(2);
mkdirSync('test-results', { recursive: true });
const [width, height] = size.split('x').map(Number);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ timezoneId: tz, viewport: { width, height }, deviceScaleFactor: width < 600 ? 2 : 1, isMobile: width < 600, hasTouch: width < 600 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url()); });
await page.goto(url + '?hq', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__onesky?.sky.online, null, { timeout: 90000 });
await page.locator('#btn-enter').click();
await page.waitForFunction(() => !document.getElementById('app').classList.contains('is-hidden'), null, { timeout: 60000 });
await page.waitForTimeout(1500);
if (js) await page.evaluate(js);
let i = 0, last = 0;
for (const t of times.split(',').map(Number)) { await page.waitForTimeout(t - last); last = t; await page.screenshot({ path: `${prefix}-${++i}.png` }); }
await browser.close();

// Measures real frame rate on this machine's GPU (headless Chromium, Direct3D11). node scripts/perf.mjs [url]
import { chromium } from '@playwright/test';
const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h, dpr] of [[1440, 900, 1], [1920, 1080, 1], [1440, 900, 2], [390, 844, 3]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })).newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__onesky && !document.getElementById('btn-enter').disabled, null, { timeout: 60000 });
  await page.locator('#btn-enter').click();
  await page.waitForTimeout(9000);
  const r = await page.evaluate(() => new Promise((res) => {
    const ts = []; let n = 0;
    const f = (t) => { ts.push(t); if (++n < 240) requestAnimationFrame(f); else {
      const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
      res({ avg: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1), p95: +d[Math.floor(d.length * 0.95)].toFixed(1), worst: +d[d.length - 1].toFixed(1) });
    } };
    requestAnimationFrame(f);
  }));
  console.log(`${w}x${h} @${dpr}x  frame ms avg ${r.avg}  p95 ${r.p95}  worst ${r.worst}`);
  await page.context().close();
}
await browser.close();

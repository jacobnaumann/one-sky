import { test, expect, type Browser, type Page } from '@playwright/test';

// Each visitor is a separate browser context (separate anonymous identity) in a different time zone.
async function visitor(browser: Browser, timezoneId: string): Promise<Page> {
  const ctx = await browser.newContext({ timezoneId, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${timezoneId}] pageerror: ${e.message}`));
  await page.goto('./?low');
  await expect(page.locator('#btn-enter')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__onesky.sky.online), { timeout: 30_000 }).toBe(true);
  await page.locator('#btn-enter').click();
  await expect(page.locator('#app')).not.toHaveClass(/is-hidden/);
  await expect.poll(() => page.evaluate(() => (window as any).__onesky.entered)).toBe(true);
  return page;
}
const uid = (p: Page) => p.evaluate(() => (window as any).__onesky.sky.uid as string);
const stamp = Date.now().toString(36);

test('two visitors see each other, wave, wave back, and a third sees their thread', async ({ browser }) => {
  const a = await visitor(browser, 'Asia/Tokyo');
  const b = await visitor(browser, 'Europe/Lisbon');
  const [ua, ub] = [await uid(a), await uid(b)];
  expect(ua).not.toBe(ub);

  // presence
  await expect.poll(() => a.evaluate((id) => (window as any).__onesky.sky.people.has(id), ub)).toBe(true);
  await expect.poll(() => b.evaluate((id) => (window as any).__onesky.sky.people.has(id), ua)).toBe(true);
  await expect(a.locator('#census')).toContainText('lights awake');
  await expect(a.locator('#you-place')).toContainText('Tokyo');
  await expect(b.locator('#you-place')).toContainText('Lisbon');

  // ring: both zones lit, visible to both
  await expect.poll(async () => Number(await a.locator('#ring-count').textContent())).toBeGreaterThanOrEqual(2);
  await expect(a.locator('#ringstrip i.lit')).not.toHaveCount(0);

  // a ripple sent by A reaches B
  await a.locator('#btn-ripple').click();
  await expect(b.locator('.feed li', { hasText: 'A ripple from Tokyo' })).toBeVisible();

  // A selects B and waves
  await a.evaluate((id) => (window as any).__onesky.select({ type: 'light', id }), ub);
  await expect(a.locator('#card h2')).toHaveText('Lisbon');
  await a.locator('#card button.btn.primary').click();
  await expect(a.locator('#card button.btn.primary')).toHaveText('Wave sent');

  // B is told, and waves back
  const incoming = b.locator('.toast', { hasText: 'Someone in Tokyo waved at you' });
  await expect(incoming).toBeVisible();
  await incoming.getByRole('button', { name: 'Wave back' }).click();

  // both are threaded
  await expect(b.locator('.toast', { hasText: 'thread now joins' })).toBeVisible();
  await expect(a.locator('.toast', { hasText: 'thread now joins' })).toBeVisible();
  await expect(a.locator('#st-threads')).not.toHaveText('0');
  const threadsA = await a.evaluate(() => [...(window as any).__onesky.threads.keys()] as string[]);
  expect(threadsA.length).toBeGreaterThan(0);

  // a third visitor arriving later sees the thread from the database
  const c = await visitor(browser, 'America/Sao_Paulo');
  await expect.poll(() => c.evaluate((ids) => ids.some((id: string) => (window as any).__onesky.threads.has(id)), threadsA)).toBe(true);
  await expect(c.locator('#census')).toContainText('3 lights awake');

  // when B leaves, A sees the light go out
  await b.context().close();
  await expect.poll(() => a.evaluate((id) => (window as any).__onesky.sky.people.has(id), ub), { timeout: 60_000 }).toBe(false);
  await a.context().close(); await c.context().close();
});

test('a lantern released by one visitor reaches another, can be warmed, and survives reload', async ({ browser }) => {
  const a = await visitor(browser, 'Africa/Nairobi');
  const b = await visitor(browser, 'America/Mexico_City');
  const text = `[test] the kettle is on ${stamp}`;

  await a.locator('#btn-lantern').click();
  await a.locator('.modal textarea').fill('see my site at example.com');
  await a.locator('.modal button.btn.primary').click();
  await expect(a.locator('.modal .err')).not.toBeEmpty();           // links are refused
  await a.locator('.modal textarea').fill(text);
  await a.locator('.modal button.btn.primary').click();
  await expect(a.locator('.toast', { hasText: 'Your lantern is aloft over Nairobi' })).toBeVisible();

  const find = (p: Page) => p.evaluate((t) => { for (const l of (window as any).__onesky.lanterns.values()) if (l.body === t) return l.id as string; return null; }, text);
  await expect.poll(() => find(b)).not.toBeNull();
  const id = (await find(b))!;

  // B opens and warms it; A sees the warmth arrive
  await b.evaluate((lid) => (window as any).__onesky.select({ type: 'lantern', id: lid }), id);
  await expect(b.locator('#card blockquote')).toContainText('the kettle is on');
  await b.locator('#card .warm-btn').click();
  await expect(b.locator('#card .warm-btn')).toContainText('Warmed');
  await expect.poll(() => a.evaluate((lid) => (window as any).__onesky.lanterns.get(lid)?.warmth, id)).toBe(1);

  // survives reload, and A still owns it
  await a.reload();
  await expect.poll(() => find(a), { timeout: 30_000 }).toBe(id);

  // user text is rendered as text, never as markup
  expect(await b.locator('#card blockquote img, #card blockquote script').count()).toBe(0);
  await a.context().close(); await b.context().close();
});

test('the page works with keyboard and shows the daily question', async ({ browser }) => {
  const a = await visitor(browser, 'Pacific/Auckland');
  await expect(a.locator('#ask-q')).not.toBeEmpty();
  await a.locator('#btn-about').click();
  await expect(a.locator('.modal h2')).toHaveText('Everyone under one sky');
  await a.keyboard.press('Escape');
  await expect(a.locator('.modal')).toHaveCount(0);
  await a.locator('#btn-move').click();
  await a.locator('.modal input[type=search]').fill('reyk');
  await a.locator('.modal .places button').first().click();
  await expect(a.locator('#you-place')).toContainText('Reykjav');
  await a.locator('#btn-postcard').click();
  await expect(a.locator('.postcard-img')).toBeVisible();
  await a.keyboard.press('Escape');

  // drift opens lanterns one after another and stops when asked
  await a.locator('#btn-drift').click();
  await expect(a.locator('#card blockquote')).toBeVisible();
  await expect(a.locator('#btn-drift')).toHaveAttribute('aria-pressed', 'true');
  await a.locator('#btn-drift').click();
  await expect(a.locator('#card')).toBeHidden();
  await a.context().close();
});

test('a wave left for an echo is delivered when that person comes back', async ({ browser }) => {
  // A visits from Tokyo and leaves; the browser profile (and so the anonymous identity) is kept
  const ctxA = await browser.newContext({ timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' });
  const enter = async (page: Page) => {
    await page.goto('./?low');
    await expect(page.locator('#btn-enter')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).__onesky.sky.online), { timeout: 30_000 }).toBe(true);
    await page.locator('#btn-enter').click();
    await expect.poll(() => page.evaluate(() => (window as any).__onesky.entered)).toBe(true);
  };
  const a1 = await ctxA.newPage();
  await enter(a1);
  await a1.waitForTimeout(2500); // let the check-in land
  await a1.close();

  // B arrives later, finds A's echo, and leaves a wave
  const b = await visitor(browser, 'Europe/Lisbon');
  const key = await expect.poll(() => b.evaluate(() => {
    const o = (window as any).__onesky;
    const e = o.echoes.find((x: any) => x.place === 'Tokyo' && x.eid);
    return e ? o.echoKey(e) : null;
  }), { timeout: 30_000 }).not.toBeNull().then(() => b.evaluate(() => { const o = (window as any).__onesky; return o.echoKey(o.echoes.find((x: any) => x.place === 'Tokyo' && x.eid)); }));
  await b.evaluate((id) => (window as any).__onesky.select({ type: 'light', id }), key);
  await expect(b.locator('#card h2')).toHaveText('Tokyo');
  await b.locator('#card button.btn.primary').click();
  await expect(b.locator('#card .note')).toContainText('waiting for them');

  // A comes back and is told
  const a2 = await ctxA.newPage();
  await enter(a2);
  await expect(a2.locator('.toast', { hasText: 'While you were away, someone in Lisbon waved at you' })).toBeVisible();
  await ctxA.close(); await b.context().close();
});

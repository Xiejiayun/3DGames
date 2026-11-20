import assert from 'node:assert/strict';

export async function checkCampaignEnding(browser) {
  const page = await browser.newPage({ offline: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = new URL('../dist/games/prism.html?manual&lvl=10&q=low&mute=1&lang=en', import.meta.url);
  const enter = async () => { await page.goto(url.href); await page.locator('#boot').waitFor({ state: 'detached' }); };
  const solve = () => page.evaluate(() => { PRISM.solveRef(); PRISM.step(3); return PRISM.state().best; });
  const note = page.locator('#solved .sv-n'), next = page.locator('[data-s="next"]');
  const advance = async room => {
    await next.tap();
    await page.waitForFunction(room => PRISM.state().level === room, room);
  };
  try {
    await enter();
    assert.deepEqual(await solve(), { L10: 3 });
    assert.equal(await note.innerText(), '1 / 10 vaults open.', 'the last room alone does not finish the campaign');
    assert.equal(await next.innerText(), 'Go to vault 1 →');
    const menu = page.locator('#tl .lvl');
    if (await menu.getAttribute('aria-expanded') === 'false') await menu.tap();
    await page.locator('[data-a="lang"]').tap();
    assert.equal(await note.innerText(), '已解开 1 / 10 关。');
    assert.equal(await next.innerText(), '前往第 1 关 →');
    if (await menu.getAttribute('aria-expanded') === 'true') await menu.tap();
    await advance(1);
    assert.deepEqual(await solve(), { L01: 3, L10: 3 });
    assert.equal(await next.innerText(), '下一关 →');
    await advance(2);

    const saved = { L01: 1, L02: 2, L03: 3, L04: 0, L05: 2, L06: 1, L07: 3, L08: 1, L09: 2, L10: 3, retired: 3 };
    await page.evaluate(best => localStorage.setItem('prismVault.v1', JSON.stringify({ best })), saved);
    await enter();
    assert.deepEqual(await solve(), saved);
    assert.equal(await note.innerText(), '9 / 10 vaults open.', 'unknown entries and zero stars cannot complete a campaign');
    assert.equal(await next.innerText(), 'Go to vault 4 →');
    await advance(4);
    const completed = { ...saved, L04: 3 };
    assert.deepEqual(await solve(), completed);
    assert.match(await note.innerText(), /All ten vaults are open/);
    assert.equal(await next.count(), 0, 'the true finale does not direct the player to an already-cleared vault');
    await page.locator('[data-s="stay"]').tap();
    assert.equal(await page.locator('#solved').isVisible(), false);
    assert.equal(await page.evaluate(() => PRISM.state().level), 4);
    await page.evaluate(() => PRISM.load(1));
    const improved = { ...completed, L01: 3 };
    assert.deepEqual(await solve(), improved);
    assert.equal(await page.locator('#solved .nb').innerText(), 'New best');
    assert.equal(await next.innerText(), 'Next vault →', 'replaying an earlier room keeps normal progression');
    await enter();
    assert.deepEqual(await solve(), improved, 'all earned stars survive reloading');
    assert.match(await note.innerText(), /All ten vaults are open/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
  console.log('PASS Prism campaign completion, bilingual backfill and saved-star replay');
}

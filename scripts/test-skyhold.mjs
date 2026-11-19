import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const site = process.env.SKYHOLD_SITE;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ offline: !site, locale: 'zh-CN', viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('skyhold.lang', 'zh');
    localStorage.setItem('skyhold.quality', 'low');
  });
  if (site) {
    await page.goto(site);
    for (const language of ['en', 'zh']) {
      await page.locator(`[data-lang="${language}"]`).click();
      assert.match(await page.locator('.skyhold-card h2').innerText(), language === 'zh' ? /浮空要塞/ : /Skyhold Bastion/i);
    }
    await page.locator('.skyhold-card .play').click();
  } else {
    await page.goto(new URL('../dist/games/skyhold.html', import.meta.url).href);
  }
  const maps = page.locator('#t-maps .mapcard');
  await maps.first().waitFor();
  await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.deepEqual(await maps.locator('.mn').allTextContents(), ['翠峰螺旋', '双桥峡谷', '云巅圣殿']);
  await page.locator('#t-lang').click();
  assert.equal(await maps.first().locator('.mn').innerText(), 'Emerald Spiral');
  await maps.first().click();
  await page.locator('#btn-call').waitFor();
  const state = () => page.evaluate(() => window.__skyhold.state());
  const start = await state();
  assert.equal(start.status, 'ready');
  assert.equal(await page.locator('#buildbar [data-type]').count(), 5);
  await page.locator('#buildbar [data-type="cryo"]').click();
  const candidates = await page.evaluate(() => window.__skyhold.padInfo().map(pad => pad.i));
  for (const pad of candidates) {
    const point = await page.evaluate(index => {
      const api = window.__skyhold;
      const point = api.project(...api.padTop(index));
      return document.elementFromPoint(point.x, point.y)?.id === 'gl' ? point : null;
    }, pad);
    if (!point) continue;
    await page.mouse.click(point.x, point.y);
    if ((await state()).turrets.some(Boolean)) break;
  }
  const built = await state();
  assert.deepEqual(built.turrets.filter(Boolean), ['cryo1']);
  assert.equal(start.gold - built.gold, await page.evaluate(() => window.__skyhold.turretCost('cryo')));
  await page.locator('#btn-call').click();
  await page.waitForFunction(() => window.__skyhold.state().wave === 1 && window.__skyhold.state().alive > 0);
  await page.keyboard.press('Space');
  assert.equal((await state()).paused, true);
  await page.locator('#btn-pause').click();
  assert.equal((await state()).paused, false);
  assert.equal(await page.locator('#diag-chip').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(`PASS Skyhold Bastion (${site ? 'live' : 'offline'}): bilingual maps, build via canvas, gold cost, wave one, pause/resume`);
} finally {
  await browser.close();
}

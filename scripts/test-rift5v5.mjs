import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ offline: true, locale: 'zh-CN', viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('../dist/games/rift5v5.html', import.meta.url).href);
  await page.locator('#h-start').click();
  await page.locator('#sel-roster [data-id="mage"]').click();
  await page.locator('#sel-lock').click();
  await page.waitForFunction(() => window.__moba.state.mode === 'game' && window.__moba.game.time > 0);
  const match = await page.evaluate(() => {
    const { heroes, player } = window.__moba.game;
    return { selected: player.def.id, humans: heroes.filter(hero => hero.isPlayer).length,
      teams: [0, 1].map(team => heroes.filter(hero => hero.team === team).length) };
  });
  assert.deepEqual(match, { selected: 'mage', humans: 1, teams: [5, 5] });

  const spawn = await page.evaluate(() => {
    const player = window.__moba.game.player;
    return [player.x, player.z];
  });
  await page.locator('#minimap').click({ button: 'right' });
  await page.waitForFunction(([startX, startZ]) => {
    const player = window.__moba.game.player;
    return Math.hypot(player.x - startX, player.z - startZ) > 2;
  }, spawn);
  await page.keyboard.press('Escape');
  await page.locator('#m-resume').waitFor();
  assert.equal(await page.evaluate(() => window.__moba.state.paused), true);
  await page.locator('#m-resume').click();
  assert.equal(await page.evaluate(() => window.__moba.state.paused), false);
  assert.deepEqual(await page.evaluate(() => window.__moba.errs), []);
  assert.deepEqual(errors, []);
  console.log('PASS Rift of Champions: offline hero selection, two teams of five, right-click movement and pause/resume');
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ offline: true, viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('../dist/games/prism.html?manual&q=low&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const checks = await page.evaluate(() => window.PRISM.selfTest());
  assert.equal(checks.filter(check => check.name.startsWith('Reference ')).length, 10);
  assert.deepEqual(checks.filter(check => !check.ok), []);

  const step = () => page.evaluate(() => { window.PRISM.step(3); return window.PRISM.state(); });
  assert.equal((await step()).level, 1);
  await page.locator('#tray [data-key="flat"]').click();
  const slot = await page.evaluate(() => window.PRISM.slotScreenVisible('1,0,1'));
  assert.ok(slot, 'the first mirror slot is visible');
  await page.mouse.click(slot.x, slot.y);
  assert.equal((await step()).layout.length, 1);
  await page.keyboard.press('r');
  assert.equal((await step()).complete, true, 'rotating the mirror lights the first core');
  await page.keyboard.press('z');
  assert.equal((await step()).lit, 0, 'undo restores the unlit core');
  await page.keyboard.press('r');
  await step();
  await page.locator('[data-s="next"]').click();
  await page.waitForFunction(() => window.PRISM.state().level === 2);
  assert.deepEqual(errors, []);
  console.log(`PASS Prism Vault: ${checks.length} puzzle checks, offline WebGL, place, rotate, undo and next chamber`);
} finally {
  await browser.close();
}

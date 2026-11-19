import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { checkTouchGestures } from './test-prism-touch.mjs';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ offline: true, locale: 'en-US', viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('../dist/games/prism.html?manual&q=low&mute=1&lang=en', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const checks = await page.evaluate(() => window.PRISM.selfTest());
  assert.equal(checks.filter(check => check.name.startsWith('Reference ')).length, 10);
  assert.deepEqual(checks.filter(check => !check.ok), []);

  const step = () => page.evaluate(() => { window.PRISM.step(3); return window.PRISM.state(); });
  assert.equal((await step()).level, 1);
  const guide = page.locator('#guide .gt');
  assert.match(await guide.textContent(), /1\/4.*Flat Mirror/);
  await page.keyboard.press('1');
  assert.match(await guide.textContent(), /2\/4.*A/);
  await page.keyboard.press('Escape');
  assert.match(await guide.textContent(), /1\/4/);
  await page.locator('#tray [data-key="flat"]').click();
  const wrong = await page.evaluate(() => PRISM.slotScreenVisible('3,0,1'));
  assert.ok(wrong);
  await page.mouse.click(wrong.x, wrong.y);
  assert.match(await guide.textContent(), /move.*A/i);
  await page.keyboard.press('Escape');
  assert.match(await guide.textContent(), /select the mirror/i);
  await page.mouse.click(wrong.x, wrong.y);
  const slot = await page.evaluate(() => window.PRISM.slotScreenVisible('1,0,1'));
  assert.ok(slot, 'the first mirror slot is visible');
  await page.mouse.click(slot.x, slot.y);
  assert.equal((await step()).layout.length, 1);
  assert.match(await guide.textContent(), /3\/4.*Rotate.*R\b/);
  await page.keyboard.press('Escape');
  assert.match(await guide.textContent(), /select.*A|A.*select/i);
  await page.evaluate(() => PRISM.step(.05));
  await page.getByRole('button', { name: 'Slot A', exact: true }).click();
  for (const action of ['help', 'levels']) {
    const opener = page.locator(`[data-a="${action}"]`);
    const dialog = page.getByRole('dialog');
    await opener.click();
    await dialog.waitFor();
    assert.ok(await dialog.locator('.ovx').evaluate(button => button === document.activeElement));
    await page.keyboard.press('Shift+Tab');
    assert.ok(await dialog.locator('button').last().evaluate(button => button === document.activeElement));
    await page.keyboard.press('Tab');
    assert.ok(await dialog.locator('.ovx').evaluate(button => button === document.activeElement));
    const before = await page.evaluate(() => PRISM.state().layout);
    for (const key of ['Control+z', 'Meta+z', 'r', 'Backspace']) await page.keyboard.press(key);
    assert.deepEqual(await page.evaluate(() => PRISM.state().layout), before, `${action} isolates the board`);
    await page.keyboard.press(action === 'help' ? 'Space' : 'Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await opener.evaluate(button => button === document.activeElement), `${action} restores focus`);
  }
  await page.keyboard.press('r');
  assert.equal((await step()).complete, true, 'rotating the mirror lights the first core');
  assert.match(await guide.textContent(), /4\/4.*core/i);
  const switchLanguage = async () => {
    const menu = page.locator('#tl .lvl');
    if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
    await page.locator('[data-a="lang"]').click();
  };
  const board = () => page.evaluate(() => {
    const { level, layout, history, held, selected, floor, best, lit, complete } = PRISM.state();
    return { level, layout, history, held, selected, floor, best, lit, complete };
  });
  const solvedBoard = await board();
  await switchLanguage();
  assert.deepEqual(await board(), solvedBoard, 'translation preserves the solved board and undo stack');
  assert.match(await guide.textContent(), /核心/);
  assert.equal(await page.locator('#solved .sv-t').textContent(), '已解开');
  assert.equal(await page.locator('#guide .gx').getAttribute('aria-label'), '关闭引导');
  await page.locator('[data-a="help"]').click();
  await page.getByRole('dialog', { name: '操作' }).getByRole('button', { name: '关闭' }).click();
  await page.locator('[data-s="stay"]').click();
  await switchLanguage();
  assert.equal(await page.locator('#solved').isVisible(), false, 'switching does not reopen a dismissed scorecard');
  assert.equal(await page.locator('#guide .gx').getAttribute('aria-label'), 'Dismiss tutorial');
  await page.keyboard.press('Control+z');
  assert.equal((await step()).lit, 0, 'undo restores the unlit core');
  assert.match(await guide.textContent(), /3\/4.*Rotate/);
  await page.locator('#guide .gx').click();
  await page.keyboard.press('Escape');
  await step();
  assert.equal(await page.locator('#guide-socket').isVisible(), false);
  await page.mouse.click(slot.x, slot.y);
  await page.keyboard.press('r');
  await step();
  assert.equal(await page.locator('#guide').isVisible(), false, 'a dismissed lesson stays off in this chamber');
  await page.locator('[data-s="next"]').click();
  await page.waitForFunction(() => window.PRISM.state().level === 2);

  await page.evaluate(() => { PRISM.load(7); PRISM.step(1); });
  const geometries = () => page.evaluate(() => PRISM.info().geometries);
  const keyFrame = async key => { await page.keyboard.press(key); return geometries(); };
  const withoutHint = await keyFrame('h');
  for (let cycle = 0; cycle < 4; cycle++) {
    assert.ok(await keyFrame('h') > withoutHint, 'second hint renders a piece preview');
    assert.equal(await keyFrame('h'), withoutHint, 'dismissing a hint releases its geometry');
  }
  const hoverSlot = await page.evaluate(() => PRISM.slotScreenVisible('1,0,3'));
  assert.ok(hoverSlot);
  await page.mouse.move(hoverSlot.x, hoverSlot.y);
  const withMirror = await keyFrame('1');
  assert.ok(withMirror > withoutHint, 'hovering shows the held piece');
  for (let cycle = 0; cycle < 4; cycle++) {
    await keyFrame('4');
    assert.equal(await keyFrame('1'), withMirror, 'changing the held piece releases its old preview');
  }
  const direct = new URL('../dist/games/prism.html?manual&q=low&lvl=2#chamber', import.meta.url);
  const enter = async url => { await page.goto(url.href); await page.locator('#boot').waitFor({ state: 'detached' }); };
  const language = () => page.locator('html').getAttribute('lang');
  await page.evaluate(() => localStorage.removeItem('prismVault.v1'));
  await enter(direct);
  assert.equal(await language(), 'en', 'browser preference on a fresh direct visit');
  await switchLanguage();
  const switched = new URL(page.url());
  assert.equal(switched.searchParams.get('lang'), 'zh');
  assert.equal(switched.searchParams.get('lvl'), '2');
  assert.equal(switched.searchParams.get('q'), 'low');
  assert.ok(switched.searchParams.has('manual'));
  assert.equal(switched.hash, '#chamber');
  await enter(direct);
  assert.equal(await language(), 'zh-CN', 'saved game preference outranks the browser');
  direct.searchParams.set('lang', 'fr'); await enter(direct);
  assert.equal(await language(), 'zh-CN', 'unsupported URL preference does not discard the saved preference');
  direct.searchParams.set('lang', 'en-GB'); await enter(direct);
  assert.equal(await language(), 'en', 'supported explicit URL preference outranks saved preference');
  await switchLanguage();
  await page.reload(); await page.locator('#boot').waitFor({ state: 'detached' });
  assert.equal(await language(), 'zh-CN', 'reload keeps the change even after an explicit language link');
  assert.deepEqual(errors, []);
  await page.close();
  const touch = await browser.newPage({ offline: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  touch.on('pageerror', error => errors.push(error.message));
  await touch.goto(new URL('../dist/games/prism.html?manual&q=low&mute=1&lang=zh', import.meta.url).href);
  await touch.locator('#boot').waitFor({ state: 'detached' });
  const settleTouch = () => touch.evaluate(() => { PRISM.step(3); });
  const menu = touch.locator('#tl .lvl');
  const tapTargets = async selector => {
    const obstructed = await touch.locator(selector).evaluateAll(buttons => buttons.filter(button => {
      const box = button.getBoundingClientRect();
      return !box.width || box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight ||
        !button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }).map(button => button.textContent.trim()));
    assert.deepEqual(obstructed, [], `fully visible and tappable: ${selector}`);
  };
  await settleTouch();
  await checkTouchGestures(touch);
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  await touch.locator('#tray [data-key="flat"]').tap();
  await settleTouch();
  assert.match(await touch.locator('#guide .gt').textContent(), /2\/4.*A/);
  const touchSlot = await touch.evaluate(() => PRISM.slotScreenVisible('3,0,1'));
  assert.ok(touchSlot);
  await touch.touchscreen.tap(touchSlot.x, touchSlot.y);
  assert.match(await touch.locator('#guide .gt').textContent(), /没有对准核心.*A/);
  await tapTargets('#guide-socket');
  await touch.getByRole('button', { name: 'A 槽位', exact: true }).tap();
  assert.match(await touch.locator('#guide .gt').textContent(), /3\/4.*旋转.*R/);
  await tapTargets('#ctx button:enabled');
  await touch.locator('[data-c="rotate"]').tap();
  await settleTouch();
  assert.match(await touch.locator('#guide .gt').textContent(), /4\/4.*核心/);
  assert.equal(await touch.locator('#guide-socket').isVisible(), false);
  await touch.locator('[data-s="next"]').tap();
  await touch.waitForFunction(() => PRISM.state().level === 2);
  await menu.tap();
  await touch.locator('[data-a="levels"]').tap();
  await touch.locator('[data-n="10"]').tap();
  await touch.waitForFunction(() => PRISM.state().level === 10);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await touch.setViewportSize(viewport);
    for (let language = 0; language < 2; language++) {
      await settleTouch();
      await tapTargets('#tl .lvl, #lit, #tray .card, #acts button, #floors button');
      await menu.tap();
      await tapTargets('#chamber-menu button');
      await touch.locator('[data-a="lang"]').tap();
      await menu.tap();
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS Prism Vault: ${checks.length} puzzle checks, offline WebGL, dialog input isolation, board controls, preview lifetimes, compact touch controls, pinch and interruption recovery, first-mirror lesson and language continuity`);
} finally {
  await browser.close();
}

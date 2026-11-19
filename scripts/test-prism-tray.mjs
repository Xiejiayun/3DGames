import assert from 'node:assert/strict';

export async function checkTrayChoices(page, touch) {
  const lang = touch ? 'zh' : 'en';
  await page.goto(new URL(`../dist/games/prism.html?manual&q=low&lvl=7&lang=${lang}&mute=1`, import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const activate = target => touch ? target.tap() : target.click();
  const card = key => page.locator(`#tray [data-key="${key}"]`);
  const state = () => page.evaluate(() => {
    PRISM.step(0.75);
    const { layout, tray, history, selected, held } = PRISM.state();
    return { layout, tray, history, selected, held };
  });
  const place = async key => {
    const point = await page.evaluate(key => PRISM.slotScreenVisible(key), key);
    assert.ok(point, `visible slot ${key}`);
    if (touch) await page.touchscreen.tap(Math.round(point.x), Math.round(point.y));
    else await page.mouse.click(point.x, point.y);
  };
  await state();
  await activate(card('filter:R')); await place('1,0,3');
  const first = await state();
  assert.equal(first.selected, '1,0,3'); assert.equal(first.history, 1);
  assert.equal(first.tray['filter:R'], 0);
  await activate(card('filter:R'));
  assert.deepEqual(await state(), first, 'an empty card is not a shortcut for removing the selected instrument');
  if (!touch) {
    const gap = await page.locator('#tray').evaluate(tray => {
      const [left, right] = [...tray.querySelectorAll('.card')].map(button => button.getBoundingClientRect());
      const x = (left.right + right.left) / 2, y = left.top + left.height / 2;
      return document.elementFromPoint(x, y) === tray && { x, y };
    });
    assert.ok(gap); await page.mouse.click(gap.x, gap.y);
    assert.deepEqual(await state(), first, 'a click between cards does not remove a piece');
  }
  await activate(card('filter:G'));
  assert.deepEqual(await state(), { ...first, selected: null, held: 'filter:G' }, 'taking the next instrument is not a board edit');
  assert.equal(await card('filter:G').getAttribute('aria-pressed'), 'true');
  await place('3,0,1');
  const second = await state();
  assert.equal(second.history, 2); assert.equal(second.layout.length, 2);
  assert.deepEqual(second.layout[0], first.layout[0]);
  assert.equal(second.selected, '3,0,1');
  await activate(page.getByRole('button', { name: touch ? '回收' : 'Recall', exact: true }));
  const recalled = await state();
  assert.deepEqual(recalled.layout, first.layout); assert.equal(recalled.history, 3);
  await activate(page.locator('[data-a="undo"]'));
  const restored = await state();
  assert.deepEqual(restored.layout, second.layout); assert.deepEqual(restored.tray, second.tray);
  assert.equal(restored.history, second.history, 'one undo restores the explicit recall');
  await page.evaluate(() => { PRISM.load(2); PRISM.step(1); });
  await activate(card('flat')); await place('2,0,3');
  const mirror = await state(); assert.equal(mirror.selected, '2,0,3');
  await activate(card('flat'));
  assert.deepEqual(await state(), { ...mirror, selected: null, held: 'flat' }, 'a stocked card can supply a second copy of the same type');
  await activate(card('flat'));
  assert.deepEqual(await state(), { ...mirror, selected: null }, 'tapping the held card puts it down without editing the board');
}

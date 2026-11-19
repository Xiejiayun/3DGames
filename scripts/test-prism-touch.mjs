import assert from 'node:assert/strict';

export async function checkTouchGestures(page) {
  const session = await page.context().newCDPSession(page);
  const send = (type, ...touchPoints) => session.send('Input.dispatchTouchEvent', { type, touchPoints });
  const board = () => page.evaluate(() => {
    const { held, selected, layout, history } = PRISM.state();
    return { held, selected, layout, history };
  });
  const span = () => page.evaluate(() => {
    PRISM.step(1.5);
    const left = PRISM.slotScreen('1,0,1'), right = PRISM.slotScreen('3,0,1');
    return Math.hypot(right.x - left.x, right.y - left.y);
  });
  const one = (point, id) => ({ id, x: point.x, y: point.y });
  const overlap = async (first, second) => {
    await send('touchStart', one(first, 1));
    await send('touchStart', one(first, 1), one(second, 2));
    await send('touchEnd');
  };
  const target = await page.evaluate(() => PRISM.slotScreenVisible('3,0,1'));
  assert.ok(target);
  const empty = { x: 110, y: 255 };
  await page.locator('#tray [data-key="flat"]').tap();
  const held = await board();
  assert.equal(held.held, 'flat');
  await span();
  const marker = await page.locator('#guide-socket').boundingBox();
  assert.ok(marker);
  const badge = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  for (const [first, second] of [[target, empty], [empty, target], [badge, empty], [empty, badge]]) {
    await overlap(first, second);
    assert.deepEqual(await board(), held, 'neither touch can place or cancel the held mirror');
  }

  const initialSpan = await span();
  const left = one({ x: 115, y: 270 }, 1), right = one({ x: 240, y: 270 }, 2);
  await send('touchStart', left);
  await send('touchStart', left, right);
  await send('touchMove', { ...left, x: 80 }, { ...right, x: 275 });
  assert.ok(await span() > initialSpan * 1.15, 'spreading two fingers brings slots closer to the camera');
  await send('touchMove', left, right);
  await send('touchEnd');
  assert.ok(Math.abs(await span() - initialSpan) < 1, 'reversing the pinch restores the view without orbiting');
  assert.deepEqual(await board(), held);

  await send('touchStart', left);
  await send('touchMove', { ...left, x: 148 });
  await send('touchCancel');
  assert.notEqual(await page.locator('#gl').evaluate(canvas => canvas.style.cursor), 'grabbing');
  assert.deepEqual(await board(), held, 'a cancelled drag cannot edit the board');
  await page.keyboard.press('Space');
  await span();

  for (const moveFirst of [true, false]) {
    await page.locator('#gl').evaluate(canvas => canvas.addEventListener('pointerdown', event => { window.testContactId = event.pointerId; }, { once: true }));
    await send('touchStart', one(target, 1));
    if (moveFirst) await send('touchMove', { ...one(target, 1), x: target.x + 1 });
    await page.locator('#gl').evaluate(canvas => canvas.releasePointerCapture(window.testContactId));
    await send('touchMove', { ...one(target, 1), x: target.x + 2 });
    await send('touchEnd');
    assert.deepEqual(await board(), held, 'losing pending or active capture discards the tap');
  }

  await page.touchscreen.tap(Math.round(target.x), Math.round(target.y));
  const selected = await board();
  assert.equal(selected.selected, '3,0,1', 'a new single tap works after interrupted gestures');
  await overlap(empty, target);
  assert.deepEqual(await board(), selected, 'multi-touch preserves an existing selection and its history');
  await page.locator('[data-a="undo"]').tap();
  assert.equal((await board()).layout.length, 0);
  await session.detach();
}

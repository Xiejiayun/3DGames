import assert from 'node:assert/strict';

export async function checkArchSightlines(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=8&q=low&lang=zh&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const settle = () => page.evaluate(() => { PRISM.step(2); return PRISM.state(); });
  const centre = slot => page.evaluate(slot => PRISM.slotScreen(slot, 0.35), slot);
  await settle();
  const home = await centre('1,0,3');
  for (const [slot, floor, key, orientation, flip] of [
    ['1,0,3', 0, 'elev', 0, 0], ['1,2,3', 2, 'elev', 0, 1],
    ['4,4,3', 4, 'flat', 2, 0], ['5,0,3', 0, 'filter:G', 0, 0],
  ]) {
    await page.locator(`#floors [data-f="${floor}"]`).tap();
    await page.locator(`#tray [data-key="${key}"]`).tap();
    assert.equal((await settle()).held, key);
    const point = await centre(slot);
    await page.touchscreen.tap(Math.round(point.x), Math.round(point.y));
    const piece = (await settle()).layout.find(piece => piece.slot === slot);
    assert.ok(piece, `default view: tapping the centre of ${slot} places the held instrument`);
    if (piece.type !== 'filter') {
      for (let turn = 0; turn < (orientation - piece.k + 4) % 4; turn++) await page.locator('[data-c="rotate"]').tap();
    }
    if (piece.type === 'elev' && piece.f !== flip) await page.locator('[data-c="flip"]').tap();
    await settle();
  }
  assert.ok((await settle()).complete, 'the three floors can be connected without orbiting or zooming');
  await page.locator('[data-s="stay"]').tap();
  await page.locator('#floors [data-f="all"]').tap();
  await settle();
  await page.locator('#gl').focus();
  await page.keyboard.down('ArrowLeft'); await page.evaluate(() => PRISM.step(0.5)); await page.keyboard.up('ArrowLeft');
  await settle();
  const rotated = await centre('1,0,3');
  assert.ok(Math.hypot(rotated.x - home.x, rotated.y - home.y) > 10);
  await page.keyboard.press('Space'); await settle();
  const reset = await centre('1,0,3');
  assert.ok(Math.hypot(reset.x - home.x, reset.y - home.y) < 1, 'camera reset returns to the playable starting view');
}

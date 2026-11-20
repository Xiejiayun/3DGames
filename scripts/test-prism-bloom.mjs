import assert from 'node:assert/strict';

export async function checkBloomReadability(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 800, height: 640 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=6&q=high&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  await page.evaluate(() => { PRISM.solveRef(); PRISM.step(4); PRISM.focus('3,2,3', 8, 1.8, 0.65); PRISM.step(2); });
  const sampleOptic = () => page.evaluate(() => {
    PRISM.step(0);
    const gl = document.querySelector('#gl').getContext('webgl2');
    const width = 330, height = 340, count = width * height, pixels = new Uint8Array(count * 4);
    gl.readPixels(235, gl.drawingBufferHeight - 166 - height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let nearWhite = 0, dark = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const low = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      const high = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (low >= 220 && high - low < 38) nearWhite++;
      if (high < 115) dark++;
    }
    return { nearWhite: nearWhite / count, dark: dark / count };
  });
  const menu = page.locator('#tl .lvl');
  for (const [index, quality] of ['high', 'med', 'low', 'high'].entries()) {
    if (index) {
      if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
      await page.locator('[data-a="quality"]').click();
      await page.evaluate(() => PRISM.step(1.5));
    }
    const state = await page.evaluate(() => PRISM.state());
    assert.ok(state.complete); assert.equal(state.quality, quality);
    const { nearWhite, dark } = await sampleOptic();
    assert.ok(nearWhite < 0.15 && dark > 0.03, `${quality}: lit elevator mirror retains dark structure (${nearWhite} near-white, ${dark} dark)`);
  }
  await page.evaluate(() => { PRISM.load(7); PRISM.step(4); PRISM.focus('5,-.4,5', 10, 0.7, 0.85); PRISM.step(2); });
  const unlit = await sampleOptic();
  await page.evaluate(() => { PRISM.solveRef(); PRISM.step(4); });
  assert.ok(await page.evaluate(() => PRISM.state().complete));
  const matched = await sampleOptic();
  assert.ok(matched.nearWhite > unlit.nearWhite + 0.008, 'matching the core still produces a visible highlight');
  assert.deepEqual(errors, []);
  await page.close();
  console.log('PASS Prism lit mirror contrast and core highlights across menu quality changes');
}

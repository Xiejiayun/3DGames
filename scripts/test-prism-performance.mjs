import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { checkReflections } from './test-prism-reflections.mjs';
import { checkFloorResources } from './test-prism-floors.mjs';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ offline: true, viewport: { width: 480, height: 320 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const callbacks = new Map();
    let sequence = 0, timestamp = 0, hidden = false;
    window.requestAnimationFrame = callback => { callbacks.set(++sequence, callback); return sequence; };
    window.cancelAnimationFrame = identifier => callbacks.delete(identifier);
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    const gpu = { calls: 0, triangles: 0 };
    for (const method of ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced']) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (mode, ...args) {
        const count = method.startsWith('drawArrays') ? args[1] : args[0];
        const instances = method.endsWith('Instanced') ? args.at(-1) : 1;
        gpu.calls++;
        if (mode === this.TRIANGLES) gpu.triangles += count / 3 * instances;
        if (mode === this.TRIANGLE_STRIP || mode === this.TRIANGLE_FAN) gpu.triangles += Math.max(0, count - 2) * instances;
        return original.call(this, mode, ...args);
      };
    }
    window.frameProbe = {
      advance(count, intervalMs) {
        for (let frame = 0; frame < count; frame++) {
          timestamp += intervalMs;
          const batch = [...callbacks.values()];
          callbacks.clear();
          for (const callback of batch) callback(timestamp);
        }
        return PRISM.state();
      },
      visibility(hide) { hidden = hide; document.dispatchEvent(new Event('visibilitychange')); },
      measure() {
        const before = { ...gpu };
        const info = PRISM.info();
        return { reported: [info.calls, info.tris], measured: [gpu.calls - before.calls, gpu.triangles - before.triangles] };
      },
    };
  });
  const open = async query => {
    await page.goto(new URL(`../dist/games/prism.html?mute=1&${query}`, import.meta.url).href, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.PRISM?.state().level === 1, undefined, { polling: 50 });
    await page.locator('#boot').waitFor({ state: 'detached' });
  };
  const advance = (count, intervalMs) => page.evaluate(([count, ms]) => frameProbe.advance(count, ms), [count, intervalMs]);
  await open('q=low');
  const normal = await advance(6, 1000 / 60);
  assert.equal(normal.fps, 60);
  const slow = await advance(30, 250);
  assert.equal(slow.fps, 4, 'visible 250 ms frames are not counted as capped 50 ms simulation ticks');
  assert.ok(Math.abs((slow.simulationSeconds - normal.simulationSeconds) - 1.5) < 1e-6, 'simulation stays bounded');
  assert.equal(await page.evaluate(() => { PRISM.step(3); PRISM.info(); return PRISM.state().fps; }), 4, 'debug steps are not display frames');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await advance(1, 16); await advance(1, 550);
  assert.equal((await advance(9, 50)).fps, 10, 'mixed intervals count frames per total second, not a mean of instantaneous rates');

  await open('lvl=1');
  await advance(6, 1000 / 60);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  let state = await advance(7, 1000);
  assert.equal(state.fps, 0); assert.equal(state.quality, 'high', 'inactive frames cannot downgrade quality');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await advance(1, 20000)).fps, 0, 'focus gap does not become a sample');
  assert.equal((await advance(2, 1000 / 60)).fps, 60);
  await page.evaluate(() => frameProbe.visibility(true));
  const hidden = await advance(2, 30000);
  await page.evaluate(() => frameProbe.visibility(false));
  state = await advance(1, 30000);
  assert.equal(state.fps, 0); assert.ok(state.simulationSeconds - hidden.simulationSeconds <= 0.05);
  assert.equal((await advance(2, 1000 / 60)).quality, 'high');
  assert.equal((await advance(8, 750)).quality, 'med', 'sustained slow foreground frames downgrade automatic quality');
  await page.locator('#tl .lvl').click();
  const quality = page.locator('[data-a="quality"]');
  await quality.click(); await quality.click();
  assert.equal((await advance(9, 750)).quality, 'high', 'player-selected high quality is not overridden');

  await page.evaluate(() => PRISM.load(10));
  await page.locator('#tl .lvl').click();
  const draws = {};
  for (const level of ['high', 'med', 'low']) {
    if (level !== 'high') await quality.click();
    assert.equal(await page.evaluate(() => PRISM.state().quality), level);
    await page.evaluate(() => PRISM.step(1));
    const sample = await page.evaluate(() => frameProbe.measure());
    assert.ok(sample.measured[0] > 1 && sample.measured[1] > 1000);
    assert.deepEqual(sample.reported, sample.measured, `${level}: all native draws and triangles in one frame`);
    draws[level] = sample.measured;
  }
  assert.ok(draws.high[0] > draws.low[0]);
  assert.deepEqual(errors, []);
  console.log('PASS Prism frame timing: 60/4 FPS, bounded simulation, focus/visibility, automatic/manual quality; chamber 10 draws/triangles:', draws);
  await page.close();
  await checkReflections(browser);
  await checkFloorResources(browser);
} finally {
  await browser.close();
}

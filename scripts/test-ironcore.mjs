import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ offline: true, viewport: { width: 960, height: 600 } });
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('../dist/games/ironcore.html?manual&test&q=low&nointro&seed=164&lang=en', import.meta.url).href);
  const deploy = page.locator('[data-act="deploy"]');
  await deploy.waitFor({ timeout: 90000 });
  assert.deepEqual(await page.locator('[data-mech]').evaluateAll(tabs => tabs.map(tab => tab.dataset.mech)), ['vanguard', 'railgunner', 'bastion']);
  await page.locator('[data-mech="railgunner"]').click();
  assert.match(await page.locator('[data-mech].on').innerText(), /Railgunner/);
  await deploy.click();
  await page.keyboard.down('d');
  await page.mouse.move(620, 130);
  await page.mouse.down();
  const battle = await page.evaluate(() => {
    const game = window.__ironcore;
    let peakShake = 0;
    game.frame(16);
    for (let frame = 0; frame < 20; frame++) {
      game.frame(100);
      peakShake = Math.max(peakShake, Math.hypot(game.cam.sx, game.cam.sy, game.cam.sz));
    }
    game.render();
    const gl = document.querySelector('#gl').getContext('webgl2');
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const colors = new Set();
    for (let row = 0; row < height; row += 12) {
      for (let column = 0; column < width; column += 12) {
        const offset = (row * width + column) * 4;
        colors.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
      }
    }
    return { state: game.state(), peakShake, colors: colors.size };
  });
  assert.equal(battle.state.mode, 'battle');
  assert.ok(battle.state.alive && battle.state.fire && battle.state.x > 1 && battle.state.enemies > 0);
  assert.ok(battle.peakShake > 0 && battle.peakShake < 2, `bounded recoil at 10 fps: ${battle.peakShake}`);
  assert.ok(battle.colors > 100, 'the 3D arena remains visible, independent of the HUD');
  await page.mouse.up();
  await page.keyboard.up('d');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => { window.__ironcore.frame(17); return window.__ironcore.state().dashCharges; }), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__ironcore.state().mode), 'paused');
  await page.locator('[data-act="resume"]').click();

  const cleared = await page.evaluate(() => {
    const game = window.__ironcore;
    for (let tick = 0; tick < 50 && game.state().mode === 'battle'; tick++) {
      game.sim(0.5);
      game.killAll();
    }
    return game.state();
  });
  assert.equal(cleared.mode, 'cards');
  assert.equal(await page.locator('#cards .card').count(), 3);
  // The deal rejects early input, and accepting a module schedules the next gate.
  await page.clock.fastForward(1000);
  await page.locator('#cards .card.in').nth(2).click();
  await page.clock.fastForward(1000);
  await page.waitForFunction(() => window.__ironcore.state().wave === 2);
  const next = await page.evaluate(() => window.__ironcore.state());
  assert.equal(next.cardPicks, 1);
  assert.deepEqual([...errors, ...next.errors], []);
  console.log('PASS Iron Core Arena: offline WebGL, hangar, movement, 10-fps recoil, dash, pause/resume and first module pick');
} finally {
  await browser.close();
}

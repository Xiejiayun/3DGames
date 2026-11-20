import assert from 'node:assert/strict';

export async function checkPondSurface(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 512, height: 384 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let scene;
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
      if (!scene && detail.isScene) scene = detail;
    });
    window.samplePond = (width, depth) => {
      const water = scene.getObjectByName('layer-1').children.find(mesh => mesh.geometry?.type === 'ShapeGeometry' && mesh.material.normalMap);
      if (!water) return null;
      const { FrontSide, Raycaster, Vector3 } = PV.THREE;
      const ray = new Raycaster(), down = new Vector3(0, -1, 0), up = new Vector3(0, 1, 0);
      const above = []; let below = 0;
      for (let row = 0; row < depth; row++) {
        let tiles = '';
        for (let col = 0; col < width; col++) {
          const point = new Vector3(col * 2 - (width - 1) + 0.125, 1, row * 2 - (depth - 1) + 0.25);
          ray.set(point, down); tiles += ray.intersectObject(water, false).length ? 'w' : '.';
          point.y = -1; ray.set(point, up);
          if (ray.intersectObject(water, false).length) below++;
        }
        above.push(tiles);
      }
      const gl = document.querySelector('#gl').getContext('webgl2');
      const readFrame = () => {
        PRISM.step(0);
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const shown = readFrame();
      water.visible = false;
      let hidden;
      try { hidden = readFrame(); } finally { water.visible = true; PRISM.step(0); }
      let changed = 0;
      for (let offset = 0; offset < shown.length; offset += 4) {
        for (let channel = offset; channel < offset + 3; channel++) {
          if (Math.abs(shown[channel] - hidden[channel]) > 8) { changed++; break; }
        }
      }
      return { above, below, frontOnly: water.material.side === FrontSide, coverage: changed / (shown.length / 4) };
    };
  });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=1&q=low&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  for (const [level, footprint] of [
    [1, ['.......', '.......', '.......', '..wwww.', '.......']],
    [7, ['ww...ww', 'ww...ww', '.......', '.......', '.......', 'ww.....', 'ww.....']],
  ]) {
    const sample = await page.evaluate(({ level, footprint }) => {
      PRISM.load(level); PRISM.step(1);
      return samplePond(footprint[0].length, footprint.length);
    }, { level, footprint });
    assert.ok(sample, `chamber ${level} has a water surface`);
    assert.deepEqual(sample.above, footprint, `chamber ${level}: only pond tiles face the player`);
    assert.ok(sample.frontOnly && sample.below === 0, 'water is single-sided, not flipped or duplicated');
    assert.ok(sample.coverage > 0.001, `chamber ${level}: water changes the default rendered view (${sample.coverage})`);
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log('PASS Prism visible pond water and dry tiles in both chamber layouts');
}

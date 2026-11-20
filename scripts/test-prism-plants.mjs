import assert from 'node:assert/strict';

export async function checkPlantResources(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 512, height: 384 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let scene, renderer, water, ripples, sharedDisposals = 0;
    const releases = new Map();
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
      if (!scene && detail.isScene) scene = detail;
      if (detail.isWebGLRenderer) renderer = detail;
    });
    window.readPondPlants = () => {
      const base = scene.getObjectByName('layer-1');
      const surface = base.children.find(mesh => mesh.geometry?.type === 'ShapeGeometry' && mesh.material.normalMap);
      if (surface && !water) {
        water = surface.material; ripples = water.normalMap;
        for (const resource of [water, ripples]) resource.addEventListener('dispose', () => sharedDisposals++);
      }
      const plants = base.children.filter(mesh => ['CircleGeometry', 'ConeGeometry'].includes(mesh.geometry?.type));
      const current = new Set(plants.map(mesh => mesh.material)), programs = new Set();
      for (const material of current) {
        if (!releases.has(material)) {
          releases.set(material, 0);
          material.addEventListener('dispose', () => releases.set(material, releases.get(material) + 1));
        }
        const program = renderer.properties.get(material).currentProgram;
        if (!program) throw new Error('Sample plant materials only after drawing them');
        programs.add(program);
      }
      return {
        current: current.size, uses: [...programs].reduce((total, program) => total + program.usedTimes, 0),
        lifetime: [...releases].every(([material, count]) => count === (current.has(material) ? 0 : 1)),
        shared: sharedDisposals === 0 && (!surface || (surface.material === water && surface.material.normalMap === ripples)),
      };
    };
  });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=1&q=low&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  for (const quality of ['low', 'high']) {
    if (quality === 'high') {
      const menu = page.locator('#tl .lvl');
      if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
      await page.locator('[data-a="quality"]').click();
    }
    assert.equal(await page.evaluate(() => PRISM.state().quality), quality);
    const warmed = new Map();
    for (let round = 0; round < 3; round++) for (const level of [1, 7, 3]) {
      const sample = await page.evaluate(level => {
        if (PRISM.state().level !== level) PRISM.load(level);
        PRISM.step(0.75); return readPondPlants();
      }, level);
      assert.equal(sample.current, level === 3 ? 0 : 2, 'leaf and flower materials exist only in pond chambers');
      assert.ok(sample.lifetime, `leaving a pond releases every former plant material exactly once (${quality}, room ${level})`);
      assert.ok(sample.shared, 'ponds retain the same undisposed shared water and ripple map');
      if (round === 1) warmed.set(level, sample.uses);
      if (round === 2) assert.equal(sample.uses, warmed.get(level), 'returning to the same chamber must not retain extra shader references');
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log('PASS Prism pond plant disposal, shared water lifetime and stable shader references');
}

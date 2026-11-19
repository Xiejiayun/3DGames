import assert from 'node:assert/strict';

export async function checkDustResources(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 640, height: 440 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let scene, renderer, liveMaterials = 0;
    const materials = new WeakSet(), programs = new WeakSet();
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
      if (!scene && detail.isScene) scene = detail;
      if (detail.isWebGLRenderer) renderer = detail;
    });
    window.readDust = () => {
      const particles = [];
      scene.traverse(object => {
        if (!object.isPoints || !object.geometry.attributes.aGlow || !object.material.uniforms?.uGlowColor) return;
        particles.push(object.geometry.attributes.position.count);
        if (!materials.has(object.material)) {
          materials.add(object.material);
          liveMaterials++;
          object.material.addEventListener('dispose', () => liveMaterials--);
        }
        const program = renderer.properties.get(object.material).currentProgram;
        if (!program) throw new Error('Dust must be drawn before sampling its shader');
        programs.add(program);
      });
      const uses = renderer.info.programs.reduce((sum, program) => sum + (programs.has(program) ? program.usedTimes : 0), 0);
      return { particles, liveMaterials, uses };
    };
  });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=1&q=low&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const menu = page.locator('#tl .lvl');
  for (const [index, quality] of ['low', 'high', 'med', 'low', 'high', 'med', 'low'].entries()) {
    if (index) {
      if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
      await page.locator('[data-a="quality"]').click();
    }
    const sample = await page.evaluate(() => { PRISM.step(0.1); return { quality: PRISM.state().quality, ...readDust() }; });
    assert.deepEqual(sample, { quality, particles: [quality === 'low' ? 150 : 300], liveMaterials: 1, uses: 1 }, `dust after quality change ${index}`);
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log('PASS Prism dust density, material disposal and shader references across quality changes');
}

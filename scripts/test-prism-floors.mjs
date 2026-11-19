import assert from 'node:assert/strict';

export async function checkFloorResources(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 640, height: 440 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let scene, live = 0, sharedDisposals = 0;
    const textures = new WeakSet(), glass = [], privateDisposals = new Map();
    const proto = WebGL2RenderingContext.prototype;
    const create = proto.createTexture, remove = proto.deleteTexture;
    proto.createTexture = function () {
      const texture = create.call(this);
      if (texture) { textures.add(texture); live++; }
      return texture;
    };
    proto.deleteTexture = function (texture) {
      if (textures.delete(texture)) live--;
      return remove.call(this, texture);
    };
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
      if (!scene && detail.isScene) scene = detail;
    });
    function watch(material) {
      if (!material.userData.perLevel || privateDisposals.has(material)) return;
      privateDisposals.set(material, 0);
      material.addEventListener('dispose', () => privateDisposals.set(material, privateDisposals.get(material) + 1));
    }
    window.floorProbe = {
      recordHigh() {
        scene.traverse(mesh => {
          if (!mesh.isMesh || !mesh.material?.isMeshPhysicalMaterial || !(mesh.material.transmission > 0)) return;
          glass.push({ mesh, high: mesh.material });
          watch(mesh.material);
        });
        const halo = scene.getObjectByName('emitter').getObjectByProperty('isSprite', true);
        halo.material.map.addEventListener('dispose', () => sharedDisposals++);
      },
      recordLow() {
        for (const entry of glass) { entry.low = entry.mesh.material; watch(entry.low); }
        return glass.length > 0 && glass.every(entry => entry.high !== entry.low);
      },
      recordFade() {
        const hidden = glass.filter(entry => entry.mesh.material !== entry.low);
        for (const entry of hidden) entry.faded = entry.mesh.material;
        return hidden.length > 0 && hidden.every(entry => entry.faded.transparent && entry.faded.opacity > 0 && entry.faded.opacity < 0.1);
      },
      staysFaded: () => glass.filter(entry => entry.faded).every(entry => entry.mesh.material === entry.faded),
      revealed: quality => glass.every(entry => entry.mesh.material === entry[quality]),
      disposal: () => ({ privateCounts: [...privateDisposals.values()], sharedDisposals }),
      textures: () => live,
    };
  });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=10&q=high&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const step = () => page.evaluate(() => PRISM.step(0.75));
  const changeQuality = async expected => {
    const menu = page.locator('#tl .lvl');
    if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
    await page.locator('[data-a="quality"]').click();
    assert.equal(await page.evaluate(() => PRISM.state().quality), expected);
    await menu.click();
  };
  const floor = async key => { await page.locator(`#floors [data-f="${key}"]`).click(); await step(); };
  await step();
  await page.evaluate(() => floorProbe.recordHigh());
  await changeQuality('med'); await changeQuality('low');
  assert.ok(await page.evaluate(() => floorProbe.recordLow()), 'glass has distinct low/high materials');
  await floor('0');
  assert.ok(await page.evaluate(() => floorProbe.recordFade()), 'an unlit core must not erase the upper-floor silhouette');
  await changeQuality('high'); await step();
  assert.ok(await page.evaluate(() => floorProbe.staysFaded()), 'quality changes must not reveal hidden glass');
  await floor('all');
  assert.ok(await page.evaluate(() => floorProbe.revealed('high')), 'revealing a floor uses the selected quality');
  await floor('0'); await changeQuality('med'); await changeQuality('low');
  await floor('all');
  assert.ok(await page.evaluate(() => floorProbe.revealed('low')));
  await floor('0');
  await page.evaluate(() => { PRISM.load(1); PRISM.step(0.75); });
  const { privateCounts, sharedDisposals } = await page.evaluate(() => floorProbe.disposal());
  assert.ok(privateCounts.length >= 2 && privateCounts.every(count => count === 1), 'release both quality variants exactly once');
  assert.equal(sharedDisposals, 0, 'a room does not own the shared halo texture');
  const samples = [];
  for (let round = 0; round < 5; round++) {
    await page.evaluate(() => { PRISM.load(10); PRISM.step(0.75); });
    await floor('0');
    samples.push(await page.evaluate(() => { PRISM.load(1); PRISM.step(0.75); return floorProbe.textures(); }));
  }
  assert.ok(samples[0] > 0 && samples.every(count => count === samples[0]), `live WebGL textures after returning to room one: ${samples}`);
  assert.deepEqual(errors, []);
  await page.close();
  console.log('PASS Prism faded floor quality, material ownership, and stable texture counts:', samples);
}

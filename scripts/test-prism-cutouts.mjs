import assert from 'node:assert/strict';

export async function checkRoundCutouts(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 512, height: 384 } });
  await page.addInitScript(() => {
    let scene;
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
      if (!scene && detail.isScene) scene = detail;
    });
    window.sampleCutout = ({ layer, height }) => {
      const { FrontSide, Raycaster, Vector3 } = PV.THREE;
      const slab = scene.getObjectByName(`layer${layer}`).children.find(mesh => mesh.geometry?.type === 'ExtrudeGeometry' && Array.isArray(mesh.material));
      slab.updateWorldMatrix(true, false);
      const ray = new Raycaster(), centre = new Vector3(1, height, 0), up = new Vector3(0, 1, 0);
      function hit(origin, direction, far) {
        ray.set(origin, direction); ray.far = far;
        return ray.intersectObject(slab)[0];
      }
      function crosses(radius, direction, vertical) {
        const point = centre.clone().addScaledVector(direction, radius).addScaledVector(up, -vertical);
        return !!hit(point, up.clone().multiplyScalar(vertical), 2);
      }
      const walls = [], backs = [], blocked = [], missingStone = [];
      for (let index = 0; index < 8; index++) {
        const angle = (index + 0.31) * Math.PI / 4;
        const outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
        walls.push(hit(centre, outward, 0.95)?.distance ?? null);
        if (hit(centre.clone().addScaledVector(outward, 0.94), outward.clone().negate(), 0.8)) backs.push(index);
        for (const vertical of [-1, 1]) {
          if (crosses(0, outward, vertical) || crosses(0.62, outward, vertical)) blocked.push([index, vertical]);
          if (!crosses(0.92, outward, vertical)) missingStone.push([index, vertical]);
        }
      }
      return { frontOnly: slab.material.every(material => material.side === FrontSide), walls, backs, blocked, missingStone };
    };
  });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=3&q=low&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  await page.evaluate(() => PRISM.step(1));
  for (const [layer, height] of [[1, 3.6], [3, 7.65]]) {
    const sample = await page.evaluate(options => sampleCutout(options), { layer, height });
    assert.ok(sample.walls.every(distance => distance > 0.68 && distance < 0.72), `layer ${layer}: stone faces the open shaft; hits ${JSON.stringify(sample.walls)}`);
    assert.ok(sample.frontOnly, `layer ${layer}: the slab remains single-sided`);
    assert.deepEqual(sample.backs, [], `layer ${layer}: the back of the bore is culled`);
    assert.deepEqual(sample.blocked, [], `layer ${layer}: light can pass through the opening from either floor`);
    assert.deepEqual(sample.missingStone, [], `layer ${layer}: the upper and lower decks still surround the opening`);
  }
  await page.close();
  console.log('PASS Prism single-sided round cutouts: normal slab, roof and two-way clearance');
}

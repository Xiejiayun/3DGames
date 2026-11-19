import assert from 'node:assert/strict';

export async function checkRelayTravel(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 640, height: 440 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let scene;
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
      if (!scene && detail.isScene) scene = detail;
    });
    window.shutterExtent = () => {
      const gate = scene.getObjectByName('gate');
      const shutter = gate.children.find(child => child.userData.anim);
      gate.updateWorldMatrix(true, true);
      const floor = gate.getWorldPosition(gate.position.clone()).y;
      let bottom = Infinity, top = -Infinity;
      shutter.traverse(part => {
        if (!part.isMesh) return;
        part.geometry.computeBoundingBox();
        const bounds = part.geometry.boundingBox.clone().applyMatrix4(part.matrixWorld);
        bottom = Math.min(bottom, bounds.min.y - floor);
        top = Math.max(top, bounds.max.y - floor);
      });
      return { bottom, top, visible: shutter.visible };
    };
  });
  await page.goto(new URL('../dist/games/prism.html?manual&lvl=9&q=low&lang=en&mute=1', import.meta.url).href);
  await page.locator('#boot').waitFor({ state: 'detached' });
  const sample = () => page.evaluate(() => { PRISM.step(2); return { ...shutterExtent(), open: PRISM.state().open }; });
  const closed = await sample();
  assert.deepEqual(closed.open, []);
  assert.ok(closed.visible && closed.bottom < 1 && closed.top >= 1 && closed.top <= 1.6,
    `closed shutter spans beam height without emerging through the lintel (top ${closed.top})`);
  await page.evaluate(() => { PRISM.solveRef(); PRISM.step(4); });
  const powered = await sample();
  assert.deepEqual(powered.open, ['g1']);
  assert.ok(powered.top < 0 && !powered.visible, 'fully retracted shutter is not rendered below its floor');
  await page.locator('[data-s="stay"]').click();
  for (let undo = 0; undo < 3; undo++) await page.keyboard.press('Control+z');
  const restored = await sample();
  assert.deepEqual(restored.open, []);
  assert.ok(restored.visible && Math.abs(restored.top - closed.top) < 0.005, 'cutting supply returns the shutter to its seat');
  assert.deepEqual(errors, []);
  await page.close();
}

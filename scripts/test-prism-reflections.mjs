import assert from 'node:assert/strict';

export async function checkReflections(browser) {
  const page = await browser.newPage({ offline: true, viewport: { width: 640, height: 440 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let samplers = null, reference = null;
    const uniforms = new WeakMap();
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) {
        if (samplers) {
          const program = this.getParameter(this.CURRENT_PROGRAM);
          if (!uniforms.has(program)) uniforms.set(program, this.getUniformLocation(program, 'envMap'));
          const uniform = uniforms.get(program);
          if (uniform !== null) {
            const active = this.getParameter(this.ACTIVE_TEXTURE);
            this.activeTexture(this.TEXTURE0 + this.getUniform(program, uniform));
            samplers.add(this.getParameter(this.TEXTURE_BINDING_2D));
            this.activeTexture(active);
          }
        }
        return original.apply(this, args);
      };
    }
    const pixels = () => {
      const gl = document.querySelector('#gl').getContext('webgl2');
      PRISM.step(0);
      const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    window.reflectionProbe = {
      maps() {
        samplers = new Set();
        PRISM.step(0);
        const valid = samplers.size === 1 && !samplers.has(null);
        samplers = null;
        return valid;
      },
      save() {
        reference = pixels();
        const tones = new Set();
        for (let offset = 0; offset < reference.length; offset += 64) tones.add(reference[offset]);
        return tones.size;
      },
      changedFraction() {
        const current = pixels();
        let changed = 0;
        for (let offset = 0; offset < current.length; offset += 4) {
          for (let channel = 0; channel < 3; channel++) {
            if (Math.abs(current[offset + channel] - reference[offset + channel]) <= 12) continue;
            changed++;
            break;
          }
        }
        return changed / (current.length / 4);
      },
    };
  });
  const board = () => page.evaluate(() => {
    const { level, quality, layout, history, selected, complete, floor } = PRISM.state();
    return { level, quality, layout, history, selected, complete, floor };
  });
  for (const [level, quality] of [[1, 'low'], [10, 'high']]) {
    await page.goto(new URL(`../dist/games/prism.html?manual&lvl=${level}&q=${quality}&lang=en&mute=1`, import.meta.url).href);
    await page.locator('#boot').waitFor({ state: 'detached' });
    if (level === 1) {
      await page.keyboard.press('1');
      await page.evaluate(() => PRISM.step(1));
      await page.locator('#guide-socket').click();
    } else await page.evaluate(() => PRISM.solveRef());
    await page.evaluate(() => PRISM.step(3));
    if (level === 10) {
      await page.locator('[data-s="stay"]').click();
      await page.locator('#floors [data-f="0"]').click();
      await page.evaluate(() => PRISM.step(2));
    }
    const original = await board();
    assert.ok(original.layout.length > 0);
    assert.ok(await page.evaluate(() => reflectionProbe.save()) > 20, 'the reference frame is not blank');
    assert.equal(await page.evaluate(() => reflectionProbe.changedFraction()), 0, 'frozen simulation produces a stable frame');
    await page.evaluate(() => {
      const canvas = document.querySelector('#gl');
      const extension = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Cannot exercise context recovery');
      canvas.addEventListener('webglcontextrestored', () => { window.graphicsRestored = true; }, { once: true });
      canvas.addEventListener('webglcontextlost', () => setTimeout(() => extension.restoreContext(), 100), { once: true });
      extension.loseContext();
    });
    await page.waitForFunction(() => window.graphicsRestored, undefined, { polling: 50, timeout: 20000 });
    assert.deepEqual(await board(), original, 'restoring the GPU must not restart the puzzle');
    assert.ok(await page.evaluate(() => reflectionProbe.changedFraction()) < 0.001, `${quality}: restoring the GPU preserves scene lighting`);
    if (level === 1) {
      await page.keyboard.press('r');
      assert.ok(await page.evaluate(() => { PRISM.step(3); return PRISM.state().complete; }), 'the restored chamber is playable');
      for (const room of [2, 7, 9, 10, 1]) {
        await page.evaluate(room => { PRISM.load(room); PRISM.step(1); }, room);
        assert.ok(await page.evaluate(() => reflectionProbe.maps()), `room ${room}: every reflective draw samples the current chapter map`);
      }
    } else {
      await page.locator('#floors [data-f="all"]').click();
      await page.evaluate(() => PRISM.step(2));
      assert.ok(await page.evaluate(() => reflectionProbe.maps()), 'revealing a floor restores the correct reflective materials');
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log('PASS Prism chapter reflection bindings and low/high WebGL context recovery');
}

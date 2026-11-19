import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const output = process.env.ACE_SCREENSHOTS ? resolve(process.env.ACE_SCREENSHOTS, 'lighting')
  : process.env.ACE_QA_OUTPUT ? resolve(process.env.ACE_QA_OUTPUT) : await mkdtemp(join(tmpdir(), 'ace-lighting-'));
await mkdir(output, { recursive: true });
const original = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const threeVersion = '0.160.0', threePrefix = `https://unpkg.com/three@${threeVersion}/`;
let threeRoot = process.env.ACE_THREE_ROOT && resolve(process.env.ACE_THREE_ROOT);
if (!threeRoot) {
  try { threeRoot = resolve(fileURLToPath(import.meta.resolve('three')), '../..'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
}
if (threeRoot) assert.equal(JSON.parse(await readFile(join(threeRoot, 'package.json'), 'utf8')).version, threeVersion);

// Test-only access to the actual inline module. The shipped game needs no capture API.
function installProbes() {
  const nativeRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeRAF(callback);
  const step = () => animate(lastTime + 1000 / 60);
  const render = () => composer ? composer.render() : renderer.render(scene, camera);
  const gl = renderer.getContext();
  const pixels = (centerOnly = false) => {
    const width = centerOnly ? 196 : gl.drawingBufferWidth, height = centerOnly ? 168 : gl.drawingBufferHeight;
    const result = new Uint8Array(width * height * 4);
    gl.readPixels((gl.drawingBufferWidth - width) >> 1, (gl.drawingBufferHeight - height) >> 1, width, height, gl.RGBA, gl.UNSIGNED_BYTE, result);
    return result;
  };
  const difference = (first, second) => {
    let total = 0, changed = 0, darker = 0;
    for (let offset = 0; offset < first.length; offset += 4) {
      const red = second[offset] - first[offset], green = second[offset + 1] - first[offset + 1], blue = second[offset + 2] - first[offset + 2];
      const absolute = (Math.abs(red) + Math.abs(green) + Math.abs(blue)) / 3;
      total += absolute;
      if (absolute > 5) changed++;
      if (red + green + blue > 18) darker++;
    }
    return { mean: total * 4 / first.length, changed, darker };
  };
  const pointCamera = (eye, target) => {
    camera.position.copy(eye); camera.lookAt(target); camera.updateMatrixWorld(); updateEnvironment(0);
  };
  const seaRow = distance => {
    const point = new THREE.Vector3(camera.position.x, 0, camera.position.z - distance).project(camera);
    return Math.max(0, Math.min(gl.drawingBufferHeight - 1, Math.round((1 + point.y) * gl.drawingBufferHeight / 2)));
  };
  window.aceQA = {
    step, cycle: cycleQuality,
    info: () => ({ revision: THREE.REVISION, webgl: renderer.capabilities.isWebGL2 ? 2 : 1, quality, hdr: supportsHDR(), post: !!composer,
      size: [gl.drawingBufferWidth, gl.drawingBufferHeight], dpr: renderer.getPixelRatio(),
      postSize: composer && [composer.readBuffer.width, composer.readBuffer.height],
      shadow: sunLight.shadow.map?.width ?? 0, clouds: cloudGeo.instanceCount, probes: skyProbes.size,
      weatherIds: [cloudBanks.id, cloudGeo.id, cloudMat.id, cloudTex.id, bolt.id, bolt.geometry.id, bolt.material.id], cloudSeed: cloudOffsets.getY(0),
      environment: scene.environment?.uuid ?? null, bolt: bolt.visible, flash: skyUniforms.uLightning.value,
      memory: { ...renderer.info.memory }, gpu: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) }),
    launch(id) {
      window.__ACE_DEBUG__.startMission(id, 0);
      camera.position.copy(player.pos).add(new THREE.Vector3(0, 5, 23));
      step();
      const image = pixels(), rgb = [0, 0, 0];
      let samples = 0;
      for (let row = Math.floor(gl.drawingBufferHeight * 0.63); row < gl.drawingBufferHeight; row += 8) {
        for (let col = 0; col < gl.drawingBufferWidth; col += 8) {
          const offset = (row * gl.drawingBufferWidth + col) * 4;
          for (let channel = 0; channel < 3; channel++) rgb[channel] += image[offset + channel];
          samples++;
        }
      }
      return rgb.map(value => Math.round(value / samples));
    },
    probeRadiance() {
      const target = skyProbes.get(selMissionIdx), sample = new Uint16Array(4);
      renderer.readRenderTargetPixels(target, 32, 32, 1, 1, sample);
      return [...sample.slice(0, 3)].map(THREE.DataUtils.fromHalfFloat);
    },
    horizonProbe() {
      render(); const image = pixels(), width = gl.drawingBufferWidth;
      const bottom = seaRow(8500) - 2, top = seaRow(1e7) + 2;
      let peak = 0;
      for (const [left, right] of [[0.03, 0.16], [0.85, 0.97]]) {
        let previous;
        for (let row = bottom; row <= top; row++) {
          const sums = [0, 0, 0]; let count = 0;
          for (let col = Math.floor(left * width); col < right * width; col++) {
            const offset = (row * width + col) * 4;
            for (let channel = 0; channel < 3; channel++) sums[channel] += image[offset + channel];
            count++;
          }
          if (previous) peak = Math.max(peak, ...sums.map((sum, channel) => Math.abs(sum - previous[channel]) / count));
          previous = sums;
        }
      }
      return { peak, rowsFromTop: [gl.drawingBufferHeight - 1 - top, gl.drawingBufferHeight - 1 - bottom], altitude: Math.round(player.pos.y) };
    },
    surfaceProbe() {
      pointCamera(new THREE.Vector3(6800, 255, 6200), new THREE.Vector3(6800, 251, 6135));
      render(); const reference = pixels(), width = gl.drawingBufferWidth;
      const band = (image, near, far) => {
        const histogram = new Uint32Array(256); let sum = 0, count = 0;
        for (let row = seaRow(near); row <= seaRow(far); row++) {
          for (let col = Math.floor(width * 0.06); col < width * 0.40; col++) {
            const offset = (row * width + col) * 4;
            const delta = (Math.abs(image[offset] - reference[offset]) + Math.abs(image[offset + 1] - reference[offset + 1]) + Math.abs(image[offset + 2] - reference[offset + 2])) / 3;
            sum += delta; histogram[Math.round(delta)]++; count++;
          }
        }
        let p99 = 0, cumulative = histogram[0];
        while (cumulative < count * 0.99) cumulative += histogram[++p99];
        return { mean: sum / count, p99 };
      };
      const ripple = oceanUniforms.uRippleMap, originalMap = ripple.value;
      const flat = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
      flat.needsUpdate = true; ripple.value = flat; render(); const flatImage = pixels();
      const nearDetail = band(flatImage, 500, 720), farDetail = band(flatImage, 2400, 3600);
      ripple.value = originalMap; flat.dispose();
      camera.position.z -= player.speed / 60; updateEnvironment(1 / 60); render();
      return { nearDetail, farDetail, cruiseFar: band(pixels(), 2000, 3600) };
    },
    shadowProbe(altitude = 36) {
      player.pos.set(4320, altitude, 4210); player.mesh.position.copy(player.pos); player.mesh.quaternion.identity();
      const direction = skyUniforms.uSunDir.value;
      const ground = player.pos.clone().addScaledVector(direction, -player.pos.y / direction.y);
      pointCamera(ground.clone().add(new THREE.Vector3(0, 72, 26)), ground);
      render(); const withShadow = pixels(true);
      const casters = [];
      player.mesh.traverse(part => { if (part.castShadow) { casters.push(part); part.castShadow = false; } });
      render(); const result = { altitude, ...difference(withShadow, pixels(true)) };
      casters.forEach(part => { part.castShadow = true; });
      const sample = ground.clone().applyMatrix4(sunLight.shadow.matrix);
      const shift = new THREE.Vector3(7.13, 0, -4.18);
      player.pos.add(shift); camera.position.add(shift); followSun(); scene.updateMatrixWorld(); sunLight.shadow.updateMatrices(sunLight);
      const motion = ground.clone().applyMatrix4(sunLight.shadow.matrix).sub(sample).multiplyScalar(sunLight.shadow.mapSize.x);
      result.texelResidual = Math.max(...[motion.x, motion.y].map(value => Math.abs(value - Math.round(value))));
      player.pos.sub(shift); camera.position.sub(shift); followSun(); render();
      return result;
    },
    coastProbe() {
      const island = islands[0];
      let land = 0, sea = island.radius * 1.25;
      for (let iteration = 0; iteration < 12; iteration++) {
        const mid = (land + sea) / 2;
        if (island.sampleHeight(mid, 0) > 0) land = mid; else sea = mid;
      }
      const coast = new THREE.Vector3(island.cx + sea, 0, island.cz);
      pointCamera(coast.clone().add(new THREE.Vector3(155, 112, 145)), coast);
      render(); const first = pixels();
      const radius = islandUniformData[0].z;
      islandUniformData[0].z = 1; render(); const surf = difference(first, pixels());
      islandUniformData[0].z = radius; oceanMesh.position.x += oceanCell; render();
      const snap = difference(first, pixels()); oceanMesh.position.x -= oceanCell; render();
      return { surf, snap };
    },
    wakeProbe() {
      const ship = carrierRef, forward = new THREE.Vector3(Math.sin(ship.heading), 0, Math.cos(ship.heading));
      const stern = ship.pos.clone().addScaledVector(forward, -160);
      pointCamera(stern.clone().add(new THREE.Vector3(145, 212, -344)), stern);
      render(); const first = pixels();
      const lengths = wakeUniformData.map(wake => wake.w);
      wakeUniformData.forEach(wake => { wake.w = 0; }); render(); const result = difference(first, pixels());
      wakeUniformData.forEach((wake, index) => { wake.w = lengths[index]; }); render();
      return { lengths, ...result };
    },
    sinkCarrier() { carrierRef.alive = false; step(); return wakeUniformData.map(wake => wake.w); },
    colorProbe() {
      pointCamera(new THREE.Vector3(4500, 120, 4000), new THREE.Vector3(4600, 88, 4700));
      bloomPass.enabled = false; composer.render(); const composed = pixels();
      renderer.render(scene, camera); const result = difference(composed, pixels());
      bloomPass.enabled = true; return result;
    },
    strike() { nextLightning = 0; updateEnvironment(0.01); render(); },
    weather(id) { setAtmosphere(MISSIONS[id]); render(); },
    failPost() { composer.render = () => { throw new Error('injected post failure'); }; step(); },
    lose() { this.loss = gl.getExtension('WEBGL_lose_context'); this.loss.loseContext(); },
    restore() { this.loss.restoreContext(); }
  };
}

const boot = '// Boot\ntry {';
const source = original.replaceAll('\r\n', '\n');
assert.ok(source.includes(boot), 'missing Ace boot entrypoint');
const html = source.replace(boot, () => `(${installProbes.toString()})();\n${boot}`);
const server = createServer((req, res) => {
  if (req.url !== '/games/ace.html') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const url = `http://127.0.0.1:${server.address().port}/games/ace.html`;
const errors = [], report = { threeVersion, moduleSource: threeRoot ? 'local package' : 'pinned CDN', missions: [] };
let browser;
try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, locale: 'zh-CN', reducedMotion: 'no-preference' });
  if (threeRoot) await context.route('https://**', route => {
    const url = route.request().url(), file = resolve(threeRoot, url.slice(threePrefix.length));
    if (url.startsWith(threePrefix) && file.startsWith(threeRoot + sep) && file.endsWith('.js')) {
      return route.fulfill({ path: file, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    errors.push(`Unexpected external request: ${url}`); return route.abort();
  });
  await context.addInitScript(() => {
    let seed = 160;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  const capture = name => page.screenshot({ path: join(output, `${name}.png`) });
  const info = () => page.evaluate(() => aceQA.info());
  await page.goto(url); await page.waitForFunction(() => window.aceQA && window.__ACE_DEBUG__);
  await page.evaluate(() => aceQA.step());
  const initial = await info();
  assert.equal(initial.revision, '160'); assert.ok(initial.hdr && initial.post); report.gpu = initial.gpu;
  await page.addStyleTag({ content: 'html.survey body > :not(#gl) { visibility: hidden !important }' });
  for (const [id, name] of ['day', 'sunset', 'storm'].entries()) {
    if (id === 1) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(() => aceQA.info().size[0] === 1280);
    }
    const sky = await page.evaluate(id => aceQA.launch(id), id);
    await capture(id === 1 ? 'sunset-chase' : name);
    if (id === 1) {
      report.horizon = await page.evaluate(() => aceQA.horizonProbe());
      assert.ok(report.horizon.altitude === 250 && report.horizon.peak < 3, JSON.stringify(report.horizon));
      report.surface = await page.evaluate(() => aceQA.surfaceProbe());
      const { nearDetail, farDetail, cruiseFar } = report.surface;
      assert.ok(nearDetail.mean > 0.35 && farDetail.mean < 0.12 && cruiseFar.p99 <= 4, JSON.stringify(report.surface));
      await page.setViewportSize({ width: 960, height: 540 });
      await page.waitForFunction(() => aceQA.info().size[0] === 960);
    }
    await page.evaluate(() => document.documentElement.classList.add('survey'));
    const shadow = await page.evaluate(altitude => aceQA.shadowProbe(altitude), [36, 1100, 250][id]);
    await capture(`shadow-${name}`);
    assert.ok(shadow.darker > 35 && shadow.texelResidual < 1e-5, `${name} shadow: ${JSON.stringify(shadow)}`);
    const radiance = await page.evaluate(() => aceQA.probeRadiance());
    assert.ok(radiance.every(value => Number.isFinite(value) && value > 0.003), `${name}: empty sky probe ${radiance}`);
    report.missions.push({ name, sky, shadow, probe: (await info()).environment, radiance });
    if (id === 0) {
      report.coast = await page.evaluate(() => aceQA.coastProbe()); await capture('coast');
      assert.ok(report.coast.surf.changed > 400 && report.coast.snap.mean < 0.3, JSON.stringify(report.coast));
      report.color = await page.evaluate(() => aceQA.colorProbe()); assert.ok(report.color.mean < 2, JSON.stringify(report.color));
    }
    if (id === 2) {
      report.wake = await page.evaluate(() => aceQA.wakeProbe()); await capture('fleet-wakes');
      assert.ok(report.wake.lengths.filter(Boolean).length === 3 && report.wake.changed > 450, JSON.stringify(report.wake));
      assert.deepEqual(await page.evaluate(() => aceQA.sinkCarrier()), [280, 280, 0, 0]);
      await page.evaluate(() => { aceQA.launch(2); aceQA.strike(); }); await capture('lightning');
      assert.ok((await info()).bolt);
    }
    await page.evaluate(() => document.documentElement.classList.remove('survey'));
  }
  const [day, sunset, storm] = report.missions.map(mission => mission.sky);
  assert.ok(day[2] > day[0] + 15 && sunset[0] > sunset[2] + 15 && storm[1] > 35 && storm[1] < day[1] - 25);
  assert.equal(new Set(report.missions.map(mission => mission.probe)).size, 3);
  assert.ok(report.missions[0].radiance[2] > report.missions[2].radiance[2] * 1.5);

  const active = await info();
  assert.ok(active.bolt && active.flash > 0);
  report.sortieWeather = [];
  for (const id of [0, 2]) {
    await page.evaluate(id => aceQA.launch(id), id);
    const state = await info();
    assert.ok(!state.bolt && state.flash === 0); assert.deepEqual(state.weatherIds, active.weatherIds);
    report.sortieWeather.push({ mission: id, bolt: state.bolt, flash: state.flash });
  }
  await page.evaluate(() => aceQA.strike());
  const before = await info();
  for (const id of [0, 1, 2, 1, 0, 2]) await page.evaluate(id => aceQA.weather(id), id);
  const after = await info();
  assert.equal(after.bolt, false); assert.equal(after.flash, 0); assert.equal(after.probes, 3);
  assert.deepEqual(after.weatherIds, before.weatherIds); assert.equal(after.cloudSeed, before.cloudSeed);
  assert.deepEqual(after.memory, before.memory); report.weatherMemory = after.memory;
  await page.evaluate(() => aceQA.strike());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => aceQA.step()); assert.equal((await info()).bolt, false);
  await page.evaluate(() => aceQA.strike()); assert.equal((await info()).flash, 0); assert.equal((await info()).bolt, false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  report.tiers = [];
  for (const [name, shadowSize] of [['med', 1024], ['low', 0], ['high', 2048]]) {
    await page.evaluate(() => { aceQA.strike(); aceQA.cycle(); aceQA.step(); });
    const state = await info();
    assert.equal(state.quality, name); assert.equal(state.shadow, shadowSize); assert.equal(state.post, name === 'high');
    assert.equal(state.bolt, false); assert.equal(state.flash, 0); assert.deepEqual(state.weatherIds, before.weatherIds);
    if (state.post) assert.deepEqual(state.size, state.postSize);
    report.tiers.push({ name, shadowSize, clouds: state.clouds }); await capture(`storm-${name}`);
    if (name === 'med') {
      report.mediumShadow = await page.evaluate(() => aceQA.shadowProbe());
      assert.ok(report.mediumShadow.darker > 35 && report.mediumShadow.texelResidual < 1e-5);
      await page.evaluate(() => aceQA.launch(2));
    }
  }
  const metrics = await page.context().newCDPSession(page);
  await metrics.send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 920, deviceScaleFactor: 2, mobile: false });
  await page.waitForFunction(() => aceQA.info().dpr > 1 && aceQA.info().dpr < 1.5);
  report.resize = await info(); assert.deepEqual(report.resize.postSize, report.resize.size);
  assert.ok(report.resize.size[0] * report.resize.size[1] <= 2200000);
  for (const [quality, budget] of [['med', 1400000], ['low', 800000], ['high', 2200000]]) {
    await page.evaluate(() => { aceQA.cycle(); aceQA.step(); });
    const state = await info(); assert.equal(state.quality, quality);
    assert.ok(state.size[0] * state.size[1] <= budget); assert.equal(state.post, quality === 'high');
    if (state.post) assert.deepEqual(state.postSize, state.size);
  }
  await metrics.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(() => aceQA.lose());
  await page.waitForFunction(() => document.querySelector('#bootErr').textContent.includes('Restoring'));
  await page.evaluate(() => aceQA.restore());
  await page.waitForFunction(() => !document.querySelector('#bootErr').textContent);
  await page.evaluate(() => aceQA.step());
  assert.equal(await page.evaluate(() => __ACE_DEBUG__.getState().mode), 'paused');
  const recovered = await info(); assert.ok(recovered.post && recovered.environment && recovered.environment !== before.environment);
  await page.evaluate(() => aceQA.failPost()); assert.equal((await info()).post, false);
  await page.evaluate(() => aceQA.step());

  report.fallbacks = {};
  for (const available of ['webgl2-no-float', 'webgl1', 'none']) {
    const fallback = await context.newPage();
    await fallback.setViewportSize({ width: 640, height: 360 });
    await fallback.addInitScript(available => {
      if (available === 'webgl2-no-float') {
        const getExtension = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function(name) {
          return name === 'EXT_color_buffer_float' ? null : getExtension.call(this, name);
        };
        return;
      }
      const native = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (type === 'webgl2' || (available === 'none' && type.includes('webgl'))) return null;
        return native.call(this, type, ...args);
      };
    }, available);
    if (available !== 'none') {
      fallback.on('pageerror', error => errors.push(error.message));
      fallback.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    }
    await fallback.goto(url);
    if (available !== 'none') {
      await fallback.waitForFunction(() => window.aceQA);
      const sky = await fallback.evaluate(() => aceQA.launch(0));
      const state = await fallback.evaluate(() => aceQA.info());
      assert.equal(state.webgl, available === 'webgl1' ? 1 : 2);
      assert.ok(!state.hdr && !state.post && state.environment === null && sky[2] > 90);
      report.fallbacks[available] = { webgl: state.webgl, sky, post: state.post, environment: state.environment };
      await fallback.screenshot({ path: join(output, `${available}-direct.png`) });
    } else {
      await fallback.locator('#bootErr').waitFor({ state: 'visible' });
      assert.match(await fallback.locator('#bootErr').textContent(), /WebGL unavailable/);
      report.fallbacks.none = 'visible WebGL unavailable message';
    }
    await fallback.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'passed', ...report, errors }, null, 2));
  console.log(`PASS r${initial.revision} WebGL lighting, sunset horizon/ripple motion, shadows, coast/wakes, weather reuse, quality, resize, recovery and direct fallbacks. Evidence: ${output}`);
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', ...report, errors, failure: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const source = (await readFile(new URL('../games/ace.html', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const boot = '// Boot\ntry {';
assert.ok(source.includes(boot) && source.includes(prefix));
const html = source.replace(boot, () => `(${installProbe.toString()})();\n${boot}`);
const output = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'fx-uploads');
const profile = process.argv.includes('--profile');
if (output) await mkdir(output, { recursive: true });

function installProbe() {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeFrame(callback);
  const step = () => animate(lastTime + 1000 / 60);
  const ahead = depth => camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(depth).add(camera.position);
  const gl = renderer.getContext();
  window.aceFX = {
    info: () => ({ webgl: renderer.capabilities.isWebGL2 ? 2 : 1, quality, size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) }),
    uploads() {
      step();
      renderer.shadowMap.enabled = false;
      const owner = new Map(), still = new THREE.Vector3(), point = ahead(110);
      for (const [label, layer] of [['smoke', smokeLayer], ['glow', glowLayer]]) {
        for (const name of ['centerSize', 'tintAlpha', 'spin']) owner.set(layer.geometry.attributes[name].array.buffer, `${label}.${name}`);
      }
      const pack = (smoke, glow, flare = false) => {
        particles.length = flares.length = 0;
        for (let index = 0; index < smoke + glow; index++) spawnParticle(point, still, 0xffc78b, 9, 2, 1, index >= smoke);
        if (flare) deployFlares();
        renderParticleLayers();
      };
      const draw = () => renderer.render(scene, camera);
      pack(1, 1); draw();
      pack(0, 0); draw();
      const { calls, triangles } = renderer.info.render;
      const nativeUpload = gl.bufferSubData, rows = [];
      let writes;
      gl.bufferSubData = function(target, offset, data, start = 0, count) {
        const key = owner.get(data.buffer);
        if (key) writes.push({ key, offset, start: data.byteOffset + start * data.BYTES_PER_ELEMENT,
          bytes: (count || (data.length - start)) * data.BYTES_PER_ELEMENT });
        return nativeUpload.apply(this, arguments);
      };
      try {
        for (const [label, smoke, glow, flare] of [['one smoke', 1, 0], ['mixed', 5, 3], ['grow', 100, 100],
          ['shrink', 0, 1], ['repack before draw', 0, 2], ['hidden', 0, 0], ['full plus flares', 0, 420, true]]) {
          if (label === 'repack before draw') pack(12, 16);
          pack(smoke, glow, flare);
          writes = []; draw();
          rows.push({ label, smoke: smokeLayer.geometry.instanceCount, glow: glowLayer.geometry.instanceCount, writes,
            calls: renderer.info.render.calls - calls, triangles: renderer.info.render.triangles - triangles });
        }
      } finally { gl.bufferSubData = nativeUpload; }
      return rows;
    },
    snapshot() {
      window.__ACE_DEBUG__.setCameraMode('1p');
      step(); spawnExplosion(ahead(100), 0.85);
      for (let index = 0; index < 12; index++) step();
      return glCanvas.toDataURL();
    },
    async sample(phase, count) {
      const intervals = [];
      let previous = await new Promise(nativeFrame), draws = 0, maxFX = 0, boltFrames = 0;
      for (let index = 0; index < count; index++) {
        if (index % 36 === 0 && phase === 'explosion') spawnExplosion(ahead(135), 1, true);
        if (index % 36 === 0 && phase === 'storm') nextLightning = 0;
        step();
        draws += renderer.info.render.calls; maxFX = Math.max(maxFX, particles.length); boltFrames += Number(bolt.visible);
        const next = await new Promise(nativeFrame);
        intervals.push(next - previous); previous = next;
      }
      intervals.sort((left, right) => left - right);
      const percentile = fraction => Number(intervals[Math.ceil(count * fraction) - 1].toFixed(1));
      return { frames: count, p50ms: percentile(0.5), p95ms: percentile(0.95), drawsPerFrame: Number((draws / count).toFixed(1)),
        maxFX, boltFrames, memory: { ...renderer.info.memory } };
    }
  };
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], report = { chromium: browser.version(), three: version, seed: 160, uploads: {} };
try {
  const context = await browser.newContext({ viewport: { width: 720, height: 405 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  await context.route('**/*', route => {
    const request = route.request().url();
    if (request === url) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    const file = resolve(root, request.slice(prefix.length));
    if (request.startsWith(prefix) && file.startsWith(root + sep) && file.endsWith('.js')) {
      return route.fulfill({ path: file, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    errors.push(`Unexpected request: ${request}`); return route.abort();
  });
  await context.addInitScript(() => {
    let seed = 160;
    Math.random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  });
  const open = async (webgl, mission = 0, low = false) => {
    const page = await context.newPage();
    if (webgl === 1) await page.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : get.call(this, type, ...args); };
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url); await page.waitForFunction(() => window.aceFX && window.__ACE_DEBUG__);
    if (low) { await page.locator('#qualBtn').click(); await page.locator('#qualBtn').click(); }
    if (mission) await page.locator(`[data-mission="${mission}"]`).click();
    await page.locator('#sortieBtn').click();
    const info = await page.evaluate(() => aceFX.info());
    assert.equal(info.webgl, webgl); assert.equal(info.quality, low ? 'low' : 'high');
    return page;
  };
  for (const webgl of [2, 1]) {
    const page = await open(webgl);
    report.uploads[webgl] = await page.evaluate(() => aceFX.uploads());
    await page.close();
  }
  if (output) {
    const page = await open(2, 0, true);
    const image = await page.evaluate(() => aceFX.snapshot());
    await writeFile(join(output, 'cockpit-explosion.png'), Buffer.from(image.split(',')[1], 'base64'));
    await page.close();
  }
  if (profile) {
    report.scenarios = {};
    for (const phase of ['cruise', 'explosion', 'storm']) {
      const page = await open(2, phase === 'storm' ? 2 : 0, true);
      report.config = await page.evaluate(() => aceFX.info());
      await page.evaluate(phase => aceFX.sample(phase, 36), phase);
      const result = await page.evaluate(phase => aceFX.sample(phase, 72), phase);
      if (phase === 'explosion') assert.ok(result.maxFX >= 39);
      if (phase === 'storm') assert.ok(result.boltFrames > 0);
      report.scenarios[phase] = result;
      if (phase === 'explosion') {
        report.restarts = [];
        for (let index = 0; index < 3; index++) {
          await page.keyboard.press('p'); await page.locator('#btnRestart').click();
          const sample = await page.evaluate(() => aceFX.sample('cruise', 8));
          assert.equal(sample.maxFX, 0); report.restarts.push(sample.memory);
        }
        assert.deepEqual(report.restarts.slice(1), [report.restarts[0], report.restarts[0]]);
      }
      await page.close();
    }
    console.log('Fixed-step flight, wall-clock frame intervals:', JSON.stringify({ config: report.config, scenarios: report.scenarios, restarts: report.restarts }));
  }
  if (output) await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  assert.deepEqual(errors, []);
  for (const [webgl, rows] of Object.entries(report.uploads)) {
    assert.deepEqual(rows.map(row => [row.smoke, row.glow]), [[1, 0], [5, 3], [100, 100], [0, 1], [0, 2], [0, 0], [0, 428]]);
    for (const { label, smoke, glow, writes, calls, triangles } of rows) {
      const expected = [];
      for (const [layer, count] of [['smoke', smoke], ['glow', glow]]) if (count) {
        for (const [name, stride] of [['centerSize', 4], ['tintAlpha', 4], ['spin', 1]]) {
          expected.push({ key: `${layer}.${name}`, offset: 0, start: 0, bytes: count * stride * 4 });
        }
      }
      const byKey = (left, right) => left.key.localeCompare(right.key);
      assert.deepEqual(writes.sort(byKey), expected.sort(byKey), `WebGL${webgl} ${label}: only the live prefix of each attribute`);
      assert.equal(calls, Number(!!smoke) + Number(!!glow)); assert.equal(triangles, 2 * (smoke + glow));
    }
  }
  console.log('PASS real WebGL 1/2 particle uploads: sparse, mixed, growth, shrink, undrawn repack, hidden and full capacity with flares.');
} finally { await browser.close(); }

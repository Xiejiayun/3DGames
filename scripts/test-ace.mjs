import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const threeRoot = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const { version } = JSON.parse(await readFile(resolve(threeRoot, 'package.json'), 'utf8'));
const threePrefix = `https://unpkg.com/three@${version}/`;
const output = process.env.ACE_SCREENSHOTS;
if (output) await mkdir(output, { recursive: true });

function measureParticleBudget() {
  const place = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(20).add(camera.position);
  const still = new THREE.Vector3();
  renderer.shadowMap.enabled = false;
  const renderPassStats = () => {
    renderer.info.reset();
    renderer.render(scene, camera);
    const { calls, triangles } = renderer.info.render;
    return { calls, triangles };
  };
  const before = renderPassStats();
  for (let index = 0; index < 200; index++) spawnParticle(place, still, 0xffdba8, 0.15, 1, 1, index % 2 === 0);
  updateProjectilesAndFX(0);
  const after = renderPassStats();
  return { calls: after.calls - before.calls, triangles: after.triangles - before.triangles, count: particles.length };
}

const server = createServer(async (req, res) => {
  try {
    const { pathname, search } = new URL(req.url, 'http://localhost');
    const file = resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    const ext = extname(file);
    res.setHeader('content-type', ext === '.webp' ? 'image/webp' : ext === '.js' ? 'application/javascript' : 'text/html; charset=utf-8');
    if (pathname === '/games/ace.html' && search === '?fx-budget') {
      res.end(data.toString('utf8').replace(/<\/script>(\s*<\/body>)/,
        () => `window.measureParticleBudget = ${measureParticleBudget.toString()};</script></body>`));
    } else res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' });
  const errors = [];
  await page.route('https://**', async route => {
    const url = route.request().url();
    if (url.startsWith(threePrefix)) {
      const file = resolve(threeRoot, url.slice(threePrefix.length));
      if (file.startsWith(threeRoot + sep) && extname(file) === '.js') {
        return route.fulfill({ path: file, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }
    errors.push(`Unexpected external request: ${url}`);
    return route.abort();
  });
  page.on('pageerror', e => errors.push(`PAGEERROR: ${e}`));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`CONSOLE_ERROR: ${msg.text()}`);
  });

  const state = () => page.evaluate(() => window.__ACE_DEBUG__.getState());
  async function frames(count = 2) {
    const start = (await state()).frameCount;
    await page.waitForFunction(target => window.__ACE_DEBUG__.getState().frameCount >= target, start + count);
  }
  const capture = async name => {
    if (output) await page.screenshot({ path: resolve(output, `${name}.png`) });
  };
  async function sampleScene(name) {
    await frames(4);
    const sample = await page.evaluate(() => new Promise(done => requestAnimationFrame(() => {
      const surface = document.createElement('canvas');
      surface.width = 48; surface.height = 27;
      const ctx = surface.getContext('2d');
      ctx.drawImage(document.querySelector('#gl'), 0, 0, 48, 27);
      const pixels = ctx.getImageData(0, 0, 48, 27).data;
      const mean = [0, 0, 0], luminance = [];
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let channel = 0; channel < 3; channel++) mean[channel] += pixels[offset + channel];
        luminance.push(pixels[offset] * 0.21 + pixels[offset + 1] * 0.72 + pixels[offset + 2] * 0.07);
      }
      luminance.sort((left, right) => left - right);
      done({ mean: mean.map(sum => Math.round(sum / luminance.length)),
        contrast: luminance[Math.floor(luminance.length * 0.95)] - luminance[Math.floor(luminance.length * 0.05)] });
    })));
    assert.ok(sample.contrast > 15, `${name}: expected visible sky/scene contrast, measured ${JSON.stringify(sample)}`);
    await capture(name);
    return sample.mean;
  }

  await page.goto(`${origin}/games/ace.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ACE_DEBUG__ && window.__ACE_DEBUG__.getState().frameCount >= 5, null, { timeout: 20000 });

  let st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'hangar');
  assert.equal(st.lang, 'zh');
  await capture('hangar');
  const memory = [];
  for (const jet of [0, 1, 2, 0, 1, 2, 0]) {
    await page.locator(`[data-jet="${jet}"]`).click();
    await frames();
    if (jet === 0) memory.push((await state()).gpu);
  }
  for (const snapshot of memory.slice(1)) {
    assert.ok(snapshot.geometries <= memory[0].geometries + 12, `Hangar leaked geometries: ${JSON.stringify(memory)}`);
    assert.ok(snapshot.textures <= memory[0].textures + 2, `Hangar leaked textures: ${JSON.stringify(memory)}`);
  }

  // Switch aircraft & mission in Hangar
  await page.locator('[data-jet="1"]').click();
  await page.locator('[data-mission="1"]').click();
  await page.locator('#langBtn').click();
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.selJetIdx, 1);
  assert.equal(st.selMissionIdx, 1);
  assert.equal(st.lang, 'en');

  // Switch back to ZH, Mission 1, Jet 0 and launch sortie
  await page.locator('#langBtn').click();
  await page.locator('[data-jet="0"]').click();
  await page.locator('[data-mission="0"]').click();
  await page.locator('#hangarAssist').uncheck();
  await page.locator('#sortieBtn').click();

  await page.mouse.move(640, 360);
  const daylight = await sampleScene('day-chase');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'playing');
  assert.ok(st.enemiesAlive >= 4, 'Mission 1 enemies spawned');

  // Test weapons, flares, camera toggle (3P -> 1P -> 3P), pause & resume
  await page.keyboard.press('KeyV');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.cameraMode, '1p', 'Switched to 1P 3D cockpit');
  await sampleScene('day-cockpit');

  await page.keyboard.press('KeyV');
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => {
    const { fx } = window.__ACE_DEBUG__.getState();
    return fx.flares === 8 && fx.smokeInstances > 0 && fx.glowInstances >= 8;
  });
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.fx.smokeInstances + st.fx.glowInstances, st.fx.particles + st.fx.flares);
  await capture('day-effects');
  assert.equal(st.cameraMode, '3p');
  assert.equal(st.activeWeapon, 'spw');
  assert.ok(st.mslAmmo < 2, 'Standard missile fired');
  assert.ok(st.spwAmmo < 16, 'Special weapon fired');

  await page.keyboard.press('Escape');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'paused');
  await page.locator('#btnResume').click();
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'playing');

  // Test Mission 2 (Sunset Fjord) & Mission 3 (Storm Carrier) load cleanly
  await page.evaluate(() => window.__ACE_DEBUG__.startMission(1, 0));
  const sunset = await sampleScene('sunset-chase');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.selMissionIdx, 1);
  assert.ok(st.enemiesAlive >= 8, 'Mission 2 radar/SAM/fighters spawned');
  assert.equal(st.fx.flares + st.fx.missiles + st.fx.glowInstances, 0, 'New sortie clears the previous effects');

  if (process.env.CAPTURE_PREVIEW === '1') {
    // Capture an iconic 16:9 Sunset Fjord in-flight action screenshot!
    await page.keyboard.down('KeyW');
    await page.mouse.move(660, 340);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__ACE_DEBUG__.fireMissile());
    await page.waitForTimeout(180);
    const pngBuf = await page.screenshot({ type: 'png' });
    await page.keyboard.up('KeyW');

    const webpB64 = await page.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 960; c.height = 540;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, 960, 540);
      return c.toDataURL('image/webp', 0.88).split(',')[1];
    }, pngBuf.toString('base64'));
    await mkdir(resolve(root, 'assets/previews'), { recursive: true });
    await writeFile(resolve(root, 'assets/previews/ace-archipelago.webp'), Buffer.from(webpB64, 'base64'));
    console.log('Captured assets/previews/ace-archipelago.webp');
  }

  await page.evaluate(() => window.__ACE_DEBUG__.startMission(2, 2));
  const storm = await sampleScene('storm-chase');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.selMissionIdx, 2);
  assert.ok(st.enemiesAlive >= 6, 'Mission 3 carrier fleet spawned');
  for (const [first, second] of [[daylight, sunset], [sunset, storm], [daylight, storm]]) {
    assert.ok(first.some((channel, index) => Math.abs(channel - second[index]) > 12), `Mission palettes collapsed: ${first} vs ${second}`);
  }
  await page.keyboard.press('Escape');
  for (const expected of ['med', 'low', 'high']) {
    await page.locator('#pauseQualBtn').click();
    await frames();
    assert.equal((await state()).quality, expected);
  }
  await page.locator('#btnHangar').click();
  await page.locator('#sortieBtn').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await frames();
  assert.equal((await state()).mode, 'playing');
  await capture('narrow-sortie');

  await page.goto(`${origin}/games/ace.html?fx-budget`);
  await page.waitForFunction(() => window.__ACE_DEBUG__?.getState().frameCount >= 3);
  const budget = await page.evaluate(() => window.measureParticleBudget());
  assert.deepEqual(budget, { calls: 2, triangles: 400, count: 200 }, '200 visible quads must render in two color draws');

  assert.deepEqual(errors, [], `Expected zero runtime/console errors, got: ${errors.join('; ')}`);
  console.log('PASS Ace: 3 jets, 3 distinct rendered missions, 1P/3P, batched flares & reset, quality, pause, narrow layout, ZH/EN; zero errors');
  console.log('Same-aircraft GPU samples:', memory, 'mission RGB:', { daylight, sunset, storm });
  console.log('Fixed FX workload (additional color draws, triangles, particles):', budget);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}

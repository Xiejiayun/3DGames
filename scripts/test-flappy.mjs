import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Test-only access to the actual inline module. No diagnostic globals ship to players.
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('games/flappy.html', root), 'utf8');
const bridge = `window.qa = {
  THREE, scene, camera, renderer, bird, pipes, chunks, terrainH, lumpy, flock, feathers, cloudMesh, cloudField, farMeshes, lakeMist, sun, waterMat, skyUniforms, cloudAtlas, bgHeightRT, skyRT,
  setBird, setQuality, resetGame, startGame, flap, update, animateVisuals,
  updateCamera, togglePause, CFG,
  get state() { return state; }, get birdY() { return birdY; },
  set birdY(v) { birdY = v; }, set scroll(v) { scroll = v; },
  get paused() { return paused; },
  set score(v) { score = v; },
  stop() { running = false; adaptive.enabled = false; },
  render(dt = 0) { renderFrame(dt); }
};`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html.replace(/<\/script>\s*<\/body>/, bridge + '</script></body>'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const output = process.env.FLAPPY_SCREENSHOTS;
async function screenshot(name) {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/${name}.png` });
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/games/flappy.html`);
  await page.waitForFunction(() => window.__fb3dReady && window.qa, null, { timeout: 60000 });
  await page.evaluate(() => qa.stop());
  const landscape = await page.evaluate(() => {
    qa.setQuality('low'); qa.render();
    const low = qa.chunks.reduce((n, c) => n + c.grassMesh.count, 0);
    qa.setQuality('high'); qa.render();
    const high = qa.chunks.reduce((n, c) => n + c.grassMesh.count, 0);
    const seam = Math.max(...[-270, -140, -16, -9, 0, 9, 75, 270].map(z =>
      Math.abs(qa.terrainH(0, z) - qa.terrainH(768, z))));
    const geo = qa.lumpy(1, 3.3, 0.14), expected = geo.clone();
    expected.computeVertexNormals();
    const normals = geo.attributes.normal.array;
    const normalError = Math.max(...normals.map((v, i) => Math.abs(v - expected.attributes.normal.array[i])));
    geo.dispose(); expected.dispose();
    return { low, high, seam, normalError };
  });
  assert.equal(landscape.low, 0, 'low quality must hide grass');
  assert(landscape.high > 10000, 'low -> high must restore vegetation');
  assert(landscape.seam < 1e-8, 'terrain loop must join continuously');
  assert(landscape.normalError < 1e-6, 'deformed rocks and crowns need updated normals');
  await screenshot('landscape-desktop');
  const birds = await page.evaluate(() => {
    const highlightsAttached = qa.bird.glints.every(g => qa.bird.eyes.includes(g.parent) &&
      Math.abs(g.position.length() - 0.145) < 0.004);
    const skins = ['blue', 'red', 'yellow'].map(name => {
      qa.setBird(name); return qa.bird.mats.body.color.getHex();
    });
    qa.flap();
    const particles = qa.feathers.filter(f => f.m.visible).length;
    qa.resetGame();
    const cleared = qa.feathers.every(f => f.life === 0 && !f.m.visible);
    const bodyScales = qa.flock.children.map(b => b.children[0].scale.toArray());
    qa.render(0.15);
    const articulated = qa.flock.children.every(b => b.userData.wings.length === 2 &&
      Math.abs(b.userData.wings[0].rotation.x + b.userData.wings[1].rotation.x) < 1e-10);
    const stableBodies = qa.flock.children.every((b, i) => b.children[0].scale.toArray().every((v, j) => v === bodyScales[i][j]));
    return { highlightsAttached, skins, particles, cleared, articulated, stableBodies };
  });
  assert(birds.highlightsAttached, 'eye highlights must stay on the eye surface');
  assert.equal(new Set(birds.skins).size, 3, 'all three skins must remain distinct');
  assert(birds.particles > 0 && birds.cleared, 'restart must clear previous feather particles');
  assert(birds.articulated && birds.stableBodies, 'flock wings flap without squashing bodies');
  for (const skin of ['blue', 'red', 'yellow']) {
    await page.evaluate(name => {
      qa.setBird(name); qa.render();
    }, skin);
    await screenshot('bird-' + skin);
  }
  console.log('PASS Flappy birds:', birds);
  await page.evaluate(() => { qa.resetGame(); qa.render(); });
  for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const framing = await page.evaluate(() => {
      window.dispatchEvent(new Event('resize')); qa.render();
      const p = qa.bird.root.position.clone().project(qa.camera);
      const title = document.querySelector('.title').getBoundingClientRect();
      const menu = document.querySelector('#menu').getBoundingClientRect();
      return { x: (1 + p.x) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2,
        title: title.bottom, menu: menu.top, width: innerWidth };
    });
    assert(framing.y > framing.title && framing.y < framing.menu, 'menu preview must remain in free space');
    assert(Math.abs(framing.x - framing.width / 2) < 2, 'menu preview must remain centred');
    await screenshot('menu-' + width + 'x' + height);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#startBtn').click();
  assert.equal(await page.evaluate(() => qa.state), 'play', 'start button begins gameplay');
  const pause = await page.evaluate(() => {
    qa.flap(); qa.render(0.05); qa.pipes[4].appear = 0.1; qa.pipes[4].pose(); qa.togglePause(true);
    const snapshot = () => JSON.stringify({
      birdY: qa.birdY, camera: qa.camera.position.toArray(),
      objects: [...qa.lakeMist, qa.flock].map(o => o.position.toArray()),
      bird: qa.bird.body.scale.toArray(), eyes: qa.bird.eyes.map(o => o.scale.toArray()),
      feathers: qa.feathers.map(f => [f.life, ...f.m.position.toArray()]),
      pipes: qa.pipes.map(p => [p.x, p.appear, p.top.position.y]),
      cirrus: qa.skyUniforms.uCirrusOff.value.toArray(),
      clouds: Array.from(qa.cloudMesh.geometry.attributes.iPos.array),
    });
    const before = snapshot();
    for (let i = 0; i < 10; i++) { qa.update(0.1); qa.render(0.1); }
    return before === snapshot();
  });
  assert(pause, 'pause must freeze all scene transforms, particles and timers');
  await page.keyboard.press('KeyP');
  assert.equal(await page.evaluate(() => qa.paused), false, 'keyboard resumes gameplay');
  const sceneryQuality = await page.evaluate(() => {
    const sample = mode => {
      qa.setQuality(mode); qa.render();
      return { clouds: qa.cloudMesh.geometry.instanceCount,
        triangles: qa.farMeshes.reduce((n, m) => n + m.geometry.index.count / 3, 0),
        geometries: qa.renderer.info.memory.geometries };
    };
    const low = sample('low'), high = sample('high'), med = sample('med'), again = sample('high');
    return { low, high, med, again, sunAbove: qa.sun.position.y > qa.sun.target.position.y };
  });
  assert(sceneryQuality.high.clouds > sceneryQuality.med.clouds && sceneryQuality.med.clouds > sceneryQuality.low.clouds, 'cloud coverage must follow quality changes');
  assert(sceneryQuality.high.triangles > sceneryQuality.med.triangles && sceneryQuality.med.triangles > sceneryQuality.low.triangles, 'far terrain must follow quality changes');
  assert.equal(sceneryQuality.high.triangles, sceneryQuality.again.triangles, 'quality cycling must preserve terrain layout');
  assert.equal(sceneryQuality.high.geometries, sceneryQuality.again.geometries, 'quality cycling must release replaced terrain geometry');
  assert(sceneryQuality.sunAbove, 'physical sky light must come from above');
  await screenshot('physical-sky-mountains-clouds');
  const shadows = await page.evaluate(() => {
    qa.setQuality('med'); qa.render(); const med = qa.sun.shadow.map.width;
    qa.setQuality('high'); qa.render(); return { med, high: qa.sun.shadow.map.width };
  });
  assert.deepEqual(shadows, { med: 1024, high: 2048 }, 'quality changes must resize shadow render targets');
  await page.evaluate(() => {
    qa.loss = qa.renderer.getContext().getExtension('WEBGL_lose_context');
    if (!qa.loss) throw new Error('WEBGL_lose_context unavailable');
    qa.loss.loseContext();
  });
  await page.waitForFunction(() => window.__fb3dReady === false && !document.querySelector('#loading').classList.contains('hide'));
  await page.evaluate(() => qa.loss.restoreContext());
  await page.waitForFunction(() => window.__fb3dReady, null, { timeout: 60000 });
  await page.evaluate(() => qa.stop());
  assert.equal(await page.evaluate(() => qa.paused), true, 'restored gameplay waits for the player to resume');
  const restoredTextures = await page.evaluate(() => {
    const cloud = new Uint8Array(1024 * 1024 * 4);
    qa.renderer.readRenderTargetPixels(qa.cloudAtlas, 0, 0, 1024, 1024, cloud);
    let opaque = 0;
    for (let i = 3; i < cloud.length; i += 4) if (cloud[i] > 128) opaque++;
    const terrain = new Uint8Array(4), sky = new Uint16Array(4);
    qa.renderer.readRenderTargetPixels(qa.bgHeightRT, 0, 0, 1, 1, terrain);
    qa.renderer.readRenderTargetPixels(qa.skyRT, 256, 96, 1, 1, sky);
    return { cloudPixels: opaque, terrainAO: terrain[3], sky: Array.from(sky.slice(0, 3)) };
  });
  assert(restoredTextures.cloudPixels > 1000 && restoredTextures.terrainAO > 0 && restoredTextures.sky.some(v => v > 0), 'restored GPU targets must contain sky, mountain and cloud data');
  await screenshot('context-restored');
  console.log('Restored GPU targets:', restoredTextures);
  console.log('PASS Flappy camera, scenery quality, pause, shadows and context recovery', sceneryQuality);
  assert.deepEqual(errors, [], 'browser and shader errors');
  console.log('PASS Flappy landscape:', landscape);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

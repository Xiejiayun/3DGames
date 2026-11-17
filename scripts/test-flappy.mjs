import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Test-only access to the actual inline module. No diagnostic globals ship to players.
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('games/flappy.html', root), 'utf8');
const bridge = `window.qa = {
  THREE, scene, camera, renderer, bird, pipes, chunks, terrainH, lumpy, flock, feathers,
  setBird, setQuality, resetGame, startGame, flap, update, animateVisuals,
  updateCamera, togglePause, CFG,
  get state() { return state; }, get birdY() { return birdY; },
  set birdY(v) { birdY = v; }, set scroll(v) { scroll = v; },
  set score(v) { score = v; }, set tod(v) { tod = v; },
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
  await page.waitForFunction(() => window.__fb3dReady, null, { timeout: 60000 });
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
  assert.deepEqual(errors, [], 'browser and shader errors');
  console.log('PASS Flappy landscape:', landscape);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

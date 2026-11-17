import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Test-only access to the actual inline module. No diagnostic globals ship to players.
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('games/flappy.html', root), 'utf8');
const bridge = `window.qa = {
  THREE, scene, camera, renderer, bird, pipes, chunks, terrainH, lumpy, flock, pipeGeo, pipeGeoLow, pipeExtGeo,
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
  const pipeChecks = await page.evaluate(() => {
    const ray = new qa.THREE.Raycaster(new qa.THREE.Vector3(0.1, 1, 0), new qa.THREE.Vector3(0, -1, 0));
    const openings = [qa.pipeGeo, qa.pipeGeoLow].map(geo => {
      const mesh = new qa.THREE.Mesh(geo, qa.pipes[0].bottom.material);
      mesh.updateMatrixWorld(true);
      const hits = ray.intersectObject(mesh);
      return hits.length && hits[0].distance > 3.5;
    });
    const nearRadii = [qa.pipeGeo, qa.pipeGeoLow].map(geo => {
      const p = geo.attributes.position;
      return Math.max(...Array.from({ length: p.count }, (_, i) => Math.hypot(p.getX(i), p.getZ(i))));
    });
    const ext = qa.pipeExtGeo.attributes.position;
    const ringVertices = new Set(Array.from({ length: ext.count }, (_, i) =>
      [ext.getX(i).toFixed(5), ext.getZ(i).toFixed(5)].join(','))).size;
    const pipe = qa.pipes[0]; pipe.setX(0); pipe.setGap(6.2, qa.CFG.PIPE_GAP); pipe.updateBoxes();
    const gap = pipe.boxes.every(box => !box.containsPoint(new qa.THREE.Vector3(0, 6.2, 0)));
    const solidRim = pipe.boxes[1].containsPoint(new qa.THREE.Vector3(0.95, pipe.lo - 0.2, 0));
    return { openings, nearRadii, ringVertices, gap, solidRim };
  });
  assert(pipeChecks.openings.every(Boolean), 'near and far pipe mouths must be recessed');
  assert(Math.abs(pipeChecks.nearRadii[0] - pipeChecks.nearRadii[1]) < 1e-5, 'LOD rims must have matching silhouette');
  assert(pipeChecks.ringVertices >= 30 && pipeChecks.ringVertices <= 32, 'extension must match the 30-segment body');
  assert(pipeChecks.gap && pipeChecks.solidRim, 'collision proxies must leave a passable gap and solid rims');
  console.log('PASS Flappy pipes:', pipeChecks);
  assert.deepEqual(errors, [], 'browser and shader errors');
  console.log('PASS Flappy landscape:', landscape);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

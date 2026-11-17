import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/kart.html', import.meta.url), 'utf8');
const expose = `globalThis.qa = { THREE, scene, camera, renderer, TRACKS, CHARS,
  buildTrackAndWorld, buildKartMesh, startRace, backToMenu, spawnItemEffect,
  stepRacer, updateProjectiles, animate, get samples(){return trackSamples},
  get world(){return worldGroup}, get racers(){return racers},
  get props(){return animatedProps}, get projectiles(){return activeProjectiles},
  get ramps(){return jumpRamps}, set track(v){selectedTrack=v},
  set char(v){selectedChar=v}, set state(v){gameState=v} };`;
const instrumented = html.replace(/<\/script>\s*<\/body>/, `${expose}</script></body>`);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(instrumented);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const screenshots = process.env.KART_SCREENSHOTS || join(tmpdir(), 'kart-3d-check');
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // Deterministic static frames avoid timing differences in visual evidence.
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    localStorage.setItem('tk3d_hq', '0');
    localStorage.setItem('tk3d_mute', '1');
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/games/kart.html`);
  await page.waitForFunction(() => !!globalThis.qa, null, { polling: 100, timeout: 60000 });
  for (let id = 0; id < 3; id++) {
    const result = await page.evaluate(id => {
      qa.track = id; qa.startRace(); qa.state = 'review';
      const failures = [];
      qa.world.traverse(o => {
        const a = o.geometry?.attributes.position?.array;
        if (a && !a.every(Number.isFinite)) failures.push(`nonfinite geometry: ${o.name}`);
      });
      const road = qa.world.getObjectByName('road-surface');
      if (!road || road.geometry.attributes.normal.getY(0) < .9) failures.push('road must face up');
      if (!qa.world.getObjectByName('road-foundation')) failures.push('missing deck');
      if (!qa.world.getObjectByName('deck-pier')) failures.push('missing piers');
      if (qa.ramps.some(r => !r.halfWidth || !r.tangent)) failures.push('ramp trigger has no frame');
      const wedge = qa.world.getObjectByName('jump-ramp');
      wedge.geometry.computeBoundingBox();
      const size = wedge.geometry.boundingBox.getSize(new qa.THREE.Vector3());
      if (Math.abs(size.x - 7.6) > .01 || Math.abs(size.z - 5.2) > .01) failures.push('ramp dimensions');
      // Exercise real update paths, including every item, instead of only booting.
      for (let n = 0; n < 180; n++) for (const r of qa.racers) qa.stepRacer(r, 1/60, n/60);
      for (const item of ['banana', 'missile', 'bubble', 'shield', 'magnet', 'nitro']) qa.spawnItemEffect(qa.racers[0], item);
      qa.updateProjectiles(1/60);
      if (qa.racers.some(r => !Number.isFinite(r.pos.length()))) failures.push('nonfinite racer');
      document.getElementById('ui').style.display = 'none';
      return { id: qa.TRACKS[id].id, failures };
    }, id);
    assert.deepEqual(result.failures, [], `${result.id}: ${result.failures.join(', ')}`);
    for (const t of [.17, .41, .65]) {
      await page.evaluate(t => {
        const s = qa.samples[Math.floor(t * 600)];
        qa.camera.position.copy(s.pos).addScaledVector(s.tangent, -20).add(new qa.THREE.Vector3(0, 6, 0));
        qa.camera.lookAt(s.pos.clone().add(new qa.THREE.Vector3(0, 3, 0)));
        qa.renderer.render(qa.scene, qa.camera);
      }, t);
      await page.screenshot({ path: join(screenshots, `${result.id}-${t}.png`) });
    }
    console.log(`PASS ${result.id}: geometry, race updates, all items, screenshots`);
  }
  const memory = await page.evaluate(() => {
    qa.backToMenu();
    const counts = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const track of qa.TRACKS) qa.buildTrackAndWorld(track);
      qa.renderer.render(qa.scene, qa.camera);
      counts.push({ ...qa.renderer.info.memory });
    }
    return counts;
  });
  assert.ok(memory[2].textures <= memory[1].textures, `texture growth: ${JSON.stringify(memory)}`);
  assert.ok(memory[2].geometries <= memory[1].geometries, `geometry growth: ${JSON.stringify(memory)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.getElementById('ui').style.display = ''; qa.animate(performance.now()); });
  await page.screenshot({ path: join(screenshots, 'mobile-menu.png') });
  await page.locator('#startBtn').click();
  await page.evaluate(() => qa.animate(performance.now() + 50));
  await page.screenshot({ path: join(screenshots, 'mobile-race.png') });
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log(`PASS repeated scene disposal: ${JSON.stringify(memory)}; mobile menu/start; no browser errors`);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// Optional browser QA: npm install --no-save --package-lock=false playwright
const pw = process.env.PLAYWRIGHT_MODULE
  ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  : await import('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.env.CS_QA_OUTPUT || join(root, '.cs-qa'));
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/games/cs.html') {
    res.writeHead(404).end(); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(await readFile(join(root, 'games/cs.html')));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
const errors = [], report = {};
try {
  browser = await pw.chromium.launch({ headless: true, ...(process.env.CS_CHROME ? { executablePath: process.env.CS_CHROME } : {}), args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.stack));
  await page.addInitScript(() => localStorage.setItem('midnight-port.qual', 'low'));
  await page.goto(`http://127.0.0.1:${server.address().port}/games/cs.html`);
  await page.waitForFunction(() => window.MIDNIGHT_PORT?.map);
  await page.locator('#btn-deploy').click();
  await page.waitForFunction(() => MIDNIGHT_PORT.state === 'playing');
  await page.keyboard.press('b');
  await page.waitForFunction(() => MIDNIGHT_PORT.state === 'shop');
  await page.screenshot({ path: join(output, 'shop.png') });
  await page.locator('#shop-close').click();
  await page.waitForFunction(() => ['playing', 'resuming'].includes(MIDNIGHT_PORT.state));
  await page.evaluate(() => { MIDNIGHT_PORT.pause(); MIDNIGHT_PORT.dirty = false; });

  report.map = await page.evaluate(() => {
    const g = MIDNIGHT_PORT, W = g.world, seen = new Set([0]), todo = [0];
    while (todo.length) for (const l of g.map.nav.nodes[todo.pop()].links) if (!seen.has(l.to)) { seen.add(l.to); todo.push(l.to); }
    const b = g.player.body;
    b.pos.set(-39.8, 0, 16.27); b.vel.set(0, 0, 0); b.onGround = true;
    const walk = (x, z) => {
      for (let i = 0; i < 2000 && Math.hypot(x - b.pos.x, z - b.pos.z) > 0.08; i++) {
        const dx = x - b.pos.x, dz = z - b.pos.z, d = Math.hypot(dx, dz);
        b.vel.x = dx / d * 3; b.vel.z = dz / d * 3; W.moveBody(b, 0.01);
      }
      return { x: b.pos.x, y: b.pos.y, z: b.pos.z };
    };
    const up = walk(-12.5, 16.27), down = walk(-39.8, 16.27);
    return {
      count: g.map.nav.nodes.length, connected: seen.size,
      blocked: g.map.nav.nodes.filter(n => !W.bodyFree(n.x, n.y, n.z, 0.42, 1.74)).map(n => n.id), up, down,
      sandbagBlocks: !W.lineClear(-27.8, 2.95, 16.3, -27.8, 2.95, 18),
      railBlocks: !W.lineClear(-30.5, 3.12, 17.1, -30.5, 3.12, 18),
      railGapClear: W.lineClear(-30.5, 3.35, 17.1, -30.5, 3.35, 18),
      canopyBlocks: !W.bodyFree(-6.5, 2.6, 2.1, 0.2, 0.4),
      cabBlocks: !W.bodyFree(25.6, 2.61, 29.5, 0.2, 0.7),
    };
  });
  assert.equal(report.map.connected, report.map.count);
  assert.deepEqual(report.map.blocked, []);
  assert.ok(Math.abs(report.map.up.y - 7.8) < 0.01 && Math.abs(report.map.down.y) < 0.01);
  for (const key of ['sandbagBlocks', 'railBlocks', 'railGapClear', 'canopyBlocks', 'cabBlocks']) assert.equal(report.map[key], true, key);

  report.campaign = await page.evaluate(() => {
    const g = MIDNIGHT_PORT, result = [];
    for (const faction of ['ct', 't']) {
      g.state = 'paused'; g.toMenu(); g.setFaction(faction);
      for (let n = 1; n <= 6; n++) {
        g.beginLevel(n, 'new'); g.state = 'paused';
        result.push({ faction, level: n, foes: g.enemies.list.length, blocked: g.enemies.list.filter(e => !g.world.bodyFree(e.body.pos.x, e.body.pos.y, e.body.pos.z, e.body.radius, e.body.height)).map(e => e.name) });
      }
      g.weapons.inv.sniper = { owned: true, mag: 5, reserve: 10 };
      for (const id of ['knife', 'pistol', 'ar', 'sniper', 'frag', 'smoke']) {
        const w = g.weapons; w.current = id; w.resetTransient(); g.player.update(1 / 60);
        for (let i = 0; i < 30; i++) w.update(1 / 60);
        g.render();
      }
    }
    return result;
  });
  for (const run of report.campaign) assert.deepEqual(run.blocked, [], `${run.faction}/${run.level}`);

  report.actions = await page.evaluate(() => {
    const g = MIDNIGHT_PORT; g.beginLevel(1, 'new'); g.state = 'paused'; g.player.update(0.016);
    const w = g.weapons; w.inv.ar.mag = 29; w.reload();
    for (let i = 0; i < 240; i++) w.update(1 / 60);
    const reloaded = w.inv.ar.mag === 30 && !w.reloading;
    g.input.fire = true;
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    g.input.fire = false;
    const fired = g.stats.shots > 0 && w.inv.ar.mag < 30;
    w.inv.sniper = { owned: true, mag: 5, reserve: 10 }; w.current = 'sniper'; w.resetTransient(); g.input.ads = true;
    for (let i = 0; i < 60; i++) w.update(1 / 60);
    const scoped = w.isScoped; g.input.release();
    for (let i = 0; i < 60; i++) w.update(1 / 60);
    return { reloaded, fired, scoped, unscoped: !w.isScoped };
  });
  for (const [action, passed] of Object.entries(report.actions)) assert.equal(passed, true, action);

  report.preview = await page.evaluate(async () => {
    const T = await import('three'), S = MIDNIGHT_PORT.ui.showcase;
    let maxExtent = 0;
    for (const crop of [1, 16 / 9, 3]) for (const id of ['m4', 'ak', 'sniper', 'pistol', 'vest', 'frag', 'smoke']) {
      S.show(id, crop);
      for (let i = 0; i < 24; i++) {
        S.render(i * Math.PI / 12); S.camera.updateMatrixWorld();
        S.models[id].traverse(o => {
          if (!o.isMesh) return;
          const p = o.geometry.attributes.position, v = new T.Vector3();
          for (let j = 0; j < p.count; j++) {
            v.fromBufferAttribute(p, j).applyMatrix4(o.matrixWorld).project(S.camera);
            maxExtent = Math.max(maxExtent, Math.abs(v.x) * Math.max(1, S.aspect / crop), Math.abs(v.y) * Math.max(1, crop / S.aspect));
          }
        });
      }
    }
    S.show('m4'); S.time = 2.3; S.render(-1.1);
    S.snapshot('pistol', document.querySelector('.side canvas'));
    return { maxExtent, current: S.current, time: S.time, angle: S.pivot.rotation.y };
  });
  assert.ok(report.preview.maxExtent < 0.95);
  assert.equal(report.preview.current, 'm4'); assert.equal(report.preview.time, 2.3); assert.equal(report.preview.angle, -1.1);

  for (const quality of ['high', 'med', 'low']) {
    await page.evaluate(q => {
      const g = MIDNIGHT_PORT; g.setQuality(q); g.state = 'paused';
      document.querySelectorAll('.overlay,#hud,#banner').forEach(e => e.classList.add('hidden'));
      g.vmScene.visible = false; g.camera.position.set(13, 5, 35); g.camera.lookAt(24, 2.4, 29.5); g.render();
    }, quality);
    const sync = await page.evaluate(() => ({ main: MIDNIGHT_PORT.renderer.toneMapping, shop: MIDNIGHT_PORT.ui.showcase.renderer.toneMapping }));
    assert.equal(sync.main, sync.shop);
    await page.screenshot({ path: join(output, `water-${quality}.png`) });
  }
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForFunction(() => MIDNIGHT_PORT.vmCamera.aspect < 0.6);
  report.narrow = await page.evaluate(async () => {
    const T = await import('three'), g = MIDNIGHT_PORT;
    g.beginLevel(1, 'new'); g.state = 'paused'; g.player.update(0.016); g.weapons.update(0.016); g.vmScene.visible = true; g.ui.show('hud'); g.render();
    const local = g.weapons.models.ar.muzzle.getWorldPosition(new T.Vector3()).project(g.vmCamera), world = g.weapons.muzzleWorld(new T.Vector3()).project(g.camera);
    g.state = 'playing'; g.input.fallback = true; g.input.mdx = 30; g.input.fire = true; g.input.jumpBuf = 0.14;
    window.dispatchEvent(new Event('blur'));
    const state = g.state; g.ui.hide('pause'); g.render();
    return { projectionError: Math.hypot(local.x - world.x, local.y - world.y), state, cleared: g.input.mdx === 0 && !g.input.fire && g.input.jumpBuf === 0 };
  });
  assert.ok(report.narrow.projectionError < 1e-8); assert.equal(report.narrow.state, 'paused'); assert.equal(report.narrow.cleared, true);
  await page.screenshot({ path: join(output, 'narrow.png') });

  for (const key of ['main', 'shop']) {
    await page.evaluate(key => { const g = MIDNIGHT_PORT, r = key === 'main' ? g.renderer : g.ui.showcase.renderer; window.qaContext = r.getContext().getExtension('WEBGL_lose_context'); qaContext.loseContext(); }, key);
    await page.waitForFunction(key => key === 'main' ? MIDNIGHT_PORT.contextLost : !MIDNIGHT_PORT.ui.showcase.ok, key);
    await page.evaluate(() => qaContext.restoreContext());
    await page.waitForFunction(key => key === 'main' ? !MIDNIGHT_PORT.contextLost : MIDNIGHT_PORT.ui.showcase.ok, key);
  }
  assert.deepEqual(errors, []);
  report.errors = errors; report.passed = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`CS WebGL checks passed. Evidence: ${output}`);
} finally {
  await browser?.close(); await new Promise(r => server.close(r));
}

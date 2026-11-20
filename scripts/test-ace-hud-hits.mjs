import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const threeRoot = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const { version } = JSON.parse(await readFile(join(threeRoot, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const output = process.env.ACE_SCREENSHOTS ? resolve(process.env.ACE_SCREENSHOTS, 'hud-hits') : await mkdtemp(join(tmpdir(), 'ace-hud-hits-'));
await mkdir(output, { recursive:true });
const errors = [];

// Loopback-only staged contacts. Inputs, emitters, target sizes, damage, scoring and the renderer are real.
function installProbe() {
  let observedImpact;
  const project = point => {
    const ndc = point.clone().project(camera);
    return [(1 + ndc.x) * hudCanvas.width / 2, (1 - ndc.y) * hudCanvas.height / 2];
  };
  function ink() {
    const names = ['beginPath', 'moveTo', 'lineTo', 'stroke', 'fillText'];
    const original = Object.fromEntries(names.map(name => [name, hudCtx[name]]));
    const marks = { sight:null, hit:null, ring:false, label:null };
    let points = [];
    hudCtx.beginPath = function() { points = []; return original.beginPath.call(this); };
    for (const name of ['moveTo', 'lineTo']) hudCtx[name] = function(x, y) {
      points.push([x, y]); return original[name].call(this, x, y);
    };
    hudCtx.stroke = function(...args) {
      const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
      const mid = values => (Math.min(...values) + Math.max(...values)) / 2;
      if (this.strokeStyle === '#86f8b8') marks.sight = [mid(xs), ys[0]];
      if (this.strokeStyle === '#ffdf9a') marks.hit = [mid(xs), mid(ys)];
      if (this.strokeStyle === '#8ee4ff') marks.ring = true;
      return original.stroke.apply(this, args);
    };
    hudCtx.fillText = function(text, ...args) {
      if (text === 'HIT' || text === '命中') marks.label = text;
      return original.fillText.call(this, text, ...args);
    };
    try { drawHUD(); } finally { Object.assign(hudCtx, original); }
    if (marks.sight) {
      const [x, y] = marks.sight;
      const pixels = hudCtx.getImageData(Math.floor(x - 13), Math.floor(y - 1), 3, 3).data;
      marks.painted = pixels.some((channel, index) => index % 4 === 1 && channel > 175 && channel > pixels[index - 1] + 45);
    }
    marks.offscreen = !document.querySelector('#offscreenHit').hidden;
    return marks;
  }
  function paint() {
    updateCamera(1 / 60); camera.updateMatrixWorld(); updateHUDDom();
    if (composer) composer.render(); else renderer.render(scene, camera);
    return ink();
  }
  function focus(depth, offset = 0.18, actor = enemies[0]) {
    player.primaryTarget = depth == null ? null : actor;
    if (depth == null) return;
    actor.pos.set(Math.abs(depth) * offset, 0, -depth).applyQuaternion(player.quat).add(player.pos);
    actor.mesh.position.copy(actor.pos);
  }
  window.hudQA = {
    focus, paint,
    fly(frames) { for (let frame = 0; frame < frames; frame++) updatePlayer(1 / 60, 1 / 60); },
    tick(frames) { for (let frame = 0; frame < frames; frame++) animate(lastTime + 50); },
    sight() {
      const marks = paint(), shot = bullets.filter(item => item.fromPlayer).at(-1);
      if (!shot) throw Error('A real cannon input must emit a tracer');
      const direction = shot.vel.clone().normalize(), target = player.primaryTarget;
      const depth = target ? target.pos.clone().sub(shot.pos).dot(direction) : 0;
      return { marks, expected:project(shot.pos.clone().addScaledVector(direction, depth > 0 ? depth : 500)),
        target:target && project(target.pos), throttle:player.throttle, bank:new THREE.Euler().setFromQuaternion(player.quat, 'YXZ').z };
    },
    lock() {
      focus(1000, 0, enemies[3]);
      for (let frame = 0; frame < 60; frame++) updateLockOn(1 / 60);
      return player.lockProgress;
    },
    crossing(kind) {
      const guided = kind === 'missile', pool = guided ? missiles : bullets;
      const shot = pool.find(item => item.fromPlayer);
      if (!shot) throw Error('Expected player projectile');
      for (const [index, actor] of enemies.entries()) {
        actor.pos.set(2200 + index * 100, 800, -1600); actor.mesh.position.copy(actor.pos);
      }
      if (guided) shot.target.pos.copy(shot.pos).addScaledVector(shot.dir, 1000);
      updateEnemies(0);
      let flyTime = kind === 'expired' ? shot.life - 0.003 : 0.2;
      while (flyTime > 1e-8) { const slice = Math.min(flyTime, 0.05); updateProjectilesAndFX(slice); flyTime -= slice; }
      if (kind === 'water') { shot.pos.y = 5; shot.vel.set(0, -shot.vel.length(), 0); }
      const start = shot.pos.clone(), direction = guided ? shot.dir.clone() : shot.vel.clone().normalize();
      const side = direction.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      const dt = kind === 'inside' ? 0 : 0.05, travel = dt * (guided ? shot.speed : shot.vel.length());
      const radius = enemies[0].radius + (guided ? 14 : 7);
      const place = (actor, along, lateral = 0) => {
        actor.pos.copy(start).addScaledVector(direction, along).addScaledVector(side, lateral); actor.mesh.position.copy(actor.pos);
      };
      if (kind === 'nearest') { place(enemies[0], travel * 0.8); place(enemies[1], travel * 0.45); }
      else if (kind === 'moving') {
        place(enemies[0], travel / 2, radius - 5);
        enemies[0].quat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), side);
      } else if (kind === 'water') place(enemies[0], 38);
      else place(enemies[0], travel * (kind === 'expired' ? 0.72 : 0.5), kind === 'miss' ? radius + 0.3 : guided ? radius - 0.3 : 0);
      const initialSeparation = start.distanceTo(enemies[0].pos);
      updateEnemies(kind === 'moving' ? dt : 0);
      const finalSeparation = start.clone().addScaledVector(direction, travel).distanceTo(enemies[0].pos);
      const before = enemies.map(actor => actor.hp), score = missionScore, kills = missionKills;
      updateProjectilesAndFX(dt);
      const changes = () => enemies.map((actor, index) => before[index] - actor.hp);
      const losses = changes(), removed = !pool.includes(shot);
      observedImpact = shot.mesh.position.clone();
      const contactDistance = observedImpact.distanceTo(enemies[kind === 'nearest' ? 1 : 0].pos);
      updateEnemies(0); updateProjectilesAndFX(dt);
      return { losses, repeated:changes(), removed, score:missionScore - score, kills:missionKills - kills, radius, contactDistance,
        initialSeparation, finalSeparation, damage:shot.dmg };
    },
    feedback(yaw = 0) {
      if (yaw) { player.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)); player.mesh.quaternion.copy(player.quat); }
      const marks = paint(); return { marks, expected:project(observedImpact) };
    }
  };
}

const close = html.lastIndexOf('</script>');
assert.ok(close > html.indexOf('<script type="module">'));
const fixture = html.slice(0, close) + `\n(${installProbe})();\n` + html.slice(close);
const browser = await chromium.launch({ args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function open(touch = false) {
  const page = await browser.newPage({ viewport:touch ? { width:390, height:844 } : { width:1100, height:660 },
    hasTouch:touch, isMobile:touch, deviceScaleFactor:touch ? 2 : 1 });
  await page.route(url, route => route.fulfill({ contentType:'text/html; charset=utf-8', body:fixture }));
  await page.route('https://**', route => {
    const address = route.request().url(), file = resolve(threeRoot, address.slice(prefix.length));
    if (address.startsWith(prefix) && file.startsWith(threeRoot + sep) && file.endsWith('.js')) {
      return route.fulfill({ path:file, contentType:'application/javascript', headers:{ 'Access-Control-Allow-Origin':'*' } });
    }
    errors.push(`Unexpected request: ${address}`); return route.abort();
  });
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => callback.name === 'animate' ? 0 : raf(callback);
  });
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url); await page.waitForFunction(() => window.hudQA && window.__ACE_DEBUG__);
  const sortie = page.locator('#sortieBtn'); if (touch) await sortie.tap(); else await sortie.click();
  return page;
}
const samePixel = (actual, expected, message) => {
  assert.ok(actual && Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 0.1, `${message}: ${actual} vs ${expected}`);
};
const reset = async page => { await page.keyboard.press('p'); await page.locator('#btnRestart').click(); };
const capture = (page, name) => page.screenshot({ path:join(output, `${name}.png`) });

try {
  const page = await open();
  for (const [width, height, cockpit, boost, depth] of [[1100,660,false,false,500], [844,390,true,true,180], [740,600,false,true,1200], [1100,660,true,false,-300], [680,420,false,false,null]]) {
    await page.setViewportSize({ width, height }); await reset(page);
    if (cockpit) await page.keyboard.press('v');
    if (boost) for (const key of ['w', 'd', 'ArrowUp']) await page.keyboard.down(key);
    await page.evaluate(() => hudQA.fly(24)); await page.evaluate(depth => hudQA.focus(depth), depth);
    await page.keyboard.press('j'); const sample = await page.evaluate(() => hudQA.sight());
    samePixel(sample.marks.sight, sample.expected, 'Canvas sight vs emitted tracer');
    assert.ok(sample.marks.painted); assert.equal(sample.marks.ring, boost);
    assert.equal(sample.marks.hit, null); assert.equal(sample.marks.label, null);
    if (depth > 0) assert.ok(Math.hypot(...sample.target.map((value, index) => value - sample.expected[index])) > 9, 'No snap to off-axis target');
    if (boost) {
      assert.ok(sample.throttle > 0.85 && Math.abs(sample.bank) > 0.3);
      for (const key of ['w', 'd', 'ArrowUp']) await page.keyboard.up(key);
    }
    await capture(page, `${width}x${height}-${cockpit ? 'cockpit' : 'chase'}`);
  }
  for (const kind of ['cross', 'nearest', 'moving', 'miss', 'inside', 'expired', 'water', 'missile']) {
    await reset(page);
    if (kind === 'missile') assert.equal(await page.evaluate(() => hudQA.lock()), 1);
    await page.keyboard.press(kind === 'missile' ? 'Space' : 'j');
    const result = await page.evaluate(kind => hudQA.crossing(kind), kind);
    const shouldHit = !['miss', 'expired', 'water'].includes(kind);
    const expected = result.losses.map((_, index) => shouldHit && index === (kind === 'nearest' ? 1 : 0) ? result.damage : 0);
    assert.deepEqual(result.losses, expected, kind); assert.deepEqual(result.repeated, expected, `${kind}: only once`);
    assert.equal(result.removed, kind !== 'miss', kind); assert.equal(result.kills, Number(kind === 'missile'));
    assert.equal(result.score, kind === 'missile' ? 400 : 0);
    if (['cross', 'missile'].includes(kind)) {
      assert.ok(result.initialSeparation > result.radius && result.finalSeparation > result.radius, 'Endpoint samples both miss');
      assert.ok(Math.abs(result.contactDistance - result.radius) < 0.02, 'Actual entry point');
    }
    if (kind === 'cross') {
      const check = await page.evaluate(() => hudQA.feedback(0.18)); samePixel(check.marks.hit, check.expected, 'Mark follows impact after camera turns');
      assert.ok(Math.hypot(...check.marks.hit.map((value, index) => value - check.marks.sight[index])) > 20);
      assert.equal(check.marks.label, '命中'); await capture(page, 'confirmed-impact');
      await page.keyboard.press('v'); const cockpit = await page.evaluate(() => hudQA.feedback()); samePixel(cockpit.marks.hit, cockpit.expected, 'Camera cut');
      await page.evaluate(() => hudQA.tick(5)); const lingering = await page.evaluate(() => hudQA.paint());
      assert.equal(lingering.hit, null); assert.equal(lingering.label, '命中');
      const behind = await page.evaluate(() => hudQA.feedback(Math.PI)); assert.ok(behind.marks.offscreen && !behind.marks.hit && !behind.marks.label);
      await page.keyboard.press('p'); await page.locator('#langBtn').click(); await page.keyboard.press('Escape');
      const notice = page.locator('#offscreenHit'), bounds = await notice.boundingBox(), viewport = page.viewportSize();
      assert.match(await notice.innerText(), /Offscreen hit/);
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, 'Offscreen notice stays in the visible HUD');
      await capture(page, 'offscreen-hit-en');
      await page.evaluate(() => hudQA.tick(10)); assert.equal((await page.evaluate(() => hudQA.paint())).offscreen, false);
    } else if (shouldHit) assert.equal((await page.evaluate(() => hudQA.feedback())).marks.label, 'HIT');
    else { const { hit, label, offscreen } = await page.evaluate(() => hudQA.paint()); assert.deepEqual([hit,label,offscreen], [null,null,false]); }
  }
  await reset(page); const clean = await page.evaluate(() => hudQA.paint()); assert.deepEqual([clean.hit,clean.label,clean.offscreen], [null,null,false]);
  await page.close();
  const phone = await open(true); await phone.evaluate(() => hudQA.focus(500)); await phone.locator('[data-flight="cannon"]').tap();
  const mobile = await phone.evaluate(() => hudQA.sight()); samePixel(mobile.marks.sight, mobile.expected, 'Touch viewport / DPR 2');
  assert.ok(mobile.marks.painted && !mobile.marks.ring); await capture(phone, '390-touch');
  assert.deepEqual(errors, [], 'Browser errors'); console.log(`PASS actual canvas vs tracer (<0.1 CSS px), chase/cockpit/boost/bank/touch, eight contact cases, once-only damage, localized feedback. Screenshots: ${output}`);
} finally { await browser.close(); }

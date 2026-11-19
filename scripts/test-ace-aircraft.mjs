import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const output = process.env.ACE_SCREENSHOTS ? resolve(process.env.ACE_SCREENSHOTS, 'aircraft')
  : process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(resolve(tmpdir(), 'ace-aircraft-'));
await mkdir(output, { recursive: true });
const html = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const close = html.lastIndexOf('</script>');
assert.notEqual(close, -1);
// Only the loopback test copy exposes scene references. Exercise the actual game module and renderer.
const bridge = `\nwindow.aircraftQA = { THREE, player, camera, scene, enemies: () => enemies,
  buildBomberMesh, updateCamera, updatePlayer, drawHUD, render: () => composer && quality !== 'low'
    ? composer.render() : renderer.render(scene, camera) };\n`;
const server = createServer((req, res) => {
  if (req.url !== '/games/ace.html') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html.slice(0, close) + bridge + html.slice(close));
});

function inspectView() {
  const { THREE, player, camera } = window.aircraftQA;
  const root = player.mesh, rig = root.userData;
  const parts = [];
  root.traverseVisible(part => { if (part.isMesh) parts.push(part); });
  const panelRects = [...document.querySelectorAll('.panel-box')].map(panel => panel.getBoundingClientRect());
  const bounds = new THREE.Box2(), point = new THREE.Vector3();
  let underCard = false;
  for (const part of parts) {
    const positions = part.geometry.getAttribute('position');
    for (let idx = 0; idx < positions.count; idx++) {
      point.fromBufferAttribute(positions, idx).applyMatrix4(part.matrixWorld).project(camera);
      bounds.expandByPoint(point);
      const px = (point.x + 1) * innerWidth / 2, py = (1 - point.y) * innerHeight / 2;
      if (panelRects.some(rect => px > rect.left && px < rect.right && py > rect.top && py < rect.bottom)) underCard = true;
    }
  }
  const ray = new THREE.Raycaster();
  const solid = parts.filter(part => !part.material.transparent);
  const firstSolid = ndc => { ray.setFromCamera(ndc, camera); return ray.intersectObjects(solid, false)[0]?.object; };
  const screen = rig.cockpit.getObjectByName('Instruments');
  const readable = [-0.5, 0, 0.5].every(offset => {
    const ndc = screen.localToWorld(point.set(offset, 0, 0)).project(camera);
    return Math.abs(ndc.x) < 0.98 && ndc.y > -0.98 && ndc.y < -0.4 && firstSolid(ndc) === screen;
  });
  const hud = document.getElementById('hudCanvas');
  const clearHud = rig.cameraView === 'hangar' && !hud.getContext('2d')
    .getImageData(hud.width / 2 - 22, hud.height / 2 - 22, 44, 44).data.some(value => value !== 0);
  return { id: root.name, mode: rig.cameraView, cockpit: rig.cockpit.visible, exterior: rig.exterior.visible, clearHud,
    bounds: [...bounds.min.toArray(), ...bounds.max.toArray()], underCard, meshes: parts.length,
    eyeError: rig.cockpit.getWorldPosition(point).distanceTo(camera.position), readable,
    clearCenter: !firstSolid({ x: 0, y: 0 }), centerY: player.pos.clone().project(camera).y,
    range: camera.position.distanceTo(player.pos), fov: camera.fov, engines: rig.flames.length };
}

function inspectSkin(bomber) {
  const { THREE, player, buildBomberMesh } = window.aircraftQA;
  const root = bomber ? buildBomberMesh() : player.mesh;
  root.updateMatrixWorld(true);
  const body = root.getObjectByName(bomber ? 'Bomber airframe' : 'Airframe');
  body.geometry.computeBoundingBox();
  const box = body.geometry.boundingBox, ray = new THREE.Raycaster();
  function hit(origin, direction) {
    ray.set(body.localToWorld(new THREE.Vector3(...origin)), new THREE.Vector3(...direction).transformDirection(body.matrixWorld));
    const result = ray.intersectObject(body, false)[0];
    return result && { pos: body.worldToLocal(result.point), normal: result.face.normal };
  }
  const heights = [];
  for (const side of [-1, 1]) {
    const width = side * box.max.x * 0.72, z = bomber ? 2.8 : 1.55;
    const top = hit([width, 12, z], [0, -1, 0]), bottom = hit([width, -12, z], [0, 1, 0]);
    if (!top || !bottom || top.normal.y < 0.85 || bottom.normal.y > -0.85 || top.pos.y <= bottom.pos.y) {
      throw new Error(`Missing or inside-out wing at x=${width}`);
    }
    heights.push(top.pos.y);
  }
  const nose = hit([0, bomber ? -0.15 : -0.07, -25], [0, 0, 1]);
  if (!bomber) for (const plume of root.userData.flames) {
    const { x, y, z } = plume.position, offset = root.name === 'f35' ? 0.63 : 0.43;
    const bore = hit([x, y, 25], [0, 0, -1]), rim = hit([x, y + offset, 25], [0, 0, -1]);
    if (!(bore?.pos.z < z && z < rim?.pos.z && rim.pos.z - bore.pos.z > 0.14)) throw new Error('Nozzle should frame a recessed glow');
  }
  const normals = body.geometry.getAttribute('normal');
  const normal = new THREE.Vector3();
  for (let idx = 0; idx < normals.count; idx++) {
    if (!(Math.abs(normal.fromBufferAttribute(normals, idx).length() - 1) < 0.001)) throw new Error(`Invalid normal ${idx}`);
  }
  return { span: box.max.x - box.min.x, length: box.max.z - box.min.z, heights, noseZ: nose?.pos.z, symmetric: Math.abs(heights[0] - heights[1]) < 0.001,
    forward: !!nose && Math.abs(nose.pos.z - box.min.z) < 0.1 && nose.normal.z < -0.9 };
}

function checkChase(view) {
  assert.ok(view.exterior && !view.cockpit && view.mode === '3p');
  assert.ok(view.range > 16 && view.range < 30 && view.fov > 56 && view.fov < 69, 'chase cut, not travel from the last view');
  assert.ok(view.centerY < -0.18 && view.centerY > -0.55 && view.clearCenter, 'jet below the boresight');
  assert.ok(view.bounds.every(value => Math.abs(value) < 0.97), 'whole jet inside frame');
}

function sampleSunsetExhaust(throttle) {
  const { THREE, player, camera, updatePlayer, render, drawHUD } = window.aircraftQA;
  const plumes = player.mesh.userData.flames, source = document.getElementById('gl');
  player.throttle = throttle; updatePlayer(0, 0);
  const center = plumes[0].getWorldPosition(new THREE.Vector3()).project(camera);
  const x = Math.round((1 + center.x) * source.width / 2) - 24, y = Math.round((1 - center.y) * source.height / 2) - 24;
  const crop = document.createElement('canvas'); crop.width = 48; crop.height = 96;
  const ctx = crop.getContext('2d', { willReadFrequently: true });
  function pixels() {
    render(); ctx.drawImage(source, x, y, 48, 96, 0, 0, 48, 96);
    return ctx.getImageData(0, 0, 48, 96).data;
  }
  for (const plume of plumes) plume.visible = false;
  const background = pixels();
  for (const plume of plumes) plume.visible = true;
  const lit = pixels(); drawHUD();
  let area = 0, red = 0, blue = 0;
  for (let idx = 0; idx < lit.length; idx += 4) {
    const delta = channel => Math.max(0, lit[idx + channel] - background[idx + channel]);
    red += delta(0); blue += delta(2);
    if (delta(0) + delta(1) + delta(2) > 45) area++;
  }
  return { area, red, blue };
}

await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    let next, now;
    window.requestAnimationFrame = callback => {
      if (callback.name !== 'animate') return nativeFrame(callback);
      next = callback; return 0;
    };
    window.stepAircraftFrame = () => new Promise((done, fail) => nativeFrame(() => {
      let draws = 0;
      const restore = [];
      window.aircraftQA.player.mesh.traverse(part => {
        if (!part.isMesh) return;
        const { onBeforeRender, onAfterRender } = part;
        let before;
        part.onBeforeRender = function(renderer, ...rest) {
          before = renderer.info.render.calls; onBeforeRender.call(this, renderer, ...rest);
        };
        part.onAfterRender = function(renderer, ...rest) {
          draws += renderer.info.render.calls - before; onAfterRender.call(this, renderer, ...rest);
        };
        restore.push(() => Object.assign(part, { onBeforeRender, onAfterRender }));
      });
      try { now = (now ?? performance.now()) + 1000 / 60; next(now); }
      catch (error) { fail(error); return; }
      finally { restore.forEach(reset => reset()); }
      nativeFrame(() => done(draws));
    }));
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/games/ace.html`);
  await page.waitForFunction(() => window.aircraftQA && window.__ACE_DEBUG__);
  const frame = () => page.evaluate(() => window.stepAircraftFrame());
  const click = selector => page.locator(selector).dispatchEvent('click');
  const shot = name => page.screenshot({ path: resolve(output, `${name}.png`) });
  const spans = [], lengths = [];
  for (const [index, id] of ['f22', 'su57', 'f35'].entries()) {
    if (index) { await page.keyboard.press('Escape'); await click('#btnHangar'); }
    await click(`[data-jet="${index}"]`);
    const exteriorDraws = await frame();
    const hangar = await page.evaluate(inspectView);
    const skin = await page.evaluate(inspectSkin, false);
    assert.ok(skin.forward && skin.symmetric, `${id}: nose / mirrored wing normals: ${JSON.stringify(skin)}`);
    assert.equal(hangar.id, id);
    assert.equal(hangar.engines, id === 'f35' ? 1 : 2);
    assert.ok(hangar.mode === 'hangar' && hangar.exterior && !hangar.cockpit && !hangar.underCard, `${id}: clear of hangar cards`);
    assert.ok(hangar.bounds[2] - hangar.bounds[0] > 0.52, `${id}: legible hangar silhouette`);
    spans.push(skin.span); lengths.push(skin.length);
    // The base HUD canvas can retain one flight frame after a screenshot. Camera cuts above must not wait for it.
    if (index) await frame();
    assert.ok((await page.evaluate(inspectView)).clearHud, `${id}: hangar evidence has no stale HUD`);
    await shot(`${id}-hangar`);
    await click('#sortieBtn'); await frame();
    checkChase(await page.evaluate(inspectView));
    await shot(`${id}-chase`);
    await page.keyboard.press('v'); const seatDraws = await frame();
    const seat = await page.evaluate(inspectView);
    assert.ok(seat.mode === '1p' && seat.cockpit && !seat.exterior && seat.eyeError < 1e-5 && seat.fov >= 69);
    assert.ok(seat.clearCenter && seat.readable, `${id}: all three instruments visible from the actual eye; boresight clear`);
    await shot(`${id}-cockpit`);
    await page.keyboard.press('v'); await frame();
    checkChase(await page.evaluate(inspectView));
    assert.ok(exteriorDraws > 0 && exteriorDraws <= 10 && seatDraws > 0 && seatDraws <= 5, `${id}: player color-pass draw budget`);
    console.log(`${id}: ${exteriorDraws} exterior / ${seatDraws} cockpit color-pass draws, span ${skin.span.toFixed(1)}`);
  }
  assert.ok(spans[1] > spans[0] && spans[0] > spans[2] && lengths[1] > lengths[0] && lengths[0] > lengths[2]);
  const bomber = await page.evaluate(inspectSkin, true);
  assert.ok(bomber.forward && bomber.symmetric && bomber.span > spans[1] * 1.7);

  const motion = await page.evaluate(() => {
    const { THREE, player, camera, updateCamera, updatePlayer, render, drawHUD } = window.aircraftQA;
    const rig = player.mesh.userData;
    const attitude = new THREE.Euler(0, 0, 0, 'YXZ');
    let maxStep = 0;
    for (let degrees = 0; degrees <= 180; degrees += 2) {
      attitude.x = THREE.MathUtils.degToRad(degrees);
      const prior = camera.quaternion.clone();
      player.quat.setFromEuler(attitude); updateCamera(1 / 60);
      maxStep = Math.max(maxStep, prior.angleTo(camera.quaternion));
    }
    player.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.51);
    player.pitchRate = 0.8; player.rollRate = -1.5; player.yawRate = 0.6;
    player.throttle = 0.15; updatePlayer(0, 0);
    const idle = rig.flames[0].scale.z;
    player.throttle = 1; updatePlayer(0, 0);
    for (let idx = 0; idx < 90; idx++) updateCamera(1 / 60);
    render(); drawHUD();
    return { maxStep, horizon: camera.up.y, plumeGrowth: rig.flames[0].scale.z / idle,
      roll: rig.aileronL.rotation.x * rig.aileronR.rotation.x, pitch: rig.tailL.rotation.x + rig.tailR.rotation.x,
      rudder: rig.finR.rotation.y, power: rig.cockpit.userData.powerBar.scale.x };
  });
  assert.ok(motion.maxStep < 0.35 && motion.horizon > 0.97, 'continuous through vertical; bank-stabilized horizon');
  assert.ok(motion.plumeGrowth > 4 && motion.roll < 0 && motion.pitch < 0 && motion.rudder !== 0 && motion.power === 1);
  await shot('f35-banked-boost');
  await page.keyboard.press('Escape'); await click('#btnRestart'); await frame();
  checkChase(await page.evaluate(inspectView));

  // Start the matched captures without any residual rates or effects from the synthetic maneuver.
  await page.reload();
  await page.waitForFunction(() => window.aircraftQA && window.__ACE_DEBUG__);
  await page.evaluate(() => window.__ACE_DEBUG__.startMission(1, 0)); await frame();
  // Hold the aircraft, camera and sunlight fixed; compare the actual rendered exhaust with the unlit nozzle.
  const cruise = await page.evaluate(sampleSunsetExhaust, 0.52); await shot('f22-sunset-cruise');
  const boost = await page.evaluate(sampleSunsetExhaust, 1); await shot('f22-sunset-boost');
  console.log('F-22 sunset, one nozzle:', { cruise, boost });
  assert.ok(cruise.area > 4 && cruise.red > cruise.blue && boost.area > 2 * cruise.area && boost.blue > 4 * cruise.blue);

  // Posed recognition shot, not a mission spawn or a fourth selectable aircraft.
  await page.addStyleTag({ content: 'body > :not(#gl) { visibility: hidden !important }' });
  await page.evaluate(() => {
    const { THREE, camera, player, scene, enemies, buildBomberMesh, render } = window.aircraftQA;
    player.mesh.visible = false;
    const heavy = buildBomberMesh(), escort = enemies().find(enemy => enemy.type === 'fighter').mesh;
    const right = new THREE.Vector3(-0.88, 0, -0.47).normalize();
    heavy.position.copy(player.pos).addScaledVector(right, -7.5); scene.add(heavy);
    escort.position.copy(player.pos).addScaledVector(right, 12.5); escort.rotation.set(-0.06, 0.08, -0.2);
    camera.position.copy(player.pos).add(new THREE.Vector3(21, 15, -39));
    camera.up.set(0, 1, 0); camera.lookAt(player.pos); camera.fov = 40; camera.updateProjectionMatrix(); render();
  });
  await shot('bomber-and-escort');
  console.log(`Screenshots: ${output}`);
  assert.deepEqual(errors, []);
  console.log('PASS aircraft skins, first-frame camera cuts, cockpit sightlines, control surfaces and boost');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}

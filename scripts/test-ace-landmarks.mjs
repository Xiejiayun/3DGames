import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

function inspectMission(index) {
  loadMissionScene(index, false);
  scene.updateMatrixWorld(true);
  const land = islands.map(island => island.mesh);
  const landmark = index === 2 ? null : worldGroup.getObjectByName(index === 0 ? 'Island airfield' : 'Sea arch');
  const down = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  let meshError = 0, padError = 0;
  function surfaceAt(x, z) {
    down.ray.origin.set(x, 1000, z);
    return down.intersectObjects(land, false)[0]?.point.y ?? -20;
  }
  for (const island of islands) {
    for (let point = 0; point < 36; point++) {
      const angle = point * 2.4, radius = island.radius * Math.sqrt((point + 0.3) / 34);
      const x = island.cx + radius * Math.cos(angle), z = island.cz + radius * Math.sin(angle);
      meshError = Math.max(meshError, Math.abs(surfaceAt(x, z) - sampleTerrainHeight(x, z)));
    }
  }
  function checkPad(root, offsetsX, offsetsZ) {
    for (const x of offsetsX) for (const z of offsetsZ) {
      padError = Math.max(padError, Math.abs(surfaceAt(root.position.x + x, root.position.z + z) - root.position.y));
    }
  }
  if (index === 0) checkPad(landmark, [-22, 0, 22, 42, 59], [-145, -85, 0, 85, 145]);
  const stations = enemies.filter(enemy => enemy.type === 'radar' || enemy.type === 'sam');
  for (const station of stations) checkPad(station.mesh, [-16, 0, 16], [-15, 0, 15]);
  const models = [...(landmark ? [landmark] : []), ...enemies.filter(enemy => !enemy.isAir).map(enemy => enemy.mesh)];
  const seen = inspectMission.seen ??= new WeakSet();
  const sharedAssets = [];
  for (const root of [...land, ...models]) {
    const owned = new Set();
    root.traverse(obj => {
      if (!obj.isMesh) return;
      owned.add(obj.geometry);
      for (const material of [].concat(obj.material)) {
        owned.add(material);
        for (const asset of Object.values(material)) {
          if (asset?.isTexture && asset !== carrierDeckTex && asset !== runwayTex) owned.add(asset);
        }
      }
    });
    for (const asset of owned) {
      if (seen.has(asset)) sharedAssets.push(`${root.name}: ${asset.type}`);
      seen.add(asset);
    }
  }
  const draws = models.map(root => {
    let calls = 0;
    root.traverse(obj => { if (obj.isMesh) calls += Array.isArray(obj.material) ? obj.geometry.groups.length : 1; });
    return calls;
  });
  const photos = {};
  function shoot(name, eye, target, fov = 46) {
    camera.position.set(...eye); camera.lookAt(...target); camera.fov = fov; camera.updateProjectionMatrix();
    skyDome.position.copy(camera.position); oceanMesh.position.set(eye[0], 0, eye[2]);
    sunLight.target.position.set(...target);
    sunLight.position.copy(sunLight.target.position).addScaledVector(skyUniforms.uSunDir.value, 1400);
    if (composer) composer.render(); else renderer.render(scene, camera);
    photos[name] = renderer.domElement.toDataURL('image/png').split(',')[1];
  }
  let shadowPixels = null, passage = null, archWaterbed = null, groundedFeet = null, shipLengths = null;
  if (index === 0) {
    const { x, y, z } = landmark.position;
    shoot('airfield', [x + 226, y + 145, z + 254], [x + 12, y + 5, z]);
    shoot('coast', [-390, 162, 222], [-940, 95, -350]);
    const island = islands[0];
    const fixture = new THREE.Scene();
    const ground = new THREE.Mesh(island.mesh.geometry, island.mesh.material);
    ground.receiveShadow = island.mesh.receiveShadow;
    const center = new THREE.Vector3(x - island.cx, surfaceAt(x, z), z - island.cz);
    const block = new THREE.Mesh(new THREE.BoxGeometry(15, 20, 15), new THREE.MeshStandardMaterial());
    block.position.copy(center); block.position.y += 14;
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.target.position.copy(center); light.position.copy(center).add(new THREE.Vector3(70, 95, 55));
    light.castShadow = true;
    Object.assign(light.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 240 });
    light.shadow.camera.updateProjectionMatrix();
    fixture.add(ground, block, light, light.target, new THREE.AmbientLight(0xffffff, 0.25));
    const view = new THREE.OrthographicCamera(-50, 50, 34, -34, 1, 400);
    view.position.copy(center); view.position.y += 250; view.up.set(0, 0, -1); view.lookAt(center);
    const target = new THREE.WebGLRenderTarget(160, 108);
    function pixels(cast) {
      block.castShadow = cast; renderer.setRenderTarget(target); renderer.render(fixture, view);
      const data = new Uint8Array(160 * 108 * 4); renderer.readRenderTargetPixels(target, 0, 0, 160, 108, data);
      return data;
    }
    const lit = pixels(false), shaded = pixels(true);
    shadowPixels = 0;
    for (let offset = 0; offset < lit.length; offset += 4) {
      if (lit[offset + 1] - shaded[offset + 1] > 4) shadowPixels++;
    }
    renderer.setRenderTarget(null); target.dispose(); light.shadow.dispose(); block.geometry.dispose(); block.material.dispose();
  } else if (index === 1) {
    player.mesh.position.copy(player.pos); player.mesh.quaternion.copy(player.quat);
    shoot('sunset-chase-250m', [0, 255.2, 1672], [0, 251.5, 1605], 70.25);
    shoot('fjord-banks-250m', [160, 250, 655], [-150, 100, -285], 55);
    shoot('passage', [48, 64, 190], [0, 71, -245]);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(landmark.matrixWorld);
    passage = [-40, 0, 40].every(cross => {
      const origin = landmark.localToWorld(new THREE.Vector3(cross, 58, 160));
      return !new THREE.Raycaster(origin, direction, 0, 320).intersectObjects([landmark, ...land], true).length;
    });
    archWaterbed = Math.max(...[-20, 0, 20].flatMap(cross => [-80, 0, 80].map(run => {
      const point = landmark.localToWorld(new THREE.Vector3(cross, 0, run));
      return surfaceAt(point.x, point.z);
    })));
    const stone = landmark.children[0], vertices = stone.geometry.attributes.position;
    groundedFeet = [-1, 1].every(side => {
      const offsets = [], point = new THREE.Vector3();
      for (let index = 0; index < vertices.count; index++) {
        if (side * vertices.getX(index) < 120 || side * vertices.getX(index) > 168) continue;
        stone.localToWorld(point.fromBufferAttribute(vertices, index));
        offsets.push(point.y - surfaceAt(point.x, point.z));
      }
      return Math.min(...offsets) < -2 && Math.max(...offsets) > 8;
    });
    for (const type of ['radar', 'sam']) {
      const { x, y, z } = stations.find(station => station.type === type).pos;
      shoot(type, [x + 57, y + 36, z + 62], [x, y + 8, z], 42);
    }
  } else {
    shipLengths = [carrierRef, ...destroyerRefs].map(ship => {
      ship.mesh.rotation.y = 0;
      const size = new THREE.Box3().setFromObject(ship.mesh).getSize(new THREE.Vector3());
      ship.mesh.rotation.y = ship.heading;
      return size.z;
    });
    shoot('fleet', [225, 209, 146], [0, 12, -550], 55);
    shoot('carrier', [147, 132, -433], [0, 20, -680], 48);
    shoot('escort', [-249, 49, -346], [-340, 13, -460], 44);
  }
  const maxTriangles = Math.max(...land.map(mesh => mesh.geometry.index.count / 3));
  return { photos, meshError, padError, shadowPixels, passage, archWaterbed, groundedFeet, maxTriangles, shipLengths, draws, sharedAssets,
    stations: stations.length, lowestStation: stations.length ? Math.min(...stations.map(station => station.pos.y)) : null, dish: !!carrierRef?.mesh.userData.radarDish };
}

const source = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const pageSource = source.replace(/<\/script>(\s*<\/body>)/, `window.inspectLandmarks = ${inspectMission.toString()};</script>$1`);
const server = createServer((req, res) => {
  if (req.url !== '/games/ace.html') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageSource);
});
const output = process.env.ACE_SCREENSHOTS ? join(process.env.ACE_SCREENSHOTS, 'landmarks')
  : process.env.ACE_LANDMARK_SHOTS || await mkdtemp(join(tmpdir(), 'ace-landmarks-'));
await mkdir(output, { recursive: true });
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
let browser;
try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    let seed = 4721;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const schedule = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => callback.name === 'animate' ? 0 : schedule(callback);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/games/ace.html`, { waitUntil: 'load', timeout: 90000 });
  assert.deepEqual(errors, []);
  const results = [];
  for (let index = 0; index < 3; index++) {
    const { photos, ...metrics } = await page.evaluate(id => window.inspectLandmarks(id), index);
    for (const [name, png] of Object.entries(photos)) await writeFile(join(output, `${name}.png`), Buffer.from(png, 'base64'));
    results.push(metrics);
  }
  console.log('Screenshots:', output, '\nMission metrics:', JSON.stringify(results));
  assert.deepEqual(errors, []);
  for (const mission of results) {
    assert.deepEqual(mission.sharedAssets, [], 'each entity owns its resources except the page-lifetime textures');
    assert.ok(mission.meshError < 0.001, 'sampled heights must follow rendered triangles');
    assert.ok(mission.padError < 0.05, 'the entire facility footprint must meet its terrain pad');
    assert.ok(mission.draws.every(calls => calls <= 12), 'at most 12 color-pass draws per landmark or ship');
    assert.ok(mission.maxTriangles <= 6272, 'terrain stays within the original island mesh budget');
  }
  assert.ok(results[0].shadowPixels > 100, 'an actual r160 shadow map must darken the terrain');
  assert.equal(results[1].stations, 6); assert.ok(results[1].lowestStation > 10, 'stations must be above the surf');
  assert.equal(results[1].passage, true); assert.ok(results[1].archWaterbed < -2, 'tidal channel must run through the arch');
  assert.equal(results[1].groundedFeet, true); assert.equal(results[2].dish, true);
  const [carrier, ...escorts] = results[2].shipLengths;
  assert.ok(carrier >= 295 && carrier <= 305 && escorts.length === 2 && escorts.every(length => length >= 140 && length <= 160), 'fleet scale');
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
}

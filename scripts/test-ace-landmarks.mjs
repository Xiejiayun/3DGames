import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

function inspectCoastAndAirfield(airfield, coast, shoot) {
  const { x, y, z } = airfield.position;
  const ray = new THREE.Raycaster();
  function hit(origin, direction) {
    ray.set(airfield.localToWorld(new THREE.Vector3(...origin)), new THREE.Vector3(...direction));
    const contact = ray.intersectObject(airfield, true)[0];
    return contact ? airfield.worldToLocal(contact.point) : null;
  }
  const bays = [-51, 0, 51].map(bay => ({
    back: [3, -4].map(offset => hit([24, 5.3, bay + offset], [1, 0, 0])?.x),
    jambs: [-13.6, 13.6].map(offset => hit([24, 5.3, bay + offset], [1, 0, 0])?.x),
    walls: [-1, 1].map(side => hit([46, 5.3, bay], [0, 0, side])?.z - bay),
    lintel: hit([24, 10.4, bay], [1, 0, 0])?.x,
    ceiling: hit([45, 5, bay + 3], [0, 1, 0])?.y, floor: hit([45, 5, bay + 3], [0, -1, 0])?.y
  }));
  const taxiway = [-75, 75].flatMap(crossing => [20, 24, 28, 32].map(across => hit([across, 5, crossing], [0, -1, 0])?.y));
  function profile(degrees) {
    const angle = THREE.MathUtils.degToRad(degrees), east = Math.cos(angle), south = Math.sin(angle);
    const height = distance => coast.sampleHeight(distance * east, distance * south);
    let shore = coast.radius * 1.2;
    while (shore > 0 && height(shore) < 0.5) shore -= 2;
    return { east, south, shore, height: inland => height(shore - inland) };
  }
  const headlands = [36, 38, 40].map(degrees => {
    const { height } = profile(degrees);
    return { lower: height(36) - height(18), bench: height(72) - height(36), upper: height(96) - height(72) };
  });
  const beach = profile(10), coveRise = beach.height(36) - beach.height(0);
  const fixture = new THREE.Scene(), target = new THREE.WebGLRenderTarget(12, 12);
  fixture.add(new THREE.Mesh(coast.mesh.geometry, coast.mesh.material), new THREE.AmbientLight(0xffffff, 2));
  const top = new THREE.OrthographicCamera(-2, 2, 2, -2, 1, 101);
  function beachLight(level) {
    let inland = 0;
    while (inland < coast.radius && beach.height(inland) < level) inland++;
    const distance = beach.shore - inland, px = distance * beach.east, pz = distance * beach.south;
    top.position.set(px, 100, pz); top.up.set(0, 0, -1); top.lookAt(px, 0, pz);
    renderer.setRenderTarget(target); renderer.render(fixture, top);
    const pixels = new Uint8Array(12 * 12 * 4); renderer.readRenderTargetPixels(target, 0, 0, 12, 12, pixels);
    let light = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) light += (pixels[offset] + 2 * pixels[offset + 1] + pixels[offset + 2]) / 4;
    return light / (12 * 12);
  }
  const wetLight = beachLight(1.2), dryLight = beachLight(9.5);
  renderer.setRenderTarget(null); target.dispose();

  function views(suffix) {
    shoot(`runway-side-door${suffix}`, [x + 5, y + 7.5, z + 15], [x + 48, y + 5.2, z], 52);
    shoot(`airfield-approach${suffix}`, [x - 60, y + 37, z + 188], [x + 18, y + 4, z - 16], 54);
    shoot(`sea-level-coast${suffix}`, [-395, 19, 212], [-940, 72, -350], 53);
  }
  function distantPan(name, eye, aim) {
    const gl = renderer.getContext(), width = 140, height = 60;
    const sample = offset => {
      shoot(offset ? null : name, [eye[0] + offset, eye[1], eye[2]], [aim[0] + offset, aim[1], aim[2]], 42);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels((gl.drawingBufferWidth - width) >> 1, (gl.drawingBufferHeight - height) >> 1, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const before = sample(0), after = sample(0.35);
    let min = 255, max = 0, changed = 0;
    for (let pixel = 0; pixel < before.length; pixel += 4) {
      min = Math.min(min, before[pixel + 1]); max = Math.max(max, before[pixel + 1]);
      if ([0, 1, 2].some(channel => Math.abs(before[pixel + channel] - after[pixel + channel]) > 24)) changed++;
    }
    return { contrast: max - min, changed: changed / (width * height) };
  }
  const visible = player.mesh.visible; player.mesh.visible = false;
  views(''); cycleQuality(); cycleQuality(); views('-low');
  const far = [distantPan('airfield-distant-low', [x - 440, y + 190, z + 750], [x + 15, y + 4, z]),
    distantPan('coast-distant-low', [-115, 115, 622], [-830, 34, -260])];
  cycleQuality(); player.mesh.visible = visible;
  return { bays, taxiway, headlands, coveRise, wetLight, dryLight, far };
}

function inspectMission(index) {
  loadMissionScene(index, false);
  updateShoreMap();
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
    if (name) photos[name] = renderer.domElement.toDataURL('image/png').split(',')[1];
  }
  let airfield = null, shadowPixels = null, passage = null, archWaterbed = null, groundedFeet = null, shipLengths = null;
  if (index === 0) {
    const { x, y, z } = landmark.position;
    shoot('airfield', [x + 226, y + 145, z + 254], [x + 12, y + 5, z]);
    shoot('coast', [-390, 162, 222], [-940, 95, -350]);
    airfield = inspectCoastAndAirfield(landmark, islands[1], shoot);
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
  return { photos, airfield, meshError, padError, shadowPixels, passage, archWaterbed, groundedFeet, maxTriangles, shipLengths, draws, sharedAssets,
    stations: stations.length, lowestStation: stations.length ? Math.min(...stations.map(station => station.pos.y)) : null, dish: !!carrierRef?.mesh.userData.radarDish };
}

const source = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const pageSource = source.replace(/<\/script>(\s*<\/body>)/, `const inspectCoastAndAirfield = ${inspectCoastAndAirfield}; window.inspectLandmarks = ${inspectMission};</script>$1`);
const threeRoot = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const { version } = JSON.parse(await readFile(join(threeRoot, 'package.json'), 'utf8'));
const threePrefix = `https://unpkg.com/three@${version}/`;
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
  await page.route('https://**', route => {
    const url = route.request().url(), file = resolve(threeRoot, url.slice(threePrefix.length));
    if (url.startsWith(threePrefix) && file.startsWith(threeRoot + sep) && file.endsWith('.js')) {
      return route.fulfill({ path: file, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    errors.push(`Unexpected request: ${url}`); return route.abort();
  });
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
  const { bays, taxiway, headlands, coveRise, wetLight, dryLight, far } = results[0].airfield;
  for (const { back, jambs, walls, lintel, floor, ceiling } of bays) {
    assert.ok(back.every(depth => depth > 54 && depth < 62) && jambs.every(depth => depth > 34 && depth < 36), 'a deep, open bay between solid jambs');
    assert.ok(lintel > 33 && lintel < 37 && walls[0] < -10 && walls[0] > -14 && walls[1] > 10 && walls[1] < 14, 'lintel and two interior walls');
    assert.ok(floor > 0.5 && floor < 1 && ceiling > 9 && ceiling < 15, 'grounded floor and actual roof underside');
  }
  assert.ok(taxiway.every(height => height > 0.5 && height < 0.8), 'both runway-to-apron connectors stay continuous');
  assert.ok(headlands.filter(({ lower, bench, upper }) => lower > 12 && bench > -2 && bench < 9 && upper > 10).length >= 2 && coveRise < 8,
    'exposed transects rise in two steps separated by a broad bench; the sheltered cove remains gradual');
  assert.ok(wetLight > 2 && dryLight > wetLight + 30, 'wet and dry beach retain broad luminance separation under the same light');
  assert.ok(far.every(({ contrast, changed }) => contrast > 30 && changed < 0.05), 'textured distant views stay stable during a subpixel pan on low quality');
  assert.equal(results[1].stations, 6); assert.ok(results[1].lowestStation > 10, 'stations must be above the surf');
  assert.equal(results[1].passage, true); assert.ok(results[1].archWaterbed < -2, 'tidal channel must run through the arch');
  assert.equal(results[1].groundedFeet, true); assert.equal(results[2].dish, true);
  const [carrier, ...escorts] = results[2].shipLengths;
  assert.ok(carrier >= 295 && carrier <= 305 && escorts.length === 2 && escorts.every(length => length >= 140 && length <= 160), 'fleet scale');
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
}

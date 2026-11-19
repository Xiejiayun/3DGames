import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const three = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const {version} = JSON.parse(await readFile(join(three, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const output = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'landscape-controls');
if (output) await mkdir(output, {recursive:true});

function inspectCockpit() {
  const rig = player.mesh.userData, screen = rig.cockpit.getObjectByName('Instruments');
  const bounds = node => {
    const {left, top, right, bottom, width, height} = node.getBoundingClientRect();
    return {left, top, right, bottom, width, height};
  };
  const overlays = [...document.querySelectorAll('#touchControls button, #touchHint, #weaponPanel, #radarWrap, #objBox, #alertBanner, #radioBox, #pauseBtn')]
    .map(node => ({name:node.dataset.flight || node.id, ...bounds(node)})).filter(rect => rect.width && rect.height);
  const buttons = [...document.querySelectorAll('#touchControls button')].map(node => {
    const rect = bounds(node), center = document.elementFromPoint(rect.left+rect.width/2, rect.top+rect.height/2);
    const text = document.createRange(); text.selectNodeContents(node);
    const label = text.getBoundingClientRect();
    return {name:node.dataset.flight, owns:node.contains(center), fits:label.left >= rect.left && label.right <= rect.right && label.top >= rect.top && label.bottom <= rect.bottom, ...rect};
  });
  function covers(rect, x, y) {
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return false;
    return rect.name !== 'radarWrap' || ((x-rect.left)*2/rect.width-1)**2 + ((y-rect.top)*2/rect.height-1)**2 <= 1;
  }
  const position = screen.geometry.getAttribute('position'), box = new THREE.Box2(), point = new THREE.Vector3();
  const pixel = new THREE.Vector2();
  for (let vertex = 0; vertex < position.count; vertex++) {
    screen.localToWorld(point.fromBufferAttribute(position, vertex)).project(camera);
    box.expandByPoint(pixel.set((point.x+1)*innerWidth/2, (1-point.y)*innerHeight/2));
  }
  const ray = new THREE.Raycaster(), hits = [], panes = Array.from({length:3}, () => ({total:0, clear:0, blockedBy:{}}));
  for (let y = Math.ceil(box.min.y); y < box.max.y; y += 3) for (let x = Math.ceil(box.min.x); x < box.max.x; x += 3) {
    ray.setFromCamera(pixel.set(x*2/innerWidth-1, 1-y*2/innerHeight), camera); hits.length = 0;
    const hit = ray.intersectObject(screen, false, hits)[0];
    if (!hit) continue;
    const horizontal = hit.uv.x*3, fraction = horizontal % 1;
    if (fraction < 0.05 || fraction > 0.95 || hit.uv.y < 0.06 || hit.uv.y > 0.94) continue;
    const pane = panes[Math.floor(horizontal)]; pane.total++;
    const blocker = overlays.find(rect => covers(rect, x, y));
    if (!blocker) pane.clear++; else pane.blockedBy[blocker.name] = (pane.blockedBy[blocker.name] ?? 0) + 1;
  }
  const collisions = [];
  const overlaps = (first,other) => Math.min(first.right,other.right) - Math.max(first.left,other.left) > 1 &&
    Math.min(first.bottom,other.bottom) - Math.max(first.top,other.top) > 1;
  for (const [index, first] of overlays.entries()) for (const other of overlays.slice(index+1)) {
    if (overlaps(first,other)) collisions.push([first.name, other.name]);
  }
  const banner = document.getElementById('alertBanner'), previous = {display:banner.style.display,text:banner.textContent};
  const warnings = [];
  try {
    banner.style.display = 'block';
    for (const key of ['alertMissile','alertPullUp']) {
      banner.textContent = I18N[lang][key];
      const rect = bounds(banner), blocked = overlays.filter(other => other.name !== 'alertBanner' && overlaps(rect,other)).map(other=>other.name);
      if (covers(rect,innerWidth/2,innerHeight/2)) blocked.push('sight');
      warnings.push({key,blocked});
    }
  } finally { banner.style.display = previous.display; banner.textContent = previous.text; }
  const sight = overlays.filter(rect => covers(rect, innerWidth/2, innerHeight/2)).map(rect => rect.name);
  return {id:player.mesh.name, lang, width:innerWidth, height:innerHeight, view:rig.cameraView, panes, buttons, sight, collisions, warnings,
    inView:box.min.x >= 0 && box.min.y >= 0 && box.max.x <= innerWidth && box.max.y <= innerHeight,
    eyeError:camera.position.distanceTo(rig.cockpit.getWorldPosition(point)), fov:camera.fov, throttle:player.throttle};
}

const fixture = html.replace(/\/\/ Boot\r?\ntry \{/, () => `window.inspectLandscape = ${inspectCockpit};\n// Boot\ntry {`);
assert.notEqual(fixture, html);
const browser = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const context = await browser.newContext({viewport:{width:568,height:320}, hasTouch:true, isMobile:true, deviceScaleFactor:1});
  const page = await context.newPage(), errors = [], observations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    const request = route.request().url();
    if (request === url) return route.fulfill({body:fixture,contentType:'text/html; charset=utf-8'});
    const file = resolve(three, request.slice(prefix.length));
    if (request.startsWith(prefix) && file.startsWith(three+sep) && file.endsWith('.js'))
      return route.fulfill({path:file,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
    errors.push(`Unexpected request: ${request}`); return route.abort();
  });
  await page.goto(url); await page.waitForFunction(() => window.__ACE_DEBUG__?.getState().frameCount > 1);
  const tap = selector => page.locator(selector).tap();
  const button = name => `[data-flight="${name}"]`;
  await tap('#qualBtn'); await tap('#qualBtn');
  const session = await context.newCDPSession(page);
  async function check(name, inset=0, bottom=0) {
    await page.waitForFunction(() => window.__ACE_DEBUG__.getState().mode === 'playing' && window.__ACE_DEBUG__.getState().cameraMode === '1p');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => window.inspectLandscape());
    if (output) await page.screenshot({path:join(output, `${name}.png`)});
    observations.push({name, inset, bottom, ...result});
    if (output) await writeFile(join(output,'measurements.json'),JSON.stringify(observations,null,2));
    assert.ok(result.inView && result.panes.every(pane => pane.total > 30 && pane.clear === pane.total),
      `${name}: touch HUD obscures cockpit artwork: ${JSON.stringify(result.panes)}`);
    assert.deepEqual(result.sight, []); assert.deepEqual(result.collisions, [], `${name}: HUD overlap`);
    for (const warning of result.warnings) assert.deepEqual(warning.blocked,[],`${name}: ${warning.key} must not cover other flight information`);
    assert.ok(result.buttons.length >= 10 && result.buttons.every(rect => rect.owns && rect.fits && rect.width >= 43.9 && rect.height >= 43.9 &&
      rect.left >= inset-0.1 && rect.top >= 0 && rect.right <= result.width-inset+0.1 && rect.bottom <= result.height-bottom+0.1), `${name}: usable touch targets`);
    assert.equal(result.view,'1p');
    assert.ok(result.eyeError < 1e-5 && result.fov >= 69 && result.fov <= 75.01);
    console.log(`PASS ${name}: visible artwork ${result.panes.map(pane=>`${pane.clear}/${pane.total}`).join(', ')}; ${result.buttons.length} touch targets`);
    return result;
  }
  for (const [index,id] of ['f22','su57','f35'].entries()) {
    await page.setViewportSize({width:568,height:320});
    if (index === 1) await tap('#langBtn');
    await tap(`[data-jet="${index}"]`); await tap('#sortieBtn'); await tap(button('view'));
    const view = await check(`${id}-568`); assert.equal(view.id,id); assert.equal(view.lang,index === 0 ? 'zh' : 'en');
    if (index === 0) {
      const right = view.buttons.find(rect=>rect.name==='cannon');
      const steer = {id:1,x:250,y:170}, moved = {...steer,x:274,y:159}, gun = {id:2,x:right.left+right.width/2,y:right.top+right.height/2};
      const touch = (type,touchPoints) => session.send('Input.dispatchTouchEvent',{type,touchPoints});
      await touch('touchStart',[steer]); await touch('touchMove',[moved]); await touch('touchStart',[moved,gun]);
      await page.waitForFunction(() => document.querySelector('#stickBase.active') && document.querySelector('#wpGun.on'));
      await touch('touchCancel',[]); await page.waitForFunction(() => !document.querySelector('#stickBase.active, #wpGun.on, #touchControls .held'));
      await tap(button('swap')); assert.equal((await page.evaluate(()=>window.__ACE_DEBUG__.getState())).activeWeapon, 'spw');
      await tap(button('flare'));
      await page.waitForFunction(() => /s$/.test(document.getElementById('flareTxt').textContent));
      const center = (name,id) => {const rect=view.buttons.find(key=>key.name===name);return {id,x:rect.left+rect.width/2,y:rect.top+rect.height/2};};
      const positions = () => page.locator('#touchControls button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
      const before = await positions(), boost = center('boost',1);
      await touch('touchStart',[boost]); await touch('touchStart',[boost,center('view',2)]);
      await page.waitForFunction(()=>window.__ACE_DEBUG__.getState().cameraMode==='3p' && document.querySelector('[data-flight="boost"].held'));
      assert.deepEqual(await positions(),before,'Do not move a button from under a held thumb when switching views');
      await touch('touchEnd',[]); await page.waitForFunction(()=>!document.querySelector('#touchControls .held'));
      await tap(button('view'));
    }
    if (index === 2) for (const [width,height,inset=0,bottom=0] of [[480,320],[500,300],[568,263],[640,360],[667,375,20,9],[720,300],[844,390,32,9]]) {
      await tap('#pauseBtn'); await page.setViewportSize({width,height});
      await session.send('Emulation.setSafeAreaInsetsOverride',{insets:{left:inset,right:inset,bottom}});
      await tap('#btnResume'); await check(`rotate-${width}x${height}`,inset,bottom);
    }
    await tap('#pauseBtn'); await tap('#btnHangar');
  }
  assert.deepEqual(errors,[]);
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const source = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const modules = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const {version} = JSON.parse(await readFile(join(modules, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const evidence = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'portrait-cockpit');
if (evidence) await mkdir(evidence, {recursive:true});

function installPanelProbe() {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeFrame(callback);
  const originalArt = new WeakMap();
  function read() {
    const rig = player.mesh.userData, cabin = rig.cockpit, screen = cabin.getObjectByName('Instruments');
    const map = screen.material.map, original = originalArt.get(screen);
    const meshes = [], blockers = [];
    cabin.traverseVisible(node => { if (node.isMesh) meshes.push(node); });
    const solids = meshes.filter(node => !node.material.transparent), ray = new THREE.Raycaster();
    const cast = (x,y) => { ray.setFromCamera({x,y}, camera); return ray.intersectObjects(solids, false)[0]?.object; };
    const {index, attributes:{position,uv}} = screen.geometry;
    function pointAt(u,v) {
      const sample = new THREE.Vector3(u,v,0), weights = new THREE.Vector3();
      for (let face = 0; face < index.count; face += 3) {
        const ids = [0,1,2].map(offset => index.getX(face + offset));
        const triangle = ids.map(id => new THREE.Vector3(uv.getX(id),uv.getY(id),0));
        THREE.Triangle.getBarycoord(sample, ...triangle, weights);
        if (Math.min(weights.x,weights.y,weights.z) < -1e-6) continue;
        const point = new THREE.Vector3();
        ids.forEach((id,corner) => point.addScaledVector(new THREE.Vector3().fromBufferAttribute(position,id),weights.getComponent(corner)));
        return screen.localToWorld(point).project(camera);
      }
      throw new Error('Sample outside instrument artwork');
    }
    for (const selector of ['#weaponPanel','#radarWrap','#touchControls button','#touchHint','#missionHud','#pauseBtn','#camBadge','#flightKeys']) {
      for (const node of document.querySelectorAll(selector)) {
        const rect = node.getBoundingClientRect(); if (rect.width && rect.height) blockers.push({selector,rect});
      }
    }
    const covered = (x,y) => blockers.some(({selector,rect}) => {
      if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return false;
      return selector !== '#radarWrap' || ((x-rect.left)/rect.width*2-1)**2 + ((y-rect.top)/rect.height*2-1)**2 <= 1;
    });
    const panes = [];
    for (let pane=0; pane<3; pane++) {
      const middle = (pane+0.5)/3, center = pointAt(middle,0.5);
      let inside=0, clear=0;
      for (let col=0; col<13; col++) for (let row=0; row<7; row++) {
        const point = pointAt((pane+0.07+(col+0.5)*0.86/13)/3,0.08+(row+0.5)*0.84/7);
        if (Math.max(Math.abs(point.x),Math.abs(point.y),Math.abs(point.z)) >= 1) continue;
        inside++;
        if (!covered((point.x+1)*innerWidth/2,(1-point.y)*innerHeight/2)) clear++;
      }
      const image = map.image, {width,height} = image;
      const topBand = image.getContext('2d').getImageData(Math.floor((middle-0.09)*width),0,Math.floor(width*0.18),Math.floor(height*0.314));
      let litRows=0;
      for (let row=0; row<topBand.height; row++) {
        let lit=0;
        for (let col=0; col<topBand.width; col++) { const offset=(row*topBand.width+col)*4; if (topBand.data[offset+1]>176 && topBand.data[offset]>95) lit++; }
        if (lit>=2) litRows++;
      }
      const projectedHeight = Math.abs(pointAt(middle,0.93).y - pointAt(middle,0.07).y)*innerHeight/2/0.86;
      const first=cast(center.x,center.y);
      panes.push({inside,clear,total:91,centerX:Math.round((center.x+1)*innerWidth/2),centerY:Math.round((1-center.y)*innerHeight/2),inkPx:litRows*projectedHeight/height,
        seesScreen:first===screen || first?.parent===screen});
    }
    const buttons=blockers.filter(item=>item.selector==='#touchControls button');
    const dockFits = buttons.every(({rect}) => rect.width>=43.9 && rect.height>=43.9 && rect.left>=-0.1 && rect.right<=innerWidth+0.1 && rect.top>=0 && rect.bottom<=innerHeight+0.1);
    const aperture = [];
    for (const x of [-0.20,0,0.20]) for (const y of [-0.14,0,0.14]) {
      const solid=cast(x,y);
      if (solid || covered((x+1)*innerWidth/2,(1-y)*innerHeight/2)) aperture.push({x,y,part:solid?.name ?? 'HUD'});
    }
    const footwell = [-0.82,0,0.82].every(x=>!!cast(x,-0.97));
    const meterBounds = document.querySelector('#weaponPanel').getBoundingClientRect();
    const meterInk = Array.from(document.querySelectorAll('#weaponPanel span')).flatMap(span => {
      const range = document.createRange(); range.selectNodeContents(span);
      return [...range.getClientRects()].filter(rect => rect.width && rect.height);
    });
    const metersFit = meterInk.length >= 10 && meterInk.every((rect, index) => rect.left >= meterBounds.left && rect.right <= meterBounds.right &&
      rect.top >= meterBounds.top && rect.bottom <= meterBounds.bottom && !meterInk.slice(index+1).some(other =>
        Math.min(rect.right,other.right) - Math.max(rect.left,other.left) > 1 && Math.min(rect.bottom,other.bottom) - Math.max(rect.top,other.top) > 1));
    return {width:innerWidth,height:innerHeight,mode,lang,quality,view:rig.cameraView,id:player.mesh.name,panes,aperture,footwell,dockFits,metersFit,buttons:buttons.length,
      fov:camera.fov,eye:cabin.getWorldPosition(new THREE.Vector3()).distanceTo(camera.position),
      straight:camera.quaternion.angleTo(player.quat), original:original === map.image, map:map.uuid, version:map.version,
      geometry:meshes.map(node=>node.geometry.uuid).sort(),power:cabin.userData.powerBar.scale.x,throttle:player.throttle};
  }
  window.panelQA={ read, remember() {const screen=player.mesh.userData.cockpit.getObjectByName('Instruments'); originalArt.set(screen,screen.material.map.image);},
    async frames(count=1) {
      await new Promise(nativeFrame);
      let draws=0; const restore=[];
      player.mesh.userData.cockpit.traverse(node=>{
        if (!node.isMesh) return;
        const original=node.onAfterRender;
        node.onAfterRender=function(...args){if(args[4]===node.material) draws++; original.apply(this,args);};
        restore.push(()=>{node.onAfterRender=original;});
      });
      try { for(let frame=0;frame<count;frame++){draws=0;animate(lastTime+1000/60);} return draws; }
      finally { for(const reset of restore) reset(); }
    }
  };
}
const fixture=source.replace(/\/\/ Boot\r?\ntry \{/,()=>`(${installPanelProbe})();\n// Boot\ntry {`);
assert.notEqual(fixture,source);
const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const observations=[];
try {
  const page=await browser.newPage({viewport:{width:320,height:568},hasTouch:true,isMobile:true,deviceScaleFactor:1});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/*',route=>{
    const request=route.request().url();
    if(request===url)return route.fulfill({body:fixture,contentType:'text/html; charset=utf-8'});
    const file=resolve(modules,request.slice(prefix.length));
    if(request.startsWith(prefix)&&file.startsWith(modules+sep)&&file.endsWith('.js'))return route.fulfill({path:file,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
    errors.push(`Unexpected request: ${request}`);return route.abort();
  });
  await page.goto(url);await page.waitForFunction(()=>window.panelQA&&window.__ACE_DEBUG__);
  const tap=selector=>page.locator(selector).tap(), frames=(count=1)=>page.evaluate(count=>panelQA.frames(count),count);
  await tap('#qualBtn');await tap('#qualBtn');
  async function check(name,compact,touch=true) {
    const draws=await frames(2), view=await page.evaluate(()=>panelQA.read());
    if(evidence)await page.screenshot({path:join(evidence,`${name}.png`)});
    const message=`${name}: ${JSON.stringify(view.panes)}`;
    assert.ok(view.panes.every(pane=>pane.inside===pane.total),`Instrument faces cropped: ${message}`);
    assert.ok(view.panes.every(pane=>pane.clear===pane.total && pane.seesScreen),`Glass, housing or HUD hides readouts: ${message}`);
    assert.deepEqual(view.aperture,[],`${name}: the solid coaming and HUD must leave the central flight sight clear: ${message}`);
    assert.ok(view.eye<1e-5 && view.straight<1e-5 && view.fov>=69 && view.fov<=75.01,`${name}: authored eye, heading and cockpit FOV`);
    assert.equal(view.original,!compact,`${name}: original wide / compact artwork`);
    assert.ok(draws>0 && draws<=5,`${name}: ${draws} cockpit color draws`);
    if(compact){assert.ok(view.footwell,`${name}: there must be a solid lower cabin rather than sky below the dashboard`);assert.ok(view.panes.every(pane=>pane.inkPx>=7.5),`Primary instrument legend too small: ${message}`);}
    assert.ok(view.dockFits && (touch?view.buttons>=10:view.buttons===0),`${name}: dock tap targets`);
    assert.ok(view.metersFit,`${name}: telemetry, ammo, flares and hull values must fit without overlapping`);
    const legend = compact ? `legends ${view.panes.map(pane=>pane.inkPx.toFixed(1)).join('/')} CSS px` : 'original wide artwork';
    observations.push({name,draws,...view});console.log(`PASS ${name} (${view.quality}): ${draws} draws; 3 × 91 exposed samples; ${legend}`);
    return view;
  }
  for(const [index,id] of ['f22','su57','f35'].entries()) {
    const width=index===0?320:390, height=index===0?568:844;
    await page.setViewportSize({width,height});if(index)await tap('#qualBtn');
    await tap(`[data-jet="${index}"]`);await tap('#sortieBtn');await frames();
    await page.evaluate(()=>panelQA.remember());await tap('[data-flight="view"]');const initial=await check(`${id}-portrait`,true);
    assert.equal(initial.id,id);assert.equal(initial.quality,['low','high','med'][index]);
    await frames(4);assert.equal((await page.evaluate(()=>panelQA.read())).version,initial.version,'Steady flight must not upload the artwork again');
    if(index===0){
      await tap('#pauseBtn');await tap('#langBtn');await tap('#btnResume');const english=await check('320-english',true);assert.equal(english.lang,'en');
      for (const [width,height] of [[320,480],[400,440],[480,480]]) {
        await page.setViewportSize({width,height});await check(`${width}x${height}-short`,true);
      }
      await page.keyboard.down('w');await frames(6);await page.keyboard.up('w');const boost=await page.evaluate(()=>panelQA.read());
      assert.ok(boost.power>english.power+0.08 && Math.abs(boost.power-boost.throttle)<1e-6,'Engine indicator must show actual throttle');
      await page.setViewportSize({width:844,height:390});const wide=await check('844-landscape',false);assert.equal(wide.map,initial.map);assert.deepEqual(wide.geometry,initial.geometry);
      await tap('#pauseBtn');await page.setViewportSize({width:390,height:844});await tap('#btnResume');const restored=await check('390-after-paused-rotation',true);assert.equal(restored.map,initial.map);
      await page.mouse.click(180,240);await frames();await check('390-mouse',true,false);
      await page.setViewportSize({width:1280,height:720});const desktop=await check('1280-desktop',false,false);assert.equal(desktop.map,initial.map);
      await page.keyboard.press('v');await frames();assert.equal(await page.locator('#hud').evaluate(element=>element.classList.contains('cockpit-view')),false);
    }
    await tap('#pauseBtn');await tap('#btnHangar');await frames();
  }
  assert.deepEqual(errors,[]);
  if(evidence)await writeFile(join(evidence,'measurements.json'),JSON.stringify(observations,null,2));
} finally {await browser.close();}

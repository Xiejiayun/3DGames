import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/kart.html', import.meta.url), 'utf8');
const expose = `globalThis.qa = { THREE, scene, camera, renderer, skyMat, TRACKS, CHARS,
  buildTrackAndWorld, buildKartMesh, startRace, backToMenu, spawnItemEffect,
  stepRacer, updateProjectiles, animate, disposeObject, previewRenderers, get samples(){return trackSamples},
  get world(){return worldGroup}, get racers(){return racers},
  get props(){return animatedProps}, get projectiles(){return activeProjectiles},
  get ramps(){return jumpRamps}, set track(v){selectedTrack=v},
  set char(v){selectedChar=v}, set state(v){gameState=v}, set cam(v){camMode=v}, get state(){return gameState} };`;
const instrumented = html.replace(/<\/script>\s*<\/body>/, `${expose}</script></body>`);
const server = createServer(async (req, res) => {
  if (/^\/games\/assets\/[a-z0-9-]+\.glb$/.test(req.url)) {
    try {const data=await readFile(process.env.KART_ASSET_DIR?join(process.env.KART_ASSET_DIR,req.url.split('/').pop()):new URL('..'+req.url,import.meta.url));res.setHeader('Content-Type','model/gltf-binary');res.end(data);}
    catch {res.writeHead(404).end();} return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(instrumented);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const screenshots = process.env.KART_SCREENSHOTS || join(tmpdir(), 'kart-3d-check', String(process.pid));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.KART_BROWSER });
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
    const result = await page.evaluate(([id,referenceAssets]) => {
      qa.track = id; qa.startRace(); qa.state = 'review';
      const failures = [];
      if (!qa.world.children.some(obj=>obj.userData.assetId===qa.TRACKS[id].id)) failures.push('track GLB fallback');
      if (!qa.world.getObjectByName('sign-'+qa.TRACKS[id].id)) failures.push('missing illustrated track sign');
      qa.world.traverse(o => {
        const a = o.geometry?.attributes.position?.array;
        if (a && !a.every(Number.isFinite)) failures.push(`nonfinite geometry: ${o.name}`);
      });
      const checkColorMap=o=>{
        for(const m of (Array.isArray(o.material)?o.material:[o.material])) {
          if(m?.map && m.map.colorSpace!==qa.THREE.SRGBColorSpace) failures.push('color texture lacks sRGB');
        }
      };
      qa.world.traverse(checkColorMap);
      qa.racers.forEach(r=>r.visual.root.traverse(checkColorMap));
      const road = qa.world.getObjectByName('road-surface');
      if (!road || road.geometry.attributes.normal.getY(0) < .9) failures.push('road must face up');
      if (!qa.world.getObjectByName('road-foundation')) failures.push('missing deck');
      if (!qa.world.getObjectByName('deck-pier')) failures.push('missing piers');
      qa.world.updateMatrixWorld(true);
      for(const index of [0,240,420]) {
        const s=qa.samples[index];
        const ray=new qa.THREE.Raycaster(s.pos.clone().addScaledVector(s.right,8.9).add(new qa.THREE.Vector3(0,2,0)),new qa.THREE.Vector3(0,-1,0),0,3);
        const hit=ray.intersectObject(qa.world.getObjectByName('road-foundation'))[0];
        if(!hit || hit.point.y<s.pos.y-.1) failures.push('unsupported shoulder gap');
      }
      if (id === 0) {
        qa.camera.position.set(0,-5,0);qa.renderer.render(qa.scene,qa.camera);
        if(qa.skyMat.uniforms.uUnderwater.value!==1) failures.push('bright sky remains underwater');
        qa.camera.position.y=5;qa.renderer.render(qa.scene,qa.camera);
        if(qa.skyMat.uniforms.uUnderwater.value!==0) failures.push('underwater tint remains above water');
        const shell = qa.world.getObjectByName('sea-tunnel-shell');
        if (!shell) failures.push('missing continuous sea tunnel');
        const fish = qa.props.filter(p => p.type === 'fish');
        if (fish.length < 10 || !qa.world.getObjectByName('seagull')) failures.push('missing coast animals');
        for (const p of fish) {
          if (qa.samples.some(s => Math.hypot(s.pos.x-p.center.x,s.pos.z-p.center.z)<10)) failures.push('fish enters road');
        }
        qa.world.updateMatrixWorld(true);
        const ocean = qa.world.getObjectByName('ocean');
        for (const s of qa.samples) {
          if (s.pos.y < -2.6 || s.pos.y > -.6) continue;
          const ray = new qa.THREE.Raycaster(s.pos.clone().add(new qa.THREE.Vector3(0,2,0)),new qa.THREE.Vector3(0,-1,0),0,1.95);
          if (ray.intersectObject(ocean).length) failures.push('sea slices driving clearance');
        }
      }
      if (id === 2) {
        for (const name of ['alpine-ice-shell','gondola-cable','gondola-station','frozen-lake']) {
          if (!qa.world.getObjectByName(name)) failures.push(`missing ${name}`);
        }
        const gondolas=qa.props.filter(p=>p.type==='gondola');
        if(gondolas.length!==3) failures.push('gondola count');
        qa.animate(1200);
        for(const ap of gondolas) {
          const expected=ap.path.getPointAt((1.2*.025+ap.phase)%1);
          if(ap.mesh.position.distanceTo(expected)>.001) failures.push('gondola detached from cable');
          if(ap.mesh.position.y-7.8<15) failures.push('gondola enters driving clearance');
        }
        qa.world.traverse(o=>{if(o.name==='frosted-pine'&&o.position.y!==-3.2) failures.push('floating pine')});
        const lake=qa.world.getObjectByName('frozen-lake');
        lake.children[0].geometry.computeBoundingBox();
        if(qa.samples.some(s=>Math.hypot(s.pos.x-lake.position.x,s.pos.z-lake.position.z)<lake.children[0].geometry.boundingBox.max.x+9.7)) failures.push('lake shore overlaps track');
      }
      if (id === 1) {
        for (const name of ['forest-cave-shell','forest-suspension-bridge','waterfall-pool','forest-boulder']) {
          if (!qa.world.getObjectByName(name)) failures.push(`missing ${name}`);
        }
        qa.world.updateMatrixWorld(true);
        const cliff = qa.world.getObjectByName('waterfall');
        for (const s of qa.samples) {
          const ray = new qa.THREE.Raycaster(s.pos.clone().add(new qa.THREE.Vector3(0,1.5,0)),s.tangent,0,4);
          if (ray.intersectObject(cliff,true).length) failures.push('waterfall obstructs track');
        }
        qa.world.traverse(o => { if (o.name==='redwood' && o.position.y!==-3.2) failures.push('floating redwood'); });
      }
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
      for (const r of qa.racers) {
        if (!r.visual.chassisFrame || r.visual.wheels.some(w=>w.parent.parent!==r.visual.chassisFrame)) failures.push('wheels outside chassis frame');
        if (r.visual.bodyGroup.getObjectByName('Fairings')) {
          if (r.visual.headGroup.name!=='Helmet' || r.visual.wheels.length!==4) failures.push('invalid Sprint 27 rig');
        } else if (referenceAssets && r.visual.root.userData.assetId===r.charCfg.id && r.visual.root.getObjectByName('detail-'+r.charCfg.id) && !r.visual.root.getObjectByName('volt-coachwork')) {
          if(!r.visual.headGroup) failures.push('missing reference driver');
        } else if (r.visual.root.userData.assetId===r.charCfg.id) {
          const frost=r.charCfg.id==='frost';
          if(!r.visual.headGroup || !r.visual.bodyGroup.getObjectByName(frost?'frost-airframe':'volt-coachwork')) failures.push('missing packed driver or custom bodywork');
          if(frost && (r.visual.fanBlades.length!==2 || r.visual.fanBlades.some(rotor=>!rotor.children.some(child=>child.name.startsWith('frost-impeller'))))) failures.push('impeller detached from rotor');
          if(!frost && !r.visual.engineGroup.getObjectByName('volt-powerplant')) failures.push('V8 detached from engine rig');
        } else failures.push('kart GLB fallback');
        for(const rig of r.visual.armRigs) {
          if(rig.glove.parent!==r.visual.steerWheelGroup) failures.push('hands detached from wheel');
        }
      }
      const owner=qa.racers[0];
      const ramp=qa.ramps[0];
      const resetAtRamp=(across)=>{
        owner.pos.copy(ramp.pos).addScaledVector(ramp.right,across);owner.sampleIdx=Math.floor(.29*600);
        owner.heading=Math.atan2(ramp.tangent.x,ramp.tangent.z);owner.speed=35;
        owner.airY=0;owner.airVy=0;owner.doingTrick=false;owner.trickAngle=0;
      };
      resetAtRamp(ramp.halfWidth+1.5);qa.stepRacer(owner,1/60,1);
      if(owner.doingTrick) failures.push('jump triggered outside ramp');
      resetAtRamp(0);qa.stepRacer(owner,1/60,1);
      if(!owner.doingTrick || owner.visual.chassisFrame.rotation.x===0) failures.push('jump does not move complete chassis');
      owner.airY=0;owner.airVy=0;owner.doingTrick=false;owner.trickAngle=0;
      owner.sampleIdx=100;owner.pos.copy(qa.samples[100].pos);owner.heading=Math.atan2(qa.samples[100].tangent.x,qa.samples[100].tangent.z);
      owner.speed=0;qa.stepRacer(owner,0,2);
      if(Math.abs(owner.visual.chassisFrame.rotation.x+Math.asin(qa.samples[100].tangent.y))>.001) failures.push('kart does not follow slope');
      qa.spawnItemEffect(owner,'banana');
      const peel=qa.projectiles.at(-1);
      const closest=qa.samples.reduce((a,s)=>Math.hypot(s.pos.x-peel.pos.x,s.pos.z-peel.pos.z)<a.distance?
        {distance:Math.hypot(s.pos.x-peel.pos.x,s.pos.z-peel.pos.z),y:s.pos.y}:a,{distance:Infinity});
      if(Math.abs(peel.pos.y-closest.y-.07)>.01 || peel.mesh.children.length!==4 || !peel.mesh.userData.binding) failures.push('banana asset, pose or silhouette');
      qa.cam=1;qa.animate(2000);
      const headPos=owner.visual.headGroup.getWorldPosition(new qa.THREE.Vector3());
      if(qa.camera.position.distanceTo(headPos)<.5) failures.push('cockpit inside head');
      qa.cam=0;
      document.getElementById('ui').style.display = 'none';
      return { id: qa.TRACKS[id].id, failures };
    }, [id,Boolean(process.env.KART_ASSET_DIR)]);
    assert.deepEqual(result.failures, [], `${result.id}: ${result.failures.join(', ')}`);
    await page.evaluate(id=>{
      const name={forest:'redwood',alpine:'frosted-pine',coast:'palm'}[id];
      const anchor=qa.world.getObjectByName(name), target=anchor.getWorldPosition(new qa.THREE.Vector3());
      const distance=id==='forest'?25:14;
      qa.camera.fov=52;qa.camera.updateProjectionMatrix();
      qa.camera.position.copy(target).add(new qa.THREE.Vector3(distance*.46,distance*.91,distance));
      qa.camera.lookAt(target.add(new qa.THREE.Vector3(0,id==='forest'?10:5,0)));qa.renderer.render(qa.scene,qa.camera);
    },result.id);
    await page.screenshot({path:join(screenshots,`${result.id}-habitat.png`)});
    await page.evaluate(id=>{
      const sign=qa.world.getObjectByName('sign-'+id), target=sign.getWorldPosition(new qa.THREE.Vector3());target.y+=3.4;
      const direction=sign.getWorldDirection(new qa.THREE.Vector3());
      qa.camera.position.copy(target).addScaledVector(direction,15);qa.camera.position.y+=1.2;
      qa.camera.lookAt(target);qa.renderer.render(qa.scene,qa.camera);
    },result.id);
    await page.screenshot({path:join(screenshots,`${result.id}-sign.png`)});
    for (const t of [.02, .17, .25, .41, .65, .85]) {
      await page.evaluate(t => {
        const s = qa.samples[Math.floor(t * 600)];
        qa.camera.position.copy(s.pos).addScaledVector(s.tangent, -20).add(new qa.THREE.Vector3(0, 6, 0));
        qa.camera.lookAt(s.pos.clone().add(new qa.THREE.Vector3(0, 3, 0)));
        qa.renderer.render(qa.scene, qa.camera);
      }, t);
      await page.screenshot({ path: join(screenshots, `${result.id}-${t}.png`) });
    }
    await page.evaluate(()=>{qa.renderer.shadowMap.enabled=true;qa.renderer.render(qa.scene,qa.camera)});
    await page.screenshot({path:join(screenshots,`${result.id}-hq.png`)});
    await page.evaluate(()=>{qa.renderer.shadowMap.enabled=false});
    console.log(`PASS ${result.id}: geometry, race updates, all items, screenshots`);
  }
  for(const [id,rear] of [[0,false],[0,true],[1,false],[1,true],[2,false],[2,true]]) {
    await page.evaluate(([id,rear])=>{
      const s=new qa.THREE.Scene();s.background=new qa.THREE.Color(0x24364a);s.environment=qa.scene.environment;
      s.add(new qa.THREE.HemisphereLight(0xffffff,0x243345,1.3));
      const light=new qa.THREE.DirectionalLight(0xffffff,2);light.position.set(3,5,4);s.add(light);
      const kart=qa.buildKartMesh(qa.CHARS[id]);s.add(kart.root);
      if(id===0 && !kart.root.getObjectByName('Fairings')) throw new Error('Sprint 27 GLB not loaded');
      const cam=new qa.THREE.PerspectiveCamera(35,1100/700,.1,30);cam.position.set(rear?-2.8:3.2,2.1,rear?-4.1:4.2);cam.lookAt(0,.8,0);
      qa.renderer.render(s,cam);qa.disposeObject(kart.root);
    },[id,rear]);
    await page.screenshot({path:join(screenshots,`driver-${id}${rear?'-rear':''}.png`)});
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
  await page.evaluate(() => {qa.state='racing';qa.animate(performance.now()+50)});
  const before=await page.evaluate(()=>qa.racers[0].pos.toArray());
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowRight');
  await page.evaluate(()=>{for(let n=0;n<120;n++) qa.stepRacer(qa.racers[0],1/60,n/60);qa.animate(performance.now()+100)});
  await page.keyboard.up('ArrowUp');await page.keyboard.up('ArrowRight');
  const after=await page.evaluate(()=>qa.racers[0].pos.toArray());
  assert.ok(Math.hypot(after[0]-before[0],after[2]-before[2])>2,'keyboard driving must move the kart');
  const handErrors=await page.evaluate(()=>{
    const r=qa.racers[0];r.visual.root.updateMatrixWorld(true);
    return r.visual.armRigs.map(rig=>new qa.THREE.Vector3(0,rig.length/2,0).applyMatrix4(rig.lower.matrixWorld).distanceTo(rig.glove.getWorldPosition(new qa.THREE.Vector3())));
  });
  assert.ok(handErrors.every(e=>e<.001),'arms must meet hands while steering');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>qa.state),'paused');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>qa.state),'racing');
  const previewAspects=await page.evaluate(()=>qa.previewRenderers.map(p=>({camera:p.camera.aspect,box:p.renderer.domElement.getBoundingClientRect().toJSON(),renderTarget:!!p.scene.environment.isRenderTargetTexture})));
  for(const p of previewAspects) {
    assert.ok(Math.abs(p.camera-p.box.width/p.box.height)<.01,'preview aspect after resize');
    assert.equal(p.renderTarget,false,'previews must not reuse a foreign WebGL render target');
  }
  await page.screenshot({ path: join(screenshots, 'mobile-race.png') });
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log(`PASS repeated scene disposal: ${JSON.stringify(memory)}; mobile menu/start; no browser errors`);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

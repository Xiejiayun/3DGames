import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/kart.html', import.meta.url), 'utf8');
const expose = `globalThis.qa = { THREE, scene, camera, renderer, skyMat, TRACKS, CHARS,
  buildTrackAndWorld, buildKartMesh, buildProceduralKart, startRace, backToMenu, spawnItemEffect, rollWeightedItem, inflictHit,
  stepRacer, resolveKartCollisions, wrapAngle, updateProjectiles, animate, animateScarf, updateSunShadow, disposeObject, previewRenderers,
  updateCornerHint, finishRace, get samples(){return trackSamples},
  get world(){return worldGroup}, get racers(){return racers}, get coins(){return coinPickups},
  get props(){return animatedProps}, get projectiles(){return activeProjectiles},
  get ramps(){return jumpRamps}, set track(v){selectedTrack=v},
  set char(v){selectedChar=v}, set state(v){gameState=v}, set cam(v){camMode=v}, get state(){return gameState} };`;
const instrumented = html.replace(/<\/script>\s*<\/body>/, `${expose}</script></body>`);
const server = createServer(async (req, res) => {
  if (req.url!=='/games/kart.html') { res.writeHead(404).end(); return; }
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
  await page.route(/^https?:/, route=>{
    if(route.request().url()===`http://127.0.0.1:${server.address().port}/games/kart.html`) return route.continue();
    errors.push(`Unexpected network request: ${route.request().url()}`);return route.abort();
  });
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
      if (!qa.world.children.some(obj=>obj.userData.assetId===qa.TRACKS[id].id)) failures.push('track GLB fallback');
      if (!qa.world.getObjectByName('sign-'+qa.TRACKS[id].id)) failures.push('missing illustrated track sign');
      if (qa.coins.length !== 18) failures.push(`expected 18 coins, got ${qa.coins.length}`);
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
        const quay = qa.world.getObjectByName('lighthouse-quay');
        if (!quay?.getObjectByName('harbor-jetty')) failures.push('missing lighthouse service jetty');
        if (quay) {
          const footprint = new qa.THREE.Box3().setFromObject(quay);
          for (const sample of qa.samples) {
            const nearest = footprint.clampPoint(sample.pos,new qa.THREE.Vector3());
            if (Math.hypot(nearest.x-sample.pos.x,nearest.z-sample.pos.z)<9.2) failures.push('quay intersects road envelope');
          }
        }
        const boats = quay?.getObjectsByProperty('name','harbor-rowboat') || [];
        if (boats.length!==2) failures.push('missing harbor rowboats');
        for (const boat of boats) {
          // Sample the footwell beside the diagonal oar and between the seats.
          const ray = new qa.THREE.Raycaster(boat.localToWorld(new qa.THREE.Vector3(.25,2,-.25)),new qa.THREE.Vector3(0,-1,0));
          const hit = ray.intersectObject(boat,true)[0];
          if (!hit || boat.worldToLocal(hit.point.clone()).y>.1) failures.push('rowboat interior must be hollow');
        }
        const headland = qa.world.getObjectByName('coastal-headland');
        if (!headland) failures.push('missing first-corner headland');
        else for (let station=0;station<qa.samples.length;station+=4) {
          const sample=qa.samples[station];
          for (const across of [-9.2,0,9.2]) {
            const ray=new qa.THREE.Raycaster(sample.pos.clone().addScaledVector(sample.right,across).add(new qa.THREE.Vector3(0,30,0)),new qa.THREE.Vector3(0,-1,0));
            if (ray.intersectObject(headland).length) failures.push('headland enters driving envelope');
          }
        }
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
        const stamp=performance.now(); qa.animate(stamp);
        for(const ap of gondolas) {
          const expected=ap.path.getPointAt((stamp*.001*.025+ap.phase)%1);
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
        if (r.charCfg.charStyle==='dao') {
          const fallback=qa.buildProceduralKart(r.charCfg);
          if (!fallback.root.getObjectByName('dao-helmet-stripe') || !fallback.root.getObjectByName('blaze-wing-flap')) failures.push('missing Dao racing kit');
          const tails = fallback.physParts.find(part=>part.mode==='scarf')?.pivot;
          const ribbons = tails?.children.find(part=>part.geometry?.type==='BufferGeometry');
          if (!tails || tails.position.x<=0 || !ribbons?.geometry.attributes.uv) failures.push('scarf must stay on driver left');
          const intakes = fallback.root.getObjectsByProperty('name','blaze-intake');
          if (intakes.length!==2 || intakes[0].scale.x*intakes[1].scale.x>=0) failures.push('intakes must be mirrored');
          const scarf=fallback.physParts.find(part=>part.mode==='scarf');
          if (scarf) {
            qa.animateScarf(scarf,1,1,.4);
            const positions=scarf.ribbon.geometry.attributes.position;
            for (const vertex of [0,1,22,23]) {
              if (Math.abs(positions.getX(vertex)-scarf.rest[vertex*3])>1e-7 || Math.abs(positions.getY(vertex)-scarf.rest[vertex*3+1])>1e-7) failures.push('scarf knot detaches');
            }
            const firstTip=positions.getY(20);
            qa.animateScarf(scarf,1.2,1,.4);
            if (Math.abs(positions.getY(20)-firstTip)<.001) failures.push('scarf tips do not flutter');
          }
          fallback.root.traverse(part=>{
            for(const attribute of ['position','normal']) {
              const values=part.geometry?.attributes[attribute]?.array;
              if(values && !values.every(Number.isFinite)) failures.push(`invalid vehicle ${attribute}`);
            }
          });
          if(fallback.root.getObjectsByProperty('name','dao-racing-boot').length!==2) failures.push('missing seated boots');
          // Check actual exterior winding and cockpit depth, not just part names.
          fallback.bodyGroup.updateWorldMatrix(true,true);
          const body=fallback.bodyGroup;
          const down=new qa.THREE.Vector3(0,-1,0).transformDirection(body.matrixWorld);
          const rayAt=depth=>new qa.THREE.Raycaster(body.localToWorld(new qa.THREE.Vector3(0,2,depth)),down);
          const nose=body.getObjectByName('blaze-sculpted-nose'), floor=body.getObjectByName('blaze-floorpan');
          const noseHit=nose && rayAt(1.05).intersectObject(nose)[0];
          const floorHit=floor && rayAt(0).intersectObject(floor)[0];
          if(!noseHit || noseHit.face.normal.y<.3) failures.push('nose exterior must face upward');
          if(!floorHit || body.worldToLocal(floorHit.point.clone()).y>.34) failures.push('cockpit must remain recessed');
          qa.disposeObject(fallback.root);
        }
        if (!r.visual.chassisFrame || r.visual.wheels.some(w=>w.parent.parent!==r.visual.chassisFrame)) failures.push('wheels outside chassis frame');
        if (r.visual.bodyGroup.getObjectByName('Fairings')) {
          if (r.visual.headGroup.name!=='Helmet' || r.visual.wheels.length!==4) failures.push('invalid Sprint 27 rig');
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
      qa.spawnItemEffect(owner,'banana',{forward:true});
      const fwdPeel=qa.projectiles.at(-1);
      const fwdSample=qa.samples[(owner.sampleIdx+14)%qa.samples.length];
      if(fwdPeel.pos.clone().sub(owner.pos).dot(qa.samples[owner.sampleIdx].tangent)<=0 || Math.abs(fwdPeel.pos.y-fwdSample.pos.y-.07)>.01) {
        failures.push('forward banana pose');
      }
      const coin = qa.coins.find(c => c.cooldown <= 0);
      if (!coin) failures.push('no active coin available');
      else {
        owner.coins = 0; owner.shieldTimer = 0;
        const coinSample = qa.samples.reduce((best, s, idx) => {
          const d = Math.hypot(s.pos.x - coin.pos.x, s.pos.z - coin.pos.z);
          return d < best.d ? { d, idx } : best;
        }, { d: Infinity, idx: 0 }).idx;
        owner.sampleIdx = coinSample;
        owner.pos.copy(coin.pos); owner.pos.y = qa.samples[coinSample].pos.y;
        owner.airY = 0; owner.airVy = 0; owner.speed = 10;
        qa.stepRacer(owner, 1/60, 3);
        if (owner.coins !== 1 || coin.cooldown <= 0 || coin.mesh.visible) failures.push('coin pickup failed');
        owner.coins = 5;
        qa.inflictHit(owner, 'missile');
        if (owner.coins !== 2) failures.push(`coin drop on hit failed: ${owner.coins}`);
        owner.shieldTimer = 2.0;
        qa.inflictHit(owner, 'missile');
        if (owner.coins !== 2) failures.push(`shielded racer should not drop coins: ${owner.coins}`);
        owner.shieldTimer = 0; owner.stunTimer = 0; owner.airY = 0; owner.airVy = 0; owner.coins = 0;
      }
      qa.cam=1;qa.animate(performance.now());
      const headPos=owner.visual.headGroup.getWorldPosition(new qa.THREE.Vector3());
      if(qa.camera.position.distanceTo(headPos)<.5) failures.push('cockpit inside head');
      qa.cam=0;
      document.getElementById('ui').style.display = 'none';
      return { id: qa.TRACKS[id].id, failures };
    }, id);
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
    if (id===0) {
      await page.evaluate(()=>{
        qa.startRace(); qa.state='review'; qa.cam=0;
        const racer=qa.racers[0], sample=qa.samples[58];
        racer.pos.copy(sample.pos); racer.sampleIdx=58; racer.heading=Math.atan2(sample.tangent.x,sample.tangent.z);
        qa.stepRacer(racer,0,performance.now()/1000);
        qa.updateSunShadow();
        const heading=new qa.THREE.Vector3(Math.sin(racer.heading),0,Math.cos(racer.heading));
        qa.camera.position.copy(racer.pos).addScaledVector(heading,-7.2); qa.camera.position.y+=3.3;
        qa.camera.lookAt(racer.pos.clone().addScaledVector(heading,9.5).add(new qa.THREE.Vector3(0,1.1,0)));
        qa.camera.fov=62; qa.camera.updateProjectionMatrix(); qa.renderer.render(qa.scene,qa.camera);
      });
      await page.screenshot({path:join(screenshots,'coast-first-corner.png')});
    }
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
  for(let id=0;id<3;id++) {
    const views = id===0 ? ['front','side','rear'] : ['front','rear'];
    for (const view of views) {
    await page.evaluate(({id,view})=>{
      const s=new qa.THREE.Scene();s.background=new qa.THREE.Color(0x24364a);s.environment=qa.scene.environment;
      s.add(new qa.THREE.HemisphereLight(0xffffff,0x243345,1.3));
      const light=new qa.THREE.DirectionalLight(0xffffff,2);light.position.set(3,5,4);s.add(light);
      const kart=qa.buildKartMesh(qa.CHARS[id]);s.add(kart.root);
      if(id===0 && !kart.root.getObjectByName('Fairings')) throw Error('Sprint GLB not loaded');
      const positions={front:[3.2,2.1,4.2],side:[5,1.4,0],rear:[-3.2,1.9,-4.2]};
      const cam=new qa.THREE.PerspectiveCamera(35,1100/700,.1,30);cam.position.set(...positions[view]);cam.lookAt(0,.8,0);
      qa.renderer.render(s,cam);qa.disposeObject(kart.root);
    },{id,view});
    await page.screenshot({path:join(screenshots,view==='front'?`driver-${id}.png`:`driver-${id}-${view}.png`)});
    }
  }
  const tacticalFailures = await page.evaluate(() => {
    const failures = [];
    qa.track = 0; qa.startRace(); qa.state = 'racing';
    const [r1, r2, r3, r4] = qa.racers;
    r1.totalProgress = 2.6; r2.totalProgress = 2.2; r3.totalProgress = 1.7; r4.totalProgress = 1.1;
    const rank1Pool = new Set(['banana', 'shield', 'bubble', 'nitro']);
    const midPool = new Set(['missile', 'bubble', 'shield', 'magnet', 'banana']);
    const rank4Pool = new Set(['nitro', 'magnet', 'missile', 'shield']);
    for (let k = 0; k < 120; k++) {
      const it1 = qa.rollWeightedItem(r1);
      const it2 = qa.rollWeightedItem(r2);
      const it4 = qa.rollWeightedItem(r4);
      if (!rank1Pool.has(it1?.id)) failures.push(`invalid rank1 item: ${it1?.id}`);
      if (!midPool.has(it2?.id)) failures.push(`invalid mid item: ${it2?.id}`);
      if (!rank4Pool.has(it4?.id)) failures.push(`invalid rank4 item: ${it4?.id}`);
    }
    r1.sampleIdx = 100; r1.pos.copy(qa.samples[100].pos);
    r1.heading = Math.atan2(qa.samples[100].tangent.x, qa.samples[100].tangent.z);
    qa.spawnItemEffect(r1, 'bubble', { backward: true });
    const backBubble = qa.projectiles.at(-1);
    const backExpected = qa.samples[(100 - 6 + qa.samples.length) % qa.samples.length].pos.clone().add(new qa.THREE.Vector3(0, 1.2, 0));
    if (backBubble.pos.distanceTo(backExpected) > 0.05) failures.push('backward bubble spawn offset');

    // Extreme maneuver missile evasion (evadeBoostTimer)
    r1.stunTimer = 0; r1.evadeBoostTimer = 0.75; r1.shieldTimer = 0;
    qa.spawnItemEffect(r2, 'missile');
    const missile = qa.projectiles.at(-1);
    missile.target = r1;
    missile.pos.copy(r1.pos).add(new qa.THREE.Vector3(0, 0.8, 5));
    const countBefore = qa.projectiles.length;
    qa.updateProjectiles(1 / 60);
    if (qa.projectiles.length !== countBefore - 1 || r1.stunTimer > 0) {
      failures.push('missile evasion failed to deflect harmlessly');
    }

    // Smart AI hazard avoidance, corner drifting & rubber-banding
    const ai = r2;
    ai.sampleIdx = 40; ai.pos.copy(qa.samples[40].pos);
    ai.heading = Math.atan2(qa.samples[40].tangent.x, qa.samples[40].tangent.z);
    ai.aiLane = 0; ai.aiBaseLane = 0; ai.speed = 35;
    const hazSample = qa.samples[50];
    qa.spawnItemEffect(r1, 'bubble', { backward: false });
    const haz = qa.projectiles.at(-1);
    haz.sampleIdx = 50; haz.pos.copy(hazSample.pos).add(new qa.THREE.Vector3(0, 1.2, 0));
    for (let step = 0; step < 15; step++) qa.stepRacer(ai, 1 / 60, step / 60);
    if (Math.abs(ai.aiLane) < 0.3) failures.push(`AI failed to steer away from ahead hazard: ${ai.aiLane}`);

    ai.sampleIdx = 80; ai.pos.copy(qa.samples[80].pos);
    ai.aiLane = 0; ai.aiBaseLane = 0;
    ai.heading = Math.atan2(qa.samples[80].tangent.x, qa.samples[80].tangent.z) - 0.65;
    ai.speed = 32; ai.drifting = false; ai.driftCharge = 0; ai.boostTimer = 0; ai.evadeBoostTimer = 0;
    qa.stepRacer(ai, 1 / 60, 1);
    if (!ai.drifting) failures.push('AI failed to initiate corner drift');
    ai.driftCharge = 0.95;
    ai.aiLane = 0; ai.aiBaseLane = 0;
    ai.heading = Math.atan2(qa.samples[94].pos.x - ai.pos.x, qa.samples[94].pos.z - ai.pos.z);
    qa.stepRacer(ai, 1 / 60, 1.02);
    if (ai.drifting || ai.boostTimer <= 0 || ai.evadeBoostTimer <= 0.7) {
      failures.push(`drift release did not grant mini-turbo & evade boost: drifting=${ai.drifting}, boost=${ai.boostTimer}, evade=${ai.evadeBoostTimer}`);
    }

    r1.totalProgress = 3.0; ai.totalProgress = 0.0;
    for (let step = 0; step < 30; step++) qa.stepRacer(ai, 1 / 60, 2 + step / 60);
    if (ai.aiRubber < 0.94 - 1e-6 || ai.aiRubber > 1.06 + 1e-6) failures.push(`aiRubber out of bounds: ${ai.aiRubber}`);

    return failures;
  });
  assert.deepEqual(tacticalFailures, [], `tactical checks: ${tacticalFailures.join(', ')}`);
  console.log('PASS tactical items, directional throws, missile evasion & AI avoidance');

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
  const telemetryCheck = await page.evaluate(() => {
    const failures = [];
    const player = qa.racers[0];
    const hintEl = document.getElementById('cornerHint');
    const minimapEl = document.getElementById('minimapWrap');

    // Find a curved track section without an intervening jump ramp ahead
    let curveIdx = -1;
    const total = qa.samples.length;
    for (let i = 0; i < total; i++) {
      const s0 = qa.samples[i];
      const fwdX = s0.tangent.x, fwdZ = s0.tangent.z;
      const nearRamp = qa.ramps.some(r => {
        const dx = r.pos.x - s0.pos.x, dy = r.pos.y - s0.pos.y, dz = r.pos.z - s0.pos.z;
        const ahead = dx * fwdX + dz * fwdZ;
        return ahead >= 14 && ahead <= 42 && Math.abs(dy) < 10;
      });
      if (nearRamp) continue;
      let deltaYaw = 0;
      let prevYaw = Math.atan2(qa.samples[(i + 12) % total].tangent.x, qa.samples[(i + 12) % total].tangent.z);
      for (let step = 13; step <= 34; step++) {
        const sn = qa.samples[(i + step) % total];
        const nextYaw = Math.atan2(sn.tangent.x, sn.tangent.z);
        let d = nextYaw - prevYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        deltaYaw += d;
        prevYaw = nextYaw;
      }
      if (Math.abs(deltaYaw) > 0.35) { curveIdx = i; break; }
    }
    if (curveIdx < 0) failures.push('no curved sample found');
    else {
      const s = qa.samples[curveIdx];
      player.pos.copy(s.pos);
      player.sampleIdx = curveIdx;
      player.heading = Math.atan2(s.tangent.x, s.tangent.z);
      qa.updateCornerHint(player);
      const style = getComputedStyle(hintEl);
      if (style.display === 'none' || !hintEl.textContent.trim()) failures.push('corner hint hidden on curve');
      if (!hintEl.classList.contains('warn-turn') && !hintEl.classList.contains('warn-sharp')) failures.push('missing turn warning class');
      const hintBox = hintEl.getBoundingClientRect();
      const mapBox = minimapEl.getBoundingClientRect();
      if (hintBox.top < mapBox.bottom && hintBox.left < mapBox.right && hintBox.right > mapBox.left) {
        failures.push('corner hint overlaps minimap on mobile');
      }
    }

    // Verify ramp warning triggers ahead of a ramp
    const ramp = qa.ramps[0];
    player.pos.copy(ramp.pos).addScaledVector(ramp.tangent, -24);
    player.heading = Math.atan2(ramp.tangent.x, ramp.tangent.z);
    qa.updateCornerHint(player);
    if (getComputedStyle(hintEl).display === 'none' || !hintEl.classList.contains('warn-ramp')) {
      failures.push('ramp warning did not activate');
    }

    // Verify lap split timing and telemetry stats initialization & updates
    if (!Array.isArray(player.lapTimes) || !player.stats || typeof player.stats.driftCount !== 'number') {
      failures.push('missing player telemetry fields');
    }
    const prevBoosts = player.stats.boostCount;
    qa.spawnItemEffect(player, 'nitro');
    if (player.stats.boostCount !== prevBoosts + 1) failures.push('nitro item did not increment boostCount');

    player.checkpoint = 1;
    player.sampleIdx = 595;
    player.speed = 0;
    player.pos.copy(qa.samples[2].pos);
    player.heading = Math.atan2(qa.samples[2].tangent.x, qa.samples[2].tangent.z);
    qa.stepRacer(player, 1/60, 1);
    const toast1 = document.getElementById('toastText').textContent;
    if (player.lap !== 2 || player.lapTimes.length !== 1 || !toast1.includes('1')) {
      failures.push(`lap 1 split failed: lap=${player.lap}, len=${player.lapTimes.length}, toast=${toast1}`);
    }
    player.checkpoint = 1;
    player.sampleIdx = 595;
    player.pos.copy(qa.samples[2].pos);
    qa.stepRacer(player, 1/60, 2);
    const toast2 = document.getElementById('toastText').textContent;
    if (player.lap !== 3 || player.lapTimes.length !== 2 || !toast2.includes('2') || !toast2.includes('🔔')) {
      failures.push(`lap 2 split/final lap failed: lap=${player.lap}, len=${player.lapTimes.length}, toast=${toast2}`);
    }

    // Simulate race finish and verify #resultStats telemetry & rating badge
    player.lapTimes = [24.5, 23.8, 23.2];
    player.stats = { driftCount: 6, boostCount: 5, trickCount: 2, hitCount: 2 };
    qa.finishRace();
    const resultStats = document.getElementById('resultStats');
    const badge = resultStats?.querySelector('.rating-badge');
    const cards = resultStats?.querySelectorAll('.tel-card') || [];
    if (qa.state !== 'finished') failures.push('state did not become finished');
    if (getComputedStyle(hintEl).display !== 'none') failures.push('corner hint visible after finish');
    if (!badge || !['S', 'A', 'B', 'C'].includes(badge.textContent.trim())) failures.push('missing or invalid rating badge');
    if (cards.length !== 4 || !resultStats.textContent.includes('00:23.20')) failures.push('missing telemetry metrics or best lap');

    qa.backToMenu();
    if (qa.state !== 'menu') failures.push('backToMenu did not reset state');
    return failures;
  });
  assert.deepEqual(telemetryCheck, [], `telemetry check: ${telemetryCheck.join(', ')}`);

  let simNow = await page.evaluate(() => performance.now() + 200);
  await page.evaluate(() => { qa.startRace(); });
  assert.equal(await page.evaluate(() => qa.state), 'countdown');
  simNow = await page.evaluate((startNow) => {
    let t = startNow;
    for (let i = 0; i < 45; i++) { t += 40; qa.animate(t); }
    return t;
  }, simNow);
  await page.keyboard.down('KeyW');
  const rocketCheck = await page.evaluate((startNow) => {
    let t = startNow;
    for (let i = 0; i < 40; i++) { t += 40; qa.animate(t); }
    const p = qa.racers[0];
    return { t, state: qa.state, rev: p.startRevCharge, overheated: p.startOverheated, boost: p.boostTimer, speed: p.speed };
  }, simNow);
  await page.keyboard.up('KeyW');
  simNow = rocketCheck.t;
  assert.equal(rocketCheck.state, 'racing');
  assert.equal(rocketCheck.overheated, false);
  assert.ok(rocketCheck.boost > 1.0 && rocketCheck.speed >= 20, `rocket start failed: ${JSON.stringify(rocketCheck)}`);

  await page.evaluate(() => { qa.startRace(); });
  await page.keyboard.down('KeyW');
  const overheatCheck = await page.evaluate((startNow) => {
    let t = startNow;
    for (let i = 0; i < 85; i++) { t += 40; qa.animate(t); }
    const p = qa.racers[0];
    return { t, state: qa.state, rev: p.startRevCharge, overheated: p.startOverheated, stun: p.stunTimer, speed: p.speed };
  }, simNow);
  await page.keyboard.up('KeyW');
  assert.equal(overheatCheck.state, 'racing');
  assert.equal(overheatCheck.overheated, true);
  assert.ok(overheatCheck.stun > 0 && overheatCheck.speed < 10, `overheat start failed: ${JSON.stringify(overheatCheck)}`);

  await page.keyboard.down('ArrowUp');
  const wallSlideResults = await page.evaluate(() => {
    qa.track = 0; qa.startRace(); qa.state = 'racing';
    const out = [];
    for (const wallSide of [1, -1]) {
      const r = qa.racers[0];
      const sIdx = 20;
      const s = qa.samples[sIdx];
      const trackYaw = Math.atan2(s.tangent.x, s.tangent.z);
      r.pos.copy(s.pos).addScaledVector(s.right, wallSide * (9.2 - 1.22 - 0.1));
      r.sampleIdx = sIdx;
      r.heading = trackYaw - wallSide * (35 * Math.PI / 180);
      r.speed = 36; r.wallHitCooldown = 0; r.lateralVel = 0; r.boostTimer = 0;
      r.airY = 0; r.airVy = 0; r.stunTimer = 0; r.bubbleTimer = 0;
      const initialErr = Math.abs(qa.wrapAngle(r.heading - trackYaw));
      const outwardDir = Math.sin(r.heading) * s.right.x + Math.cos(r.heading) * s.right.z;
      for (let f = 0; f < 15; f++) qa.stepRacer(r, 1 / 60, 10 + f / 60);
      const ns = qa.samples[r.sampleIdx];
      const finalYaw = Math.atan2(ns.tangent.x, ns.tangent.z);
      const finalErr = Math.abs(qa.wrapAngle(r.heading - finalYaw));
      const finalLat = r.pos.clone().sub(ns.pos).dot(ns.right);
      out.push({ wallSide, outwardSign: Math.sign(outwardDir), speed: r.speed, initialErr, finalErr, finalLat });
    }
    const a = qa.racers[0], b = qa.racers[1];
    const s = qa.samples[20];
    const ty = Math.atan2(s.tangent.x, s.tangent.z);
    a.pos.copy(s.pos); a.sampleIdx = 20; a.heading = ty; a.speed = 38; a.lateralVel = 0;
    b.pos.copy(s.pos).addScaledVector(s.tangent, 1.4); b.sampleIdx = 20; b.heading = ty; b.speed = 20; b.lateralVel = 0;
    qa.resolveKartCollisions();
    const bumpGap = b.pos.distanceTo(a.pos);
    return { walls: out, bump: { speedA: a.speed, speedB: b.speed, gap: bumpGap } };
  });
  await page.keyboard.up('ArrowUp');
  for (const w of wallSlideResults.walls) {
    assert.equal(w.outwardSign, w.wallSide, `wall test setup must point outward (side ${w.wallSide})`);
    assert.ok(w.speed > 36 * 0.70, `wall slide must retain >70% speed on side ${w.wallSide}, got ${w.speed.toFixed(2)}`);
    assert.ok(w.finalErr < w.initialErr * 0.5, `wall slide must steer heading toward tangent on side ${w.wallSide}: ${w.initialErr.toFixed(3)} -> ${w.finalErr.toFixed(3)}`);
    assert.ok(Math.abs(w.finalLat) <= 9.2 - 1.22 + 0.05, `racer must stay inside guardrail on side ${w.wallSide}, got lat=${w.finalLat.toFixed(3)}`);
  }
  assert.ok(wallSlideResults.bump.speedA < 38 && wallSlideResults.bump.speedA > 28, `rear bump must transfer gentle impulse to trailing kart, got ${wallSlideResults.bump.speedA.toFixed(2)}`);
  assert.ok(wallSlideResults.bump.speedB > 20, `rear bump must push lead kart forward, got ${wallSlideResults.bump.speedB.toFixed(2)}`);
  assert.ok(wallSlideResults.bump.gap > 1.4, `kart collision must separate overlapping karts, got gap=${wallSlideResults.bump.gap.toFixed(3)}`);
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log(`PASS wall-slide (${wallSlideResults.walls.map(w=>`side=${w.wallSide} spd=${w.speed.toFixed(1)} err=${w.initialErr.toFixed(2)}->${w.finalErr.toFixed(2)}`).join('; ')}) & bump (${wallSlideResults.bump.speedA.toFixed(1)}/${wallSlideResults.bump.speedB.toFixed(1)})`);
  console.log(`PASS repeated scene disposal: ${JSON.stringify(memory)}; mobile menu/start; corner hint & telemetry; no browser errors`);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

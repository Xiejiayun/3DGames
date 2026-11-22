import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const source = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const three = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const {version} = JSON.parse(await readFile(join(three, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const output = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'landscape-legends');
if (output) await mkdir(output, {recursive:true});

function installLegendProbe() {
  const nativeFrame = requestAnimationFrame.bind(window), textRuns = new WeakMap(), paints = new WeakMap(), originals = new WeakMap();
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeFrame(callback);
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function(text, left, baseline, ...rest) {
    if (/^(系统|推力|SYS|THR|SYS \/ BUS|ENG \/ THR|SYSTEMS|ENGINE|F-22X|SU-57X|F-35X)$/.test(text)) {
      const ink = this.measureText(text), transform = this.getTransform();
      const topLeft = transform.transformPoint({x:left-ink.actualBoundingBoxLeft, y:baseline-ink.actualBoundingBoxAscent});
      const bottomRight = transform.transformPoint({x:left+ink.actualBoundingBoxRight, y:baseline+ink.actualBoundingBoxDescent});
      if (!textRuns.has(this.canvas)) textRuns.set(this.canvas, new Map());
      textRuns.get(this.canvas).set(text, [topLeft.x, topLeft.y, bottomRight.x, bottomRight.y]);
      paints.set(this.canvas, (paints.get(this.canvas) ?? 0) + 1);
    }
    return fillText.call(this, text, left, baseline, ...rest);
  };
  function project(screen, horizontal, vertical) {
    const {index, attributes:{position,uv}} = screen.geometry;
    const sample = new THREE.Vector3(horizontal, 1-vertical, 0), weights = new THREE.Vector3();
    for (let face = 0; face < index.count; face += 3) {
      const ids = [0,1,2].map(offset => index.getX(face + offset));
      const corners = ids.map(id => new THREE.Vector3(uv.getX(id), uv.getY(id), 0));
      THREE.Triangle.getBarycoord(sample, ...corners, weights);
      if (Math.min(weights.x,weights.y,weights.z) < -1e-6) continue;
      const point = new THREE.Vector3();
      ids.forEach((id,corner) => point.addScaledVector(new THREE.Vector3().fromBufferAttribute(position,id), weights.getComponent(corner)));
      return screen.localToWorld(point).project(camera);
    }
    throw new Error('Glyph projected outside the instrument mesh');
  }
  function read() {
    const cabin = player.mesh.userData.cockpit, screen = cabin.getObjectByName('Instruments'), map = screen.material.map;
    const image = map.image, {width,height} = image, ctx = image.getContext('2d');
    if (!originals.has(screen)) originals.set(screen,image);
    const pixels = ctx.getImageData(0,0,width,height).data;
    function checksum(start) {
      let hash = 2166136261;
      for (let pixel = start; pixel < pixels.length; pixel++) hash = Math.imul(hash ^ pixels[pixel],16777619);
      return hash >>> 0;
    }
    const meshes = [], ray = new THREE.Raycaster(); cabin.traverseVisible(node => { if (node.isMesh) meshes.push(node); });
    const solids = meshes.filter(node => !node.material.transparent);
    const first = point => { ray.setFromCamera(point,camera); return ray.intersectObjects(solids,false)[0]?.object; };
    const code = JETS[selJetIdx].code, expected = [lang==='zh'?'系统':'SYS',code,lang==='zh'?'推力':'THR'];
    const runs = textRuns.get(image) ?? new Map();
    const legends = expected.map((wanted,pane) => {
      const text = [wanted,...[['SYS / BUS','SYSTEMS'],[],['ENG / THR','ENGINE']][pane]].find(label => runs.has(label));
      if (!text) return {text:null,inkPx:0};
      const [left,top,right,bottom] = runs.get(text), mid = (left+right)/(2*width);
      const luminance = offset => {
        const linear = channel => {const value = pixels[offset+channel]/255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;};
        return 0.2126*linear(0) + 0.7152*linear(1) + 0.0722*linear(2);
      };
      const rows = [];
      for (let row=Math.floor(top);row<Math.ceil(bottom);row++) {
        const values=[];
        for(let col=Math.floor(left);col<Math.ceil(right);col++) values.push(luminance((row*width+col)*4));
        rows.push(values);
      }
      const levels=rows.flat().sort((first,second)=>first-second), background=levels[Math.floor(levels.length*0.05)];
      const contrast=(levels[Math.floor(levels.length*0.95)]+0.05)/(background+0.05);
      let inkPx=0;
      rows.forEach((values,row)=>{
        if(values.filter(value=>(value+0.05)/(background+0.05)>=4.5).length<2) return;
        const upper=(Math.floor(top)+row)/height;
        inkPx+=Math.abs(project(screen,mid,upper).y-project(screen,mid,upper+1/height).y)*innerHeight/2;
      });
      const center=project(screen,mid,(top+bottom)/(2*height)), hit=first(center);
      return {text,inkPx:+inkPx.toFixed(2),contrast:+contrast.toFixed(1),visible:hit===screen || hit?.parent===screen,
        inPane:left>=pane*width/3 && right<=(pane+1)*width/3 && top>=0 && bottom<=height*0.35};
    });
    return {code,lang,quality,mode,width:innerWidth,height:innerHeight,expected,legends,map:map.uuid,geometry:meshes.map(node=>node.geometry.uuid).sort(),
      original:image===originals.get(screen),version:map.version,paints:paints.get(image),art:checksum(0),gauges:checksum(Math.ceil(height*0.32)*width*4),
      eye:cabin.getWorldPosition(new THREE.Vector3()).distanceTo(camera.position),heading:camera.quaternion.angleTo(player.quat),
      clear:[-0.18,0,0.18].every(horizontal=>[-0.12,0,0.12].every(vertical=>!first({x:horizontal,y:vertical}))),fov:camera.fov,power:cabin.userData.powerBar.scale.x,throttle:player.throttle};
  }
  window.legendQA = {read,async frames(count=1) {
    await new Promise(nativeFrame);
    let draws=0; const restore=[];
    player.mesh.userData.cockpit.traverse(node=>{
      if(!node.isMesh) return;
      const original=node.onAfterRender;
      node.onAfterRender=function(...args){if(args[4]===node.material) draws++;original.apply(this,args);};
      restore.push(()=>{node.onAfterRender=original;});
    });
    try {for(let frame=0;frame<count;frame++){draws=0;animate(lastTime+1000/60);}return draws;}
    finally {restore.forEach(reset=>reset());}
  }};
}

const fixture=source.replace(/\/\/ Boot\r?\ntry \{/,()=>`(${installLegendProbe})();\n// Boot\ntry {`);
assert.notEqual(fixture,source);
const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const observations=[];
try {
  const page=await browser.newPage({viewport:{width:1280,height:720},hasTouch:true,isMobile:true,deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
    const target=route.request().url();if(target===url)return route.fulfill({body:fixture,contentType:'text/html; charset=utf-8'});
    const file=resolve(three,target.slice(prefix.length));
    if(target.startsWith(prefix)&&file.startsWith(three+sep)&&file.endsWith('.js'))return route.fulfill({path:file,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
    errors.push(target);return route.abort();
  });
  await page.goto(url);await page.waitForFunction(()=>window.legendQA&&window.__ACE_DEBUG__);
  const tap=selector=>page.locator(selector).tap(), frames=count=>page.evaluate(count=>legendQA.frames(count),count);
  const resize=(width,height)=>page.setViewportSize({width,height});
  async function record(name) {
    const draws=await frames(2), result=await page.evaluate(()=>legendQA.read());
    observations.push({name,draws,...result});
    if(output)await page.screenshot({path:join(output,`${name}.png`)});
    return {...result,draws};
  }
  function compact(result,reference) {
    assert.ok(result.legends.every(label=>label.inkPx>=7.5),`${result.code} ${result.width}×${result.height}: ${JSON.stringify(result.legends)}`);
    assert.deepEqual(result.legends.map(label=>label.text),result.expected);
    assert.ok(result.legends.every(label=>label.contrast>=4.5 && label.inPane && label.visible),'Complete, contrasting text on the visible faces');
    assert.ok(result.eye<1e-5 && result.heading<1e-5 && result.clear && result.fov>=69 && result.fov<=75.01);
    assert.equal(result.original,true);assert.equal(result.map,reference.map);assert.deepEqual(result.geometry,reference.geometry);
    assert.equal(result.gauges,reference.gauges);assert.equal(result.draws,reference.draws);assert.ok(result.draws>0 && result.draws<=5);
    assert.notEqual(result.art,reference.art);
  }
  await tap('#qualBtn');await tap('#qualBtn');
  for(const [index,code] of ['F-22X','SU-57X','F-35X'].entries()) {
    await resize(1280,720);if(index)await tap('#qualBtn');
    await tap(`[data-jet="${index}"]`);await tap('#sortieBtn');await page.keyboard.press('v');
    const desktop=await record(`${code}-desktop`);assert.equal(desktop.code,code);assert.equal(desktop.quality,['low','high','med'][index]);
    await resize(390,844);const portrait=await record(`${code}-portrait`);
    await resize(568,320);const phone=await record(`${code}-568`);compact(phone,desktop);
    await frames(4);await resize(620,345);await frames(2);const steady=await page.evaluate(()=>legendQA.read());
    assert.equal(steady.paints,phone.paints,'Steady flight and same-layout resizes must not repaint the titles');
    assert.equal(steady.version,phone.version,'Steady flight and same-layout resizes must not re-upload the atlas');
    await tap('#pauseBtn');await tap('#langBtn');await tap('#btnResume');
    await resize(667,375);const translated=await record(`${code}-667`);compact(translated,desktop);
    assert.notEqual(translated.lang,phone.lang);assert.notEqual(translated.art,phone.art);
    if(!index){
      await resize(480,300);await page.keyboard.down('w');await frames(24);await page.keyboard.up('w');
      const boost=await record('480-boost');compact(boost,desktop);
      assert.ok(boost.power>phone.power+0.15 && Math.abs(boost.power-boost.throttle)<1e-6);
      await resize(844,390);compact(await record('844-landscape'),desktop);
    }
    await tap('#pauseBtn');await tap('#langBtn');await resize(390,844);await tap('#btnResume');
    const rotated=await record(`${code}-portrait-restored`);assert.equal(rotated.art,portrait.art);assert.equal(rotated.map,desktop.map);
    await resize(1280,720);const restored=await record(`${code}-desktop-restored`);assert.equal(restored.art,desktop.art);assert.ok(restored.original);
    await tap('#pauseBtn');await tap('#btnHangar');
  }
  await resize(568,320);await tap('[data-jet="1"]');await tap('#sortieBtn');await tap('[data-flight="view"]');
  const direct=await record('568-direct-entry');await resize(1280,720);
  compact(direct,await record('direct-entry-restored'));assert.equal(direct.code,'SU-57X');
  assert.deepEqual(errors,[]);
} finally {
  await browser.close();if(output)await writeFile(join(output,'measurements.json'),JSON.stringify(observations,null,2));
}

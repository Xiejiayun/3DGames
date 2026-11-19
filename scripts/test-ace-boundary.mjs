import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const game = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const modules = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const {version} = JSON.parse(await readFile(join(modules, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const evidence = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'boundary');
if (evidence) await mkdir(evidence, {recursive:true});

function installBoundaryFixture() {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeFrame(callback);
  lastTime = 0;
  function read() {
    return { time:missionTimer, mode, pos:player.pos.toArray(), speed:player.speed, hp:player.hp,
      forward:new THREE.Vector3(0,0,-1).applyQuaternion(player.quat).toArray(),
      label:document.getElementById('objMission').textContent };
  }
  window.boundaryQA = {
    read,
    step(frames, ms) {
      if (composer) throw new Error('Fixed-step check requires low quality');
      const render = renderer.render, samples = [];
      renderer.render = (world, view) => view.updateMatrixWorld();
      try {
        for (let frame = 0; frame < frames; frame++) { animate(lastTime + ms); samples.push(read()); }
      } finally { renderer.render = render; }
      return samples;
    },
    paint() { renderer.render(scene, camera); drawHUD(); },
    // Controlled physics cases only; the two first sorties never use this setup.
    place({jet = 0, radius, altitude, bearing = 0, offset = 0, pitch = 0}) {
      window.__ACE_DEBUG__.startMission(0, jet);
      player.pos.set(radius * Math.sin(bearing), altitude, -radius * Math.cos(bearing));
      player.quat.setFromEuler(new THREE.Euler(pitch, -bearing - offset, 0, 'YXZ'));
      return read();
    }
  };
}
const fixture = game.replace(/\/\/ Boot\r?\ntry \{/, () => `(${installBoundaryFixture})();\n// Boot\ntry {`);
assert.notEqual(fixture, game, 'Expected the Ace boot entry');
const radius = sample => Math.hypot(sample.pos[0], sample.pos[2]);

function checkArc(samples, warning, assist) {
  const began = samples.findIndex(sample => sample.label === assist);
  const peak = samples.reduce((best, sample) => radius(sample) > radius(best) ? sample : best);
  const back = samples.find(sample => sample.time > peak.time && radius(sample) < 3200);
  assert.ok(back, `Aircraft never returned inside 3200 m; peak ${radius(peak).toFixed(1)} m, last ${radius(samples.at(-1)).toFixed(1)} m`);
  const notice = samples.find(sample => sample.label === warning);
  assert.ok(notice && began > 0 && notice.time < samples[began].time);
  assert.ok(radius(peak) < 4599, 'An unsteered sortie must turn before ever clipping the perimeter');
  assert.equal(back.label, samples[0].label, 'Hand back the mission label after re-entry');
  let maxYaw = 0, distance = 0;
  for (let index = 1; index < samples.length; index++) {
    const sample = samples[index], previous = samples[index - 1];
    assert.equal(sample.mode, 'playing');
    assert.ok(Math.abs(sample.pos[1] - samples[0].pos[1]) < 0.001, 'Hands-off level flight lost height');
    const length = Math.hypot(sample.pos[0] - previous.pos[0], sample.pos[2] - previous.pos[2]);
    assert.ok(Math.abs(length - sample.speed * (sample.time - previous.time)) < 0.01, 'Displayed speed must represent actual travel throughout the turn');
    distance += length;
    const dot = sample.forward.reduce((sum, component, axis) => sum + component * previous.forward[axis], 0);
    maxYaw = Math.max(maxYaw, Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
  }
  assert.ok(maxYaw < 5, `Unexpected single-frame aircraft heading change: ${maxYaw} degrees`);
  return {warning:notice.time, assisting:samples[began].time, peakRadius:radius(peak), back:back.time, altitude:back.pos[1], maxYaw, distance};
}

const browser = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
async function fly(touch) {
  const page = await browser.newPage({viewport:touch ? {width:568,height:320} : {width:960,height:540}, hasTouch:touch, isMobile:touch, deviceScaleFactor:1});
  const errors = [], driver = touch ? 'touch-cockpit-zh' : 'keyboard-chase-en';
  const warning = touch ? '空域边缘 · 请掉头' : 'Airspace edge · turn back';
  const assist = touch ? '正在辅助掉头 · 仍可转向' : 'Turning back · you can steer';
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    const request = route.request().url();
    if (request === url) return route.fulfill({body:fixture, contentType:'text/html; charset=utf-8'});
    const file = resolve(modules, request.slice(prefix.length));
    if (request.startsWith(prefix) && file.startsWith(modules + sep) && file.endsWith('.js'))
      return route.fulfill({path:file, contentType:'text/javascript', headers:{'Access-Control-Allow-Origin':'*'}});
    errors.push(`Unexpected request: ${request}`); return route.abort();
  });
  await page.addInitScript(seed => { Math.random = () => ((seed = (Math.imul(seed,1664525) + 1013904223) >>> 0) / 4294967296); }, touch ? 207 : 206);
  const act = selector => touch ? page.locator(selector).tap() : page.locator(selector).click();
  const step = (frames, ms = 50) => page.evaluate(([count, delta]) => boundaryQA.step(count, delta), [frames, ms]);
  const place = data => page.evaluate(options => boundaryQA.place(options), data);
  async function capture(name) {
    const clear = await page.locator('#objMission').evaluate(label => {
      const box = label.getBoundingClientRect();
      return label.checkVisibility() && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom < innerHeight / 2 &&
        ['#pauseBtn','#radarWrap','#weaponPanel','#touchControls'].every(selector => {
          const element = document.querySelector(selector), other = element.getBoundingClientRect();
          return !element.checkVisibility() || other.left >= box.right || other.right <= box.left || other.top >= box.bottom || other.bottom <= box.top;
        });
    });
    assert.ok(clear, 'Edge message must not cover the reticle, readouts or controls');
    if (evidence) {
      await page.evaluate(() => boundaryQA.paint());
      await page.screenshot({path:join(evidence, `${driver}-${name}.png`)});
    }
  }
  try {
    await page.goto(url); await page.waitForFunction(() => window.boundaryQA && window.__ACE_DEBUG__);
    if (!touch) await act('#langBtn');
    await act('#qualBtn'); await act('#qualBtn'); await act('#sortieBtn');
    if (touch) await act('[data-flight="view"]');
    const session = touch && await page.context().newCDPSession(page);
    if (touch) {
      const box = await page.locator('[data-flight="boost"]').boundingBox();
      await session.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:box.x + box.width / 2,y:box.y + box.height / 2,id:1}]});
    } else await page.keyboard.down('w');
    const trace = [await page.evaluate(() => boundaryQA.read())], seen = new Set();
    try {
      for (let group = 0; group < 72; group++) {
        trace.push(...await step(10));
        const current = trace.at(-1);
        if ([warning, assist].includes(current.label) && !seen.has(current.label)) {
          seen.add(current.label); await capture(current.label === assist ? 'turning' : 'approach');
        }
        if (current.mode !== 'playing' || (seen.has(assist) && radius(current) < 3150)) break;
      }
    } finally {
      if (touch) await session.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
      else await page.keyboard.up('w');
    }
    const result = checkArc(trace, warning, assist);
    assert.ok(result.assisting - result.warning >= 1.75 && trace.at(-1).speed > 294, 'Give a full-speed pilot time to turn voluntarily');
    console.log(`PASS ${driver}: ${JSON.stringify(result)}`);
    if (evidence) await writeFile(join(evidence, `${driver}.json`), JSON.stringify({result,trace}));
    if (!touch) {
      for (const [jet, bearing, offset, altitude, ms] of [[1,0.93,-0.18,1480,1000/60],[2,-1.73,0.31,560,1000/30]]) {
        const start = await place({jet, radius:3200, bearing, offset, altitude});
        await page.keyboard.down('w');
        const samples = await step(Math.ceil(14000 / ms), ms); await page.keyboard.up('w');
        console.log(`PASS placed jet ${jet} at ${altitude} m: ${JSON.stringify(checkArc([start,...samples], warning, assist))}`);
      }
      for (const [key, side] of [['ArrowLeft',-1],['ArrowRight',1]]) {
        const early = await place({radius:3510, altitude:1000}); await page.keyboard.down(key);
        const voluntary = [];
        const inward = sample => sample.forward[0] * sample.pos[0] + sample.forward[2] * sample.pos[2] < -0.7 * radius(sample) * Math.hypot(sample.forward[0], sample.forward[2]);
        do { voluntary.push(...await step(2)); } while (voluntary.length < 60 && !inward(voluntary.at(-1)));
        await page.keyboard.up(key); assert.ok(inward(voluntary.at(-1)), `Did not turn back manually with ${key}`);
        assert.equal(voluntary[0].label, warning); assert.equal(voluntary.at(-1).label, early.label);
        assert.ok(!voluntary.some(sample => sample.label === assist), 'Do not take over a voluntary return');
        await place({radius:4070, altitude:850}); await page.keyboard.down(key);
        const inputs = await step(8); await page.keyboard.up(key);
        assert.equal(inputs[0].label, assist); assert.ok(side * inputs.at(-1).forward[0] > 0.4, `Pilots can choose ${key} at the edge`);
      }
      await place({radius:4350, altitude:510, pitch:0.2});
      const [climb] = await step(1);
      assert.equal(climb.label, assist); assert.ok(Math.abs(climb.pos[1] - 510 - Math.sin(0.2) * climb.speed * 0.05) < 1e-6);
      await place({radius:4599, altitude:700, pitch:0.2}); const [limit] = await step(1);
      assert.ok(Math.abs(radius(limit) - 4600) < 1e-6); assert.ok(Math.abs(limit.pos[1] - 700 - Math.sin(0.2) * limit.speed * 0.05) < 1e-6);
      await place({radius:4350, altitude:1649, pitch:0.35}); assert.equal((await step(1))[0].pos[1], 1650);
      await place({radius:4350, altitude:28}); const [low] = await step(1);
      assert.equal(low.label, assist); assert.equal(await page.locator('#alertBanner').innerText(), 'LOW ALTITUDE · PULL UP');
      assert.ok(await page.locator('#alertBanner').isVisible());
      await act('#pauseBtn'); await act('#langBtn'); const [paused] = await step(2);
      assert.equal(paused.mode, 'paused'); assert.equal(paused.time, low.time); assert.deepEqual(paused.pos, low.pos);
      await act('#btnResume'); assert.equal((await step(1))[0].label, '正在辅助掉头 · 仍可转向');
      await act('#pauseBtn'); await act('#btnRestart'); const [retry] = await step(1);
      assert.equal(retry.mode, 'playing'); assert.equal(retry.pos[1], 250); assert.match(retry.label, /晴空/);
    }
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
}
try { await fly(false); await fly(true); } finally { await browser.close(); }

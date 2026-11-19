import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Euler, Quaternion } from 'three';

const html = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const modules = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const {version} = JSON.parse(await readFile(join(modules, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const evidence = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'level-turns');
if (evidence) await mkdir(evidence, {recursive:true});

function installTurnFixture() {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeFrame(callback);
  lastTime = 0;
  function read() {
    const angles = new THREE.Euler().setFromQuaternion(player.quat, 'YXZ');
    return {time:missionTimer, mode, view:cameraMode, pos:player.pos.toArray(), hp:player.hp, grace:player.terrainGrace,
      quat:player.quat.toArray(), heading:-angles.y, pitch:angles.x, bank:angles.z, stick:[stick.x,stick.y],
      rates:[player.pitchRate,player.yawRate,player.rollRate], speed:player.speed};
  }
  window.turnQA = {read, aim:() => [aim.x,aim.y],
    step(frames, ms) {
      if (composer) throw new Error('Fixed-step check requires low quality');
      const render = renderer.render, samples = [];
      renderer.render = (world, view) => view.updateMatrixWorld();
      try { for (let frame = 0; frame < frames; frame++) { animate(lastTime + ms); samples.push(read()); } }
      finally { renderer.render = render; }
      return samples;
    },
    paint() { renderer.render(scene, camera); drawHUD(); },
    // Only the attitude/isolation cases set a starting pose; first sorties use the real hangar.
    pose(jet, pitch, bank) {
      window.__ACE_DEBUG__.startMission(0, jet);
      player.pos.set(0, 900, 1400); player.quat.setFromEuler(new THREE.Euler(pitch, 0.4, bank, 'YXZ'));
      return read();
    }
  };
}
const fixture = html.replace(/\/\/ Boot\r?\ntry \{/, () => `(${installTurnFixture})();\n// Boot\ntry {`);
assert.notEqual(fixture, html, 'Expected the Ace game boot entry');
const step = (page, frames, ms = 50) => page.evaluate(([count, delta]) => turnQA.step(count, delta), [frames,ms]);
const pose = (page, jet, pitch, bank) => page.evaluate(args => turnQA.pose(...args), [jet,pitch,bank]);
const state = page => page.evaluate(() => turnQA.read());
const traces = {};
async function shot(page, name) {
  if (!evidence) return;
  await page.evaluate(() => turnQA.paint()); await page.screenshot({path:join(evidence, `${name}.png`)});
}
function checkTurn(samples, side, minimumTurn) {
  const start = samples[0], end = samples.at(-1), altitudes = samples.map(sample => sample.pos[1]);
  assert.ok(Math.max(...altitudes) - Math.min(...altitudes) < 0.01, `Pure horizontal input changed altitude: ${start.pos[1]} → ${end.pos[1]}`);
  assert.ok(samples.every(sample => sample.mode === 'playing' && sample.hp === start.hp && !sample.grace && Math.abs(sample.stick[1]) < 0.001));
  let turn = 0;
  for (let index = 1; index < samples.length; index++) {
    const delta = samples[index].heading - samples[index - 1].heading;
    turn += Math.atan2(Math.sin(delta), Math.cos(delta));
  }
  assert.ok(side * turn > minimumTurn && samples.some(sample => -side * sample.bank > 0.35), 'Holding the input must visibly bank and turn, not freeze the plane');
  const result = {altitude:end.pos[1], hp:end.hp, turnDegrees:Math.round(turn * 180 / Math.PI)};
  return result;
}
function checkBodyAxes(start, samples, ms) {
  const expected = new Quaternion().fromArray(start.quat), increment = new Quaternion(), angles = new Euler(0,0,0,'YXZ');
  for (const sample of samples) {
    angles.set(...sample.rates.map(rate => rate * ms / 1000));
    expected.multiply(increment.setFromEuler(angles)).normalize();
    assert.ok(expected.angleTo(new Quaternion().fromArray(sample.quat)) < 1e-6, 'Classic/manual-roll rotation diverged from the legacy body-axis trajectory');
  }
  assert.ok(samples.some(sample => Math.abs(sample.rates[1]) > 0.6 && Math.abs(sample.bank) > 0.4));
}

const browser = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
async function fly(touch) {
  const page = await browser.newPage({viewport:touch ? {width:390,height:844} : {width:960,height:540}, hasTouch:touch,isMobile:touch,deviceScaleFactor:1});
  const errors = [], act = selector => touch ? page.locator(selector).tap() : page.locator(selector).click();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    const request = route.request().url();
    if (request === url) return route.fulfill({body:fixture,contentType:'text/html; charset=utf-8'});
    const file = resolve(modules, request.slice(prefix.length));
    if (request.startsWith(prefix) && file.startsWith(modules + sep) && file.endsWith('.js'))
      return route.fulfill({path:file,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
    errors.push(`Unexpected request: ${request}`); return route.abort();
  });
  await page.addInitScript(seed => { Math.random = () => ((seed = (Math.imul(seed,1664525) + 1013904223) >>> 0) / 4294967296); }, touch ? 207 : 206);
  try {
    await page.goto(url); await page.waitForFunction(() => window.turnQA && window.__ACE_DEBUG__);
    await act('#qualBtn'); await act('#qualBtn'); await act('#sortieBtn');
    const session = touch && await page.context().newCDPSession(page);
    for (const side of [-1,1]) {
      if (side === 1) { await act('#pauseBtn'); await act('#btnRestart'); }
      if (touch) await act('[data-flight="view"]');
      const key = side < 0 ? 'ArrowLeft' : 'ArrowRight', name = `${touch ? 'touch-cockpit' : 'keyboard-chase'}-${side < 0 ? 'left' : 'right'}`;
      const trace = [await state(page)];
      if (touch) {
        const point = {id:1,x:190,y:400};
        await session.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]});
        await session.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{...point,x:point.x + side * 56}]});
        await page.waitForFunction(sign => turnQA.aim()[0] * sign > 0.99, side);
      } else await page.keyboard.down(key);
      trace.push(...await step(page, 40));
      const result = checkTurn(trace, side, 2.4); assert.equal(trace.at(-1).view, touch ? '1p' : '3p'); await shot(page, name);
      if (touch) {
        await session.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
        await page.waitForFunction(() => turnQA.aim()[0] === 0);
      } else await page.keyboard.up(key);
      trace.push(...await step(page, 24)); checkTurn(trace, side, 2.4);
      assert.ok(Math.abs(trace.at(-1).bank) < 0.04 && Math.abs(trace.at(-1).rates[1]) < 0.01, 'Released steering settles without an extra input');
      traces[name] = {result,trace}; console.log(`PASS ${name}: ${JSON.stringify(result)}`);
    }
    if (!touch) {
      await act('#pauseBtn'); await act('#btnRestart'); await page.mouse.move(820,270);
      const mouse = await step(page, 90, 1000/60); checkTurn(mouse, 1, 0.9); await page.mouse.move(480,270);
      for (const [jet, pitch, bank, ms] of [[1,0.28,-0.73,1000/60],[2,-0.23,0.64,1000/30],[0,1.54,0.7,50]]) {
        const start = await pose(page, jet, pitch, bank); await page.keyboard.down('ArrowLeft');
        const samples = await step(page, Math.round(1000/ms), ms); await page.keyboard.up('ArrowLeft');
        const travel = samples.reduce((sum, sample) => sum + sample.speed * ms / 1000, 0);
        assert.ok(samples.every(sample => Math.abs(sample.pitch - pitch) < 1e-5), 'A horizontal turn preserves an intentional flight-path angle, even near vertical');
        assert.ok(Math.abs(samples.at(-1).pos[1] - start.pos[1] - travel * Math.sin(pitch)) < 0.001, 'No altitude clamp may hide a climb/dive');
      }
      for (const [physical, manual] of [['classic',false],['comfort',true]]) {
        await act('#pauseBtn'); await page.locator('#steeringResponse').selectOption(physical); await act('#btnResume');
        const start = await pose(page, 0, 0.18, 0.59); await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowUp');
        if (manual) await page.keyboard.down('a'); const samples = await step(page, 20, 1000/30);
        if (manual) await page.keyboard.up('a'); await page.keyboard.up('ArrowUp'); await page.keyboard.up('ArrowRight');
        checkBodyAxes(start, samples, 1000/30);
      }
      await act('#pauseBtn'); await act('#langBtn'); assert.equal(await page.getByLabel('Steering response').inputValue(), 'comfort');
      await act('#btnRestart'); await page.keyboard.down('ArrowDown'); const dive = await step(page, 60); await page.keyboard.up('ArrowDown');
      assert.ok(dive.some(sample => sample.grace > 0 && sample.hp < 115), 'An intentional dive still triggers terrain damage');
      console.log('PASS mouse, inclined flight at 20/30/60 Hz, original classic/manual roll orientation, intentional terrain contact and restart');
    }
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
}
try { await fly(false); await fly(true); if (evidence) await writeFile(join(evidence,'sorties.json'), JSON.stringify(traces)); }
finally { await browser.close(); }

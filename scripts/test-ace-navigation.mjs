import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const game = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const modules = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const {version} = JSON.parse(await readFile(join(modules, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`, url = 'http://127.0.0.1/games/ace.html';
const evidence = process.env.ACE_SCREENSHOTS && resolve(process.env.ACE_SCREENSHOTS, 'navigation');
if (evidence) await mkdir(evidence, {recursive:true});

function installNavigationFixture() {
  lastTime = 0;
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => callback === animate ? 0 : nativeFrame(callback);
  function state() {
    const target = player.primaryTarget?.alive ? player.primaryTarget : null, point = target?.pos.clone().project(camera);
    const cue = document.getElementById('contactCue');
    const visible = !!point && point.z >= -1 && point.z < 1 && Math.abs(point.x) < 1 - 40 / innerWidth && Math.abs(point.y) < 1 - 40 / innerHeight;
    return { time:+missionTimer.toFixed(2), kills:missionKills, defeated:enemies.flatMap((enemy, index) => enemy.alive ? [] : [index]),
      mode, target:enemies.indexOf(target), lock:player.lockProgress,
      visible, box:visible ? [point.x * innerWidth / innerHeight, -point.y] : null,
      cue:cue && !cue.hidden ? cue.textContent : null };
  }
  window.navigationQA = {
    readAim:() => [aim.x, aim.y],
    step(frames) {
      if (composer) throw new Error('Use the direct-render low quality setting for fixed-step QA');
      const render = renderer.render;
      // Run the real game and HUD at 20 steps/s, rasterizing only the evidence frames.
      renderer.render = (world, view) => view.updateMatrixWorld();
      try { for (let frame = 0; frame < frames && mode === 'playing'; frame++) animate(lastTime + 50); }
      finally { renderer.render = render; }
      return state();
    },
    paint() { renderer.render(scene, camera); drawHUD(); },
    projectionCases() {
      const target = player.primaryTarget, original = target.pos.clone(), fill = hudCtx.fill;
      const offsets = [[0,0,-300],[-4000,0,-300],[4000,0,-300],[0,2000,-300],[0,-2000,-300],
        [-100,24,300],[3,30,300],[100,24,300],[-2,30,300],[0,0,-300],
        [-1800,1800,-300],[1800,1800,-300],[-1800,-1800,-300],[1800,-1800,-300],[800,0,0]];
      let arrow = null;
      hudCtx.fill = function (...args) {
        if (this.fillStyle === '#56f5a4') { const matrix = this.getTransform(); arrow = [matrix.a, matrix.b]; }
        return fill.apply(this, args);
      };
      try {
        return offsets.map(offset => {
          arrow = null;
          target.pos.set(...offset).applyMatrix4(camera.matrixWorld);
          drawHUD();
          return {...state(), arrow};
        });
      } finally { hudCtx.fill = fill; target.pos.copy(original); drawHUD(); }
    }
  };
}

const fixture = game.replace(/\/\/ Boot\r?\ntry \{/, () => `(${installNavigationFixture})();\n// Boot\ntry {`);
assert.notEqual(fixture, game, 'Expected a game boot entry');
const browser = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
async function fly(touch) {
  const page = await browser.newPage({viewport:touch ? {width:390,height:844} : {width:720,height:405}, hasTouch:touch, isMobile:touch, deviceScaleFactor:1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    const request = route.request().url();
    if (request === url) return route.fulfill({body:fixture, contentType:'text/html; charset=utf-8'});
    const file = resolve(modules, request.slice(prefix.length));
    if (request.startsWith(prefix) && file.startsWith(modules + sep) && extname(file) === '.js') {
      return route.fulfill({path:file, contentType:'text/javascript', headers:{'Access-Control-Allow-Origin':'*'}});
    }
    errors.push(`Unexpected request: ${request}`); return route.abort();
  });
  await page.addInitScript(initial => {
    let seed = initial; window.resetNavigationSeed = () => { seed = initial; };
    Math.random = () => ((seed = (Math.imul(seed,1664525) + 1013904223) >>> 0) / 4294967296);
  }, touch ? 161 : 160);
  const step = frames => page.evaluate(count => navigationQA.step(count), frames);
  const act = selector => touch ? page.locator(selector).tap() : page.locator(selector).click();
  async function capture(name) {
    await page.evaluate(() => navigationQA.paint());
    if (evidence) await page.screenshot({path:join(evidence, `${touch ? 'touch' : 'keyboard'}-${name}.png`)});
  }
  try {
    await page.goto(url); await page.waitForFunction(() => window.navigationQA && window.__ACE_DEBUG__);
    if (!touch) await act('#langBtn');
    await act('#qualBtn'); await act('#qualBtn'); await act('#muteBtn');
    await page.evaluate(() => resetNavigationSeed()); await act('#sortieBtn');
    if (touch) await act('[data-flight="view"]');
    let flight = await step(1);
    const cases = await page.evaluate(() => navigationQA.projectionCases());
    const words = touch ? [/左侧/,/右侧/,/上方/,/下方/,/后方.*左转/,/后方.*右转/] : [/Target left/,/Target right/,/Target above/,/Target below/,/behind.*left/,/behind.*right/];
    for (const [index, word] of [0,1,2,3,4,4,5,5].entries()) assert.match(cases[index + 1].cue ?? '', words[word]);
    for (const index of [0,9]) { assert.ok(cases[index].visible); assert.equal(cases[index].cue, null); }
    assert.deepEqual(cases.slice(10).map(row => row.cue?.match(/[↖↗↙↘→]/)?.[0]), ['↖','↗','↙','↘','→']);
    for (const index of [5,6,7,8]) {
      const [horizontal, vertical] = cases[index].arrow;
      assert.ok(Math.abs(vertical) < 0.001 && (index < 7 ? horizontal < -0.99 : horizontal > 0.99), 'The actual HUD arrow must agree with the turn instruction');
    }
    while (flight.lock < 0.99 && flight.time < 8) flight = await step(1);
    assert.ok(flight.lock >= 0.99, 'First contact is ready at the default spawn');
    if (touch) await act('[data-flight="launch"]'); else await page.keyboard.press('Space');
    while (flight.kills === 0 && flight.time < 9) flight = await step(2);
    assert.equal(flight.kills, 1, 'Real first contact, without moving any actors during the flight');
    if (touch) await act('[data-flight="target"]'); else await page.keyboard.press('e');
    flight = await step(1);
    while ((flight.time < 12 || !/behind|后方/.test(flight.cue)) && flight.time < 18) flight = await step(2);
    assert.match(flight.cue ?? '', /behind|后方/); assert.equal(flight.visible, false);
    const lost = flight;
    await capture('behind');
    await act('#pauseBtn'); assert.equal(await page.locator('#contactCue').isVisible(), false);
    await act('#btnResume'); await page.evaluate(() => navigationQA.paint());
    assert.equal(await page.locator('#contactCue').innerText(), lost.cue);
    const session = touch && await page.context().newCDPSession(page);
    let active = [], lastDrag = '', recovered;
    async function steer(dx, dy) {
      if (touch) {
        const x = 190 + Math.round(42 * dx), y = 410 + Math.round(42 * dy);
        if (lastDrag !== `${x},${y}`) {
          await session.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{id:1,x,y}]});
          const radius = Math.max(42, Math.hypot(x - 190, y - 410));
          await page.waitForFunction(expected => navigationQA.readAim().every((value, index) => Math.abs(value - expected[index]) < 0.035), [(x-190)/radius,(y-410)/radius], {timeout:3000});
        }
        lastDrag = `${x},${y}`; return;
      }
      const keys = [dx < 0 ? 'ArrowLeft' : dx > 0 ? 'ArrowRight' : '', dy < 0 ? 'ArrowUp' : dy > 0 ? 'ArrowDown' : ''].filter(Boolean);
      if (keys.join() === active.join()) return;
      for (const key of active.filter(key => !keys.includes(key))) await page.keyboard.up(key);
      for (const key of keys.filter(key => !active.includes(key))) await page.keyboard.down(key);
      active = keys;
    }
    if (touch) await session.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{id:1,x:190,y:410}]});
    try {
      const followCue = cue => steer(Number(/[→↗↘]/.test(cue)) - Number(/[←↖↙]/.test(cue)), Number(/[↓↙↘]/.test(cue)) - Number(/[↑↖↗]/.test(cue)));
      while (!flight.visible && flight.mode === 'playing' && flight.time < lost.time + 7) {
        const cue = flight.cue;
        assert.match(cue ?? '', /[←→↑↓↖↗↙↘]/);
        await followCue(cue);
        flight = await step(3);
      }
      assert.ok(flight.visible, 'Steering in the indicated direction must recover a real target box');
      assert.equal(flight.target, lost.target, 'It is the same moving contact, not a target swap');
      assert.equal(flight.cue, null); recovered = flight.time; await capture('recovered');
      while (flight.lock < 0.99 && flight.mode === 'playing' && flight.time < recovered + 8) {
        if (flight.box) await steer(...flight.box.map(offset => touch ? Math.max(-1, Math.min(1, offset * 1.8)) : Math.abs(offset) > 0.18 ? Math.sign(offset) : 0));
        else await followCue(flight.cue);
        flight = await step(2);
      }
      assert.ok(flight.lock >= 0.99, `Reacquired contact never became ready: ${JSON.stringify(flight)}`); assert.equal(flight.target, lost.target);
    } finally {
      if (touch) await session.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
      else for (const key of active) await page.keyboard.up(key);
    }
    if (touch) await act('[data-flight="launch"]'); else await page.keyboard.press('Space');
    const fired = flight.time;
    while (flight.kills === 1 && flight.mode === 'playing' && flight.time < fired + 7) flight = await step(2);
    assert.equal(flight.kills, 2); assert.ok(flight.defeated.includes(lost.target)); await capture('second-contact');
    console.log(`PASS ${touch ? 'native touch/cockpit/zh' : 'keyboard/chase/en'}: same contact ${lost.target}, behind ${lost.time}s → box ${recovered}s → second confirmed hit ${flight.time}s`);
    if (touch) {
      await act('#pauseBtn'); await act('#btnHangar'); await page.setViewportSize({width:568,height:320});
      await act('[data-mission="2"]'); await act('#sortieBtn');
      assert.equal((await step(1)).cue, null);
      const storm = await step(335); assert.match(storm.cue ?? '', /后方/); await capture('storm-landscape');
      const clear = await page.locator('#contactCue').evaluate(cue => {
        const bounds = cue.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom < innerHeight / 2 &&
          ['#pauseBtn','#radarWrap','#weaponPanel','#touchControls'].every(selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return rect.left >= bounds.right || rect.right <= bounds.left || rect.top >= bounds.bottom || rect.bottom <= bounds.top;
          });
      });
      assert.ok(clear, 'Short-screen direction cue must clear the reticle, readouts and controls');
      await act('#pauseBtn'); await act('#btnRestart'); assert.equal((await step(1)).cue, null);
    }
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
}
try { await fly(false); await fly(true); } finally { await browser.close(); }

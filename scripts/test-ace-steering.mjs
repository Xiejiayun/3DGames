import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const threeRoot = resolve(fileURLToPath(import.meta.resolve('three')), '../..');
const { version } = JSON.parse(await readFile(join(threeRoot, 'package.json'), 'utf8'));
const prefix = `https://unpkg.com/three@${version}/`;
const output = process.env.ACE_SCREENSHOTS ? resolve(process.env.ACE_SCREENSHOTS, 'steering') : await mkdtemp(join(tmpdir(), 'ace-steering-'));
await mkdir(output, { recursive:true });
const errors = [];

// Only the intercepted loopback page can step the real player. No pose or input is injected.
function installProbe() {
  window.steeringQA = {
    step(frames, dt) {
      if (mode === 'playing') for (let frame = 0; frame < frames; frame++) updatePlayer(dt, dt);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quat);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(player.quat);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quat);
      return { stick:[stick.x, stick.y], pitch:Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)), bank:Math.atan2(right.y, up.y),
        heading:Math.atan2(-forward.x, -forward.z), rollRate:player.rollRate, leveling, view:cameraMode, mode };
    },
    paint() { animate(lastTime); }
  };
}
const close = html.lastIndexOf('</script>');
assert.ok(close > html.indexOf('<script type="module">'));
const fixture = html.slice(0, close) + `\n(${installProbe})();\n` + html.slice(close);
const url = 'http://127.0.0.1/games/ace.html';
const browser = await chromium.launch({ args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const step = (page, frames = 1, dt = 1 / 60) => page.evaluate(([count, delta]) => steeringQA.step(count, delta), [frames, dt]);
const near = (value, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(value - expected) < tolerance, `${message}: ${value} vs ${expected}`);
const tilt = pose => Math.max(Math.abs(pose.pitch), Math.abs(pose.bank));

async function open(viewport, touch = false) {
  const page = await browser.newPage({ viewport, hasTouch:touch, isMobile:touch, deviceScaleFactor:1 });
  await page.route(url, route => route.fulfill({ contentType:'text/html; charset=utf-8', body:fixture }));
  await page.route('https://**', route => {
    const request = route.request().url(), file = resolve(threeRoot, request.slice(prefix.length));
    if (request.startsWith(prefix) && file.startsWith(threeRoot + sep) && file.endsWith('.js')) {
      return route.fulfill({ path:file, contentType:'application/javascript', headers:{ 'Access-Control-Allow-Origin':'*' } });
    }
    errors.push(`Unexpected request: ${request}`); return route.abort();
  });
  await page.addInitScript(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => callback.name === 'animate' ? 0 : nativeFrame(callback);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url); await page.waitForFunction(() => window.steeringQA && window.__ACE_DEBUG__);
  const launch = page.locator('#sortieBtn');
  if (touch) await launch.tap(); else await launch.click();
  return page;
}

async function capture(page, name) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => { steeringQA.paint(); requestAnimationFrame(done); })));
  await page.screenshot({ path:join(output, `${name}.png`) });
}

async function desktopRun() {
  const page = await open({ width:1100, height:660 });
  const key = name => page.keyboard.press(name);
  await page.mouse.move(568, 336);
  const jitter = await step(page, 120);
  near(jitter.heading, 0, 'No heading drift over two seconds'); near(jitter.pitch, 0, 'No pitch drift');
  await page.mouse.move(595, 330); const edge = (await step(page)).stick[0];
  await page.mouse.move(660, 330); const fine = (await step(page)).stick[0];
  await page.mouse.move(935, 330); const coarse = (await step(page)).stick[0];
  assert.ok(edge > 0 && edge < 0.005 && fine > 0.05 && fine < 0.13 && coarse > 0.5 && coarse < 0.7);
  await page.mouse.move(0, 330); near((await step(page)).stick[0], -1, 'Outer analog authority');
  await page.keyboard.down('ArrowRight'); near((await step(page)).stick[0], 1, 'Full digital authority');
  await page.keyboard.up('ArrowRight'); near((await step(page)).stick[0], 0, 'Arrow release clears input');

  for (const [view, hz] of [['3p', 60], ['1p', 20]]) {
    await key('p'); await page.locator('#btnRestart').click();
    if (view === '1p') await key('v');
    await page.mouse.move(825, 165);
    const before = await step(page, 40);
    assert.equal(before.view, view); assert.ok(Math.abs(before.bank) > 0.15 && Math.abs(before.pitch) > 0.15);
    await capture(page, `${view}-before`);
    await key('r');
    const first = await step(page, 1, 1 / hz), middle = await step(page, hz / 2, 1 / hz), done = await step(page, hz * 3, 1 / hz);
    assert.ok(first.leveling && middle.leveling && !done.leveling);
    assert.ok(tilt(first) < tilt(before) && tilt(first) >= tilt(before) - 2.4 / hz - 1e-6 && tilt(middle) < tilt(first));
    for (const pose of [first, middle, done]) near(pose.heading, before.heading, 'Recovery preserves horizontal heading');
    near(tilt(done), 0, 'Upright and level'); await capture(page, `${view}-after`);
  }

  await page.keyboard.down('a'); await step(page, 54); await key('r');
  const rolling = await step(page); assert.ok(!rolling.leveling && rolling.rollRate > 2 && Math.abs(rolling.bank) > 2);
  await page.keyboard.up('a'); await key('r'); assert.ok((await step(page, 3)).leveling);
  await page.keyboard.down('d'); const override = await step(page, 12); await page.keyboard.up('d');
  assert.ok(!override.leveling && override.rollRate < -1, 'Manual roll takes over a recovery');
  await key('r'); assert.ok((await step(page)).leveling); await key('a');
  assert.ok(!(await step(page, 0)).leveling, 'Even a pilot tap between simulation frames cancels recovery');
  await key('r'); assert.ok((await step(page)).leveling);
  await page.mouse.move(800, 200); assert.ok(!(await step(page, 20)).leveling, 'Moving the mouse takes over');
  await key('r'); const recovering = await step(page, 2); assert.ok(recovering.leveling && Math.abs(recovering.pitch) > 0.02);
  await key('p'); const paused = await step(page, 30); assert.equal(paused.mode, 'paused'); assert.equal(paused.leveling, false);
  await key('Escape'); near((await step(page, 10)).pitch, recovering.pitch, 'Resume does not continue leveling');
  await key('r'); assert.ok((await step(page)).leveling); await key('p'); await page.locator('#btnRestart').click();
  const fresh = await step(page); near(tilt(fresh), 0, 'Restart is upright'); assert.equal(fresh.leveling, false);

  await page.keyboard.down('ArrowUp'); const steep = await step(page, 53); await page.keyboard.up('ArrowUp');
  assert.ok(steep.pitch > 1.5, 'Start near vertical from keyboard input');
  await key('r'); const horizon = await step(page, 70, 0.05);
  near(tilt(horizon), 0, 'Near-vertical recovery stays finite'); near(horizon.heading, steep.heading, 'Steep recovery keeps heading');

  await key('p'); const response = page.getByLabel('转向手感'); assert.equal(await response.inputValue(), 'comfort');
  await response.selectOption('classic'); await page.locator('#langBtn').click();
  assert.equal(await page.getByLabel('Steering response').inputValue(), 'classic');
  await capture(page, 'settings'); await key('Escape');
  await page.mouse.move(568, 336); const classic = await step(page, 120);
  near(classic.stick[0], 18 / 550, 'Classic original linear response');
  near(classic.stick[1], 6 / 330, 'Classic original pitch response');
  near(classic.heading * 180 / Math.PI, -5.556, 'Classic matches measured pre-change heading', 0.01);
  near(classic.pitch * 180 / Math.PI, -4.135, 'Classic matches measured pre-change pitch', 0.01);
  console.log(`PASS comfort / classic drift: ${(jitter.heading * 180 / Math.PI).toFixed(2)}° / ${(classic.heading * 180 / Math.PI).toFixed(2)}°; 20% deflection → ${fine.toFixed(3)}`);
  await page.close();
}

async function touchRun() {
  const page = await open({ width:320, height:568 }, true);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const level = page.getByRole('button', { name:'改平', exact:true });
  const box = await level.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
  const button = { id:2, x:Math.round(box.x + box.width / 2), y:Math.round(box.y + box.height / 2) };
  const start = { id:1, x:70, y:272 }, moved = { ...start, x:94, y:244 };
  await touch('touchStart', [start]); await touch('touchMove', [{ ...start, x:72, y:274 }]);
  near(tilt(await step(page, 120)), 0, 'Small diagonal thumb jitter is neutral');
  await touch('touchMove', [moved]); const banked = await step(page, 30); assert.ok(tilt(banked) > 0.15);
  await touch('touchStart', [moved, button]); assert.ok(await level.evaluate(node => node.classList.contains('held')));
  assert.ok(!(await step(page)).leveling, 'A second thumb cannot steal a live stick');
  await touch('touchCancel', []); const canceled = await step(page); near(Math.hypot(...canceled.stick), 0, 'Canceled touch is neutral');
  await touch('touchStart', [start]); await touch('touchMove', [moved]); await step(page, 4); await touch('touchEnd', []);
  const released = await step(page); near(Math.hypot(...released.stick), 0, 'Lifting thumb centers the stick');
  await level.tap(); assert.ok((await step(page)).leveling); const done = await step(page, 180);
  near(tilt(done), 0, 'Touch button levels flight'); near(done.heading, released.heading, 'Touch recovery keeps heading');
  await capture(page, '320-touch');
  await page.setViewportSize({ width:568, height:320 }); await page.locator('#pauseBtn').tap();
  await page.locator('#langBtn').tap(); await page.locator('#btnResume').tap();
  const landscapeLevel = page.getByRole('button', { name:'Level', exact:true });
  const landscapeBox = await landscapeLevel.boundingBox(); assert.ok(landscapeBox.x + landscapeBox.width < 568 / 2, 'Dock leaves the jet visible');
  await landscapeLevel.tap(); await capture(page, '568-touch');
  await page.close();
}

try {
  await desktopRun(); await touchRun(); assert.deepEqual(errors, [], 'Browser errors');
  console.log(`PASS actual mouse, keys, multitouch, both cameras, 60/20 Hz recovery and interruptions. Screenshots: ${output}`);
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const html = await readFile(new URL('../games/ace.html', import.meta.url), 'utf8');
const started = performance.now();
const evidence = process.env.ACE_SCREENSHOTS ? resolve(process.env.ACE_SCREENSHOTS, 'playability') : await mkdtemp(join(tmpdir(), 'ace-playability-'));
await mkdir(evidence, { recursive:true });
console.log(`Screenshots: ${evidence}`);

// Served only on the loopback fixture URL. It never sets HP, kills, ammo, score, stage or mode.
function installFixture() {
  window.arcadeQA = {
    read: () => ({ pitch:player.pitchRate, yaw:player.yawRate, roll:player.rollRate, throttle:player.throttle,
      target:enemies.indexOf(player.primaryTarget), gun:player.gunCd, flare:player.flareCd, time:missionTimer, terrainGrace:player.terrainGrace,
      held:[...heldInputs.values()], shots:bullets.filter(shot => shot.fromPlayer).length,
      kills:missionKills, wakes:wakeUniformData.filter(slot => slot.w > 0).length,
      passed:enemies.some(enemy => enemy.alive && enemy.pos.z > player.pos.z) }),
    gallery() {
      player.pos.set(0, 900, 1300); player.quat.identity();
      player.pitchRate = player.yawRate = player.rollRate = 0;
      enemies.filter(enemy => enemy.alive).forEach((enemy, index) => {
        enemy.pos.set(0, 900, 420 - index * 90); enemy.mesh.position.copy(enemy.pos);
        enemy.speed = 0; enemy.fireCd = enemy.mslCd = 10000;
      });
    },
    moveSecondBehind() { enemies[1].pos.copy(player.pos); enemies[1].pos.z += 500; },
    inspectTargetTags() {
      const visibleContacts = enemies.filter(enemy => {
        const point = enemy.pos.clone().project(camera);
        return enemy.alive && point.z > -1 && point.z < 1 && Math.abs(point.x) < 0.9 && Math.abs(point.y) < 0.9;
      }).length;
      const tags = [], fillText = hudCtx.fillText;
      hudCtx.fillText = function (text, ...args) {
        if (/\d+m$/.test(text)) tags.push(text);
        return fillText.call(this, text, ...args);
      };
      try { drawHUD(); } finally { hudCtx.fillText = fillText; }
      return { visibleContacts, tags };
    },
    sampleFleetPatrol() {
      const ships = enemies.filter(enemy => !enemy.isAir);
      for (const enemy of enemies) enemy.fireCd = enemy.mslCd = 10000;
      let furthest = 0, highestTerrain = -Infinity;
      for (let frame = 0; frame < 12000; frame++) {
        updateEnemies(0.05);
        for (const ship of ships) {
          furthest = Math.max(furthest, ship.pos.length());
          highestTerrain = Math.max(highestTerrain, sampleTerrainHeight(ship.pos.x, ship.pos.z));
        }
      }
      return { furthest, highestTerrain };
    }
  };
}
const moduleStart = html.indexOf('<script type="module">');
const insert = html.indexOf('</script>', moduleStart);
assert.ok(moduleStart >= 0 && insert > moduleStart, 'Expected the Ace game module');
const fixtureHtml = html.slice(0, insert) + `\n(${installFixture})();\n` + html.slice(insert);
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/games/ace.html') return response.writeHead(404).end();
  response.writeHead(200, { 'content-type':'text/html; charset=utf-8' }).end(url.search === '?fixture' ? fixtureHtml : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/games/ace.html`;
const errors = [];

const state = page => page.evaluate(() => window.__ACE_DEBUG__.getState());
const detail = page => page.evaluate(() => window.arcadeQA.read());
const wait = (page, predicate, arg) => page.waitForFunction(predicate, arg, { timeout:90000 });
const modeIs = (page, mode) => wait(page, expected => window.__ACE_DEBUG__?.getState().mode === expected, mode);
const shot = (page, name) => page.screenshot({ path:join(evidence, `${name}.png`) });

async function open(page, fixture = false) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url + (fixture ? '?fixture' : ''));
  await wait(page, () => window.__ACE_DEBUG__?.getState().frameCount > 1);
}

async function checkHitTargets(page, selector) {
  const misses = await page.locator(selector).evaluateAll(elements => elements.filter(element => {
    const box = element.getBoundingClientRect();
    return box.width < 1 || box.height < 1 || box.left < 0 || box.top < 0 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1 ||
      !element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }).map(element => element.id || element.dataset.flight));
  assert.deepEqual(misses, [], 'Every visible action must be in bounds and own its hit target');
}

async function checkFlightLayout(page) {
  await checkHitTargets(page, '#pauseBtn, #touchControls button');
  const problems = await page.evaluate(() => {
    const ids = ['objBox', 'pauseBtn', 'weaponPanel', 'radarWrap', 'touchControls'];
    const rects = ids.map(id => document.getElementById(id).getBoundingClientRect());
    const problems = [];
    rects.forEach((rect, index) => {
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) problems.push(`${ids[index]} clips`);
      if (rect.left < innerWidth / 2 && rect.right > innerWidth / 2 && rect.top < innerHeight / 2 && rect.bottom > innerHeight / 2) problems.push(`${ids[index]} covers reticle`);
      rects.slice(index + 1).forEach((other, offset) => {
        if (rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top) problems.push(`${ids[index]} overlaps ${ids[index + offset + 1]}`);
      });
    });
    return problems;
  });
  assert.deepEqual(problems, [], 'HUD panels and controls must not collide');
}

async function center(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box);
  return { x:Math.round(box.x + box.width / 2), y:Math.round(box.y + box.height / 2) };
}

async function touchRun(browser) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:1, isMobile:true, hasTouch:true });
  try {
    const page = await context.newPage();
    await open(page);
    assert.equal(await page.evaluate(() => typeof window.arcadeQA), 'undefined');
    await checkHitTargets(page, '#sortieBtn');
    await shot(page, '390-hangar');
    await page.locator('#sortieBtn').tap();
    await modeIs(page, 'playing');
    await checkFlightLayout(page);
    await wait(page, () => document.querySelector('#hudTime').textContent >= '00:01');
    await shot(page, '390-flight');
    console.log('PASS 390x844 unforced first-action launch tap');

    const cdp = await context.newCDPSession(page);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const first = { id:1, x:90, y:430 }, raised = { ...first, y:393 };
    const gun = { id:2, ...await center(page, '[data-flight="cannon"]') };
    const altitude = (await state(page)).alt;
    await touch('touchStart', [first]);
    await touch('touchMove', [raised]);
    await touch('touchStart', [raised, gun]);
    await wait(page, base => window.__ACE_DEBUG__.getState().alt > base + 8 && document.querySelector('#wpGun.on'), altitude);
    await shot(page, '390-multitouch');
    await touch('touchCancel', []);
    await wait(page, () => !document.querySelector('#stickBase.active, #wpGun.on, #touchControls .held'));

    for (const action of ['launch', 'swap', 'launch', 'flare', 'target', 'view']) await page.locator(`[data-flight="${action}"]`).tap();
    const after = await state(page);
    assert.equal(after.cameraMode, '1p'); assert.equal(after.activeWeapon, 'spw');
    assert.ok(after.mslAmmo < 2 && after.spwAmmo < 16);
    assert.match(await page.locator('#flareTxt').innerText(), /s$/);
    const boost = { id:3, ...await center(page, '[data-flight="boost"]') };
    await touch('touchStart', [boost]);
    await wait(page, () => window.__ACE_DEBUG__.getState().speed > 225);
    await touch('touchEnd', []);
    const brake = { id:4, ...await center(page, '[data-flight="brake"]') };
    const bank = { id:5, ...await center(page, '[data-flight="rollLeft"]') };
    await touch('touchStart', [brake, bank]);
    await wait(page, () => window.__ACE_DEBUG__.getState().speed < 155 && document.querySelectorAll('#touchControls .held').length === 2);
    await touch('touchEnd', []);
    await page.locator('#pauseBtn').tap();
    await modeIs(page, 'paused');
    await page.locator('#langBtn').tap(); await page.locator('#pauseQualBtn').tap(); await page.locator('#pauseQualBtn').tap();
    await page.locator('#btnHangar').tap();
    for (const [width, height] of [[320,568], [568,320], [844,390], [768,1024], [1024,600]]) {
      await page.setViewportSize({ width, height });
      await page.locator('[data-mission="2"]').tap();
      await page.locator('[data-jet="2"]').tap();
      await checkHitTargets(page, '#sortieBtn');
      await page.locator('#sortieBtn').tap();
      await modeIs(page, 'playing');
      assert.equal((await state(page)).selMissionIdx, 2);
      await checkFlightLayout(page);
      if (height === 320 || width === 320) await shot(page, `${width}x${height}-flight`);
      if (width === 1024) {
        await page.mouse.click(width / 2, height / 2);
        assert.equal(await page.locator('#touchControls').isVisible(), false);
        await page.touchscreen.tap(width / 2, height / 2);
        assert.equal(await page.locator('#touchControls').isVisible(), true);
      }
      await page.locator('#pauseBtn').tap(); await page.locator('#btnHangar').tap();
      console.log(`PASS ${width}x${height} selection, launch, HUD and return`);
    }
    console.log('PASS touch steering + cannon together, pointercancel, touch actions and portrait/landscape/tablet hit targets');
  } finally { await context.close(); }
}

async function desktopRun(browser) {
  const desktop = { width:1280, height:720 }, compact = { width:680, height:420 };
  const context = await browser.newContext({ viewport:desktop, deviceScaleFactor:1, isMobile:false, hasTouch:false });
  try {
    const page = await context.newPage();
    await open(page, true);
    assert.equal(await page.locator('html').evaluate(root => root.classList.contains('touch-flight')), false);
    await page.locator('#langBtn').click(); await page.locator('#qualBtn').click(); await page.locator('#qualBtn').click();
    await page.locator('#sortieBtn').click();
    await modeIs(page, 'playing');
    assert.equal(await page.locator('#touchControls').isVisible(), false);
    assert.equal(await page.locator('#touchHint').isVisible(), false);
    assert.equal(await page.locator('#flightKeys').isVisible(), true);
    await wait(page, () => window.arcadeQA.read().target >= 0);
    const radar = await page.locator('#radarCanvas').evaluate(canvas => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const rows = [];
      for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset] === 255 && data[offset + 1] === 90 && data[offset + 2] === 77) rows.push(Math.floor(offset / 4 / canvas.width));
      }
      return rows.length && Math.max(...rows);
    });
    assert.ok(radar > 0 && radar < 80, 'Forward contacts appear above the radar chevron');
    await wait(page, () => window.arcadeQA.read().time >= 1);
    await shot(page, 'desktop-flight');
    await page.setViewportSize(compact);
    const neutralMouse = () => page.mouse.move(compact.width / 2, compact.height / 2);
    await page.mouse.move(compact.width * 0.7, compact.height * 0.35);
    await wait(page, () => window.arcadeQA.read().yaw < -0.1 && window.arcadeQA.read().pitch > 0.1);
    await neutralMouse();
    await page.keyboard.down('w'); await wait(page, () => window.__ACE_DEBUG__.getState().speed > 225); await page.keyboard.up('w');
    await page.keyboard.down('s'); await wait(page, () => window.__ACE_DEBUG__.getState().speed < 155); await page.keyboard.up('s');
    await page.keyboard.down('a'); await wait(page, () => window.arcadeQA.read().roll > 1); await page.keyboard.up('a');
    await page.keyboard.down('d'); await wait(page, () => window.arcadeQA.read().roll < -1); await page.keyboard.up('d');
    await page.keyboard.down('ArrowLeft'); await wait(page, () => window.arcadeQA.read().yaw > 0.5); await page.keyboard.up('ArrowLeft');
    await page.mouse.down();
    await wait(page, () => window.arcadeQA.read().shots > 0);
    await page.mouse.down({ button:'right' });
    assert.equal((await state(page)).mslAmmo, 1);
    assert.ok((await detail(page)).held.includes('cannon'), 'Mouse chord does not release cannon');
    await page.mouse.up({ button:'right' }); await page.mouse.up();
    await page.keyboard.down('q'); await page.keyboard.down('q'); await page.keyboard.up('q');
    assert.equal((await state(page)).activeWeapon, 'spw', 'Key repeat did not swap again');
    await page.keyboard.press('Space'); await page.keyboard.press('Shift'); await page.keyboard.press('v');
    assert.ok((await state(page)).spwAmmo < 16 && (await detail(page)).flare > 0);
    assert.equal((await state(page)).cameraMode, '1p');
    await page.keyboard.press('c');
    await page.keyboard.down('p'); await page.keyboard.down('p'); await page.keyboard.up('p');
    await modeIs(page, 'paused');
    const ammo = (await state(page)).mslAmmo;
    await page.locator('#sensSlider').focus(); await page.keyboard.press('ArrowRight');
    assert.ok(Number(await page.locator('#sensSlider').inputValue()) > 1);
    await page.locator('#invertBtn').click(); assert.equal(await page.locator('#invertBtn').innerText(), 'On');
    await page.locator('#btnResume').click(); assert.equal((await state(page)).mslAmmo, ammo);
    await page.keyboard.down('ArrowUp'); await wait(page, () => window.arcadeQA.read().pitch < -0.5); await page.keyboard.up('ArrowUp');
    await page.keyboard.down('w'); await page.keyboard.down('j');
    await wait(page, () => window.arcadeQA.read().throttle > 0.8 && window.arcadeQA.read().shots > 0);
    const other = await context.newPage(); await other.bringToFront();
    const switched = (await state(page)).mode === 'paused';
    await page.bringToFront(); await other.close();
    if (!switched) {
      await page.evaluate(() => {
        const peer = document.createElement('iframe'); peer.id = 'focusPeer'; peer.srcdoc = '<button>Other window</button>';
        peer.style.cssText = 'position:fixed;inset:0 auto auto 0;width:150px;height:60px;z-index:100';
        document.body.append(peer);
      });
      await page.frameLocator('#focusPeer').getByRole('button').click();
      await page.locator('#focusPeer').evaluate(peer => peer.remove());
    }
    await modeIs(page, 'paused');
    const paused = await detail(page);
    assert.deepEqual(paused.held, []);
    const pausedFrame = (await state(page)).frameCount;
    await wait(page, start => window.__ACE_DEBUG__.getState().frameCount > start + 3, pausedFrame);
    assert.equal((await detail(page)).time, paused.time);
    await page.locator('#btnResume').click();
    await wait(page, () => window.arcadeQA.read().throttle < 0.57 && window.arcadeQA.read().gun === 0);
    assert.deepEqual((await detail(page)).held, []);
    await page.keyboard.up('w'); await page.keyboard.up('j');
    await page.locator('#pauseBtn').click();
    assert.equal((await detail(page)).gun, 0, 'Clicking HUD must not shoot');
    await page.locator('#invertBtn').click(); assert.equal(await page.locator('#invertBtn').innerText(), 'Off');
    await page.locator('#btnRestart').click();
    assert.equal((await state(page)).activeWeapon, 'msl'); assert.equal((await detail(page)).flare, 0);
    console.log(`PASS mouse-only desktop, keyboard, mouse chords, radar, settings, restart and genuine blur (${switched ? 'tab switch' : 'focus moved into a child browsing context'})`);

    await page.keyboard.down('ArrowDown');
    await wait(page, () => window.arcadeQA.read().terrainGrace > 0 && window.__ACE_DEBUG__.getState().hp < 115);
    await modeIs(page, 'debrief'); await page.keyboard.up('ArrowDown');
    assert.equal(await page.locator('#debriefTitle').innerText(), 'AIRCRAFT DESTROYED');
    assert.equal(await page.locator('#dHull').innerText(), '0%'); assert.equal(await page.locator('#dBtnNext').isVisible(), false);
    await shot(page, 'loss');
    await page.locator('#dBtnRetry').click();
    assert.equal((await state(page)).hp, 115); assert.equal((await state(page)).enemiesAlive, 4);
    assert.equal((await detail(page)).kills, 0); assert.deepEqual((await detail(page)).held, []);
    await neutralMouse();
    await page.evaluate(() => { window.arcadeQA.gallery(); window.arcadeQA.moveSecondBehind(); });
    await page.keyboard.press('e');
    for (let cycle = 0; cycle < 4 && (await detail(page)).target !== 1; cycle++) await page.keyboard.press('e');
    const selectedFrame = (await state(page)).frameCount;
    await wait(page, start => window.__ACE_DEBUG__.getState().frameCount > start + 4, selectedFrame);
    assert.equal((await detail(page)).target, 1, 'An explicitly chosen offscreen icon stays selected');
    console.log('PASS real flight-input loss, debrief, full-health retry and persistent target cycling');

    async function clearGallery(count) {
      await neutralMouse();
      for (let pass = 0; pass < 3; pass++) {
        await page.evaluate(() => window.arcadeQA.gallery());
        await page.keyboard.down('s'); await page.keyboard.down('j');
        try {
          await wait(page, expected => {
            const { kills, passed } = window.arcadeQA.read();
            return kills >= expected || passed || window.__ACE_DEBUG__.getState().mode !== 'playing';
          }, count);
        } finally { await page.keyboard.up('j'); await page.keyboard.up('s'); }
        if ((await detail(page)).kills === count) return;
      }
      assert.fail(`Gallery did not reach ${count}: ${JSON.stringify(await detail(page))}`);
    }
    async function win(total, final = false) {
      await modeIs(page, 'debrief');
      assert.equal(await page.locator('#dKills').innerText(), `${total} / ${total}`);
      assert.equal(await page.locator('#debriefTitle').innerText(), final ? 'CAMPAIGN COMPLETE' : 'MISSION ACCOMPLISHED');
      assert.ok(Number(await page.locator('#dScore').innerText()) > 0);
      assert.equal(await page.locator('#dBtnNext').isVisible(), !final);
      console.log(`PASS debrief: ${total}/${total} contacts, score ${await page.locator('#dScore').innerText()}`);
    }
    await clearGallery(4);
    assert.match(await page.locator('#objText').innerText(), /Wave 2\/2/); assert.equal((await state(page)).enemiesAlive, 5);
    await clearGallery(9); await win(9); await shot(page, 'mission-clear');
    await page.setViewportSize(desktop);
    await page.locator('#dBtnNext').click(); assert.equal((await state(page)).selMissionIdx, 1);
    await wait(page, () => window.arcadeQA.read().time >= 1 && window.arcadeQA.read().target >= 0);
    assert.equal(await page.locator('#touchControls').isVisible(), false);
    const { visibleContacts, tags } = await page.evaluate(() => window.arcadeQA.inspectTargetTags());
    assert.ok(visibleContacts >= 5, `Expected a crowded sunset view, got ${visibleContacts} contacts`);
    assert.equal(tags.length, 1, 'Only the selected contact gets a text label in a crowd');
    await shot(page, '1280x720-sunset');
    await page.setViewportSize(compact);
    await clearGallery(10); await win(10);
    await page.locator('#dBtnNext').click(); assert.equal((await state(page)).selMissionIdx, 2);
    const { furthest, highestTerrain } = await page.evaluate(() => window.arcadeQA.sampleFleetPatrol());
    assert.ok(furthest < 4600, `Ship outside arena: ${furthest}`);
    assert.ok(highestTerrain < 0, `Patrol crossed dry land: ${highestTerrain}`);
    await page.locator('#pauseBtn').click(); await page.locator('#btnRestart').click();
    await clearGallery(1); await wait(page, () => window.arcadeQA.read().wakes === 2);
    await clearGallery(6);
    assert.match(await page.locator('#objText').innerText(), /Crimson-1/);
    assert.equal((await state(page)).enemiesAlive, 1); assert.equal((await detail(page)).wakes, 0);
    await clearGallery(7); await win(7, true); await shot(page, 'campaign-complete');
    await page.locator('#dBtnHangar').click(); await modeIs(page, 'hangar');
    console.log(`PASS full-health staged targets via real cannon input: 9/9 → 10/10 → 7/7, Next/Retry/Hangar, wake cleanup; ten simulated minutes of fleet movement, furthest ${Math.ceil(furthest)}/4600`);
  } finally { await context.close(); }
}

let browser;
try {
  assert.ok(!(process.argv.includes('--desktop-only') && process.argv.includes('--touch-only')), 'Choose one subset, or neither to run the full suite');
  browser = await chromium.launch({ args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  if (!process.argv.includes('--desktop-only')) await touchRun(browser);
  if (!process.argv.includes('--touch-only')) await desktopRun(browser);
  assert.deepEqual(errors, [], 'Browser runtime/console errors');
  console.log(`PASS zero browser/console errors in ${Math.round((performance.now() - started) / 1000)}s`);
} catch (error) {
  if (errors.length) console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

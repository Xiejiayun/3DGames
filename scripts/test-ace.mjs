import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    const ext = extname(file);
    res.setHeader('content-type', ext === '.webp' ? 'image/webp' : ext === '.js' ? 'application/javascript' : 'text/html; charset=utf-8');
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', e => errors.push(`PAGEERROR: ${e}`));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`CONSOLE_ERROR: ${msg.text()}`);
  });

  await page.goto(`${origin}/games/ace.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ACE_DEBUG__ && window.__ACE_DEBUG__.getState().frameCount >= 5, null, { timeout: 20000 });

  let st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'hangar');
  assert.equal(st.lang, 'zh');

  // Switch aircraft & mission in Hangar
  await page.locator('[data-jet="1"]').click();
  await page.locator('[data-mission="1"]').click();
  await page.locator('#langBtn').click();
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.selJetIdx, 1);
  assert.equal(st.selMissionIdx, 1);
  assert.equal(st.lang, 'en');

  // Switch back to ZH, Mission 1, Jet 0 and launch sortie
  await page.locator('#langBtn').click();
  await page.locator('[data-jet="0"]').click();
  await page.locator('[data-mission="0"]').click();
  await page.locator('#sortieBtn').click();

  await page.waitForTimeout(350);
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'playing');
  assert.ok(st.enemiesAlive >= 4, 'Mission 1 enemies spawned');

  // Test weapons, flares, camera toggle (3P -> 1P -> 3P), pause & resume
  await page.keyboard.press('KeyV');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.cameraMode, '1p', 'Switched to 1P 3D cockpit');

  await page.keyboard.press('KeyV');
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyF');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.cameraMode, '3p');
  assert.equal(st.activeWeapon, 'spw');
  assert.ok(st.mslAmmo < 2, 'Standard missile fired');
  assert.ok(st.spwAmmo < 16, 'Special weapon fired');

  await page.keyboard.press('Escape');
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'paused');
  await page.locator('#btnResume').click();
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.mode, 'playing');

  // Test Mission 2 (Sunset Fjord) & Mission 3 (Storm Carrier) load cleanly
  await page.evaluate(() => window.__ACE_DEBUG__.startMission(1, 0));
  await page.waitForTimeout(450);
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.selMissionIdx, 1);
  assert.ok(st.enemiesAlive >= 8, 'Mission 2 radar/SAM/fighters spawned');

  if (process.env.CAPTURE_PREVIEW === '1') {
    // Capture an iconic 16:9 Sunset Fjord in-flight action screenshot!
    await page.keyboard.down('KeyW');
    await page.mouse.move(660, 340);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__ACE_DEBUG__.fireMissile());
    await page.waitForTimeout(180);
    const pngBuf = await page.screenshot({ type: 'png' });
    await page.keyboard.up('KeyW');

    const webpB64 = await page.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 960; c.height = 540;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, 960, 540);
      return c.toDataURL('image/webp', 0.88).split(',')[1];
    }, pngBuf.toString('base64'));
    await mkdir(resolve(root, 'assets/previews'), { recursive: true });
    await writeFile(resolve(root, 'assets/previews/ace-archipelago.webp'), Buffer.from(webpB64, 'base64'));
    console.log('Captured assets/previews/ace-archipelago.webp');
  }

  await page.evaluate(() => window.__ACE_DEBUG__.startMission(2, 2));
  await page.waitForTimeout(450);
  st = await page.evaluate(() => window.__ACE_DEBUG__.getState());
  assert.equal(st.selMissionIdx, 2);
  assert.ok(st.enemiesAlive >= 6, 'Mission 3 carrier fleet spawned');

  assert.deepEqual(errors, [], `Expected zero runtime/console errors, got: ${errors.join('; ')}`);
  console.log('PASS games/ace.html: hangar, 3 jets, 3 missions, 1P/3P cockpit, weapons/flares, pause, ZH/EN; zero errors');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Test the published files: missing build assets must fail, even if source files exist.
const root = new URL('../dist/', import.meta.url);
const directory = fileURLToPath(root).replace(/[\\/]$/, '');
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(directory, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(directory + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.setHeader('content-type', extname(file) === '.webp' ? 'image/webp' : 'text/html; charset=utf-8');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const games = ['cs', 'flappy', 'kart', 'ace', 'prism'].map(name => `games/${name}.html`);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (!r.ok()) errors.push(`${r.status()} ${r.url()}`); });
  const output = process.env.HOME_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin);
    await page.locator('.preview img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
    for (const lang of ['en', 'zh']) {
      await page.locator(`[data-lang="${lang}"]`).click();
      const state = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        overflow: document.documentElement.scrollWidth > innerWidth,
        columns: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length,
        cards: [...document.querySelectorAll('.card')].map(card => {
          const img = card.querySelector('.preview img'), link = img.closest('a'), box = img.getBoundingClientRect();
          return { width: img.naturalWidth, height: img.naturalHeight, alt: img.alt,
            ratio: box.width / box.height, href: link.getAttribute('href'), play: card.querySelector('.play').getAttribute('href'),
            label: card.querySelector('.preview-label').textContent,
            title: document.getElementById(link.getAttribute('aria-labelledby'))?.textContent };
        }),
      }));
      assert.equal(state.lang, lang === 'zh' ? 'zh-CN' : 'en');
      assert.equal(state.overflow, false, `${width}px: no horizontal overflow`);
      assert.equal(state.columns, width > 720 ? 2 : 1);
      assert.deepEqual(state.cards.map(card => card.href), games);
      for (const card of state.cards) {
        assert.equal(card.width, 960); assert.equal(card.height, 540);
        assert.ok(Math.abs(card.ratio - 16 / 9) < 0.01, 'preview retains full 16:9 frame');
        assert.equal(card.href, card.play); assert.ok(card.title);
        assert.match(card.alt, lang === 'zh' ? /实机画面/ : /gameplay:/);
        assert.equal(card.label, lang === 'zh' ? '实机截图' : 'In-game screenshot');
        const target = await page.request.get(new URL(card.href, origin).href);
        assert.equal(target.status(), 200, 'game entry is included in build');
      }
      if (output) await page.screenshot({ path: `${output}/homepage-${width}-${lang}.png`, fullPage: true });
    }
  }
  await page.locator('.preview').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(`${origin}/games/cs.html`, { waitUntil: 'commit' });
  assert.deepEqual(errors, []);
  console.log(`PASS built homepage: ${games.length} screenshots, ZH/EN, 4 viewports, game links, keyboard navigation; no page/HTTP errors`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}

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
if (!process.env.HOME_URL) await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = process.env.HOME_URL || `http://127.0.0.1:${server.address().port}`;
const games = [
  ['cs', 'midnight-port', '午夜港口', 'Midnight Port'], ['flappy', 'flappy-bird', '像素飞鸟', 'Flappy Bird 3D'],
  ['kart', 'turbo-kart', '极速卡丁车', 'Turbo Kart 3D'], ['ace', 'ace-archipelago', '王牌群岛', 'Ace Archipelago'],
  ['prism', 'prism-vault', '棱镜密室', 'Prism Vault'], ['ironcore', 'iron-core-arena', '铁核竞技场', 'Iron Core Arena'],
  ['skyhold', 'skyhold-bastion', '浮空要塞', 'Skyhold Bastion'],
].map(([slug, preview, zh, en]) => ({ href: `games/${slug}.html`, image: `assets/previews/${preview}.webp`, zh, en }));
const sizes = [[1920, 1080], [1920, 651], [1440, 900], [1440, 675], [1366, 768], [1280, 720], [1024, 768],
  [820, 1180], [768, 1024], [768, 600], [640, 480], [500, 568], [390, 844], [375, 667], [360, 640],
  [320, 740], [320, 568], [844, 390], [568, 320]];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (!r.ok()) errors.push(`${r.status()} ${r.url()}`); });
  const output = process.env.HOME_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  for (const game of games) {
    const target = await page.request.get(new URL(game.href, origin).href);
    assert.equal(target.status(), 200, game.href);
    assert.match(target.headers()['content-type'], /text\/html/, game.href);
    await target.dispose();
  }
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.goto(origin);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await page.locator('.preview img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
    for (const lang of ['en', 'zh']) {
      await page.locator(`[data-lang="${lang}"]`).click();
      const state = await page.evaluate(() => {
        const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const inside = (box, frame) => box.width > 0 && box.height > 0 && box.left >= frame.left - 1 &&
          box.top >= frame.top - 1 && box.right <= frame.right + 1 && box.bottom <= frame.bottom + 1;
        return { lang: document.documentElement.lang, selected: document.querySelector('[aria-pressed="true"]').dataset.lang,
          extent: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], scroll: [scrollX, scrollY],
          cards: [...document.querySelectorAll('.card')].map(card => {
            const image = card.querySelector('img'), link = card.querySelector('a'), title = card.querySelector('h2');
            const desc = card.querySelector('.desc'), launch = card.querySelector('.launch'), frame = card.getBoundingClientRect();
            const visible = [image, title, desc, launch].every(node => {
              const box = node.getBoundingClientRect();
              return inside(box, frame) && inside(box, viewport) && node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('a') === link;
            });
            const textFits = [title, desc, launch].every(node => {
              const range = document.createRange(); range.selectNodeContents(node);
              const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
              return [...range.getClientRects()].every(box => inside(box, frame) && inside(box, viewport) &&
                box.left >= bounds.left - 1 && box.right <= bounds.right + 1 &&
                (style.overflowY === 'visible' || inside(box, bounds)));
            });
            const art = image.getBoundingClientRect();
            return { visible: visible && inside(frame, viewport), textFits, href: link.getAttribute('href'), src: image.getAttribute('src'),
              title: title.innerText, description: desc.innerText, action: launch.innerText, alt: image.alt,
              size: [image.naturalWidth, image.naturalHeight], ratio: art.width / art.height };
          }) };
      });
      const label = `${width}×${height} / ${lang}`;
      assert.equal(state.lang, lang === 'zh' ? 'zh-CN' : 'en');
      assert.equal(state.selected, lang);
      assert.deepEqual(state.scroll, [0, 0], label);
      assert.deepEqual(state.extent, [width, height], `${label}: no page scrolling`);
      assert.deepEqual(state.cards.map(card => card.href), games.map(game => game.href));
      for (const [index, card] of state.cards.entries()) {
        const game = games[index];
        assert.ok(card.visible, `${label}: ${game.en} fully visible and clickable`);
        assert.ok(card.textFits, `${label}: ${game.en} text not clipped`);
        assert.deepEqual(card.size, [960, 540]); assert.equal(card.src, game.image);
        assert.ok(Math.abs(card.ratio - 16 / 9) < .01, 'full 16:9 preview');
        assert.equal(card.title, game[lang]); assert.equal(card.action, lang === 'zh' ? '开始游戏' : 'Play');
        assert.match(card.description, lang === 'zh' ? /[\u4e00-\u9fff]/ : /^[a-zA-Z]/);
        assert.match(card.alt, lang === 'zh' ? /实机画面/ : /gameplay:/);
        assert.equal(await page.getByRole('link', { name: `${card.action} ${card.title}`, exact: true }).count(), 1);
      }
      if (output) await page.screenshot({ path: `${output}/homepage-${width}x${height}-${lang}.png` });
    }
  }
  await page.locator('[data-lang="en"]').focus();
  for (const game of games) {
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('href'), game.href);
    assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [0, 0]);
  }
  await page.keyboard.press('Enter');
  await page.waitForURL(url => url.origin === new URL(origin).origin && /^\/games\/skyhold(?:\.html)?$/.test(url.pathname), { waitUntil: 'commit' });
  assert.deepEqual(errors, []);
  console.log(`PASS ${origin}: ${games.length} playable cards, ZH/EN, ${sizes.length} viewports with no scrolling or clipping, 16:9 screenshots and keyboard navigation`);
} finally {
  await browser?.close();
  if (server.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

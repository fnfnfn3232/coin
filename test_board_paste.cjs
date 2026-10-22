const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(root, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  const post = { id: 'paste-test-post', title: 'Existing post', body: '<p>Saved original text</p>', htmlEnabled: true,
    author: 'Tester', category: 'free', createdAt: Date.now() };
  const snapshot = { generatedAt: Math.floor(Date.now() / 1000), fxUsdKrw: 1350,
    boards: { binance: [{ symbol: 'BTC', pair: 'BTC/USDT', name: 'Bitcoin', priceUsd: 100, sortCapUsd: 1000 }], upbit: [], bithumb: [], coinbase: [], robinhood: [] },
    futures: {}, stats: {}, coinInfo: {}, news: { items: [] }, notes: {} };
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'fnfnfn3232.github.io') {
        if (url.pathname === '/coin/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
        if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: `window.BOARD_DATA = ${JSON.stringify(snapshot)};`, contentType: 'text/javascript' });
        const file = path.resolve(root, '.' + url.pathname.replace(/^\/coin/, ''));
        return route.fulfill({ body: file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '', contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      }
      if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ body: '' });
      let result = {};
      if (url.pathname === '/api/session') {
        result = { authenticated: true, role: 'admin', expiresAt: Date.now() + 86400000,
          extensionCount: 0, token: 'paste-test-session' };
      } else if (url.pathname === '/api/market-data') result = snapshot;
      else if (url.pathname === '/api/board/posts') result = { posts: [post] };
      else if (url.pathname.includes('/api/board/posts/')) result = { posts: [post], post };
      else if (url.pathname === '/api/board/categories') result = { categories: [{ value: 'free', label: 'Free board' }] };
      else if (url.pathname === '/api/screen-settings') result = { settings: {} };
      else if (url.pathname === '/api/news') result = { items: [], total: 0, hasMore: false };
      else if (/^\/api\/l[12]-fees$/.test(url.pathname)) result = { fetchedAt: Date.now(), rows: [{ slug: 'ethereum', name: 'Ethereum', total24h: 1 }] };
      return route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
    });
    await page.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.body.classList.contains('locked'));
    await page.locator('#boardToggleBtn').click();
    await page.waitForSelector('[data-free-board-write]');

    async function seed(text) {
      const editor = page.locator('#freeBoardRichEditor');
      await editor.fill(text);
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.evaluate(() => saveFreeBoardRichEditorSelection());
      return editor;
    }
    async function selectRange(start, end) {
      await page.locator('#freeBoardRichEditor').evaluate((editor, offsets) => {
        const range = document.createRange();
        const boundary = offset => {
          const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (offset <= node.length) return [node, offset];
            offset -= node.length;
          }
          throw new Error('Selection offset exceeds editor text');
        };
        range.setStart(...boundary(offsets[0]));
        range.setEnd(...boundary(offsets[1]));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, [start, end]);
    }
    async function paste(text, htmlText = '') {
      return page.locator('#freeBoardRichEditor').evaluate((editor, data) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', data.text);
        if (data.htmlText) clipboardData.setData('text/html', data.htmlText);
        const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
        editor.dispatchEvent(event);
        return event.defaultPrevented;
      }, { text, htmlText });
    }
    async function assertBody(text, message) {
      assert.equal(await page.locator('#freeBoardRichEditor').textContent(), text, message);
      const stored = await page.locator('#freeBoardBody').inputValue();
      const actual = await page.evaluate(value => { const node = document.createElement('div'); node.innerHTML = value; return node.textContent; }, stored);
      assert.equal(actual, text, `${message}: hidden submitted body stays in sync`);
    }

    for (const mode of ['write', 'edit']) {
      if (mode === 'write') await page.locator('[data-free-board-write]').click();
      else {
        await page.locator('#boardToggleBtn').click();
        await page.evaluate(() => { freeBoardMode = 'list'; renderFreeBoard(); });
        await page.locator('[data-free-board-open="paste-test-post"]:visible').click();
        await page.locator('[data-free-board-edit="paste-test-post"]').click();
      }
      await page.waitForSelector('#freeBoardRichEditor');
      await seed('Original text must disappear');
      // Keep Ctrl+A held so no keyup has saved the new selection before paste.
      await page.keyboard.down('Control');
      await page.keyboard.down('a');
      assert.equal(await paste('Replaced text'), true);
      await page.keyboard.up('a');
      await page.keyboard.up('Control');
      await assertBody('Replaced text', `${mode}: fast Ctrl+A then paste replaces all content`);
      await page.keyboard.press('Control+z');
      await assertBody('Original text must disappear', `${mode}: undo restores replaced text`);
      await page.keyboard.press('Control+Shift+z');
      await assertBody('Replaced text', `${mode}: redo reapplies replacement`);

      await seed('prefix OLD suffix');
      await selectRange(7, 10);
      await paste('NEW');
      await assertBody('prefix NEW suffix', `${mode}: partial selection is replaced`);
      await seed('left right');
      await selectRange(5, 5);
      await paste('middle ');
      await assertBody('left middle right', `${mode}: current caret wins over stale saved caret`);

      await page.locator('#freeBoardRichEditor').evaluate(editor => {
        editor.innerHTML = '<p>alpha <strong>OLD</strong> omega</p>';
        editor.focus();
        const saved = document.createRange();
        saved.selectNodeContents(editor);
        saved.collapse(false);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(saved);
        saveFreeBoardRichEditorSelection(editor);
        const current = document.createRange();
        current.selectNodeContents(editor.querySelector('strong'));
        selection.removeAllRanges();
        selection.addRange(current);
      });
      await paste('NEW');
      await assertBody('alpha NEW omega', `${mode}: selections inside formatted paragraphs are replaced`);

      await seed('Old');
      await selectRange(0, 3);
      const unsafe = '<img src=x onerror=alert(1)>\n한글 붙여넣기';
      await paste(unsafe, '<img src=x onerror=alert(1)><script>alert(1)</script>');
      assert.equal(await page.locator('#freeBoardRichEditor img, #freeBoardRichEditor script').count(), 0);
      assert.ok((await page.locator('#freeBoardRichEditor').textContent()).includes('<img src=x onerror=alert(1)>'));
      assert.ok((await page.locator('#freeBoardBody').inputValue()).includes('&lt;img'));

      await seed('Replace text with media link');
      await selectRange(0, 'Replace text with media link'.length);
      await paste('https://example.com/picture.png');
      await assertBody('', `${mode}: media-only URL paste replaces selected body too`);
      assert.equal(await page.evaluate(() => freeBoardComposeMediaTokens.length), 1);

      await seed('Keep adjacent letters');
      await selectRange(5, 5);
      await paste('https://example.com/video.mp4');
      await assertBody('Keep adjacent letters', `${mode}: media-only paste at a caret does not delete adjacent text`);
      assert.equal(await page.evaluate(() => freeBoardComposeMediaTokens.length), 2);

      await seed('Keep this when attachment limit is exceeded');
      await selectRange(0, 'Keep this when attachment limit is exceeded'.length);
      await page.evaluate(() => {
        freeBoardComposeMediaTokens = Array.from({ length: FREE_BOARD_MAX_MEDIA }, (_, i) => createComposeMediaToken('image', `https://example.com/${i}.png`));
      });
      assert.equal(await paste('https://example.com/overflow.png', '<img src=x onerror=alert(1)>'), true, 'rejected media paste cannot fall through to unsafe native HTML insertion');
      await assertBody('Keep this when attachment limit is exceeded', `${mode}: rejected paste preserves current text`);
      await page.evaluate(() => { freeBoardComposeMediaTokens = []; });
      console.log(`PASS: ${mode} paste replacement, stale-selection handling, caret insertion, undo/redo, safe plain text, media conversion and rejected-paste preservation.`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

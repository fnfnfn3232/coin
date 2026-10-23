const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(root, 'index.html'), 'utf8');
  const base = 'https://fnfnfn3232.github.io/coin/';
  const snapshot = { generatedAt: Math.floor(Date.now() / 1000), fxUsdKrw: 1350,
    boards: { binance: [{ symbol: 'BTC', pair: 'BTC/USDT', name: 'Bitcoin', priceUsd: 100, sortCapUsd: 1000 }], upbit: [], bithumb: [], coinbase: [], robinhood: [] },
    futures: {}, stats: {}, coinInfo: {}, news: { items: [] }, notes: {} };
  const posts = ['one', 'two'].map((id, i) => ({ id: `post-${id}`, title: `Shared post ${id}`, body: `Private body ${id}`, category: 'free', createdAt: Date.now() - i }));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
  const failures = [];
  async function test(name, options, run) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const state = { authenticated: options.authenticated !== false, read: options.read !== false, held: Boolean(options.held), postStatus: options.postStatus || 200, requests: [], waiters: [] };
    const errors = [];
    context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(({ cachedPosts, savedView, clipboardDenied }) => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
        if (clipboardDenied) throw new Error('Clipboard denied');
        window.copiedPostUrl = text;
      } } });
      if (cachedPosts) sessionStorage.setItem('blockscope_content_cache_v1', JSON.stringify({ subject: 'member:reader', board: { posts: cachedPosts, fetchedAt: Date.now() } }));
      if (savedView) sessionStorage.setItem('fdv_app_view_state_v1', JSON.stringify({ app: 'exchange-market-cap', ...savedView }));
    }, { cachedPosts: options.cachedPosts, savedView: options.savedView, clipboardDenied: options.clipboardDenied });
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'fnfnfn3232.github.io') {
        if (url.pathname === '/coin/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
        if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: `window.BOARD_DATA = ${JSON.stringify(snapshot)};`, contentType: 'text/javascript' });
        const file = path.resolve(root, '.' + url.pathname.replace(/^\/coin/, ''));
        return route.fulfill({ body: file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '', contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      }
      if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ body: '' });
      state.requests.push(url.pathname);
      const session = { authenticated: true, role: 'member', subject: 'reader', boardReadApproved: state.read, boardWriteApproved: false,
        expiresAt: Date.now() + 86400000, token: 'link-test-session', extensionCount: 0 };
      let result = {}, status = 200;
      if (url.pathname === '/api/session') {
        result = state.authenticated ? session : { error: 'auth_required' };
        status = state.authenticated ? 200 : 401;
      } else if (url.pathname === '/api/login/member/password') { state.authenticated = true; result = session; }
      else if (url.pathname === '/api/market-data') result = snapshot;
      else if (url.pathname === '/api/board/posts') {
        if (state.held) await new Promise(resolve => state.waiters.push(resolve));
        status = state.postStatus;
        result = status === 200 ? { posts } : { error: 'temporary_failure' };
      } else if (url.pathname.includes('/api/board/posts/')) result = { posts, post: posts[0] };
      else if (url.pathname === '/api/board/categories') result = { categories: [{ value: 'free', label: 'Free board' }] };
      else if (url.pathname === '/api/news') result = { items: [], total: 0, hasMore: false };
      else if (url.pathname === '/api/screen-settings') result = { settings: {} };
      return route.fulfill({ status, json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
    });
    const release = () => { state.held = false; state.waiters.splice(0).forEach(resolve => resolve()); };
    try {
      await page.goto(base + (options.hash || ''), { waitUntil: 'domcontentloaded' });
      await run({ page, context, state, release });
      assert.deepEqual(errors, []);
      console.log(`PASS: ${name}`);
    } catch (error) { failures.push(name); console.error(`FAIL: ${name}: ${error.message}`); }
    finally { release(); await context.close(); }
  }
  try {
    await test('opening a post changes the address; copying it opens the exact post in a clean tab', {}, async ({ page, context }) => {
      await page.waitForFunction(() => siteAuthConfirmed && freeBoardPostsLoaded);
      await page.locator('#boardToggleBtn').click();
      await page.locator('[data-free-board-open="post-two"]:visible').click();
      assert.equal(page.url(), base + '#board/post/post-two');
      await page.locator('[data-free-board-copy-link]').click();
      assert.equal(await page.evaluate(() => copiedPostUrl), page.url());
      const second = await context.newPage();
      await second.goto(page.url(), { waitUntil: 'domcontentloaded' });
      await second.waitForSelector('.free-board-read-title', { timeout: 5000 });
      assert.equal(await second.locator('.free-board-read-title').textContent(), 'Shared post two');
    });
    await test('explicit post URL overrides old session view and survives reload', {
      hash: '#board/post/post-two', savedView: { viewMode: 'board', freeBoardMode: 'read', freeBoardSelectedId: 'post-one' },
    }, async ({ page }) => {
      await page.waitForFunction(() => siteAuthConfirmed && freeBoardPostsLoaded);
      assert.equal(await page.evaluate(() => freeBoardSelectedId), 'post-two');
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Shared post two');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Shared post two');
    });
    await test('login preserves the destination and does not fetch protected posts before authentication', {
      hash: '#board/post/post-two', authenticated: false,
    }, async ({ page, state }) => {
      await page.waitForFunction(() => isSiteLocked() && !siteLockCheckPromise);
      assert.equal(page.url(), base + '#board/post/post-two');
      assert.equal(state.requests.includes('/api/board/posts'), false);
      await page.locator('#lockMemberEmailInput').fill('reader@example.com');
      await page.locator('#lockMemberPasswordInput').fill('test-password');
      await page.locator('#lockMemberPasswordInput').press('Enter');
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Shared post two');
    });
    await test('slow post loading preserves the deep link rather than showing the home page', { hash: '#board/post/post-two', held: true }, async ({ page, state, release }) => {
      await page.waitForFunction(() => siteAuthConfirmed);
      assert.equal(await page.evaluate(() => state.viewMode), 'board');
      assert.equal(await page.evaluate(() => freeBoardSelectedId), 'post-two');
      assert.equal(page.url(), base + '#board/post/post-two');
      assert.equal(state.requests.filter(path => path === '/api/board/posts').length, 1);
      release();
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
    });
    await test('a fresh cache missing the requested post is refreshed once', { hash: '#board/post/post-two', cachedPosts: [posts[0]] }, async ({ page, state }) => {
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Shared post two');
      assert.equal(state.requests.filter(path => path === '/api/board/posts').length, 1);
    });
    await test('missing posts get a clear notice; back and forward retain the correct post', { hash: '#board/post/missing-post' }, async ({ page }) => {
      await page.waitForFunction(() => siteAuthConfirmed && freeBoardPostsLoaded);
      assert.ok((await page.locator('#newsPanel').textContent()).includes('찾을 수 없는 게시글'));
      await page.locator('[data-free-board-list]').click();
      await page.locator('[data-free-board-open="post-two"]:visible').click();
      await page.locator('[data-free-board-list]').click();
      assert.equal(page.url(), base + '#board');
      await page.goBack();
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Shared post two');
      await page.goForward();
      await page.waitForSelector('.free-board-list', { timeout: 5000 });
      await page.locator('#marketToggleBtn').click();
      assert.equal(new URL(page.url()).hash, '');
    });
    await test('a shared URL does not grant board access to an unapproved account', { hash: '#board/post/post-two', read: false }, async ({ page, state }) => {
      await page.waitForFunction(() => siteAuthConfirmed);
      assert.equal(state.requests.includes('/api/board/posts'), false);
      assert.equal(await page.locator('.free-board-read-title').count(), 0);
      assert.equal(await page.evaluate(() => freeBoardServerPosts.length), 0);
    });
    await test('malformed post identifiers are ignored safely', { hash: '#board/post/%E0%A4%A' }, async ({ page }) => {
      await page.waitForFunction(() => siteAuthConfirmed);
      assert.equal(await page.locator('.free-board-read-title').count(), 0);
    });
    await test('temporary failures show a retry state instead of falsely claiming the post was deleted', { hash: '#board/post/post-two', postStatus: 503 }, async ({ page, state }) => {
      await page.waitForSelector('[data-free-board-retry]', { timeout: 5000 });
      assert.ok(!(await page.locator('#newsPanel').textContent()).includes('찾을 수 없는 게시글'));
      assert.equal(state.requests.filter(path => path === '/api/board/posts').length, 1);
      state.postStatus = 200;
      await page.locator('[data-free-board-retry]').click();
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Shared post two');
    });
    await test('hash navigation selects another post without a full reload or extra list request', { hash: '#board/post/post-one' }, async ({ page, state }) => {
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      const requests = state.requests.filter(path => path === '/api/board/posts').length;
      await page.evaluate(() => { location.hash = 'board/post/post-two'; });
      await page.waitForFunction(() => document.querySelector('.free-board-read-title')?.textContent === 'Shared post two');
      assert.equal(state.requests.filter(path => path === '/api/board/posts').length, requests);
    });
    await test('clipboard denial is reported honestly and the share controls fit narrow mobile screens', { hash: '#board/post/post-two', clipboardDenied: true }, async ({ page }) => {
      await page.waitForSelector('.free-board-read-title', { timeout: 5000 });
      await page.locator('[data-free-board-copy-link]').click();
      assert.ok((await page.locator('[data-free-board-share-status]').textContent()).includes('복사하지 못했습니다'));
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.screenshot({ path: path.join(os.tmpdir(), 'board-links-320.png'), fullPage: true });
    });
  } finally { await browser.close(); }
  assert.deepEqual(failures, [], 'post URL regressions');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

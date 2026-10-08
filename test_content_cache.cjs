const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(root, 'index.html'), 'utf8');
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'board_snapshot.json'), 'utf8'));
  const cacheKey = 'blockscope_content_cache_v1';
  const news = { query: '', items: [{ id: 'cached-news', title: 'Cached news headline', summary: 'News summary', publishAt: Date.now() }], total: 1, storedCount: 1, nextOffset: 1, hasMore: false };
  const posts = [{ id: 'cached-post', title: 'Cached board title', body: 'Private board body', author: 'Tester', category: 'free', createdAt: Date.now() }];
  snapshot.news = news;
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const calls = [], errors = [], waiters = [];
    let sessionSeen;
    const sessionRequest = new Promise(resolve => { sessionSeen = resolve; });
    const held = new Set(['/api/session']);
    let boardStatus = 200, newsStatus = 200, boardReadApproved = true, memberSubject = 'member-a';
    page.on('pageerror', error => errors.push(error.message));
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'fnfnfn3232.github.io') {
        if (url.pathname === '/coin/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
        if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: 'window.BOARD_DATA = undefined;', contentType: 'text/javascript' });
        const file = path.resolve(root, '.' + url.pathname.replace(/^\/coin/, ''));
        return route.fulfill({ body: file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '', contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      }
      if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ body: '' });
      calls.push(url.pathname + url.search);
      if (url.pathname === '/api/session') sessionSeen();
      if (held.has(url.pathname)) await new Promise(resolve => waiters.push({ path: url.pathname, resolve }));
      let result = {}, status = 200;
      if (url.pathname === '/api/session') {
        const expiresAt = Date.now() + 86400000;
        result = { authenticated: true, role: 'member', subject: memberSubject, boardReadApproved, boardWriteApproved: false,
          expiresAt, extensionCount: 0, token: `v3.${Math.floor(expiresAt / 1000)}.0.member.${memberSubject}.test.signature` };
      } else if (url.pathname === '/api/market-data') result = snapshot;
      else if (url.pathname === '/api/news') {
        status = newsStatus;
        const query = url.searchParams.get('q') || '';
        result = status === 200 ? { ...news, query, items: query ? [{ ...news.items[0], title: 'Search result headline' }] : news.items } : { error: 'upstream_unavailable' };
      } else if (url.pathname === '/api/board/posts') {
        status = boardStatus;
        result = status === 200 ? { posts } : { error: status === 403 ? 'board_access_approval_required' : 'temporary_failure' };
      } else if (url.pathname === '/api/board/categories') result = { categories: [{ value: 'free', label: 'Free board' }] };
      else if (url.pathname === '/api/screen-settings') result = { settings: {} };
      else if (/^\/api\/l[12]-fees$/.test(url.pathname)) result = { fetchedAt: Date.now(), rows: [{ slug: 'ethereum', name: 'Ethereum', total24h: 100, total7d: 700, total30d: 3000, change1d: 0 }] };
      else if (url.pathname === '/api/live-prices') result = { boards: {}, futures: {} };
      return route.fulfill({ status, json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
    });
    function release(pathname) {
      held.delete(pathname);
      for (const waiter of waiters.filter(item => item.path === pathname)) waiter.resolve();
    }
    const count = pathname => calls.filter(call => call.split('?')[0] === pathname).length;
    await page.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
    await sessionRequest;
    assert.equal(count('/api/news'), 0, 'no news prefetch before verified login');
    assert.equal(count('/api/board/posts'), 0, 'no private board prefetch before verified login');
    release('/api/session');
    await page.waitForFunction(key => {
      const cache = JSON.parse(sessionStorage.getItem(key) || 'null');
      return cache?.news?.payload?.items?.length && cache?.board?.posts?.length && cache?.board?.categories?.length;
    }, cacheKey);
    assert.equal(count('/api/board/posts'), 1);
    assert.equal(count('/api/board/categories'), 1);
    const newsCount = count('/api/news');
    await page.locator('#newsToggleBtn').click();
    assert.ok(await page.locator('.news-item').count(), 'news appears on the first menu click');
    assert.ok((await page.locator('.news-text-box').textContent()).includes('News summary'));
    await page.locator('#boardToggleBtn').click();
    assert.ok((await page.locator('.free-board-list').textContent()).includes('Cached board title'), 'prefetched board appears on the first click');
    assert.equal(await page.locator('[data-free-board-write]').count(), 0, 'cache never grants writing to a read-only member');
    assert.equal(count('/api/board/posts'), 1, 'switching tabs does not force another board request');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.free-board-list');
    assert.ok((await page.locator('.free-board-list').textContent()).includes('Cached board title'), 'reload restores private board after permission verification');
    assert.equal(count('/api/board/posts'), 1, 'fresh board cache avoids unnecessary reload requests');
    await page.locator('#newsToggleBtn').click();
    assert.equal(count('/api/news'), newsCount, 'news menu and reload reuse fresh cache');
    await page.locator('#newsSearchForm input').fill('Ethereum');
    assert.ok((await page.locator('.news-item').textContent()).includes('Cached news headline'), 'typing does not submit a news search');
    await page.locator('#newsSearchForm').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('.news-item')?.textContent.includes('Search result headline'));
    await page.locator('[data-news-clear]').click();
    assert.ok((await page.locator('.news-item').textContent()).includes('Cached news headline'), 'clearing search instantly restores the original news');

    await page.evaluate(key => {
      const cache = JSON.parse(sessionStorage.getItem(key));
      cache.news.fetchedAt = Date.now() - 11 * 60000;
      cache.board.fetchedAt = Date.now() - 60000;
      sessionStorage.setItem(key, JSON.stringify(cache));
    }, cacheKey);
    held.add('/api/news');
    held.add('/api/board/posts');
    boardStatus = 503;
    newsStatus = 503;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.news-item');
    assert.ok((await page.locator('.news-item').textContent()).includes('Cached news headline'), 'stale news remains visible while its API is held');
    await page.locator('#boardToggleBtn').click();
    assert.ok((await page.locator('.free-board-list').textContent()).includes('Cached board title'), 'stale board remains visible while its API is held');
    release('/api/news');
    release('/api/board/posts');
    await page.waitForFunction(() => document.querySelector('.free-board-list .news-refresh-status.error'));
    assert.ok((await page.locator('.free-board-list').textContent()).includes('Cached board title'), 'temporary failure preserves readable posts');
    await page.locator('#newsToggleBtn').click();
    assert.ok((await page.locator('.news-item').textContent()).includes('Cached news headline'), 'failed refresh never clears the original news');
    const failedNewsCalls = count('/api/news');
    await page.locator('#boardToggleBtn').click();
    await page.locator('#newsToggleBtn').click();
    assert.equal(count('/api/news'), failedNewsCalls, 'failed news refresh has a cooldown instead of a re-render request loop');
    await page.locator('#boardToggleBtn').click();

    boardStatus = 403;
    newsStatus = 200;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#boardToggleBtn').classList.contains('board-access-hidden'));
    assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null')?.board || null, cacheKey), null, 'board API denial immediately purges private cache');
    boardStatus = 200;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key) || 'null')?.board?.posts?.length, cacheKey);
    await page.locator('#boardToggleBtn').click();
    await page.evaluate(key => {
      const cache = JSON.parse(sessionStorage.getItem(key));
      cache.news.fetchedAt = Date.now() - 11 * 60000;
      cache.board.fetchedAt = Date.now() - 60000;
      sessionStorage.setItem(key, JSON.stringify(cache));
    }, cacheKey);

    // A pending private response must not resurrect a logged-out user's cache.
    boardStatus = 200;
    newsStatus = 200;
    held.add('/api/board/posts');
    held.add('/api/news');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.free-board-list');
    await page.locator('#lockLogoutBtn').click();
    await page.waitForFunction(() => document.body.classList.contains('locked'));
    release('/api/board/posts');
    release('/api/news');
    await page.waitForFunction(key => sessionStorage.getItem(key) === null, cacheKey);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), cacheKey), null);

    // Read approval must be current, not inferred from a cached list.
    boardReadApproved = false;
    await page.evaluate(({ key, news, posts }) => {
      sessionStorage.setItem(key, JSON.stringify({ subject: 'member:member-a', news: { payload: news, fetchedAt: Date.now() }, board: { posts, fetchedAt: Date.now() } }));
    }, { key: cacheKey, news, posts });
    const beforeDenied = count('/api/board/posts');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.body.classList.contains('locked'));
    assert.equal(count('/api/board/posts'), beforeDenied, 'revoked members never prefetch private posts');
    assert.ok(await page.locator('#boardToggleBtn').evaluate(button => button.classList.contains('board-access-hidden')));
    assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null')?.board || null, cacheKey), null);

    boardReadApproved = true;
    memberSubject = 'member-b';
    held.add('/api/board/posts');
    await page.evaluate(({ key, posts }) => {
      sessionStorage.setItem(key, JSON.stringify({ subject: 'member:member-a', board: { posts: [{ ...posts[0], title: 'Foreign saved post' }], fetchedAt: Date.now() } }));
    }, { key: cacheKey, posts });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#boardToggleBtn').classList.contains('board-access-hidden'));
    await page.locator('#boardToggleBtn').click();
    assert.ok(!(await page.locator('.free-board-list').textContent()).includes('Foreign saved post'), 'another account cannot inherit cached private posts');
    release('/api/board/posts');
    await page.waitForFunction(() => document.querySelector('.free-board-list')?.textContent.includes('Cached board title'));
    assert.deepEqual(errors, []);
    console.log('PASS: verified-login prefetch, instant news/board navigation and reload, news search reset, desktop/mobile layout, upstream failure, read-only access, logout races and revoked approval.');
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

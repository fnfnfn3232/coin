const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(root, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  const snapshot = { generatedAt: Math.floor(Date.now() / 1000), fxUsdKrw: 1350,
    boards: { binance: [{ symbol: 'BTC', pair: 'BTC/USDT', name: 'Bitcoin', priceUsd: 100, sortCapUsd: 1000 }], upbit: [], bithumb: [], coinbase: [], robinhood: [] },
    futures: {}, stats: {}, coinInfo: {}, news: { items: [] }, notes: {} };
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
  const failures = [];
  async function test(name, run, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const calls = [], errors = [], waiters = [];
    const held = new Set(options.held || []);
    let posts = [{ id: 'workflow-post', title: 'Original title', body: '<p>Original body</p>', htmlEnabled: true,
      author: 'Tester', authorMemberId: 'writer', category: 'free', createdAt: Date.now(), comments: [] }];
    let failPosts = false, failSave = false;
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
      const method = route.request().method(), key = `${method} ${url.pathname}`;
      calls.push(key);
      if (held.has(key)) await new Promise(resolve => waiters.push({ key, resolve }));
      let result = {}, status = 200;
      if (url.pathname === '/api/session') {
        result = { authenticated: true, role: options.member ? 'member' : 'admin', subject: 'writer', boardReadApproved: true, boardWriteApproved: true,
          expiresAt: Date.now() + 86400000, extensionCount: 0, token: 'workflow-session' };
      } else if (url.pathname === '/api/market-data') result = snapshot;
      else if (key === 'GET /api/board/posts') {
        status = failPosts ? 503 : 200;
        result = status === 200 ? { posts } : { error: 'temporary_failure' };
      } else if (key === 'POST /api/board/posts' || key === 'PUT /api/board/posts/workflow-post') {
        if (failSave) { status = 503; result = { error: 'temporary_failure' }; }
        else {
          const body = route.request().postDataJSON();
          const post = { ...posts[0], ...body, id: method === 'POST' ? `created-${calls.length}` : 'workflow-post' };
          posts = method === 'POST' ? [post, ...posts] : [post];
          result = { posts, post };
        }
      } else if (key === 'POST /api/board/posts/workflow-post/comments') {
        const comment = { ...route.request().postDataJSON(), id: 'new-comment', createdAt: Date.now() };
        posts[0].comments.push(comment);
        result = { posts, post: posts[0], comment };
      } else if (url.pathname.startsWith('/api/board/posts/')) result = { posts, post: posts[0] };
      else if (url.pathname === '/api/board/categories') result = { categories: [{ value: 'free', label: 'Free board' }, { value: 'games', label: 'Games' }] };
      else if (url.pathname === '/api/screen-settings') result = { settings: {} };
      else if (url.pathname === '/api/news') result = { items: [], total: 0, hasMore: false };
      return route.fulfill({ status, json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
    });
    const count = key => calls.filter(call => call === key).length;
    const release = key => { held.delete(key); waiters.filter(item => item.key === key).forEach(item => item.resolve()); };
    async function write() {
      await page.locator('#boardToggleBtn').click();
      await page.locator('[data-free-board-write]').click();
      await page.locator('#freeBoardTitle').fill('Draft title');
      await page.locator('#freeBoardPassword').fill('post-password');
      await page.locator('#freeBoardRichEditor').fill('Draft body');
    }
    async function read() {
      await page.locator('#boardToggleBtn').click();
      await page.locator('[data-free-board-open="workflow-post"]:visible').click();
      await page.waitForSelector('#freeBoardCommentForm');
    }
    async function submit() { await page.locator('#freeBoardForm').evaluate(form => form.requestSubmit()); }
    async function installUploadStub() {
      await page.evaluate(() => {
        window.pendingUploads = [];
        uploadFreeBoardAttachment = file => new Promise((resolve, reject) => pendingUploads.push({ name: file.name, resolve, reject }));
      });
    }
    async function files(names) {
      await page.locator('#freeBoardFileInput').setInputFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: Buffer.from('test image') })));
    }
    try {
      await page.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => siteAuthConfirmed && freeBoardPostsLoaded);
      await run({ page, write, read, submit, count, held, release, installUploadStub, files,
        failPosts: value => { failPosts = value; }, failSave: value => { failSave = value; } });
      assert.deepEqual(errors, []);
      console.log(`PASS: ${name}`);
    } catch (error) { failures.push(name); console.error(`FAIL: ${name}: ${error.message}`); }
    finally { for (const key of held) release(key); await context.close(); }
  }
  try {
    await test('admin can save an edit using its existing authenticated session', async ({ page, read, count }) => {
      await read();
      await page.locator('[data-free-board-edit="workflow-post"]').click();
      await page.locator('#freeBoardTitle').fill('Admin edited');
      await page.locator('#freeBoardForm').evaluate(form => form.requestSubmit());
      await page.waitForTimeout(100);
      assert.equal(count('PUT /api/board/posts/workflow-post'), 1);
      await page.waitForSelector('.free-board-read-title');
      assert.equal(await page.locator('.free-board-read-title').textContent(), 'Admin edited');
    });
    await test('double submission creates one post and failure preserves a retryable draft', async ({ page, write, submit, held, release, count, failSave }) => {
      await write();
      const key = 'POST /api/board/posts';
      held.add(key);
      failSave(true);
      await submit(); await submit();
      await page.waitForTimeout(100);
      assert.equal(count(key), 1);
      release(key);
      await page.waitForFunction(() => document.querySelector('#freeBoardMessage')?.classList.contains('error'));
      assert.equal(await page.locator('#freeBoardTitle').inputValue(), 'Draft title');
      assert.equal(await page.locator('#freeBoardRichEditor').textContent(), 'Draft body');
      assert.equal(await page.locator('#freeBoardForm button[type=submit]').isEnabled(), true);
      failSave(false);
      await submit();
      await page.waitForSelector('.free-board-list');
      assert.equal(count(key), 2);
    }, { member: true });
    await test('delayed categories preserve draft fields, editor node and selection', async ({ page, write, release }) => {
      await write();
      await page.evaluate(() => { window.draftEditor = getFreeBoardRichEditor(); draftEditor.focus(); });
      release('GET /api/board/categories');
      await page.waitForFunction(() => freeBoardCategoriesLoaded && !freeBoardCategoriesPromise);
      assert.equal(await page.locator('#freeBoardTitle').inputValue(), 'Draft title');
      assert.equal(await page.locator('#freeBoardRichEditor').textContent(), 'Draft body');
      assert.equal(await page.evaluate(() => draftEditor === getFreeBoardRichEditor() && document.activeElement === draftEditor), true);
      assert.equal(await page.locator('#freeBoardCategory option[value=games]').count(), 1);
    }, { held: ['GET /api/board/categories'] });
    await test('confirmed comment does not become a failure when a redundant refresh fails', async ({ page, read, failPosts, count }) => {
      await read();
      failPosts(true);
      await page.locator('#freeBoardCommentForm [name=body]').fill('A saved comment');
      await page.locator('#freeBoardCommentForm [name=commentPassword]').fill('comment-password');
      const reads = count('GET /api/board/posts');
      await page.locator('#freeBoardCommentForm').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => !freeBoardCommentSubmitting);
      assert.equal(count('POST /api/board/posts/workflow-post/comments'), 1);
      assert.equal(count('GET /api/board/posts'), reads);
      assert.equal(await page.locator('#freeBoardCommentForm [name=body]').inputValue(), '');
      assert.ok((await page.locator('.free-board-comment-list').textContent()).includes('A saved comment'));
    });
    await test('upload blocks premature save and overlapping batches; successful files survive later failure', async ({ page, write, submit, count, installUploadStub, files }) => {
      await write(); await installUploadStub();
      await files(['one.png', 'two.png']);
      await page.waitForFunction(() => pendingUploads.length === 1);
      await submit();
      assert.equal(count('POST /api/board/posts'), 0);
      await files(['overlap.png']);
      assert.equal(await page.evaluate(() => pendingUploads.length), 1);
      await page.evaluate(() => pendingUploads[0].resolve({ url: 'https://example.com/one.png', size: 10, fileName: 'one.png' }));
      await page.waitForFunction(() => pendingUploads.length === 2);
      await page.evaluate(() => pendingUploads[1].reject(new Error('upload_failed')));
      await page.waitForFunction(() => document.querySelector('#freeBoardMessage')?.classList.contains('error'));
      assert.equal(await page.evaluate(() => freeBoardComposeMediaTokens.length), 1);
      assert.ok((await page.locator('#freeBoardComposeAttachments').textContent()).includes('one.png'));
      assert.equal(await page.locator('#freeBoardForm button[type=submit]').isEnabled(), true);
    });
    await test('late upload completion cannot attach a file to a different draft', async ({ page, write, installUploadStub, files }) => {
      await write(); await installUploadStub(); await files(['old.png']);
      await page.waitForFunction(() => pendingUploads.length === 1);
      await page.locator('[data-free-board-list]').click();
      await page.locator('[data-free-board-write]').click();
      await page.locator('#freeBoardRichEditor').fill('New draft');
      await page.evaluate(() => pendingUploads[0].resolve({ url: 'https://example.com/old.png', size: 10, fileName: 'old.png' }));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => freeBoardComposeMediaTokens.length), 0);
      assert.equal(await page.locator('#freeBoardRichEditor').textContent(), 'New draft');
    });
    await test('Korean IME Enter commits composition without triggering board search', async ({ page }) => {
      await page.locator('#boardToggleBtn').click();
      await page.locator('#freeBoardSearchInput').fill('한글');
      await page.locator('#freeBoardSearchInput').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
      assert.equal(await page.evaluate(() => freeBoardQuery), '');
      await page.locator('#freeBoardSearchInput').press('Enter');
      assert.equal(await page.evaluate(() => freeBoardQuery), '한글');
    });
    await test('background and comment refreshes preserve the same comment draft and focus', async ({ page, read }) => {
      await read();
      await page.locator('#freeBoardCommentForm [name=author]').fill('Nickname');
      await page.locator('#freeBoardCommentForm [name=commentPassword]').fill('password');
      await page.locator('#freeBoardCommentForm [name=body]').fill('Unfinished comment');
      await page.locator('#freeBoardCommentForm [name=body]').focus();
      await page.locator('#freeBoardCommentForm [name=body]').evaluate(input => input.setSelectionRange(3, 7));
      await page.evaluate(() => { window.commentDraft = document.getElementById('freeBoardCommentForm'); renderFreeBoard(); });
      await page.evaluate(() => renderFreeBoardCommentsSection({ preserveScroll: true }));
      assert.equal(await page.locator('#freeBoardCommentForm [name=body]').inputValue(), 'Unfinished comment');
      assert.equal(await page.locator('#freeBoardCommentForm [name=commentPassword]').inputValue(), 'password');
      assert.equal(await page.evaluate(() => commentDraft === document.getElementById('freeBoardCommentForm') && document.activeElement.name === 'body'), true);
      assert.deepEqual(await page.locator('#freeBoardCommentForm [name=body]').evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 7]);
    });
    await test('late view response cannot restore private posts after logout', async ({ page, read, held, release }) => {
      const key = 'POST /api/board/posts/workflow-post/view';
      held.add(key);
      await read();
      await page.locator('#lockLogoutBtn').click();
      await page.waitForFunction(() => document.body.classList.contains('locked'));
      release(key);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => freeBoardServerPosts.length), 0);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('blockscope_content_cache_v1')), null);
    });
    await test('late save completion does not replace a newly opened draft', async ({ page, write, submit, held, release, count }) => {
      await write();
      const key = 'POST /api/board/posts';
      held.add(key);
      await submit();
      await page.waitForFunction(() => freeBoardPostSubmissions.has(document.getElementById('freeBoardForm')));
      await page.locator('[data-free-board-list]').click();
      await page.locator('[data-free-board-write]').click();
      await page.locator('#freeBoardTitle').fill('New draft must stay');
      release(key);
      await page.waitForTimeout(150);
      assert.equal(count(key), 1);
      assert.equal(await page.locator('#freeBoardTitle').inputValue(), 'New draft must stay');
    });
    await test('clipboard image upload uses the same guarded attachment flow', async ({ page, write, installUploadStub }) => {
      await write(); await installUploadStub();
      await page.locator('#freeBoardRichEditor').evaluate(editor => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File(['image'], 'clipboard.png', { type: 'image/png' }));
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => pendingUploads.length === 1);
      assert.equal(await page.locator('#freeBoardForm button[type=submit]').isDisabled(), true);
      await page.evaluate(() => pendingUploads[0].resolve({ url: 'https://example.com/clipboard.png', size: 5, fileName: 'clipboard.png' }));
      await page.waitForFunction(() => !freeBoardUploadForms.has(document.getElementById('freeBoardForm')));
      assert.equal(await page.evaluate(() => freeBoardComposeMediaTokens.length), 1);
      assert.equal(await page.locator('#freeBoardForm button[type=submit]').isEnabled(), true);
    });
    await test('body search uses visible text rather than HTML tags and encoded entities', async ({ page }) => {
      const matches = await page.evaluate(() => {
        freeBoardSearchType = 'body';
        const posts = [{ id: 'formatted', body: '<p>솔<strong>라나</strong> &amp; 비트코인</p><p>다음 줄</p>', htmlEnabled: true, category: 'free' }];
        return ['솔라나 & 비트코인', '비트코인 다음 줄', 'strong'].map(query => {
          freeBoardQuery = query;
          return getFilteredFreeBoardPosts(posts).length;
        });
      });
      assert.deepEqual(matches, [1, 1, 0]);
    });
    await test('desktop and mobile board read/write/edit remain usable without page overflow', async ({ page, read }) => {
      await read();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.locator('[data-free-board-edit="workflow-post"]').click();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.equal(await page.locator('#freeBoardRichEditor').isVisible(), true);
        if (width !== 390) await page.screenshot({ path: path.join(os.tmpdir(), `board-workflow-${width}.png`), fullPage: true });
      }
    });
  } finally { await browser.close(); }
  assert.deepEqual(failures, [], 'board workflow regressions');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const origin = 'https://fnfnfn3232.github.io';
  const site = origin + '/coin/';
  const fixture = require('./test_market_fixture.cjs')();
  const now = Date.now();
  const seed = { id: 'sky-initial-issue', title: 'Sky protocol 사태 · stUSDS 관련 이슈',
    body: '관리자가 등록한 내용\n\n유저들이 예치해놓은 stUSDS 풀\n한국 투자자들은 투자자피해 발생 가능',
    createdAt: now, updatedAt: now, revision: 1, author: '관리자' };
  const posts = new Map([['SKY:skyprotocol', [seed]]]);
  for (const [exchange, rows] of Object.entries(fixture.boards)) {
    rows.unshift({ ...rows[0], exchange, symbol: 'SKY', name: '스카이프로토콜', koreanName: '스카이프로토콜',
      englishName: 'Sky', pair: 'SKY/USDT', nameKeys: ['SKY', 'Sky', '스카이프로토콜'] });
  }
  fixture.coinInfo.SKY = { koreanName: '스카이프로토콜', englishName: 'Sky',
    sources: { bithumb: { description: '거래소 공식 소개', assetName: 'Sky Protocol' } }, listings: {} };
  fixture.coinInfo.BTC = { englishName: 'Bitcoin', koreanName: '비트코인', sources: {}, listings: {} };
  fixture.coinInfo.ETH = { englishName: 'Ethereum', koreanName: '이더리움', sources: {}, listings: {} };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const errors = [];
  const requests = [];
  let slowAsset = '';
  let releaseSlow;
  let failIssueLists = false;
  let detailDelayMs = 0;
  try {
    async function start(role, clock = false) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      const expiresAt = Date.now() + 3600000;
      const token = `v3.${Math.floor(expiresAt / 1000)}.issues-test.${role}.owner.0.test`;
      await context.addInitScript(token => {
        sessionStorage.setItem('fdv_server_auth_session_token_v1', token);
        window.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} };
      }, token);
      await context.route('https://**/*', async route => {
        const url = new URL(route.request().url());
        const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' };
        if (url.origin === origin) {
          const file = path.join(__dirname, url.pathname.slice('/coin/'.length) || 'index.html');
          if (file.endsWith('data.js')) return route.fulfill({ body: 'window.BOARD_DATA=null;', contentType: 'text/javascript' });
          return route.fulfill({ body: fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : '',
            contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
        }
        if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ json: {}, headers });
        if (url.pathname === '/api/session') return route.fulfill({ json: {
          ok: true, token, expiresAt, role, subject: 'owner', boardReadApproved: true, boardWriteApproved: false,
        }, headers });
        if (url.pathname === '/api/market-data') return route.fulfill({ json: fixture, headers });
        if (!url.pathname.startsWith('/api/coin-issues')) return route.fulfill({ json: {}, headers });
        const asset = url.searchParams.get('asset');
        const method = route.request().method();
        const id = url.pathname.split('/')[3];
        const section = url.searchParams.get('section') || 'all';
        requests.push({ asset, method, id, section });
        if (asset === slowAsset && method === 'GET' && section === 'issues') await new Promise(resolve => { releaseSlow = resolve; });
        const allRecords = posts.get(asset) || [];
        const records = allRecords.filter(post => section === 'all' || section === (post.source === 'coinness' ? 'news' : 'issues'));
        if (method === 'GET') {
          if (id) {
            if (detailDelayMs) await new Promise(resolve => setTimeout(resolve, detailDelayMs));
            const post = records.find(item => item.id === id);
            return route.fulfill({ json: post ? { post } : { error: 'issue_not_found' }, status: post ? 200 : 404, headers });
          }
          if (failIssueLists) return route.fulfill({ json: { error: 'temporary_failure' }, status: 503, headers });
          let remaining = 24 * 1024;
          const includedPosts = records.slice(0, 10).filter(post => {
            const bytes = Buffer.byteLength(JSON.stringify(post));
            if (bytes > 8 * 1024 || bytes > remaining) return false;
            remaining -= bytes; return true;
          });
          return route.fulfill({ json: { items: records.map(({ body, ...post }) => post), includedPosts, total: records.length, page: 1 }, headers });
        }
        const body = route.request().postDataJSON();
        if (role !== 'admin') return route.fulfill({ json: { error: 'admin_required' }, status: 403, headers });
        if (body.adminPassword !== 'correct') return route.fulfill({ json: { error: 'invalid_password' }, status: 401, headers });
        const old = records.find(item => item.id === id);
        if (method === 'DELETE') {
          posts.set(asset, allRecords.filter(item => item.id !== id));
          return route.fulfill({ json: { ok: true }, headers });
        }
        const post = { id: old?.id || body.id, title: body.title, body: body.body,
          createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(), revision: (old?.revision || 0) + 1, author: '관리자' };
        posts.set(asset, [post, ...allRecords.filter(item => item.id !== post.id)]);
        return route.fulfill({ json: { post }, headers });
      });
      const page = await context.newPage();
      if (clock) await page.clock.install();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(site);
      await page.waitForFunction(() => siteAuthConfirmed && data.boards.upbit.length);
      return { context, page };
    }
    const { page, context } = await start('admin');
    assert.deepEqual(await page.evaluate(() => {
      data.coinInfo.XLM = { englishName: 'Stellar' };
      data.coinInfo.AI = { englishName: 'Gensyn' };
      return [
        coinIssueAssetKey({ symbol: 'XLM', englishName: 'Lumen' }),
        coinIssueAssetKey({ symbol: 'AI', englishName: 'Sleepless AI' }),
        coinIssueAssetKey({ symbol: 'AI', englishName: 'Gensyn' }),
      ];
    }), ['XLM:stellar', 'AI:sleeplessai', 'AI:gensyn']);
    await page.getByRole('button', { name: '스카이프로토콜 코인 정보 보기' }).click();
    assert.match(await page.locator('#coinInfoBody').textContent(), /거래소 공식 소개/);
    await page.waitForFunction(() => coinIssuesCache.has('SKY:skyprotocol:issues:1') && coinIssuesCache.has('SKY:skyprotocol:news:1'));
    assert.equal(requests.length, 2, 'opening the introduction prefetches only that coin, one list per section');
    assert.equal(requests[0].asset, 'SKY:skyprotocol');
    await page.locator('#coinIssuesTab').click();
    await page.getByRole('button', { name: seed.title, exact: true }).waitFor();
    detailDelayMs = 750;
    const beforeFirstRead = requests.length;
    const firstRead = await page.evaluate(id => {
      const start = performance.now();
      document.querySelector(`[data-coin-issue-id="${id}"]`).click();
      return { text: document.querySelector('.coin-issue-text')?.textContent, elapsed: performance.now() - start };
    }, seed.id);
    assert.equal(firstRead.text, seed.body, 'the first click renders the included body synchronously');
    assert.ok(firstRead.elapsed < 100, 'opening included text does not wait for the intentionally delayed API');
    assert.equal(requests.length, beforeFirstRead, 'opening an included article makes no extra HTTP request');
    detailDelayMs = 0;
    assert.equal(await page.locator('.coin-issue-text').textContent(), seed.body);
    assert.match(await page.locator('.coin-issues-meta').textContent(), /관리자 작성/);
    async function assertQuietDelete(target) {
      const layout = await target.locator('[data-coin-issue-action="delete"]').evaluate(button => {
        const bounds = button.getBoundingClientRect();
        const article = button.closest('article');
        return { top: bounds.top, right: bounds.right, articleRight: article.getBoundingClientRect().right,
          bodyBottom: article.querySelector('.coin-issue-text').getBoundingClientRect().bottom,
          background: getComputedStyle(button).backgroundColor, footer: Boolean(button.closest('.coin-issue-footer')) };
      });
      assert.ok(layout.footer && layout.top >= layout.bodyBottom, 'delete follows the article body');
      assert.ok(Math.abs(layout.right - layout.articleRight) < 2, 'delete is right aligned');
      assert.equal(layout.background, 'rgba(0, 0, 0, 0)', 'delete has no red or filled background');
      const list = await target.locator('.coin-issue-footer [data-coin-issue-action="list"]').evaluate(button => ({
        x: button.getBoundingClientRect().left, articleX: button.closest('article').getBoundingClientRect().left,
        y: button.getBoundingClientRect().top, bodyY: button.closest('article').querySelector('.coin-issue-text').getBoundingClientRect().bottom,
      }));
      assert.ok(Math.abs(list.x - list.articleX) < 2 && list.y >= list.bodyY, 'list stays at the bottom left');
    }
    await assertQuietDelete(page);
    await page.getByRole('button', { name: '목록', exact: true }).click();
    await page.getByRole('button', { name: '글쓰기', exact: true }).click();
    const title = page.locator('#coinIssueForm input[name="title"]');
    const body = page.locator('#coinIssueForm textarea');
    const password = page.locator('#coinIssueForm input[type="password"]');
    await title.fill('새 이슈 <img src=x onerror=alert(1)>');
    await body.fill('첫째 줄\n둘째 줄\n<script>window.__attack = true</script>');
    await page.locator('#coinIssuesTab').click();
    assert.match(await body.inputValue(), /첫째 줄/, 'clicking the selected tab does not discard a draft');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#coinNewsTab').click();
    assert.match(await body.inputValue(), /첫째 줄/, 'declining a tab switch preserves the draft');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    }), true);
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#coinInfoCloseBtn').click();
    assert.equal(await page.locator('#coinInfoModal').isVisible(), true, 'canceling the discard prompt preserves the editor');
    await password.fill('wrong');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('coinIssueError').textContent.includes('올바르지'));
    assert.equal(await password.inputValue(), '');
    assert.match(await body.inputValue(), /둘째 줄/, 'bad password preserves the text draft');
    await password.fill('correct');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForSelector('.coin-issue-text');
    assert.equal(await page.locator('#coinIssuesPanel script, #coinIssuesPanel img').count(), 0);
    assert.equal(await page.evaluate(() => window.__attack), undefined);
    await page.getByRole('button', { name: '수정', exact: true }).click();
    await body.fill('수정된 내용\n' + '읽기 쉬운 텍스트입니다. '.repeat(80));
    await password.fill('correct');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForSelector('.coin-issue-text');
    assert.match(await page.locator('.coin-issue-text').textContent(), /수정된 내용/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#coinIssuesPanel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    const screenshotRoot = process.env.COIN_ISSUES_SCREENSHOTS || os.tmpdir();
    await page.locator('#coinInfoModal').screenshot({ path: path.join(screenshotRoot, 'coin-issues-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.locator('#coinInfoModal').screenshot({ path: path.join(screenshotRoot, 'coin-issues-desktop.png') });
    await page.locator('#coinInfoCloseBtn').click();
    await page.reload();
    await page.waitForFunction(() => siteAuthConfirmed);
    await page.getByRole('button', { name: '스카이프로토콜 코인 정보 보기' }).click();
    await page.locator('#coinIssuesTab').click();
    await page.getByRole('button', { name: /새 이슈/ }).click();
    assert.match(await page.locator('.coin-issue-text').textContent(), /수정된 내용/, 'server-saved issue survives reload');
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await password.fill('correct');
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await page.waitForSelector('.coin-issues-list');
    assert.equal(await page.getByRole('button', { name: /새 이슈/ }).count(), 0);
    await page.locator('#coinInfoCloseBtn').click();
    await page.evaluate(() => openCoinInfo('BTC'));
    await page.locator('#coinIssuesTab').click();
    await page.waitForFunction(() => document.getElementById('coinIssuesPanel').textContent.includes('등록된 이슈가 없습니다.'));
    assert.doesNotMatch(await page.locator('#coinIssuesPanel').textContent(), /Sky protocol 사태/);
    await page.locator('#coinInfoCloseBtn').click();
    slowAsset = 'ETH:ethereum';
    await page.evaluate(() => openCoinInfo('ETH'));
    await page.locator('#coinIssuesTab').click();
    await page.waitForFunction(() => document.getElementById('coinIssuesPanel').textContent.includes('불러오는 중'));
    await page.evaluate(() => openCoinInfo('SKY'));
    await page.locator('#coinIssuesTab').click();
    for (let i = 0; !releaseSlow && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof releaseSlow, 'function');
    releaseSlow();
    await page.waitForSelector('.coin-issues-list');
    assert.match(await page.locator('#coinIssuesPanel').textContent(), /Sky protocol 사태/);
    await page.evaluate(() => clearSiteLoginState());
    assert.equal(await page.locator('#coinInfoModal').isVisible(), false);
    assert.equal(await page.locator('#coinIssuesPanel').textContent(), '');
    assert.equal(await page.evaluate(() => coinIssuesCache.size), 0);
    await context.close();
    const member = await start('member');
    await member.page.getByRole('button', { name: '스카이프로토콜 코인 정보 보기' }).click();
    await member.page.locator('#coinIssuesTab').click();
    await member.page.getByRole('button', { name: seed.title, exact: true }).click();
    assert.equal(await member.page.getByRole('button', { name: '글쓰기', exact: true }).count(), 0);
    assert.equal(await member.page.getByRole('button', { name: '수정', exact: true }).count(), 0);
    assert.equal(await member.page.getByRole('button', { name: '삭제', exact: true }).count(), 0);
    await member.context.close();

    const automatic = { id: 'coinness-123456', title: 'SKY 자동 뉴스', body: '요약 <img src=x onerror=alert(1)>',
      source: 'coinness', sourceUrl: 'https://coinness.com/news/123456', createdAt: now - 1000, updatedAt: now - 1000, revision: 1 };
    posts.set('SKY:skyprotocol', [seed, automatic]);
    slowAsset = '';
    const live = await start('admin', true), livePage = live.page;
    await livePage.evaluate(() => openCoinInfo('SKY'));
    await livePage.locator('#coinNewsTab').click();
    assert.equal(await livePage.getByRole('button', { name: '글쓰기', exact: true }).count(), 0, 'news is automatic only');
    assert.equal(await livePage.getByRole('button', { name: seed.title, exact: true }).count(), 0, 'manual issues do not leak into news');
    const autoRequests = requests.filter(request => request.id === automatic.id).length;
    await livePage.getByRole('button', { name: automatic.title, exact: true }).click();
    assert.equal(requests.filter(request => request.id === automatic.id).length, autoRequests, 'automatic summaries open from the list payload');
    assert.match(await livePage.locator('.coin-issues-meta').textContent(), /코인니스 · 자동등록/);
    assert.equal(await livePage.getByRole('link', { name: '코인니스 원문 보기' }).getAttribute('href'), automatic.sourceUrl);
    await assertQuietDelete(livePage);
    assert.equal(await livePage.getByRole('button', { name: '수정', exact: true }).count(), 0);
    assert.equal(await livePage.locator('#coinIssuesPanel img').count(), 0);
    await livePage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await livePage.locator('#coinIssuesPanel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await livePage.locator('#coinInfoModal').screenshot({ path: path.join(screenshotRoot, 'coin-automatic-news-mobile.png') });
    await livePage.setViewportSize({ width: 1440, height: 980 });
    await livePage.getByRole('button', { name: '목록', exact: true }).click();
    const originalCacheAt = await livePage.evaluate(() => coinIssuesCache.get('SKY:skyprotocol:news:1').at);
    await livePage.clock.fastForward(1000);
    await livePage.getByRole('button', { name: automatic.title, exact: true }).click();
    await livePage.getByRole('button', { name: '목록', exact: true }).click();
    assert.equal(await livePage.evaluate(() => coinIssuesCache.get('SKY:skyprotocol:news:1').at), originalCacheAt,
      'reopening cached lists does not postpone their freshness deadline');
    const next = { ...automatic, id: 'coinness-123457', title: '추가 자동 뉴스', sourceUrl: 'javascript:alert(1)' };
    posts.set('SKY:skyprotocol', [next, seed, automatic]);
    await livePage.clock.fastForward(61000);
    await livePage.getByRole('button', { name: next.title, exact: true }).waitFor();
    await livePage.getByRole('button', { name: next.title, exact: true }).click();
    assert.equal(await livePage.getByRole('link', { name: '코인니스 원문 보기' }).count(), 0, 'only canonical Coinness article URLs become links');
    await livePage.getByRole('button', { name: '목록', exact: true }).click();
    failIssueLists = true;
    await livePage.clock.fastForward(61000);
    await livePage.getByText('자동 뉴스 연결 지연 · 기존 글은 유지됩니다.').waitFor();
    assert.equal(await livePage.getByRole('button', { name: automatic.title, exact: true }).isVisible(), true);
    failIssueLists = false;
    await livePage.locator('#coinIssuesTab').click();
    await livePage.getByRole('button', { name: seed.title, exact: true }).waitFor();
    slowAsset = 'SKY:skyprotocol'; releaseSlow = undefined;
    await livePage.clock.fastForward(61000);
    for (let i = 0; !releaseSlow && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof releaseSlow, 'function');
    await livePage.getByRole('button', { name: '글쓰기', exact: true }).click();
    await livePage.locator('#coinIssueForm input[name="title"]').fill('작성 중인 제목');
    await livePage.locator('#coinIssueForm textarea').fill('백그라운드 뉴스가 와도 유지');
    releaseSlow(); slowAsset = '';
    await livePage.waitForTimeout(150);
    assert.equal(await livePage.locator('#coinIssueForm textarea').inputValue(), '백그라운드 뉴스가 와도 유지');
    const beforeDraftPoll = requests.length;
    await livePage.clock.fastForward(61000);
    assert.equal(requests.length, beforeDraftPoll, 'editing drafts never trigger automatic issue refresh');
    livePage.once('dialog', dialog => dialog.accept());
    await livePage.getByRole('button', { name: '취소', exact: true }).click();
    await livePage.locator('#coinNewsTab').click();
    await livePage.getByRole('button', { name: automatic.title, exact: true }).click();
    await livePage.getByRole('button', { name: '삭제', exact: true }).click();
    assert.equal(await livePage.locator('#coinIssueForm input[type="password"]').isVisible(), true);
    await livePage.locator('#coinIssueForm input[type="password"]').fill('correct');
    await livePage.getByRole('button', { name: '삭제', exact: true }).click();
    await livePage.locator('.coin-issues-list').waitFor();
    assert.equal(await livePage.getByRole('button', { name: automatic.title, exact: true }).count(), 0);
    const telegram = { ...seed, id: 'telegram-123abc', title: '공개 채널의 SKY 언급', source: 'telegram',
      sourceName: '@BChoSN', sourceUrl: 'https://t.me/BChoSN/123', body: '짧은 발췌 <script>alert(1)</script>' };
    posts.set('SKY:skyprotocol', [seed, telegram, next]);
    await livePage.evaluate(async () => { await invalidateCoinIssueLists(coinIssuesView.asset); });
    await livePage.locator('#coinIssuesTab').click();
    await livePage.getByRole('button', { name: telegram.title, exact: true }).click();
    assert.match(await livePage.locator('.coin-issues-meta').textContent(), /@BChoSN · 발췌 · 자동등록/);
    assert.equal(await livePage.getByRole('link', { name: '텔레그램 원문 보기' }).getAttribute('href'), telegram.sourceUrl);
    assert.equal(await livePage.getByRole('button', { name: '수정', exact: true }).count(), 0);
    assert.equal(await livePage.locator('#coinIssuesPanel script').count(), 0);
    await assertQuietDelete(livePage);
    await livePage.locator('#coinInfoModal').screenshot({ path: path.join(screenshotRoot, 'coin-telegram-issue-desktop.png') });
    await livePage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await livePage.locator('#coinIssuesPanel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await livePage.locator('#coinInfoModal').screenshot({ path: path.join(screenshotRoot, 'coin-telegram-issue-mobile.png') });
    await livePage.setViewportSize({ width: 1440, height: 980 });
    await livePage.locator('#coinIssuesTab').focus();
    await livePage.keyboard.press('Home');
    assert.equal(await livePage.locator('#coinIntroTab').getAttribute('aria-selected'), 'true');
    await livePage.keyboard.press('ArrowRight');
    assert.equal(await livePage.locator('#coinNewsTab').getAttribute('aria-selected'), 'true');
    assert.equal(await livePage.getByRole('button', { name: telegram.title, exact: true }).count(), 0);
    await livePage.keyboard.press('End');
    assert.equal(await livePage.locator('#coinIssuesTab').getAttribute('aria-selected'), 'true');
    await livePage.locator('#coinInfoCloseBtn').click();
    const afterClose = requests.length;
    await livePage.clock.fastForward(61000);
    assert.equal(requests.length, afterClose, 'closed modals do not poll coin issue data');

    const long = { ...seed, id: 'long-manual-issue', title: '긴 수동 글', body: '긴 본문입니다.\n'.repeat(1500) };
    posts.set('SKY:skyprotocol', [seed, long]);
    await livePage.evaluate(() => { coinIssuesCache.clear(); openCoinInfo('SKY'); });
    await livePage.locator('#coinIssuesTab').click();
    const longButton = livePage.getByRole('button', { name: long.title, exact: true });
    await longButton.waitFor();
    assert.equal(requests.filter(request => request.id === long.id).length, 0, 'large manual bodies are not bulk-downloaded with the list');
    detailDelayMs = 250;
    await longButton.hover();
    await longButton.click();
    await livePage.locator('.coin-issue-text').waitFor();
    assert.equal(await livePage.locator('.coin-issue-text').textContent(), long.body);
    assert.equal(requests.filter(request => request.id === long.id).length, 1, 'hover and click share one large-body request');
    await livePage.getByRole('button', { name: '목록', exact: true }).click();
    const repeat = await livePage.evaluate(id => {
      document.querySelector(`[data-coin-issue-id="${id}"]`).click();
      return document.querySelector('.coin-issue-text')?.textContent;
    }, long.id);
    assert.equal(repeat, long.body, 'reopening a fetched large article is synchronous');
    assert.equal(requests.filter(request => request.id === long.id).length, 1);
    await livePage.getByRole('button', { name: '목록', exact: true }).click();
    posts.set('SKY:skyprotocol', [seed, { ...long, revision: 2, body: '새로 수정한 긴 글\n'.repeat(1500) }]);
    await livePage.clock.fastForward(61000);
    await livePage.waitForFunction(() => coinIssuesView.items.some(post => post.id === 'long-manual-issue' && post.revision === 2));
    await livePage.getByRole('button', { name: long.title, exact: true }).click();
    await livePage.waitForFunction(() => document.querySelector('.coin-issue-text')?.textContent.startsWith('새로 수정한 긴 글'));
    assert.equal(requests.filter(request => request.id === long.id).length, 2, 'new revisions invalidate cached bodies');
    const expired = await livePage.evaluate(id => {
      const view = coinIssuesView;
      localStorage.setItem(LOCK_AUTH_UNTIL_KEY, String(Date.now() - 1));
      loadCoinIssues(id);
      return { confirmed: siteAuthConfirmed, details: view.details.size, pending: view.pendingDetails.size,
        hidden: document.getElementById('coinInfoModal').classList.contains('hidden') };
    }, seed.id);
    assert.deepEqual(expired, { confirmed: false, details: 0, pending: 0, hidden: true }, 'expired login cannot open private cached text');
    assert.equal(await livePage.evaluate(() => coinIssuesCache.size), 0);
    await live.context.close();
    assert.deepEqual(errors, []);
    console.log('PASS: synchronous first/repeat article opening without detail HTTP, bounded inline bodies, coalesced long-body prefetch, revision invalidation, admin CRUD, automatic news, XSS, drafts, expiry/logout privacy and responsive layout');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

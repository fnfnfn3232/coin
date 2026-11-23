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
  try {
    async function start(role) {
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
        requests.push({ asset, method });
        if (asset === slowAsset && method === 'GET') await new Promise(resolve => { releaseSlow = resolve; });
        const records = posts.get(asset) || [];
        const id = url.pathname.split('/')[3];
        if (method === 'GET') {
          if (id) {
            const post = records.find(item => item.id === id);
            return route.fulfill({ json: post ? { post } : { error: 'issue_not_found' }, status: post ? 200 : 404, headers });
          }
          return route.fulfill({ json: { items: records.map(({ body, ...post }) => post), total: records.length, page: 1 }, headers });
        }
        const body = route.request().postDataJSON();
        if (role !== 'admin') return route.fulfill({ json: { error: 'admin_required' }, status: 403, headers });
        if (body.adminPassword !== 'correct') return route.fulfill({ json: { error: 'invalid_password' }, status: 401, headers });
        const old = records.find(item => item.id === id);
        if (method === 'DELETE') {
          posts.set(asset, records.filter(item => item.id !== id));
          return route.fulfill({ json: { ok: true }, headers });
        }
        const post = { id: old?.id || body.id, title: body.title, body: body.body,
          createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(), revision: (old?.revision || 0) + 1, author: '관리자' };
        posts.set(asset, [post, ...records.filter(item => item.id !== post.id)]);
        return route.fulfill({ json: { post }, headers });
      });
      const page = await context.newPage();
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
    assert.equal(requests.length, 0, 'opening the introduction does not fetch every coin issue board');
    await page.locator('#coinIssuesTab').click();
    await page.getByRole('button', { name: seed.title, exact: true }).click();
    assert.equal(await page.locator('.coin-issue-text').textContent(), seed.body);
    assert.match(await page.locator('.coin-issues-meta').textContent(), /관리자 작성/);
    await page.getByRole('button', { name: '목록', exact: true }).click();
    await page.getByRole('button', { name: '글쓰기', exact: true }).click();
    const title = page.locator('#coinIssueForm input[name="title"]');
    const body = page.locator('#coinIssueForm textarea');
    const password = page.locator('#coinIssueForm input[type="password"]');
    await title.fill('새 이슈 <img src=x onerror=alert(1)>');
    await body.fill('첫째 줄\n둘째 줄\n<script>window.__attack = true</script>');
    await page.locator('#coinIssuesTab').click();
    assert.match(await body.inputValue(), /첫째 줄/, 'clicking the selected tab does not discard a draft');
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
    assert.deepEqual(errors, []);
    console.log('PASS: per-asset issues, lazy loading, admin text CRUD, password failures, XSS, reload, stale responses, logout privacy, member read-only and desktop/mobile layout');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

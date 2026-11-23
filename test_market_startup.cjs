const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const site = 'https://fnfnfn3232.github.io/coin/';
  const cacheKey = 'fdv_last_good_data_v5';
  const snapshot = require('./test_market_fixture.cjs')();
  snapshot.coinInfo.EXTRA = { description: 'x'.repeat(700000) };
  snapshot.coinInfo.BTC = { englishName: 'Bitcoin', koreanName: '비트코인', sources: {
    bithumb: { description: 'Complete Bitcoin introduction retained beyond localStorage quota.' } }, listings: {} };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  let releaseSettings, releaseMarket, releaseLive;
  const heldIntroductions = [];
  let holdIntroduction = false;
  let issueCalls = 0;
  const issueAssets = [];
  const issue = { id: 'btc-test', title: 'Bitcoin cached issue', body: 'Already fetched issue body.', revision: 1,
    createdAt: Date.now(), updatedAt: Date.now() };
  let holdMarket = false, marketCalls = 0, marketStatus = 200;
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(key => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) {
        if (name === key && value.length > 256 * 1024) throw new DOMException('Synthetic storage quota', 'QuotaExceededError');
        return setItem.call(this, name, value);
      };
      window.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} };
    }, cacheKey);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(site).origin) {
        const file = path.resolve(__dirname, url.pathname.slice('/coin/'.length) || 'index.html');
        return route.fulfill({ body: file.endsWith('data.js') ? 'window.BOARD_DATA=null;'
          : file.startsWith(__dirname + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : '',
        contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
      }
      const headers = { 'Access-Control-Allow-Origin': new URL(site).origin, 'Access-Control-Allow-Credentials': 'true' };
      let result = {};
      if (url.pathname === '/api/session') {
        const expiresAt = Date.now() + 3600000;
        result = { role: 'member', subject: 'startup-test', expiresAt,
          token: `v3.${Math.floor(expiresAt / 1000)}.0.member.startup-test.0.test` };
      } else if (url.pathname === '/api/screen-settings') {
        await new Promise(resolve => { releaseSettings = resolve; });
        result = { settings: {}, exists: false };
      } else if (url.pathname === '/api/market-data') {
        marketCalls++;
        if (holdMarket) await new Promise(resolve => { releaseMarket = resolve; });
        result = snapshot;
      } else if (url.pathname === '/api/live-prices') {
        await new Promise(resolve => { releaseLive = resolve; });
        result = { prices: {}, caps: {} };
      } else if (url.pathname === '/api/coin-issues') {
        issueCalls++;
        issueAssets.push(url.searchParams.get('asset'));
        result = { items: [issue], includedPosts: [issue], total: 1 };
      } else if (url.pathname === '/api/coin-info') {
        if (holdIntroduction) await new Promise(resolve => heldIntroductions.push(resolve));
        const symbol = url.searchParams.get('symbol');
        result = { symbol, generatedAt: snapshot.generatedAt, info: snapshot.coinInfo[symbol] || null };
      }
      return route.fulfill({ json: result, headers, status: url.pathname === '/api/market-data' ? marketStatus : 200 });
    });
    await page.goto(site, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && Boolean(screenSettingsServerRequest));
    await page.waitForFunction(() => document.querySelector('#tableBody [data-coin-info-symbol]'), null, { timeout: 2000 });
    assert.equal(marketCalls, 1, 'market snapshot is fetched while screen settings are still held');
    assert.ok(releaseSettings, 'settings remain unresolved when the coins appear');
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || 'null')?.startupOnly, cacheKey);
    const cache = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), cacheKey);
    assert.ok(cache.boards.upbit.length, 'quota-safe startup cache retains every Upbit row');
    assert.equal(cache.generatedAt, snapshot.generatedAt, 'cache does not fabricate a newer observation time');
    assert.ok(JSON.stringify(cache).length < 256 * 1024);
    assert.equal(cache.coinInfo.BTC.englishName, 'Bitcoin', 'compact cache retains canonical issue identity');
    await page.waitForFunction(async () => Boolean((await BlockscopeCoinDetailCache.read('introductions', comparisonCacheOwner(), 86400000, () => true))?.payload.coinInfo.BTC));
    releaseSettings();
    holdMarket = true;
    holdIntroduction = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && Boolean(marketDataLoadPromise));
    assert.ok(await page.locator('#tableBody [data-coin-info-symbol]').count(), 'cached coins remain visible with both APIs held');
    await page.evaluate(() => openCoinInfo('BTC'));
    await page.waitForFunction(() => document.getElementById('coinInfoBody').textContent.includes('Complete Bitcoin introduction'));
    assert.match(await page.locator('#coinInfoTitle').textContent(), /비트코인/);
    if (process.env.MARKET_STARTUP_SCREENSHOTS) await page.locator('#coinInfoModal').screenshot({
      path: path.join(process.env.MARKET_STARTUP_SCREENSHOTS, 'coin-introduction-cached.png') });
    assert.equal(await page.evaluate(() => coinIssuesView.asset), 'BTC:bitcoin');
    await page.waitForFunction(() => coinIssuesCache.has('BTC:bitcoin:1'));
    assert.equal(await page.evaluate(() => {
      document.getElementById('coinIssuesTab').click();
      return document.getElementById('coinIssuesPanel').textContent.includes('Bitcoin cached issue');
    }), true, 'the issue tab renders its prefetched list in the click task');
    if (process.env.MARKET_STARTUP_SCREENSHOTS) await page.locator('#coinInfoModal').screenshot({
      path: path.join(process.env.MARKET_STARTUP_SCREENSHOTS, 'coin-issues-prefetched.png') });
    await page.waitForFunction(async () => Boolean(await BlockscopeCoinDetailCache.read('issues:BTC:bitcoin:1', comparisonCacheOwner(), 60000, () => true)));
    const beforeIssueReload = issueCalls;
    releaseSettings();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && Boolean(marketDataLoadPromise));
    await page.evaluate(() => openCoinInfo('BTC'));
    await page.waitForFunction(() => coinIssuesCache.has('BTC:bitcoin:1'));
    await page.locator('#coinIssuesTab').click();
    assert.match(await page.locator('#coinIssuesPanel').textContent(), /Bitcoin cached issue/);
    assert.equal(issueCalls, beforeIssueReload, 'reload reuses a fresh owner-bound issue list without a network round trip');
    await page.evaluate(async key => {
      await BlockscopeCoinDetailCache.clear();
      const legacy = JSON.parse(localStorage.getItem(key)); legacy.coinInfo = {};
      localStorage.setItem(key, JSON.stringify(legacy));
    }, cacheKey);
    releaseSettings();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && Boolean(marketDataLoadPromise));
    await page.evaluate(() => openCoinInfo('BTC'));
    assert.match(await page.locator('#coinInfoBody').textContent(), /불러오는 중/);
    assert.doesNotMatch(await page.locator('#coinInfoBody').textContent(), /정보 없음/);
    await page.locator('#coinIssuesTab').click();
    releaseMarket();
    releaseSettings();
    await page.waitForFunction(() => document.getElementById('coinInfoBody').textContent.includes('Complete Bitcoin introduction'));
    assert.equal(await page.locator('#coinIssuesTab').getAttribute('aria-selected'), 'true', 'snapshot hydration does not reset the selected issue tab');
    await page.locator('#coinInfoCloseBtn').click();
    holdMarket = false;
    await page.evaluate(() => { marketDataLoadedFromServer = false; data.boards = Object.fromEntries(MARKET_BOARDS.map(board => [board, []])); render(); });
    assert.match(await page.locator('#tableBody').textContent(), /불러오는 중/);
    assert.doesNotMatch(await page.locator('#tableBody').textContent(), /표시할 코인이 없습니다/);
    await page.evaluate(() => fetchLatestBoardData());
    await page.waitForFunction(() => marketDataLoadedFromServer && !marketDataLoadPromise);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.table-wrap').screenshot({ path: path.join(process.env.MARKET_STARTUP_SCREENSHOTS || require('node:os').tmpdir(), `coin-market-startup-${width}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    holdMarket = false;
    marketStatus = 503;
    await page.evaluate(async () => {
      marketDataLoadedFromServer = false;
      data.boards = Object.fromEntries(MARKET_BOARDS.map(board => [board, []]));
      try { await fetchLatestBoardData(); } catch (_error) {}
    });
    assert.match(await page.locator('#tableBody').textContent(), /받지 못했습니다/);
    assert.doesNotMatch(await page.locator('#statusText').textContent(), /총 0개/);
    marketStatus = 200;
    const nonemptyBoards = snapshot.boards;
    snapshot.boards = Object.fromEntries(Object.keys(nonemptyBoards).map(board => [board, []]));
    await page.evaluate(() => fetchLatestBoardData());
    assert.match(await page.locator('#tableBody').textContent(), /표시할 코인이 없습니다/,
      'a successful empty response remains distinct from pending or failed loading');
    assert.deepEqual(await page.evaluate(async () => {
      const cache = BlockscopeCoinDetailCache, owner = comparisonCacheOwner(), now = Date.now();
      await cache.write('test-owner', owner, { private: true }, now, now + 60000, () => true);
      const other = await cache.read('test-owner', 'member:other', 60000, () => true);
      await cache.write('test-old', owner, {}, now - 61000, now + 60000, () => true);
      const old = await cache.read('test-old', owner, 60000, () => true);
      await cache.write('test-future', owner, {}, now + 60000, now + 120000, () => true);
      const future = await cache.read('test-future', owner, 60000, () => true);
      const late = cache.write('test-late', owner, { private: true }, now, now + 60000, () => true);
      const clearing = cache.clear();
      await Promise.all([late, clearing]);
      return [other, old, future, await cache.read('test-late', owner, 60000, () => true)];
    }), [null, null, null, null], 'another owner, expired/future entries and a late pre-logout write cannot restore private cached details');
    assert.ok(issueAssets.every(asset => asset === 'BTC:bitcoin'), 'even the legacy empty-info cache never requests the wrong BTC:btc issue key');
    assert.deepEqual(errors, []);
    console.log('PASS: market startup is independent of settings, survives cache quota, and distinguishes loading from empty results');
    await context.close();
  } finally {
    for (const release of heldIntroductions) release();
    releaseSettings?.(); releaseMarket?.(); releaseLive?.();
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

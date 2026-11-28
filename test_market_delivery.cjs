const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
async function main() {
  const source = fs.readFileSync(path.join(__dirname, 'server-auth/cloudflare-worker.js'), 'utf8')
    .replace('import "../comparison-identity.js";', fs.readFileSync(path.join(__dirname, 'comparison-identity.js'), 'utf8'));
  const { marketDataForScope } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { marketDataForScope };').toString('base64'));
  const fixture = require('./test_market_fixture.cjs')();
  fixture.coinInfo.BTC = { englishName: 'Bitcoin', koreanName: '비트코인', sources: { bithumb: {
    description: 'Independent introduction with oracle delivery phrase.' } }, listings: {} };
  fixture.coinInfo.EXTRA = { englishName: 'Extra', sources: { bithumb: { description: 'D'.repeat(2000000) } } };
  fixture.futures.binance[0].padding = 'F'.repeat(2000000);
  fixture.defillamaRankings.padding = 'R'.repeat(500000);
  const fullBytes = Buffer.byteLength(JSON.stringify(fixture));
  const requests = [], errors = [];
  let infoCalls = 0, corruptDelta = false;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} }; });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'fnfnfn3232.github.io') {
        const file = path.resolve(__dirname, url.pathname.slice('/coin/'.length) || 'index.html');
        return route.fulfill({ body: file.endsWith('data.js') ? 'window.BOARD_DATA=null;' :
          file.startsWith(__dirname + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : '',
        contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
      }
      let payload = {};
      if (url.pathname === '/api/session') {
        const expiresAt = Date.now() + 3600000;
        payload = { role: 'member', subject: 'delivery-test', expiresAt, token: `v3.${Math.floor(expiresAt / 1000)}.0.member.delivery-test.0.test` };
      } else if (url.pathname === '/api/market-data') {
        const scope = url.searchParams.get('scope'), since = Number(url.searchParams.get('since'));
        payload = since === fixture.generatedAt ? { notModified: true, generatedAt: fixture.generatedAt }
          : marketDataForScope(fixture, scope, Number(url.searchParams.get('baseSince')) === fixture.generatedAt);
        if (corruptDelta) payload = { sectionOnly: true, snapshotVersion: fixture.generatedAt - 1, generatedAt: fixture.generatedAt - 1, dataScope: scope };
        requests.push({ scope, since, bytes: Buffer.byteLength(JSON.stringify(payload)) });
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, requests.at(-1).bytes / 1000)));
      } else if (url.pathname === '/api/coin-info') {
        infoCalls++;
        const symbol = url.searchParams.get('symbol');
        payload = { symbol, generatedAt: fixture.generatedAt, info: fixture.coinInfo[symbol] || null };
      } else if (url.pathname === '/api/coin-issues') payload = { items: [], includedPosts: [], total: 0 };
      else if (url.pathname === '/api/live-prices') payload = { prices: {}, caps: {} };
      return route.fulfill({ json: payload, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
    });
    await page.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => marketDataLoadedFromServer && !marketDataLoadPromise);
    assert.deepEqual(requests.map(item => item.scope), ['market']);
    assert.ok(requests[0].bytes < fullBytes * 0.15, 'first paint must not download hidden descriptions/futures/archives');
    assert.ok(await page.locator('#tableBody [data-coin-info-symbol]').count());
    const logoWork = await page.evaluate(() => {
      const original = getComparableSymbol;
      let calls = 0;
      getComparableSymbol = row => { calls++; return original(row); };
      try {
        coinLogoIndex = null;
        const rows = Object.values(data.boards).flat();
        for (const row of rows.slice(0, 50)) coinLogoSources(row);
        return { calls, rows: rows.length };
      } finally { getComparableSymbol = original; }
    });
    assert.ok(logoWork.calls < logoWork.rows * 2 + 200, '50 logos share one symbol index instead of scanning every listing 50 times');
    await page.evaluate(() => openCoinInfo('BTC'));
    await page.waitForFunction(() => document.getElementById('coinInfoBody').textContent.includes('oracle delivery phrase'));
    assert.equal(infoCalls, 1, 'an uncached introduction uses a small per-coin request, not a full snapshot');
    assert.equal(requests.length, 1);
    await page.locator('#coinInfoCloseBtn').click();
    await page.evaluate(() => openCoinInfo('MOCK0'));
    await page.waitForFunction(() => document.getElementById('coinInfoBody').textContent.includes('정보 없음'));
    await page.locator('#coinInfoCloseBtn').click();
    await page.evaluate(() => setViewMode('futures'));
    await page.waitForFunction(() => hasDataScope('futures') && !marketDataLoadPromise);
    assert.ok(await page.locator('.futures-table tbody tr').count());
    assert.equal(requests.at(-1).scope, 'futures');
    assert.equal(requests.at(-1).since, 0, 'a missing section cannot be skipped by a snapshot not-modified response');
    assert.ok(requests.at(-1).bytes < Buffer.byteLength(JSON.stringify(marketDataForScope(fixture, 'futures'))), 'section navigation does not resend the shared spot base');
    await page.evaluate(() => { setViewMode('ranking'); setViewMode('audit'); });
    await page.waitForFunction(() => hasDataScope('audit') && !marketDataLoadPromise);
    assert.ok(await page.evaluate(() => hasDataScope('futures')), 'same-generation section loads merge instead of erasing prior views');
    await page.evaluate(() => { setViewMode('market'); state.query = 'oracle delivery'; render(); });
    await page.waitForFunction(() => hasDataScope('search') && !marketDataLoadPromise);
    assert.equal(await page.locator('#tableBody [data-coin-info-symbol="BTC"]').count(), 1, 'description search still uses complete official text');
    assert.equal(requests.at(-1).scope, 'search');
    await page.evaluate(() => { state.query = ''; render(); });
    const beforeReload = requests.length;
    await page.waitForFunction(() => Number(JSON.parse(localStorage.getItem('fdv_last_good_data_v5') || '{}').snapshotVersion) > 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => marketDataLoadedFromServer && !marketDataLoadPromise);
    assert.equal(requests[beforeReload].since, fixture.generatedAt, 'reload validates the embedded server revision, not a mutable live tick clock');
    assert.ok(requests[beforeReload].bytes < 500, 'an unchanged complete cached view receives only revision metadata');
    fixture.generatedAt++;
    await page.evaluate(() => fetchLatestBoardData());
    assert.equal(await page.evaluate(() => data.snapshotVersion), fixture.generatedAt);
    assert.equal(await page.evaluate(() => hasDataScope('audit')), false, 'an older resource view cannot be relabeled as the new generation');
    corruptDelta = true;
    assert.equal(await page.evaluate(async () => {
      state.viewMode = 'audit';
      try { await fetchLatestBoardData(); return false; } catch (error) { return error.message === 'market_section_revision_mismatch'; }
    }), true, 'a mismatched section must not merge into a newer shared base');
    assert.equal(await page.evaluate(() => data.snapshotVersion), fixture.generatedAt);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ test: 'scoped delivery, independent introduction, lazy views, complete text search and unchanged reload', fullBytes, firstViewBytes: requests[0].bytes, scopes: requests.map(item => item.scope) }));
    await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

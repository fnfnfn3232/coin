const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(root, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  const row = (symbol, name, quote, price, cap = 1000) => ({ symbol, name, englishName: name, nameKeys: [name],
    pair: `${symbol}/${quote}`, nativeCurrency: quote === 'KRW' ? 'KRW' : 'USD', priceUsd: quote === 'KRW' ? price / 1400 : price,
    priceKrw: quote === 'KRW' ? price : price * 1400, sortCapUsd: cap, marketCapUsd: cap, circulatingSupply: 10, totalSupply: 20 });
  const snapshot = { generatedAt: Math.floor(Date.now() / 1000), fxUsdKrw: 1400, boards: {
    binance: [row('BTC', 'Bitcoin', 'USDT', 100), row('ETH', 'Ethereum', 'USDT', 10, 500), row('AI', 'Sleepless AI', 'USDT', 1),
      { ...row('NEO', 'NEO', 'USDT', 10), nameKeys: ['neo', '네오'] }, { ...row('CLASH', 'Other Asset', 'USDT', 1), nameKeys: ['겹치는이름'] }],
    upbit: [row('BTC', 'Bitcoin', 'KRW', 135000), row('ETH', 'Ethereum', 'KRW', 12800, 500), row('AI', 'Gensyn', 'KRW', 100), row('LOCAL', 'Local Only', 'KRW', 100),
      { ...row('NEO', 'NEO', 'KRW', 13500), nameKeys: ['neo', '네오'] }, { ...row('CLASH', 'Different Asset', 'KRW', 1300), nameKeys: ['겹치는이름'] }],
    bithumb: [row('BTC', 'Bitcoin', 'KRW', 136000)],
    coinbase: [row('BTC', 'Bitcoin', 'USD', 100), row('ETH', 'Ethereum', 'USD', 10, 500), row('USDT', 'Tether', 'USD', 1.01)], robinhood: [],
  }, stats: {}, futures: {}, notes: {}, coinInfo: {}, news: { items: [] } };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  let fxCalls = 0;
  let bulkEnabled = false;
  const bulkCalls = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await context.addInitScript(() => {
    window.testSockets = [];
    window.WebSocket = class {
      static OPEN = 1;
      constructor(url) {
        this.url = url; this.readyState = 0; this.sent = [];
        testSockets.push(this);
        setTimeout(() => { if (this.readyState !== 3) { this.readyState = 1; this.onopen?.(); } }, 0);
      }
      send(value) { this.sent.push(JSON.parse(value)); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fnfnfn3232.github.io') {
      if (url.pathname === '/coin/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: `window.BOARD_DATA=${JSON.stringify(snapshot)};`, contentType: 'text/javascript' });
      const file = path.resolve(root, '.' + url.pathname.replace(/^\/coin/, ''));
      return route.fulfill({ body: file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '', contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    }
    if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ body: '' });
    let result = {};
    if (url.pathname === '/api/session') result = { authenticated: true, role: 'member', subject: 'test-reader', boardReadApproved: true,
      boardWriteApproved: false, expiresAt: Date.now() + 86400000, token: 'test-session' };
    else if (url.pathname === '/api/market-data') result = snapshot;
    else if (url.pathname === '/api/price-difference-fx') {
      fxCalls++;
      result = { rate: 1300, date: new Date().toISOString().slice(0, 10), source: 'Frankfurter', frequency: 'daily', checkedAt: Date.now(), stale: false };
    } else if (url.pathname === '/api/price-difference-quotes') {
      const exchange = url.searchParams.get('exchange');
      bulkCalls.push(exchange);
      result = { exchange, prices: bulkEnabled ? Object.fromEntries((snapshot.boards[exchange] || []).map(row => [row.symbol, ['upbit', 'bithumb'].includes(exchange) ? row.priceKrw : row.priceUsd])) : {}, observedAt: Date.now() };
    } else if (url.pathname === '/api/board/posts') result = { posts: [] };
    else if (url.pathname === '/api/board/categories') result = { categories: [{ value: 'free', label: 'Free' }] };
    else if (url.pathname === '/api/news') result = { items: [], total: 0, hasMore: false };
    return route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
  });
  async function emit(board, value) {
    await page.evaluate(({ board, value }) => {
      const host = { binance: 'stream.binance.com', upbit: 'api.upbit.com', bithumb: 'pubwss.bithumb.com', coinbase: 'advanced-trade-ws.coinbase.com' }[board];
      for (const socket of testSockets.filter(socket => socket.readyState === 1 && socket.url.includes(host))) {
        socket.onmessage?.({ data: JSON.stringify(value) });
      }
    }, { board, value });
  }
  async function prices() {
    await emit('upbit', { code: 'KRW-BTC', trade_price: 135000 });
    await emit('upbit', { code: 'KRW-ETH', trade_price: 12800 });
    await emit('bithumb', { content: { symbol: 'BTC_KRW', closePrice: 136000 } });
    await emit('binance', { data: { s: 'BTCUSDT', c: '100' } });
    await emit('binance', { data: { s: 'ETHUSDT', c: '10' } });
    await emit('coinbase', { events: [{ tickers: [{ product_id: 'BTC-USD', price: '100' }, { product_id: 'ETH-USD', price: '10' }, { product_id: 'USDT-USD', price: '1.01' }] }] });
  }
  const cell = symbol => page.locator(`tr[data-live-product="KRW-${symbol}"] [data-price-difference]`);
  try {
    await page.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    await page.locator('#marketToggleBtn').click();
    await page.locator('#baseBoardSelect').selectOption('upbit');
    await page.locator('#priceDifferenceBoard').selectOption('binance');
    await page.waitForFunction(() => priceDifferenceFx?.rate === 1300 && testSockets.filter(socket => socket.readyState === 1).length >= 3);
    assert.match(await cell('BTC').innerText(), /확인 중|연결 지연/);
    await prices();
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-BTC"] [data-price-difference]').textContent.includes('%'));
    const expected = (135000 / (100 * 1.01 * 1300) - 1) * 100;
    assert.ok((await cell('BTC').innerText()).includes(`+${expected.toFixed(3)}%`));
    assert.match(await cell('BTC').innerText(), /3,700원/);
    assert.match(await cell('BTC').locator('[title]').getAttribute('title'), /Frankfurter.*1300.*Coinbase USDT\/USD 1.01/);
    assert.equal(await cell('AI').innerText(), '비교 없음');
    assert.equal(await cell('CLASH').innerText(), '자산 미확인');
    assert.equal(await cell('LOCAL').innerText(), '비교 없음');
    assert.ok(await page.evaluate(() => !!priceDifferenceReference(data.boards.upbit.find(row => row.symbol === 'NEO'))));
    assert.match(await cell('ETH').innerText(), /^-/);
    assert.equal(fxCalls, 1);
    console.log('PASS: independent daily FX, USDT depeg conversion, positive/negative deltas, missing listings and ticker collisions');

    await emit('binance', { data: { s: 'BTCUSDT', c: '101' } });
    const updated = (135000 / (101 * 1.01 * 1300) - 1) * 100;
    await page.waitForFunction(expected => document.querySelector('tr[data-live-product="KRW-BTC"] [data-price-difference]').textContent.includes(expected), updated.toFixed(3));
    await page.locator('#thPriceDifference').click();
    assert.equal(await page.locator('#thPriceDifference').getAttribute('aria-sort'), 'descending');
    assert.equal(await page.locator('#tableBody tr').first().getAttribute('data-live-product'), 'KRW-BTC');
    await page.locator('#thPriceDifference').press('Enter');
    assert.equal(await page.locator('#thPriceDifference').getAttribute('aria-sort'), 'ascending');
    assert.equal(await page.locator('#tableBody tr').first().getAttribute('data-live-product'), 'KRW-ETH');
    console.log('PASS: overseas-only ticks update the visible delta; bidirectional sorting keeps missing comparisons last');

    await page.locator('#priceDifferenceBoard').selectOption('coinbase');
    await page.waitForTimeout(50);
    await prices();
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-BTC"] [data-price-difference]').textContent.includes('3.846%'));
    assert.equal(await page.locator('#tableBody tr').first().locator('td').count(), 9);
    const headers = await page.locator('#marketTable th').allTextContents();
    assert.equal(headers[4].replace(/[ ↑↓]/g, ''), '시세차이');
    await page.locator('#thCap').click();
    await page.locator('.table-wrap').screenshot({ path: path.join(os.tmpdir(), 'price-difference-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#marketTable').screenshot({ path: path.join(os.tmpdir(), 'price-difference-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await cell('BTC').isVisible());
    console.log('PASS: reference selection, column position and desktop/mobile layout');

    const freshState = await page.evaluate(() => {
      const btc = data.boards.upbit.find(row => row.symbol === 'BTC');
      const ref = priceDifferenceReference(btc);
      const saved = [btc.livePriceUpdatedAt, btc.comparisonPriceAt, ref.livePriceUpdatedAt];
      btc.livePriceUpdatedAt = Date.now() - 130000; btc.comparisonPriceAt = 0;
      refreshPriceDifferenceCells();
      const stale = document.querySelector('tr[data-live-product="KRW-BTC"] [data-price-difference]').textContent;
      btc.comparisonPriceAt = Date.now();
      const restored = getPriceDifference(btc).percent;
      btc.livePriceUpdatedAt = saved[0]; btc.comparisonPriceAt = saved[1];
      priceDifferenceFx.stale = true;
      const badFx = getPriceDifference(btc).percent;
      priceDifferenceFx.stale = false;
      return { stale, restored, badFx };
    });
    assert.match(freshState.stale, /갱신 지연|연결 지연/);
    assert.ok(Number.isFinite(freshState.restored));
    assert.equal(freshState.badFx, undefined);
    console.log('PASS: stale prices and failed FX never display a misleading live percentage');

    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator('#baseBoardSelect').selectOption('binance');
    await page.waitForTimeout(50);
    await prices();
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="BTCUSDT"] [data-price-difference]').textContent.includes('%'));
    assert.equal(await page.locator('#priceDifferenceBoard').inputValue(), 'coinbase');
    const openBefore = await page.evaluate(() => testSockets.filter(socket => socket.readyState === 1).length);
    await page.evaluate(() => { render(); render(); render(); });
    assert.equal(await page.evaluate(() => testSockets.filter(socket => socket.readyState === 1).length), openBefore);

    bulkEnabled = true;
    await page.evaluate(() => {
      clearPriceDifferenceCache();
      for (const rows of Object.values(data.boards)) for (const row of rows) { row.livePriceUpdatedAt = 0; row.comparisonPriceAt = 0; }
      priceDifferenceUsdt.livePriceUpdatedAt = 0;
      priceDifferenceUsdt.comparisonPriceAt = 0;
      state.board = 'upbit'; state.priceDifferenceBoard = 'binance'; render();
    });
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-NEO"] [data-price-difference]')?.textContent.includes('%'));
    assert.ok((await cell('BTC').innerText()).includes(expected.toFixed(3)));
    assert.ok(!bulkCalls.slice(-3).includes('bithumb'));
    assert.equal(await page.evaluate(() => [...priceDifferenceSockets.values()].some(connection => connection.target.entries.has('NEOUSDT'))), true);
    console.log('PASS: REST bootstrap displays quiet coins without any ticker event and NEO identity is preserved');

    await page.evaluate(() => savePriceDifferenceCache());
    const requestsBeforeReload = bulkCalls.length;
    const fxBeforeReload = fxCalls;
    bulkEnabled = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    await page.locator('#baseBoardSelect').selectOption('upbit');
    await page.locator('#priceDifferenceBoard').selectOption('binance');
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-NEO"] [data-price-difference]')?.textContent.includes('%'));
    assert.equal(bulkCalls.length, requestsBeforeReload);
    assert.equal(fxCalls, fxBeforeReload);
    console.log('PASS: reload restores fresh quotes and FX immediately without another bootstrap request');

    const rejectedCaches = await page.evaluate(() => {
      savePriceDifferenceCache();
      const good = sessionStorage.getItem(PRICE_DIFFERENCE_CACHE_KEY);
      const other = JSON.parse(good);
      other.owner = 'member:different-account';
      clearPriceDifferenceCache();
      sessionStorage.setItem(PRICE_DIFFERENCE_CACHE_KEY, JSON.stringify(other));
      restorePriceDifferenceCache();
      const wrongOwner = Object.keys(priceDifferenceQuoteCache).length === 0 && !priceDifferenceFx;
      const expired = JSON.parse(good);
      expired.fx.checkedAt = Date.now() - 3600001;
      for (const quotes of Object.values(expired.quotes)) for (const quote of Object.values(quotes)) quote.at = Date.now() - 130000;
      clearPriceDifferenceCache();
      sessionStorage.setItem(PRICE_DIFFERENCE_CACHE_KEY, JSON.stringify(expired));
      restorePriceDifferenceCache();
      const stale = Object.keys(priceDifferenceQuoteCache).length === 0 && !priceDifferenceFx;
      clearPriceDifferenceCache();
      sessionStorage.setItem(PRICE_DIFFERENCE_CACHE_KEY, good);
      restorePriceDifferenceCache();
      return { wrongOwner, stale };
    });
    assert.deepEqual(rejectedCaches, { wrongOwner: true, stale: true });
    console.log('PASS: cache restoration rejects another account and expired quote/FX records');

    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    assert.equal(await page.evaluate(() => testSockets.filter(socket => socket.readyState === 1).length), 0);
    await page.evaluate(() => syncLivePriceStream());
    await page.waitForTimeout(50);
    await page.evaluate(() => clearSiteLoginState());
    assert.equal(await page.evaluate(() => testSockets.filter(socket => socket.readyState === 1).length), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem(PRICE_DIFFERENCE_CACHE_KEY)), null);
    assert.deepEqual(errors, []);
    console.log('PASS: foreign-base conversion, no duplicate streams on render, offline/logout teardown');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

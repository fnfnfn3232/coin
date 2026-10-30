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
    coinbase: [row('BTC', 'Bitcoin', 'USD', 100), row('ETH', 'Ethereum', 'USD', 10, 500), row('USDT', 'Tether', 'USD', 1.01)], robinhood: [row('BTC', 'Bitcoin', 'USD', 100)],
  }, stats: {}, futures: {}, notes: {}, coinInfo: {}, news: { items: [] } };
  const fallbackFixtures = {
    gateio: { symbol: 'GATEONLY', name: 'Gate Only Asset', price: 10, label: 'Gate.io' },
    bybit: { symbol: 'BYBITONLY', name: 'Bybit Only Asset', price: 20, label: 'Bybit' },
    bitget: { symbol: 'BITGETONLY', name: 'Bitget Only Asset', price: 30, label: 'Bitget' },
    okx: { symbol: 'OKXONLY', name: 'Okx Only Asset', price: 40, label: 'OKX' },
  };
  for (const [board, price] of [['upbit', 1100], ['bithumb', 1000]]) {
    snapshot.boards[board].push(row('DUALKRW', 'Domestic Only Asset', 'KRW', price, 100));
    snapshot.boards[board].push({ ...row('TICKKRW', 'TICKKRW', 'KRW', price, 100), koreanName: '\uc911\ubcf5\ucf54\uc778' });
    snapshot.boards[board].push(row('MISMATCH', board === 'upbit' ? 'Project A' : 'Project B', 'KRW', price, 100));
  }
  const reported = [
    { symbol: 'SOON', name: 'SOON', foreign: 'Soon' }, { symbol: 'BEAM', name: 'Beam', foreign: 'Beam', foreignSymbol: 'BEAMX' },
    { symbol: 'FLUID', name: 'Fluid', foreign: 'Fluid' }, { symbol: 'PIEVERSE', name: 'Pieverse', foreign: 'Pieverse' },
    { symbol: 'CC', name: 'Canton', foreign: 'Canton Network' }, { symbol: 'WAVES', name: 'Waves', foreign: 'Waves' },
    { symbol: 'B3', name: 'B3', foreign: 'B3 Base' },
    { symbol: 'CAP', name: 'Cap', foreign: 'Cap', foreignBoard: 'coinbase' },
    { symbol: 'GRVT', name: 'Grvt', foreign: 'Grvt', foreignBoard: 'coinbase' },
  ];
  for (const item of reported) snapshot.boards.upbit.push({ ...row(item.symbol, item.name, 'KRW', 1350), koreanName: '\uad6d\ub0b4\ucf54\uc778',
    marketIdentityVerified: false, marketCapUsd: null, marketCapKrw: null, sortCapUsd: null });
  for (const item of reported.filter(item => item.foreignBoard === 'coinbase')) snapshot.boards.coinbase.push(row(item.symbol, item.foreign, 'USD', 1));
  for (const fixture of Object.values(fallbackFixtures)) snapshot.boards.upbit.push(row(fixture.symbol, fixture.name, 'KRW', fixture.price * 1350));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  let fxCalls = 0;
  let bulkEnabled = false;
  const bulkCalls = [];
  let bootstrapFailure = 0;
  let bootstrapFailureBoard = 'binance';
  let directCalls = 0;
  let snapshotBootstrap = false;
  let fxRate = 1300;
  let coinbaseFuturesCalls = 0;
  let coinbaseFuturesFailure = false;
  const fxPayload = () => ({ rate: fxRate, asOf: Date.now(), date: new Date().toISOString().slice(0, 10),
    source: 'currency-converter.live', frequency: 'intraday', marketStatus: 'open', checkedAt: Date.now(), stale: false });
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
      send(value) { this.sent.push(value === 'ping' ? value : JSON.parse(value)); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await context.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'data-api.binance.vision' || url.hostname === 'www.okx.com') {
      directCalls++;
      assert.equal(route.request().headers().authorization, undefined);
      if (url.hostname === 'www.okx.com') return route.fulfill({ json: { code: '0', data: [
        { instType: 'SPOT', instId: 'OKXONLY-USDT', last: '42' }, { instType: 'SWAP', instId: 'OKXONLY-USDT-SWAP', last: '999' },
      ] } });
      return route.fulfill({ json: [{ symbol: 'BTCUSDT', price: '101' }, { symbol: 'BTCUSDC', price: '999' }] });
    }
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
    else if (url.pathname === '/api/market-data') {
      result = { ...snapshot };
      if (snapshotBootstrap) result.comparisonBootstrap = { fx: fxPayload(), direct: ['binance'], quotes: {
        ...Object.fromEntries(Object.entries(snapshot.boards).map(([board, rows]) => [board, { exchange: board, observedAt: Date.now(),
          prices: Object.fromEntries(rows.map(row => [row.symbol, ['upbit', 'bithumb'].includes(board) ? row.priceKrw : row.priceUsd])) }])),
        ...Object.fromEntries(Object.entries(fallbackFixtures).map(([board, fixture]) => [board, { exchange: board, observedAt: Date.now(),
          prices: { [fixture.symbol]: fixture.price }, assets: { [fixture.symbol]: [fixture.name, `${fixture.symbol.toLowerCase()}-asset`] }, catalogAt: Date.now() }])),
      } };
    }
    else if (url.pathname === '/api/coinbase-futures') {
      coinbaseFuturesCalls++;
      if (coinbaseFuturesFailure) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
      result = { observedAt: Date.now(), rows: ['BTC', 'ETH', 'AI'].map(symbol => ({ symbol, rawUnderlyingSymbol: symbol,
        contractId: `${symbol}_USDC-PERPETUAL`, pair: `${symbol}_USDC-PERPETUAL`, exchange: 'coinbase',
        contractType: 'PERPETUAL', contractTypeLabel: '무기한', contractMarket: 'Coinbase / Deribit', underlyingType: 'crypto',
        quoteAsset: 'USDC', marginAsset: 'USDC', priceCurrency: 'USDC', nativeCurrency: 'USD',
        underlyingIdentityVerified: true, underlyingName: { BTC: 'Bitcoin', ETH: 'Ethereum', AI: 'Sleepless AI' }[symbol],
        englishName: { BTC: 'Bitcoin', ETH: 'Ethereum', AI: 'Sleepless AI' }[symbol],
        priceUsd: symbol === 'BTC' ? 100 : symbol === 'AI' ? 1 : 10, markPrice: symbol === 'BTC' ? 99 : 9,
        futuresQuoteAt: Date.now(), futuresPriceBasis: 'last' })) };
    }
    else if (url.pathname === '/api/price-difference-fx') {
      fxCalls++;
      result = fxPayload();
    } else if (url.pathname === '/api/price-difference-quotes') {
      const exchange = url.searchParams.get('exchange');
      bulkCalls.push(exchange);
      if (exchange === bootstrapFailureBoard && bootstrapFailure) return route.fulfill({ status: bootstrapFailure,
        json: { error: 'quote_refresh_failed', assets: exchange === 'okx' ? { OKXONLY: ['Okx Only Asset', 'okxonly-asset'] } : {}, catalogAt: Date.now() } });
      result = { exchange, prices: bulkEnabled ? Object.fromEntries((snapshot.boards[exchange] || []).map(row => [row.symbol, ['upbit', 'bithumb'].includes(exchange) ? row.priceKrw : row.priceUsd])) : {}, observedAt: Date.now() };
      if (exchange === 'coinbase' && bulkEnabled) {
        result.assets = Object.fromEntries(reported.filter(item => item.foreignBoard === 'coinbase').map(item => [item.symbol, [item.foreign, `coinbase-${item.symbol.toLowerCase()}`]]));
        result.catalogAt = Date.now();
      }
      const fixture = fallbackFixtures[exchange];
      if (fixture && bulkEnabled) result = { exchange, prices: { [fixture.symbol]: fixture.price }, observedAt: Date.now(),
        assets: { [fixture.symbol]: [fixture.name, `${fixture.symbol.toLowerCase()}-asset`] }, catalogAt: Date.now(), identitySource: 'CoinPaprika' };
      if (fixture && bulkEnabled) {
        result.prices.CLASH = 999;
        result.assets.CLASH = ['Unrelated Project', 'clash-unrelated'];
        if (exchange === 'gateio') for (const item of reported.filter(item => !item.foreignBoard)) {
          const symbol = item.foreignSymbol || item.symbol;
          result.prices[symbol] = 1;
          result.assets[symbol] = [item.foreign, `gate-${symbol.toLowerCase()}`];
        }
      }
    } else if (url.pathname === '/api/board/posts') result = { posts: [] };
    else if (url.pathname === '/api/board/categories') result = { categories: [{ value: 'free', label: 'Free' }] };
    else if (url.pathname === '/api/news') result = { items: [], total: 0, hasMore: false };
    return route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
  });
  async function emit(board, value) {
    await page.evaluate(({ board, value }) => {
      const host = { binance: 'stream.binance.com', upbit: 'api.upbit.com', bithumb: 'pubwss.bithumb.com', coinbase: 'advanced-trade-ws.coinbase.com',
        gateio: 'api.gateio.ws', bybit: 'stream.bybit.com', bitget: 'ws.bitget.com', okx: 'ws.okx.com', coinbase_futures: 'streams.drb.coinbase.com' }[board];
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
    assert.equal(fxCalls, 0);
    assert.equal(bulkCalls.length, 0);
    console.log('PASS: foreign default view does not request Korean premiums or FX');
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
    assert.match(await cell('BTC').locator('[title]').getAttribute('title'), /currency-converter.live.*장중 참고.*1300.*Coinbase USDT\/USD 1.01/);
    assert.equal(await cell('AI').innerText(), '비교 없음');
    assert.equal(await cell('CLASH').innerText(), '자산 미확인');
    assert.equal(await cell('LOCAL').innerText(), '비교 없음');
    assert.ok(await page.evaluate(() => !!priceDifferenceReference(data.boards.upbit.find(row => row.symbol === 'NEO'))));
    assert.match(await cell('ETH').innerText(), /^-/);
    assert.equal(fxCalls, 1);
    console.log('PASS: timestamped intraday FX, USDT depeg conversion, positive/negative deltas, missing listings and ticker collisions');

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
    assert.equal(await page.locator('[data-price-difference]').count(), 0);
    assert.equal(await page.locator('#thPriceDifference').isVisible(), false);
    assert.equal(await page.locator('.price-difference-tools').isVisible(), false);
    const foreignCalls = { quotes: bulkCalls.length, fx: fxCalls };
    await page.evaluate(() => { requestPriceDifferenceQuotes(); requestPriceDifferenceFx(); });
    assert.deepEqual({ quotes: bulkCalls.length, fx: fxCalls }, foreignCalls);
    assert.equal(await page.evaluate(() => priceDifferenceSockets.size), 0);
    assert.equal(await page.locator('#priceDifferenceBoard').inputValue(), 'coinbase');
    for (const foreign of ['coinbase', 'robinhood']) {
      await page.locator('#baseBoardSelect').selectOption(foreign);
      assert.equal(await page.locator('#thPriceDifference').isVisible(), false);
      assert.equal(await page.locator('.price-difference-tools').isVisible(), false);
      assert.equal(await page.locator('[data-price-difference]').count(), 0);
      assert.equal(await page.evaluate(() => priceDifferenceSockets.size), 0);
    }
    console.log('PASS: Binance/Coinbase/Robinhood hide premium controls and cells, stop premium sockets and do not request FX');
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
    assert.ok(bulkCalls.includes('bithumb'));
    assert.equal(await page.evaluate(() => [...priceDifferenceSockets.values()].some(connection => connection.target.entries.has('NEOUSDT'))), true);
    console.log('PASS: REST bootstrap displays quiet coins without any ticker event and NEO identity is preserved');
    for (const item of reported) {
      await page.waitForFunction(symbol => document.querySelector(`tr[data-live-product="KRW-${symbol}"] [data-price-difference]`)?.textContent.includes('%'), item.symbol);
      assert.equal(await page.evaluate(symbol => data.boards.upbit.find(row => row.symbol === symbol).marketCapUsd, item.symbol), null);
    }
    console.log('PASS: reported SOON/BEAM/FLUID/PIEVERSE/CC/WAVES/B3 render premiums while unknown caps remain unknown');

    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-DUALKRW"] [data-price-difference]')?.textContent.includes('+10.000%'));
    assert.match(await cell('DUALKRW').locator('.price-difference-source').innerText(), /국내.*빗썸/);
    assert.match(await cell('DUALKRW').locator('[title]').getAttribute('title'), /국내 거래소 비교.*환율 미사용/);
    assert.match(await cell('TICKKRW').innerText(), /10.000%/);
    const nativeSafety = await page.evaluate(() => {
      const row = data.boards.upbit.find(row => row.symbol === 'DUALKRW');
      const reference = priceDifferenceReference(row);
      const fx = priceDifferenceFx;
      const peg = priceDifferenceUsdt.livePriceUpdatedAt;
      priceDifferenceFx = null;
      priceDifferenceUsdt.livePriceUpdatedAt = 0;
      const withoutFx = getPriceDifference(row).percent;
      priceDifferenceFx = fx;
      priceDifferenceUsdt.livePriceUpdatedAt = peg;
      const at = reference.comparisonPriceAt;
      reference.comparisonPriceAt = Date.now() - 130000;
      const stale = getPriceDifference(row).percent;
      reference.comparisonPriceAt = at;
      const mismatch = getPriceDifference(data.boards.upbit.find(row => row.symbol === 'MISMATCH')).percent;
      const btc = data.boards.upbit.find(row => row.symbol === 'BTC');
      const foreignPreferred = !['upbit', 'bithumb'].includes(priceDifferenceReference(btc).comparisonExchange);
      return { withoutFx, stale, mismatch, foreignPreferred };
    });
    assert.ok(Math.abs(nativeSafety.withoutFx - 10) < 1e-9);
    assert.equal(nativeSafety.stale, undefined);
    assert.equal(nativeSafety.mismatch, undefined);
    assert.equal(nativeSafety.foreignPreferred, true);
    await emit('bithumb', { content: { symbol: 'DUALKRW_KRW', closePrice: 1050 } });
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-DUALKRW"] [data-price-difference]')?.textContent.includes('+4.762%'));
    await emit('upbit', { code: 'KRW-DUALKRW', trade_price: 1200 });
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-DUALKRW"] [data-price-difference]')?.textContent.includes('+14.286%'));
    assert.ok(await page.evaluate(() => priceDifferenceSockets.get('bithumb').socket.sent.some(value => value.type === 'ticker' && value.symbols.includes('DUALKRW_KRW'))));
    await page.locator('#baseBoardSelect').selectOption('bithumb');
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="DUALKRW_KRW"] [data-price-difference]')?.textContent.includes('-12.500%'));
    assert.match(await page.locator('tr[data-live-product="DUALKRW_KRW"] .price-difference-source').innerText(), /국내.*업비트/);
    await emit('upbit', { code: 'KRW-DUALKRW', trade_price: 1250 });
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="DUALKRW_KRW"] [data-price-difference]')?.textContent.includes('-16.000%'));
    assert.ok(await page.evaluate(() => priceDifferenceSockets.get('upbit').socket.sent.some(value => Array.isArray(value) && value.some(item => item.codes?.includes('KRW-DUALKRW')))));
    await page.locator('#baseBoardSelect').selectOption('upbit');
    console.log('PASS: verified domestic duplicates fall back in both directions without FX; both native streams update; stale prices and identity conflicts fail closed; foreign listings keep priority');

    for (const [board, fixture] of Object.entries(fallbackFixtures)) {
      await page.waitForFunction(symbol => document.querySelector(`tr[data-live-product="KRW-${symbol}"] [data-price-difference]`)?.textContent.includes('%'), fixture.symbol);
      assert.equal(await cell(fixture.symbol).locator('.price-difference-source').innerText(), fixture.label);
      assert.match(await cell(fixture.symbol).locator('[title]').getAttribute('title'), /대체 출처/);
      assert.equal(await page.evaluate(board => priceDifferenceSockets.get(board)?.target.kind, board), 'spot');
    }
    await emit('gateio', { channel: 'spot.tickers', event: 'update', result: { currency_pair: 'GATEONLY_USDT', last: '11' } });
    await emit('bybit', { topic: 'tickers.BYBITONLYUSDT', type: 'snapshot', data: { symbol: 'BYBITONLYUSDT', lastPrice: '21' } });
    await emit('bitget', { arg: { instType: 'SPOT', channel: 'ticker', instId: 'BITGETONLYUSDT' }, data: [{ instId: 'BITGETONLYUSDT', lastPr: '31' }] });
    await emit('okx', { arg: { channel: 'tickers' }, data: [{ instType: 'SPOT', instId: 'OKXONLY-USDT', last: '41' }] });
    for (const [board, fixture] of Object.entries(fallbackFixtures)) {
      await page.waitForFunction(({ board, symbol, price }) => comparisonMarketRows(board).find(row => row.symbol === symbol)?.priceUsd === price,
        { board, symbol: fixture.symbol, price: fixture.price + 1 });
    }
    await page.waitForFunction(() => !livePriceFlushFrame);
    const beforeFutures = await cell('OKXONLY').innerText();
    await emit('okx', { arg: { channel: 'tickers' }, data: [{ instType: 'SWAP', instId: 'OKXONLY-USDT-SWAP', last: '999' }] });
    assert.equal(await cell('OKXONLY').innerText(), beforeFutures);
    assert.ok(await page.evaluate(() => [...priceDifferenceSockets.values()].filter(connection => PRICE_DIFFERENCE_ADDITIONAL_BOARDS.includes(connection.target.exchange)).every(connection => connection.heartbeat > 0)));
    console.log('PASS: four identity-verified spot fallback sources are labeled, update live, use heartbeats and reject derivatives');
    assert.equal(await cell('CLASH').innerText(), '자산 미확인');
    assert.equal(await page.evaluate(() => {
      const quote = priceDifferenceQuoteCache.bybit.BYBITONLY;
      const nextIdentity = { ...quote.identity, at: quote.identity.at + 1 };
      rememberComparisonQuote('bybit', 'BYBITONLY', 999, quote.at - 1, nextIdentity);
      return priceDifferenceQuoteCache.bybit.BYBITONLY.price === 21
        && priceDifferenceQuoteCache.bybit.BYBITONLY.identity.at === nextIdentity.at;
    }), true);

    await page.evaluate(() => savePriceDifferenceCache());
    const requestsBeforeReload = bulkCalls.length;
    const fxBeforeReload = fxCalls;
    bulkEnabled = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    await page.locator('#baseBoardSelect').selectOption('upbit');
    await page.locator('#priceDifferenceBoard').selectOption('binance');
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="KRW-NEO"] [data-price-difference]')?.textContent.includes('%'));
    for (const fixture of Object.values(fallbackFixtures)) assert.equal(await cell(fixture.symbol).locator('.price-difference-source').innerText(), fixture.label);
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

    const reviewedProjects = await page.evaluate(() => {
      const results = {};
      const originals = { binance: data.boards.binance, additional: priceDifferenceAdditionalRows };
      try {
        data.boards.binance = [];
        priceDifferenceAdditionalRows = { gateio: [], okx: [] };
        const pairs = [
          ['ZBT', 'ZEROBASE', 'Zerobase', 'gateio', 'gate-zbt'],
          ['KGEN', 'KGeN', 'KGeN', 'gateio', 'gate-kgen'],
          ['MLK', 'MiL.k', 'MiL.k Alliance', 'gateio', 'mlk-milk-alliance'],
          ['FRAX', 'Frax', 'Frax Finance', 'gateio', 'gate-frax'],
          ['XDP', 'Doppler Finance', 'Doppler Finance', 'okx', 'okx-doppler-finance'],
        ];
        for (const [symbol, local, foreign, exchange, id] of pairs) {
          priceDifferenceAdditionalRows[exchange].push({ symbol, pair: `${symbol}/USDT`, englishName: foreign, paprikaId: id,
            comparisonIdentity: { officialName: true }, identityAt: Date.now(), priceUsd: 1, comparisonPriceAt: Date.now() });
          resetComparisonIdentityCache();
          const row = { symbol, pair: `${symbol}/KRW`, englishName: local, koreanName: '\uad6d\ub0b4\ucf54\uc778', priceKrw: 1350, comparisonPriceAt: Date.now() };
          results[symbol] = Number.isFinite(getPriceDifference(row).percent);
        }
        priceDifferenceAdditionalRows.gateio = [{ symbol: 'FRAX', englishName: 'Frax', paprikaId: 'frax-frax', identityAt: Date.now() }];
        resetComparisonIdentityCache();
        results.rejectLegacyFrax = !priceDifferenceReference({ symbol: 'FRAX', englishName: 'Frax' });
        results.port443 = testSockets.filter(socket => socket.url.includes('stream.binance.com')).every(socket => !socket.url.includes(':9443'));
      } finally {
        data.boards.binance = originals.binance;
        priceDifferenceAdditionalRows = originals.additional;
        resetComparisonIdentityCache();
      }
      return results;
    });
    assert.deepEqual(reviewedProjects, { ZBT: true, KGEN: true, MLK: true, FRAX: true, XDP: true, rejectLegacyFrax: true, port443: true });
    console.log('PASS: actual ZBT/KGEN/MLK/FRAX/XDP name variants resolve; legacy FRAX is rejected and Binance uses port 443');

    for (const status of [503, 401, 403]) {
      bootstrapFailure = status;
      const before = directCalls;
      await page.evaluate(() => {
        clearPriceDifferenceCache();
        for (const rows of Object.values(data.boards)) for (const row of rows) { row.livePriceUpdatedAt = 0; row.comparisonPriceAt = 0; }
        requestPriceDifferenceQuotes();
      });
      await page.waitForFunction(() => priceDifferenceQuoteRequests.get('binance')?.pending === false);
      assert.equal(directCalls - before, status === 503 ? 1 : 0);
      if (status === 503) assert.equal(await page.evaluate(() => priceDifferenceQuoteCache.binance.BTC.price), 101);
    }
    console.log('PASS: Worker source failure can bootstrap public Binance quotes without credentials; 401/403 never fall back');
    bootstrapFailureBoard = 'okx';
    bootstrapFailure = 503;
    const beforeOkx = directCalls;
    await page.evaluate(() => { clearPriceDifferenceCache(); requestPriceDifferenceQuotes(); });
    await page.waitForFunction(() => priceDifferenceQuoteRequests.get('okx')?.pending === false);
    assert.equal(directCalls - beforeOkx, 1);
    assert.equal(await page.evaluate(() => priceDifferenceQuoteCache.okx.OKXONLY.price), 42);
    console.log('PASS: OKX public fallback retains verified metadata and excludes perpetual contracts');

    snapshotBootstrap = true;
    bootstrapFailure = 0;
    const bootPage = await context.newPage();
    try {
      const quotesBefore = bulkCalls.length;
      const fxBefore = fxCalls;
      await bootPage.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
      await bootPage.waitForFunction(() => siteAuthConfirmed && priceDifferenceQuoteCache.upbit?.BTC && priceDifferenceFx);
      await bootPage.evaluate(() => { state.viewMode = 'market'; state.board = 'upbit'; state.priceDifferenceBoard = 'binance'; renderCurrentView(); });
      assert.match(await bootPage.locator('tr[data-live-product="KRW-BTC"] [data-price-difference]').innerText(), /%/);
      assert.equal(fxCalls, fxBefore);
      assert.equal(bulkCalls.length, quotesBefore);
      const previous = await bootPage.evaluate(() => getPriceDifference(data.boards.upbit.find(row => row.symbol === 'BTC')).percent);
      fxRate = 1310;
      await bootPage.evaluate(async () => { priceDifferenceFxRetryAt = 0; await requestPriceDifferenceFx(); });
      assert.equal(await bootPage.evaluate(() => priceDifferenceFx.rate), 1310);
      assert.notEqual(await bootPage.evaluate(() => getPriceDifference(data.boards.upbit.find(row => row.symbol === 'BTC')).percent), previous);
      assert.equal(await bootPage.evaluate(() => usableComparisonFx({ ...priceDifferenceFx, asOf: Date.now() - 600000 })), false);
      assert.equal(await bootPage.evaluate(() => usableComparisonFx({ ...priceDifferenceFx, frequency: 'daily' })), false);
      assert.match(await bootPage.locator('#priceDifferenceFxStatus').innerText(), /장중 참고/);
      assert.equal(await bootPage.evaluate(() => priceDifferenceFxRetryAt - Date.now() <= 60000), true);
      const binanceBefore = bulkCalls.filter(board => board === 'binance').length;
      const directBefore = directCalls;
      await bootPage.evaluate(() => {
        for (const row of data.boards.binance) { row.livePriceUpdatedAt = 0; row.comparisonPriceAt = 0; }
        requestPriceDifferenceQuotes();
      });
      await bootPage.waitForFunction(() => !priceDifferenceQuoteRequests.get('binance')?.pending);
      assert.equal(bulkCalls.filter(board => board === 'binance').length, binanceBefore);
      assert.equal(directCalls, directBefore + 1);
      console.log('PASS: snapshot bootstrap renders without quote/FX round trips; live FX changes recalculate deltas; source clocks expire; known blocked proxies are skipped');
    } finally { await bootPage.close(); snapshotBootstrap = false; fxRate = 1300; }

    bootstrapFailure = 0;
    await page.evaluate(() => { state.viewMode = 'market'; state.board = 'upbit'; renderCurrentView(); });
    await page.waitForTimeout(50);
    const silent = await page.evaluate(() => {
      const previous = livePriceSocket;
      livePriceTarget.socketStartedAt = Date.now() - 120000;
      livePriceTarget.lastMessageAt = Date.now() - 50000;
      livePriceTarget.lastQuoteAt = Date.now() - 120000;
      const extras = [...priceDifferenceSockets.values()];
      for (const connection of extras) {
        connection.startedAt = Date.now() - 120000;
        connection.target.lastMessageAt = Date.now(); // Heartbeats alone do not prove ticker delivery.
        connection.target.lastQuoteAt = Date.now() - 100000;
      }
      inspectComparisonStreams();
      return { mainClosed: previous.readyState === 3, extraClosed: extras.every(connection => connection.socket.readyState === 3) };
    });
    assert.deepEqual(silent, { mainClosed: true, extraClosed: true });
    await page.waitForFunction(() => livePriceSocket?.readyState === 1 && [...priceDifferenceSockets.values()].every(connection => connection.socket?.readyState === 1));
    const countBefore = bulkCalls.filter(board => board === 'upbit').length;
    await page.evaluate(() => {
      const request = priceDifferenceQuoteRequests.get('upbit');
      request.checkedAt = Date.now() - 65000; request.retryAt = 0;
      for (const row of data.boards.upbit) row.livePriceUpdatedAt = Date.now();
      requestPriceDifferenceQuotes(); requestPriceDifferenceQuotes();
    });
    await page.waitForFunction(() => !priceDifferenceQuoteRequests.get('upbit')?.pending);
    assert.equal(bulkCalls.filter(board => board === 'upbit').length, countBefore + 1, 'healthy-looking WS data still gets one coalesced independent bulk refresh');
    bootstrapFailureBoard = 'gateio'; bootstrapFailure = 503;
    await page.evaluate(() => {
      priceDifferenceQuoteRequests.set('gateio', { checkedAt: 0, retryAt: 0, catalogCheckedAt: Date.now() - 86400000 });
      requestPriceDifferenceQuotes();
    });
    await page.waitForFunction(() => priceDifferenceQuoteRequests.get('gateio')?.pending === false);
    const firstBackoff = await page.evaluate(() => priceDifferenceQuoteRequests.get('gateio').retryAt - Date.now());
    assert(firstBackoff > 0 && firstBackoff <= 15000);
    await page.evaluate(() => { priceDifferenceQuoteRequests.get('gateio').retryAt = 0; requestPriceDifferenceQuotes(); });
    await page.waitForFunction(() => priceDifferenceQuoteRequests.get('gateio')?.pending === false);
    const secondBackoff = await page.evaluate(() => priceDifferenceQuoteRequests.get('gateio').retryAt - Date.now());
    assert(secondBackoff > 15000 && secondBackoff <= 30000);
    bootstrapFailure = 0;
    const late = await page.evaluate(async () => {
      const row = data.boards.upbit.find(row => row.symbol === 'BTC');
      const before = row.priceKrw;
      let active = true;
      const target = { exchange: 'upbit', kind: 'spot', entries: new Map([['KRW-BTC', { row, exchange: 'upbit', kind: 'spot' }]]), isCurrent: () => active };
      const pending = handleLivePriceMessage(target, JSON.stringify({ code: 'KRW-BTC', trade_price: 999999 }));
      active = false;
      await pending;
      return row.priceKrw === before;
    });
    assert.equal(late, true, 'a late decoded message from a retired socket cannot update a price');
    const sourceClocks = await page.evaluate(() => {
      const row = { symbol: 'BTC' };
      const target = { entries: new Map([['KRW-BTC', { row, exchange: 'upbit', kind: 'spot' }]]) };
      const now = Date.now();
      applyRealtimePrice('KRW-BTC', 100, target, now);
      applyRealtimePrice('KRW-BTC', 1, target, now - 1);
      applyRealtimePrice('KRW-BTC', 2, target, now - 130000);
      applyRealtimePrice('KRW-BTC', 3, target, now + 6000);
      return { price: row.priceKrw, sourceAt: row.liveSourceAt === now };
    });
    assert.deepEqual(sourceClocks, { price: 100, sourceAt: true }, 'old, out-of-order and future source timestamps cannot make stale prices look fresh');
    assert.match(await page.locator('#priceDifferenceHealth').innerText(), /시세 비교/);
    if (process.env.COMPARISON_SCREENSHOT) {
      await page.screenshot({ path: process.env.COMPARISON_SCREENSHOT });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: process.env.COMPARISON_SCREENSHOT.replace('.png', '-mobile.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      await page.setViewportSize({ width: 1600, height: 1000 });
    }
    console.log('PASS: silent/open sockets and heartbeat-only feeds reconnect; bulk reconciliation is bounded; failures back off; late retired messages are ignored');

    await page.evaluate(() => { futuresExchange = 'coinbase'; setViewMode('futures'); renderCurrentView(); });
    await page.waitForSelector('tr[data-live-product="BTC_USDC-PERPETUAL"]');
    await page.waitForFunction(() => testSockets.some(socket => socket.url.includes('streams.drb.coinbase.com') && socket.sent.length));
    assert.equal(coinbaseFuturesCalls, 1);
    const futureCell = page.locator('tr[data-live-product="BTC_USDC-PERPETUAL"] .futures-price');
    assert.match(await futureCell.innerText(), /100(?:\.0+)? USDC/);
    assert.match(await page.locator('th.futures-price').innerText(), /최근 체결가/);
    const subscription = await page.evaluate(() => testSockets.find(socket => socket.url.includes('streams.drb.coinbase.com')).sent[0]);
    assert.equal(subscription.method, 'public/subscribe');
    assert.deepEqual(subscription.params.channels, ['ticker.AI_USDC-PERPETUAL.100ms', 'ticker.BTC_USDC-PERPETUAL.100ms', 'ticker.ETH_USDC-PERPETUAL.100ms']);
    assert.match(await page.locator('tr[data-live-product="AI_USDC-PERPETUAL"] .futures-underlying').innerText(), /Sleepless AI/);
    assert.doesNotMatch(await page.locator('tr[data-live-product="AI_USDC-PERPETUAL"] .futures-underlying').innerText(), /Gensyn|젠신/);
    await emit('coinbase_futures', { jsonrpc: '2.0', method: 'subscription', params: { channel: 'ticker.BTC_USDC-PERPETUAL.100ms',
      data: { instrument_name: 'BTC_USDC-PERPETUAL', last_price: 101, mark_price: 98, timestamp: Date.now(), state: 'open' } } });
    await page.waitForFunction(() => document.querySelector('tr[data-live-product="BTC_USDC-PERPETUAL"] [data-live-price-main]').textContent.includes('101'));
    assert.match(await futureCell.getAttribute('title'), /Mark 98/);
    if (process.env.COINBASE_FUTURES_SCREENSHOT) {
      await page.screenshot({ path: process.env.COINBASE_FUTURES_SCREENSHOT });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: process.env.COINBASE_FUTURES_SCREENSHOT.replace('.png', '-mobile.png') });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.setViewportSize({ width: 1600, height: 1000 });
    }
    for (const timestamp of [Date.now() - 130000, Date.now() + 60000]) await emit('coinbase_futures', {
      method: 'subscription', params: { channel: 'ticker.BTC_USDC-PERPETUAL.100ms', data: { instrument_name: 'BTC_USDC-PERPETUAL', last_price: 999, timestamp, state: 'open' } },
    });
    assert.match(await futureCell.innerText(), /101(?:\.0+)? USDC/);
    await page.evaluate(() => { const row = getFuturesRows('coinbase').find(row => row.symbol === 'BTC'); row.futuresQuoteAt = Date.now() - 130000; refreshCoinbaseFuturesCells(); });
    assert.match(await futureCell.innerText(), /갱신 지연/);
    coinbaseFuturesFailure = true;
    await page.evaluate(async () => { coinbaseFuturesClient.checkedAt = 0; await requestCoinbaseFutures(); });
    assert.match(await page.locator('.futures-note[role="status"]').innerText(), /연결 지연/);
    const failedCoinbaseCalls = coinbaseFuturesCalls;
    await page.evaluate(() => { renderCurrentView(); renderCurrentView(); });
    assert.equal(coinbaseFuturesCalls, failedCoinbaseCalls);
    coinbaseFuturesFailure = false;
    await page.evaluate(async () => { coinbaseFuturesClient.checkedAt = 0; await requestCoinbaseFutures(); });
    await page.waitForFunction(() => !coinbaseFuturesClient.error);
    assert.match(await futureCell.innerText(), /100(?:\.0+)? USDC/);
    const coinbaseSilent = await page.evaluate(() => {
      const socket = livePriceSocket;
      livePriceTarget.socketStartedAt = Date.now() - 120000;
      livePriceTarget.lastMessageAt = Date.now() - 50000;
      livePriceTarget.lastQuoteAt = Date.now() - 120000;
      inspectComparisonStreams();
      return socket.readyState === 3;
    });
    assert.equal(coinbaseSilent, true);
    await page.waitForFunction(() => livePriceSocket?.readyState === 1);
    await page.evaluate(() => { state.board = 'upbit'; setViewMode('market'); renderCurrentView(); });
    assert.equal(await page.evaluate(() => testSockets.filter(socket => socket.url.includes('streams.drb.coinbase.com') && socket.readyState === 1).length), 0);
    console.log('PASS: Coinbase migrated contracts stream last trades (not marks), reject old clocks, expose stale states, retry quietly, reconnect and stop on navigation');

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

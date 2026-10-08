const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(root, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'board_snapshot.json'), 'utf8'));
  const deriveSource = html.match(/      function recomputeDerivedFields\([\s\S]*?(?=      function normalizeKnownAssetIdentities)/)[0];
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const derive = new Function('data', 'toPositiveNumber', 'computeCirculatingRatio', `${deriveSource}; return recomputeDerivedFields;`)(
    { fxUsdKrw: 1350 }, positive, (a, b) => a && b ? a / b : null);
  const authoritative = { priceUsd: 0.379, circulatingSupply: 190000000, marketCapUsd: 71947107.75,
    marketCapKrw: 71947107.75 * 1350, supplyIdentityVerified: true };
  derive(authoritative, { preferComputedCap: true });
  assert.equal(authoritative.marketCapUsd, 71947107.75, 'live prices never replace the authoritative spot market cap');
  const untrusted = { priceUsd: 0.379, circulatingSupply: 365386617983886, marketCapUsd: null, marketCapKrw: null };
  derive(untrusted, { preferComputedCap: true });
  assert.equal(untrusted.marketCapUsd, null, 'unverified supply cannot generate a fabricated market cap');
  const poisoned = { symbol: 'CT', name: 'CT', englishName: 'Concrete', contractId: 'CTUSDT', quoteAsset: 'USDT',
    priceUsd: 0.379, marketCapUsd: 138230000000000, marketCapKrw: 138230000000000 * 1350,
    circulatingSupply: 365386617983886, sortCapUsd: 138230000000000, nativeCurrency: 'USD' };
  snapshot.futures.binance.push({ ...poisoned, capSource: 'futures_underlying_coinbase' });
  snapshot.boards.coinbase.push({ ...poisoned, pair: 'CT/USD', capSource: 'coinbase_coingecko_market_cap' });
  const bybitFixture = Array.from({ length: 60 }, (_, index) => ({
    exchange: 'bybit', contractId: index === 0 ? 'BTCUSDT' : `TEST${index}USDT`,
    symbol: index === 0 ? 'BTC' : `TEST${index}`, name: index === 0 ? '비트코인' : `Test ${index}`,
    contractType: 'PERPETUAL', contractTypeLabel: '무기한', contractMarket: 'USDT-M',
    quoteAsset: 'USDT', marginAsset: 'USDT', exchangeStatus: 'Trading', symbolType: '',
    priceUsd: 100, priceKrw: 135000, marketCapUsd: 1000000 - index * 1000,
    marketCapKrw: (1000000 - index * 1000) * 1350, sortCapUsd: 1000000 - index * 1000,
  }));
  if (!process.env.BYBIT_LIVE_TEST) {
    for (const rows of [...Object.values(snapshot.boards), ...Object.values(snapshot.futures)]) {
      for (const row of rows) if (row.symbol === 'BTC') { row.priceUsd = 100; row.priceKrw = 135000; }
    }
  }
  bybitFixture[58].contractId = '1000TEST58USDT';
  bybitFixture[58].rawUnderlyingSymbol = '1000TEST58';
  snapshot.boards.binance.push(...bybitFixture.slice(1, 59).map(row => ({ ...row, exchange: 'binance', pair: `${row.symbol}/USDT` })));
  bybitFixture.push(...[
    { quoteAsset: 'USDC' }, { marginAsset: 'BTC' }, { contractType: 'FUTURES' },
    { exchangeStatus: 'Closed' }, { isPreListing: true }, { symbolType: 'stock' },
  ].map((extra, index) => ({ ...bybitFixture[0], contractId: `INVALID${index}USDT`, ...extra })));
  snapshot.futures.bybit = [];
  snapshot.refreshIssues = { ...snapshot.refreshIssues, bybit_futures: 'fallback_previous_payload:HTTP Error 403: Forbidden' };
  const bybitInstruments = bybitFixture.map(row => ({
    symbol: row.contractId, baseCoin: row.rawUnderlyingSymbol || row.symbol, quoteCoin: row.quoteAsset, settleCoin: row.marginAsset,
    status: row.exchangeStatus, contractType: row.contractType === 'PERPETUAL' ? 'LinearPerpetual' : 'LinearFutures',
    isPreListing: !!row.isPreListing, symbolType: row.symbolType,
  }));
  const bybitCalls = [];
  let failBybitPage = false;
  const news = { query: '', items: [{ id: 'news-test', title: 'Bitcoin news', summary: 'Summary', publishAt: Date.now() }], total: 1, storedCount: 1, nextOffset: 1, hasMore: false };
  snapshot.news = news;
  const feeRow = (slug, name, total24h) => ({ slug, name, total24h, total7d: total24h * 7, total30d: total24h * 30, change1d: 1, url: `https://defillama.com/chain/${slug}`, logo: '' });
  const fees = {
    l1fees: { rows: [feeRow('near', 'Near', 100), feeRow('bitcoin', 'Bitcoin', 200), feeRow('solana', 'Solana', 300), feeRow('bsc', 'BSC', 400)] },
    l2fees: { rows: [feeRow('base', 'Base', 100), feeRow('arbitrum', 'Arbitrum', 200)] },
  };
  const calls = [];
  const legacySettings = {
    resourceOrder: ['l1fees', 'futures', 'audit', 'ranking', 'l2fees'],
    resourceLabels: { ranking: '디파이라마' },
  };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'application/json');
    res.end(file.endsWith('data.js') ? `window.BOARD_DATA = ${JSON.stringify(snapshot)};` : file.endsWith('index.html') ? html : fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(settings => {
      if (!localStorage.getItem('fdv_screen_settings_v1')) {
        localStorage.setItem('fdv_screen_settings_v1', JSON.stringify(settings));
      }
    }, legacySettings);
    await page.addInitScript(() => {
      const nativeNow = Date.now;
      window.testTimeOffset = 0;
      Date.now = () => nativeNow() + window.testTimeOffset;
      const NativeWebSocket = window.WebSocket;
      const nativeInterval = window.setInterval;
      const nativeClear = window.clearInterval;
      window.bybitSockets = [];
      window.bybitIntervals = new Map();
      window.setInterval = (callback, delay, ...args) => {
        const id = nativeInterval(callback, delay, ...args);
        if (delay === 20000) window.bybitIntervals.set(id, callback);
        return id;
      };
      window.clearInterval = id => { window.bybitIntervals.delete(id); nativeClear(id); };
      function MockWebSocket(url) {
        if (!url.includes('stream.bybit.com')) return new NativeWebSocket(url);
        const socket = { url, readyState: 1, sent: [],
          send(message) { socket.sent.push(JSON.parse(message)); },
          close() { socket.readyState = 3; socket.onclose?.(); },
        };
        window.bybitSockets.push(socket);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      }
      MockWebSocket.OPEN = NativeWebSocket.OPEN;
      window.WebSocket = MockWebSocket;
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = process.env.BYBIT_LIVE_TEST ? 'https://fnfnfn3232.github.io' : `http://127.0.0.1:${server.address().port}`;
    await page.route('https://**/*', route => {
      const url = new URL(route.request().url());
      if (process.env.BYBIT_LIVE_TEST && url.hostname === 'fnfnfn3232.github.io') {
        if (url.pathname.endsWith('data.js')) return route.fulfill({ body: `window.BOARD_DATA = ${JSON.stringify(snapshot)};`, contentType: 'text/javascript' });
        if (url.pathname === '/coin/' || url.pathname.endsWith('/index.html')) return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
        const file = path.resolve(root, '.' + url.pathname.replace(/^\/coin/, ''));
        return route.fulfill({ body: file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      }
      if (url.hostname === 'api.bybit.com') {
        if (process.env.BYBIT_LIVE_TEST) return route.continue();
        bybitCalls.push(url.pathname + url.search);
        assert.equal(route.request().headers().cookie, undefined, 'public API never receives login cookies');
        if (failBybitPage && url.searchParams.get('cursor') === 'page2') {
          return route.fulfill({ status: 503, body: 'unavailable', headers: { 'Access-Control-Allow-Origin': origin } });
        }
        const result = url.pathname.endsWith('instruments-info')
          ? url.searchParams.get('cursor') === 'page2'
            ? { list: bybitInstruments.slice(45), nextPageCursor: '' }
            : { list: bybitInstruments.slice(0, 45), nextPageCursor: 'page2' }
          : { list: bybitFixture.map(row => ({ symbol: row.contractId, lastPrice: row.contractId.startsWith('1000') ? '100000' : '100' })) };
        return route.fulfill({ json: { retCode: 0, result }, headers: { 'Access-Control-Allow-Origin': origin } });
      }
      if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ body: '' });
      calls.push(url.pathname + url.search);
      let data = {};
      if (url.pathname === '/api/market-data') data = snapshot;
      else if (url.pathname === '/api/l1-fees') data = fees.l1fees;
      else if (url.pathname === '/api/l2-fees') data = fees.l2fees;
      else if (url.pathname === '/api/news') data = { ...news, query: url.searchParams.get('q') || '' };
      else if (url.pathname === '/api/session') data = { authenticated: true, role: 'admin' };
      else if (url.pathname === '/api/screen-settings') data = { settings: legacySettings };
      else if (url.pathname === '/api/board/posts') data = { posts: [] };
      else if (url.pathname === '/api/board/categories') data = { categories: [] };
      else if (url.pathname === '/api/live-prices') data = { boards: {}, futures: {} };
      return route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } });
    });
    await page.goto(process.env.BYBIT_LIVE_TEST ? `${origin}/coin/` : origin);
    await page.waitForFunction(() => !document.body.classList.contains('locked'));
    await page.locator('#marketToggleBtn').click();
    await page.waitForSelector('#tableBody .coin-mark');
    await page.locator('#searchInput').fill('BTC');
    assert.ok(await page.locator('#tableBody tr').count() > 0);
    await page.locator('#searchInput').fill('');
    await page.locator('#tabUpbit').click();
    await page.evaluate(() => {
      const row = document.querySelector('#tableBody tr');
      row.querySelector('.price-main').textContent = '112,669,000원';
      row.querySelector('.cap-main').textContent = '2267조 312억원';
      row.querySelector('.supply-main').textContent = '유통량 1,863억 3,541만개 · 총발행량 1,895억 5,524만개 · 유통비율 98.3%';
    });
    for (const width of [1920, 1440, 1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('#tableBody .price-main, #tableBody .cap-main, #tableBody .supply-main')];
        return {
          pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
          coinWidth: document.querySelector('#tableBody tr td:nth-child(2)').getBoundingClientRect().width,
          tableFits: document.querySelector('#marketTable').getBoundingClientRect().width <= document.querySelector('.table-wrap').clientWidth + 1,
          cells: nodes.map(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const lines = [...new Set([...range.getClientRects()].map(rect => Math.round(rect.top)))];
            const box = node.getBoundingClientRect();
            const cell = node.closest('td').getBoundingClientRect();
            return { lines: lines.length, fits: box.right <= cell.right + 1 && box.left >= cell.left - 1,
              accessible: node.scrollWidth <= node.clientWidth + 1 || getComputedStyle(node).overflowX === 'auto' };
          }),
        };
      });
      assert.ok(layout.pageFits, `spot table stays within the page at ${width}px`);
      if (width === 1920) assert.ok(layout.tableFits, 'wide desktop shows every spot column without scrolling');
      if (width > 820) assert.ok(layout.coinWidth >= 200, `spot coin names retain readable space at ${width}px`);
      assert.ok(layout.cells.every(cell => cell.lines === 1), `spot prices, caps and supply stay on one line at ${width}px`);
      assert.ok(layout.cells.every(cell => cell.fits && cell.accessible), `spot values never overlap or hide text at ${width}px`);
      if (width === 1920 || width === 390) {
        await page.locator('#tableBody tr').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.TEMP || root, `blockscope-spot-layout-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#tabBinance').click();
    assert.ok(await page.locator('#tableBody tr').count() > 1);
    await page.locator('#resourcesMenuBtn').click();

    async function openResource(mode) {
      if (mode === 'l1fees' || mode === 'l2fees') {
        if (!await page.locator('[data-defi-view]').count()) {
          await page.locator('[data-resource-view="ranking"]').click();
        }
        await page.locator(`[data-defi-view="${mode}"]`).click();
      } else {
        await page.locator(`[data-resource-view="${mode}"]`).click();
      }
    }
    assert.equal(await page.locator('.resource-tab').count(), 3);
    assert.deepEqual(await page.locator('.resource-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.resourceView)), ['futures', 'audit', 'ranking']);
    assert.equal(await page.locator('[data-resource-view="ranking"]').textContent(), '디파이');
    assert.equal(await page.locator('[data-resource-view="l1fees"], [data-resource-view="l2fees"]').count(), 0);
    await openResource('ranking');
    assert.equal(await page.locator('.defi-tabs button').count(), 7);
    assert.equal(await page.locator('.defi-tabs .active').getAttribute('data-ranking-category'), 'tvl');
    await openResource('l2fees');
    await page.waitForSelector('.l2-fees-table');
    assert.equal(await page.locator('.resource-tab.active').getAttribute('data-resource-view'), 'ranking');
    assert.equal(await page.locator('.defi-tabs .active').getAttribute('data-defi-view'), 'l2fees');
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), fees.l2fees.rows.length);
    await openResource('l1fees');
    await page.waitForSelector('.l2-fees-table');
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), fees.l1fees.rows.length);
    await page.locator('[data-l2-sort="total24h"]').click();
    assert.match(await page.locator('.l2-fees-table tbody tr').first().textContent(), /Near/);
    await page.locator('[data-ranking-category="fees"]').click();
    assert.equal(await page.locator('.defi-tabs .active').getAttribute('data-ranking-category'), 'fees');
    assert.ok(await page.locator('#rankingSearchForm').count());
    await page.goBack();
    await page.waitForSelector('.l2-fees-table');
    assert.equal(await page.locator('.defi-tabs .active').getAttribute('data-defi-view'), 'l1fees');
    await page.reload();
    await page.waitForSelector('.l2-fees-table');
    assert.equal(await page.locator('.defi-tabs .active').getAttribute('data-defi-view'), 'l1fees');
    assert.equal(await page.locator('.resource-tab.active').textContent(), '디파이');
    await page.screenshot({ path: path.join(process.env.TEMP || root, 'blockscope-defi-desktop.png') });
    console.log('PASS: legacy settings migrate to three parent tabs; all seven DeFi tabs, fee sorting, cross-view navigation, back, and reload.');

    await openResource('l1fees');
    await page.waitForSelector('.l2-fees-table');
    const videoCdp = await page.context().newCDPSession(page);
    const videoInput = page.locator('#l2FeesSearchForm input');
    const videoRows = page.locator('.l2-fees-table tbody tr');
    const videoInputHandle = await videoInput.elementHandle();
    async function composeSyllables(groups) {
      await videoInput.focus();
      for (const group of groups) {
        for (const text of group) {
          await videoCdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        }
        await videoCdp.send('Input.insertText', { text: group.at(-1) });
        assert.ok(await videoInputHandle.evaluate(input => input.isConnected), 'video regression: the IME input must stay attached after each syllable');
      }
    }
    await composeSyllables([['ㅅ', '소', '솔'], ['ㄹ', '라']]);
    assert.equal(await videoInput.inputValue(), '솔라', 'video regression: Solana text never splits into standalone jamo');
    assert.equal(await videoRows.count(), 1);
    assert.match(await videoRows.textContent(), /Solana/);
    await composeSyllables([['ㄴ', '나']]);
    assert.equal(await videoInput.inputValue(), '솔라나');
    for (let index = 0; index < 3; index++) await videoInput.press('Backspace');
    assert.equal(await videoInput.inputValue(), '');
    assert.equal(await videoRows.count(), fees.l1fees.rows.length);
    await composeSyllables([['ㅂ', '비'], ['ㅌ', '트']]);
    assert.equal(await videoInput.inputValue(), '비트');
    assert.equal(await videoRows.count(), 1, 'video regression: the final syllable is applied, not only the first syllable');
    assert.match(await videoRows.textContent(), /Bitcoin/);
    await videoInput.press('Backspace');
    await videoInput.press('Backspace');
    assert.equal(await videoInput.inputValue(), '');
    assert.equal(await videoRows.count(), fees.l1fees.rows.length, 'video regression: deleting Bitcoin restores every chain');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await videoInput.focus();
      await videoCdp.send('Input.imeSetComposition', { text: '솔라', selectionStart: 2, selectionEnd: 2 });
      const bounds = await videoInput.boundingBox();
      await page.mouse.click(bounds.x + bounds.width - 24, bounds.y + bounds.height / 2);
      assert.equal(await videoInput.inputValue(), '', `video regression: ${width}px native clear during composition`);
      assert.equal(await videoRows.count(), fees.l1fees.rows.length);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log('PASS: video sequence Solana -> clear -> Bitcoin -> clear, syllable composition, and native clear during composition.');
    if (process.env.SEARCH_VIDEO_ONLY) {
      assert.deepEqual(errors, []);
      return;
    }

    await openResource('futures');
    assert.equal(await page.locator('.futures-tab').count(), 3);
    await page.locator('#futuresSearchForm input').fill('CTUSDT');
    const legacyCt = page.locator('tr[data-live-product="CTUSDT"] .futures-cap').last();
    assert.doesNotMatch(await legacyCt.textContent(), /138\.23|33,656|\$0/, 'legacy poisoned CT cap is not rendered or treated as zero');
    await page.locator('#futuresSearchForm input').fill('');
    await page.locator('[data-futures-exchange="bybit"]').click();
    const bybitRows = page.locator('.futures-table tbody tr');
    await page.waitForFunction(() => document.querySelectorAll('.futures-table tbody tr').length === 50);
    assert.equal(await bybitRows.count(), 50);
    if (process.env.BYBIT_LIVE_TEST) {
      const meta = await page.locator('.futures-meta').textContent();
      assert.ok(Number(meta.match(/총 ([\d,]+)개/)[1].replaceAll(',', '')) > 100);
      await page.locator('#futuresSearchForm input').fill('BTCUSDT');
      const btcRow = page.locator('tr[data-live-product="BTCUSDT"]');
      assert.equal(await btcRow.count(), 1);
      assert.match(await btcRow.textContent(), /비트코인/);
      assert.ok(!/\$0(?:\s|원)/.test(await btcRow.locator('[data-live-price-main]').textContent()));
      assert.equal(await page.locator('.futures-note[role="status"]').count(), 0);
      await page.locator('#futuresSearchForm input').fill('');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: path.join(process.env.TEMP || root, `blockscope-bybit-live-${width}.png`) });
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: real Bybit public REST, production browser origin/CORS, live contract prices, spot cap linkage and desktop/mobile layout: ${meta}`);
      return;
    }
    assert.equal(bybitCalls.length, 3, 'all instrument pages and one bulk ticker request, even with an empty server snapshot');
    assert.equal(await page.locator('.futures-note[role="status"]').count(), 0, 'server-region 403 does not override successful public quotes');
    assert.ok(!(await bybitRows.allTextContents()).some(text => text.includes('INVALID')));
    const topics = await page.evaluate(() => bybitSockets.at(-1).sent.find(message => message.op === 'subscribe').args);
    assert.equal(topics.length, 50);
    assert.ok(topics.every(topic => topic.startsWith('tickers.') && topic.endsWith('USDT')));
    await page.locator('#futuresSearchForm input').fill('비트코인');
    assert.equal(await bybitRows.count(), 1);
    await page.evaluate(() => {
      const socket = bybitSockets.at(-1);
      socket.onmessage({ data: JSON.stringify({ topic: 'tickers.BTCUSDT', type: 'snapshot', data: { symbol: 'BTCUSDT', lastPrice: '432.1' } }) });
    });
    await page.waitForFunction(() => document.querySelector('[data-live-price-main]')?.textContent.includes('432.1'));
    const price = await bybitRows.locator('[data-live-price-main]').textContent();
    await page.evaluate(() => {
      bybitSockets.at(-1).onmessage({ data: JSON.stringify({ topic: 'tickers.BTCUSDT', type: 'delta', data: { fundingRate: '0.001' } }) });
    });
    assert.equal(await bybitRows.locator('[data-live-price-main]').textContent(), price, 'deltas without lastPrice never erase the price');
    await page.evaluate(() => {
      for (const callback of bybitIntervals.values()) callback();
      bybitSockets.at(-1).onmessage({ data: JSON.stringify({ topic: 'tickers.BTCUSDT', type: 'delta', data: { lastPrice: '500' } }) });
    });
    await page.waitForFunction(() => document.querySelector('[data-live-price-main]')?.textContent.includes('500'));
    assert.ok(await page.evaluate(() => bybitSockets.at(-1).sent.some(message => message.op === 'ping')));
    await page.locator('#futuresSearchForm input').fill('');
    assert.equal(await bybitRows.count(), 50);
    await page.locator('[data-futures-page="2"]').click();
    assert.equal(await bybitRows.count(), 10);
    await page.locator('[data-futures-sort]').click();
    assert.equal(await bybitRows.count(), 50);
    assert.match(await bybitRows.first().textContent(), /TEST58USDT/);
    assert.equal(await bybitRows.first().locator('.futures-underlying > span').textContent(), 'TEST58', 'bundled contracts link to the underlying coin, not a multiplied token supply');
    await page.locator('[data-futures-sort]').click();
    assert.match(await bybitRows.first().textContent(), /BTCUSDT/);
    await page.locator('#futuresSearchForm input').fill('TEST59');
    assert.equal(await bybitRows.count(), 1);
    assert.doesNotMatch(await bybitRows.locator('.futures-cap').textContent(), /\$0|0원/, 'unknown market caps are never displayed as a zero value');
    await page.locator('#futuresSearchForm input').fill('');
    assert.equal(bybitCalls.length, 3, 'search, pagination and sorting use memory, not additional API requests');
    await page.reload();
    await page.waitForSelector('.futures-table');
    assert.equal(await page.locator('.futures-tab.active').getAttribute('data-futures-exchange'), 'bybit');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('[data-futures-exchange="binance"]').click();
      await page.locator('[data-futures-exchange="bybit"]').click();
      const tab = await page.locator('.futures-tab.active').boundingBox();
      const nav = await page.locator('.futures-tabs').boundingBox();
      assert.ok(tab.x >= nav.x - 1 && tab.x + tab.width <= nav.x + nav.width + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(process.env.TEMP || root, `blockscope-bybit-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    failBybitPage = true;
    await page.evaluate(() => { window.testTimeOffset = 600001; });
    await page.locator('[data-futures-exchange="binance"]').click();
    await page.locator('[data-futures-exchange="bybit"]').click();
    await page.waitForSelector('.futures-note[role="status"]');
    assert.equal(await bybitRows.count(), 50, 'partial API refresh cannot erase the last complete list');
    assert.match(await page.locator('.futures-meta').textContent(), /총 60개/);
    const failedCalls = bybitCalls.length;
    await page.locator('#futuresSearchForm input').fill('비트코인');
    await page.locator('#futuresSearchForm input').fill('');
    assert.equal(bybitCalls.length, failedCalls, 'failed requests have a cooldown, including search rerenders');
    failBybitPage = false;
    await page.evaluate(() => { window.testTimeOffset += 60001; });
    await page.locator('[data-futures-exchange="binance"]').click();
    await page.locator('[data-futures-exchange="bybit"]').click();
    await page.waitForFunction(() => !document.querySelector('.futures-note[role="status"]'));
    assert.equal(await bybitRows.count(), 50, 'successful retry restores the complete list and clears the warning');
    await page.evaluate(() => { window.testTimeOffset = 0; });
    await page.locator('[data-futures-exchange="coinbase"]').click();
    assert.equal(await page.evaluate(() => bybitIntervals.size), 0, 'leaving Bybit stops its heartbeat');
    assert.ok(await page.evaluate(() => bybitSockets.every(socket => socket.readyState === 3)), 'leaving Bybit closes every Bybit socket');
    await page.locator('[data-futures-exchange="binance"]').click();
    console.log('PASS: Bybit browser-direct bulk API, all instrument pages, empty server snapshot, spot cap linkage, filters, cached search, pagination, sorting, history/reload, realtime snapshot/delta, heartbeat cleanup, and desktop/mobile layout.');

    const cases = [
      ['futures', '#futuresSearchForm input', '.futures-table tbody tr', 'BTC'],
      ['ranking', '#rankingSearchForm input', '.ranking-table tbody tr', 'zz-no-protocol'],
      ['audit', '#auditSearchForm input', '.audit-table tbody tr', '비트코인'],
      ['l1fees', '#l2FeesSearchForm input', '.l2-fees-table tbody tr', '니어'],
      ['l2fees', '#l2FeesSearchForm input', '.l2-fees-table tbody tr', '베이스'],
    ];
    for (const [mode, selector, rows, query] of cases) {
      await openResource(mode);
      await page.waitForSelector(rows);
      const originalCount = await page.locator(rows).count();
      const historyLength = await page.evaluate(() => history.length);
      const apiCalls = calls.filter(call => /\/api\/(?:l[12]-fees|market-data)/.test(call)).length;
      const originalInput = await page.locator(selector).elementHandle();
      await page.locator(selector).fill(query);
      assert.equal(await page.locator(selector).inputValue(), query);
      assert.ok(await page.locator(selector).evaluate(input => document.activeElement === input));
      assert.ok(await originalInput.evaluate(input => input.isConnected), `${mode} never replaces the live search input`);
      assert.ok(await page.locator(rows).count() < originalCount, `${mode} filters without submit`);
      if (mode === 'l1fees') assert.match(await page.locator(rows).textContent(), /Near/);
      const searchBounds = await page.locator(selector).boundingBox();
      await page.mouse.click(searchBounds.x + searchBounds.width - 24, searchBounds.y + searchBounds.height / 2);
      assert.equal(await page.locator(selector).inputValue(), '', `${mode} native clear button clears the field`);
      assert.equal(await page.locator(rows).count(), originalCount, `${mode} native clear button restores all rows`);
      await page.locator(selector).fill(query);
      await page.locator(selector).press('ControlOrMeta+A');
      await page.locator(selector).press('Backspace');
      assert.equal(await page.locator(rows).count(), originalCount, `${mode} restores all rows when cleared`);
      await page.locator(selector).pressSequentially('zz-no-match', { delay: 10 });
      assert.equal(await page.locator(selector).inputValue(), 'zz-no-match', `${mode} keeps typing focus`);
      assert.equal(await page.locator(rows).count(), 0);
      await page.locator(selector).evaluate(input => {
        input.value = '';
        input.dispatchEvent(new Event('search', { bubbles: false }));
      });
      assert.equal(await page.locator(rows).count(), originalCount, `${mode} supports the native search clear event`);
      assert.equal(await page.evaluate(() => history.length), historyLength, `${mode} does not add history per keystroke`);
      assert.equal(calls.filter(call => /\/api\/(?:l[12]-fees|market-data)/.test(call)).length, apiCalls, `${mode} filters locally`);
      if (mode === 'futures' || mode === 'audit') {
        await page.locator(`[data-${mode}-page="2"]`).click();
        await page.locator(selector).fill(query);
        assert.equal(await page.evaluate(key => history.state[key], mode === 'futures' ? 'futuresPage' : 'upbitAuditPage'), 1);
        await page.locator(selector).fill('');
      }
      if (mode !== 'l1fees' && mode !== 'l2fees') {
        await page.locator(selector).fill(query);
        await page.locator(`[data-${mode}-clear]`).evaluate(button => button.click());
        assert.equal(await page.locator(selector).inputValue(), '', `${mode} reset clears even when focus stays in the input`);
        assert.equal(await page.locator(rows).count(), originalCount);
      }
      console.log(`PASS: ${mode} live search and clear`);
    }

    await openResource('l1fees');
    await page.waitForSelector('.l2-fees-table');
    await page.locator('#l2FeesSearchForm input').focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '니어', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '니어' });
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), 1);
    await cdp.send('Input.imeSetComposition', { text: '니어', selectionStart: 2, selectionEnd: 2, replacementStart: 0, replacementEnd: 2 });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    assert.equal(await page.locator('#l2FeesSearchForm input').inputValue(), '');
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), fees.l1fees.rows.length, 'clearing Korean composition restores the full list');
    await page.locator('#l2FeesSearchForm input').evaluate(input => {
      window.composingInput = input;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = '니';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    assert.ok(await page.evaluate(() => composingInput.isConnected && document.activeElement === composingInput));
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), 1);
    await page.locator('[data-l2-refresh]').evaluate(button => button.click());
    await page.waitForFunction(() => !document.querySelector('[data-l2-refresh]').disabled);
    assert.ok(await page.evaluate(() => composingInput.isConnected));
    await page.locator('#l2FeesSearchForm input').evaluate(input => {
      input.value = '니어';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '어' }));
    });
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), 1);
    assert.equal(await page.locator('#l2FeesSearchForm input').inputValue(), '니어');
    await page.locator('#l2FeesSearchForm input').evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'deleteContentBackward' }));
    });
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), fees.l1fees.rows.length, 'empty input restores all rows even before compositionend');
    await page.locator('#l2FeesSearchForm input').dispatchEvent('compositionend');
    await page.locator('#l2FeesSearchForm input').fill('니어');
    await page.locator('#l2FeesSearchForm input').evaluate(input => input.setSelectionRange(1, 1));
    await page.locator('#l2FeesSearchForm input').press('Backspace');
    assert.equal(await page.locator('#l2FeesSearchForm input').evaluate(input => input.selectionStart), 0);
    await page.locator('#l2FeesSearchForm input').fill('');
    await page.locator('#l2FeesSearchForm input').press('Enter');
    assert.equal(await page.locator('.l2-fees-table tbody tr').count(), fees.l1fees.rows.length);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await openResource('l2fees');
      await openResource('l1fees');
      const tabBounds = await page.locator('.defi-tabs .active').boundingBox();
      const navBounds = await page.locator('.defi-tabs').boundingBox();
      assert.ok(tabBounds.x >= navBounds.x - 1 && tabBounds.x + tabBounds.width <= navBounds.x + navBounds.width + 1, `${width}px active DeFi tab scrolls into view`);
      await page.locator('#l2FeesSearchForm input').fill('니어');
      assert.equal(await page.locator('.l2-fees-table tbody tr').count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(process.env.TEMP || root, `blockscope-live-search-${width}.png`) });
      const bounds = await page.locator('#l2FeesSearchForm input').boundingBox();
      await page.mouse.click(bounds.x + bounds.width - 24, bounds.y + bounds.height / 2);
      assert.equal(await page.locator('#l2FeesSearchForm input').inputValue(), '');
      assert.equal(await page.locator('.l2-fees-table tbody tr').count(), fees.l1fees.rows.length);
    }

    await page.locator('#newsToggleBtn').click();
    await page.waitForSelector('.news-item');
    const newsHtml = await page.locator('.news-text-box').innerHTML();
    const newsCalls = calls.filter(call => call.startsWith('/api/news')).length;
    await page.locator('#newsSearchForm input').fill('should-not-search');
    assert.equal(await page.locator('.news-text-box').innerHTML(), newsHtml);
    assert.equal(calls.filter(call => call.startsWith('/api/news')).length, newsCalls);
    await page.locator('#newsSearchForm').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('.news-refresh-status')?.textContent.includes('완료'));
    assert.ok(calls.some(call => call.includes('q=should-not-search')));

    await page.locator('#boardToggleBtn').click();
    await page.waitForSelector('#freeBoardSearchInput');
    await page.locator('#freeBoardSearchInput').fill('not-applied-yet');
    assert.equal(await page.evaluate(() => history.state.freeBoardQuery), '');
    await page.locator('[data-free-board-search]').click();
    assert.equal(await page.evaluate(() => history.state.freeBoardQuery), 'not-applied-yet');
    assert.deepEqual(errors, []);
    console.log('PASS: instant resource filtering, clear/reset, focus/cursor, Korean IME, pagination, local-only queries, mobile, and unchanged news/board search.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

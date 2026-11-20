const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const origin = 'https://fnfnfn3232.github.io';
  const site = origin + '/coin/';
  const data = require('./test_market_fixture.cjs')();
  const now = Date.now();
  const expiresAt = now + 3600000;
  const token = `v3.${Math.floor(expiresAt / 1000)}.spot-test.admin.owner.0.test-signature`;
  const base = { pair: 'BTC/USDT', nativeCurrency: 'USDT', priceUpdatedAt: Math.floor(now / 1000) };
  data.boards.bybit = [];
  data.boards.bitget = [{ ...data.boards.binance[0], ...base, exchange: 'bitget', spotListingDate: '2018-07-24' }];
  data.spotListings = { bybit: { 'BTC/USDT': { date: '2021-07-15' }, 'KOR/USDT': { date: '2026-11-04' } },
    upbit: { 'BTC/KRW': { date: '2017-10-24' } } };
  data.spotTradingEnds = { bybit: { 'KOR/USDT': { at: Math.floor(now / 1000) + 86400, url: 'https://announcements.bybit.com/' },
    'BTC/USDC': { at: Math.floor(now / 1000) + 86400 }, 'REUSED/USDT': { at: Math.floor(now / 1000) - 1 } } };
  data.spotSpecialTreatment = { bitget: { pairs: ['BTC/USDT'], observedAt: Math.floor(now / 1000) } };
  data.spotMarketStatus = { bybit: { usePublicFeed: true }, bitget: { usePublicFeed: false } };
  data.spotMarketReferences = { bybit: {
    BTC: { englishName: 'Bitcoin', koreanName: '비트코인', referencePriceUsd: 100, marketCapUsd: 1e12,
      circulatingSupply: 19000000, totalSupply: 21000000,
      capSource: 'spot_coinpaprika_asset', capSourceDetail: 'coinpaprika:btc-bitcoin', capUpdatedAt: Math.floor(now / 1000) },
    AI: { englishName: 'Sleepless AI', referencePriceUsd: 0.02, marketCapUsd: 1e7 },
    KOR: { englishName: 'Kor Protocol', circulatingSupply: 2286666667, totalSupply: 10000000000,
      capSource: 'spot_launch_supply_estimate', verifiedListingKey: '1331',
      launchSupplyAt: Math.floor(now / 1000) - 86400, launchSupplyUntil: Math.floor(now / 1000) + 86400 },
    REUSED: { englishName: 'Previous project', referencePriceUsd: 100, marketCapUsd: 1e7, verifiedListingKey: '42' },
  } };
  data.coinInfo.AI = { englishName: 'Gensyn', koreanName: '젠신', sources: {}, listings: {} };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addInitScript(token => {
      sessionStorage.setItem('fdv_server_auth_session_token_v1', token);
      window.__sockets = [];
      window.WebSocket = class {
        static OPEN = 1;
        constructor(url) {
          this.url = url; this.readyState = 1; this.sent = [];
          window.__sockets.push(this);
          setTimeout(() => this.onopen?.(), 0);
        }
        send(message) { this.sent.push(message); }
        close() { this.readyState = 3; }
      };
    }, token);
    const requests = [];
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) {
        const file = path.join(__dirname, url.pathname.slice('/coin/'.length) || 'index.html');
        if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: 'window.BOARD_DATA=null;', contentType: 'text/javascript' });
        return route.fulfill({ body: fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : '',
          contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
      }
      const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' };
      if (url.hostname === 'coin-board-auth.dlatl20000.workers.dev') {
        const json = url.pathname === '/api/session' ? { ok: true, token, expiresAt, role: 'admin', subject: 'owner' }
          : url.pathname === '/api/market-data' ? data : {};
        return route.fulfill({ json, headers });
      }
      if (url.hostname === 'api.bybit.com' && url.searchParams.get('category') === 'spot') {
        assert.equal(route.request().headers().authorization, undefined);
        requests.push(url.pathname);
        const list = url.pathname.endsWith('instruments-info')
          ? ['BTC', 'AI', 'KOR', 'REUSED', 'AAPLX', 'HALT'].map(baseCoin => ({ baseCoin, quoteCoin: 'USDT', symbol: baseCoin + 'USDT',
              symbolId: baseCoin === 'KOR' ? 1331 : 1332,
              stTag: baseCoin === 'AI' ? '1' : '0',
              symbolType: baseCoin === 'AAPLX' ? 'xstocks' : '', status: baseCoin === 'HALT' ? 'Closed' : 'Trading' }))
          : ['BTC', 'AI', 'KOR', 'REUSED', 'AAPLX', 'HALT'].map(symbol => ({ symbol: symbol + 'USDT',
              lastPrice: ({ AI: '0.02', KOR: '0.001107' })[symbol] || '100' }));
        return route.fulfill({ json: { retCode: 0, time: Date.now(), result: { category: 'spot', list } }, headers });
      }
      return route.fulfill({ json: {}, headers });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(site);
    await page.waitForFunction(() => siteAuthConfirmed && data.spotMarketStatus);
    assert.equal(requests.length, 0, 'no extra spot REST fetch before selection');
    await page.locator('.tab[data-board="bybit"]').click();
    await page.waitForFunction(() => getBoardRows('bybit').length === 4);
    assert.equal(requests.length, 2);
    assert.deepEqual(await page.evaluate(() => getBoardRows('bybit').map(row => row.symbol)), ['BTC', 'AI', 'KOR', 'REUSED']);
    assert.equal(await page.evaluate(() => getBoardRows('bybit')[0].marketCapUsd), 1e12);
    assert.equal(await page.evaluate(() => getBoardRows('bybit')[0].capSource), 'spot_coinpaprika_asset');
    assert.match(await page.locator('#statusText').textContent(), /USDT 현물 4개/);
    const kor = page.locator('tr[data-live-product="KORUSDT"]');
    const btc = page.locator('tr[data-live-product="BTCUSDT"]');
    assert.match(await btc.locator('.supply-main').textContent(), /유통비율 90\.48%/);
    assert.equal(await page.evaluate(() => getBoardRows('bybit')[0].circulatingSupply), 19000000);
    assert.equal(await page.evaluate(() => getBoardRows('bybit')[0].totalSupply), 21000000);
    assert.equal(await kor.locator('.asset-risk-badge.delisting').textContent(), '상폐예정');
    assert.equal(await page.locator('tr[data-live-product="AIUSDT"] .asset-risk-badge.warning').textContent(), '유의(ST)');
    assert.equal(await btc.locator('.asset-risk-badge.delisting').count(), 0, 'a USDC notice cannot affect USDT');
    assert.equal(await page.locator('tr[data-live-product="REUSEDUSDT"] .asset-risk-badge.delisting').count(), 0);
    const listingHeader = page.locator('#thListingDate');
    await listingHeader.click();
    assert.equal(await listingHeader.getAttribute('aria-sort'), 'descending');
    assert.deepEqual(await page.evaluate(() => getRows().map(row => row.symbol)), ['KOR', 'BTC', 'AI', 'REUSED']);
    await listingHeader.press('Enter');
    assert.equal(await listingHeader.getAttribute('aria-sort'), 'ascending');
    assert.deepEqual(await page.evaluate(() => getRows().map(row => row.symbol)), ['BTC', 'KOR', 'AI', 'REUSED']);
    assert.match(await kor.locator('.cap-sub').textContent(), /참고 시총/);
    assert.match(await kor.locator('.supply-main').textContent(), /발행 시점 유통량/);
    assert.equal(await page.evaluate(() => getBoardRows('bybit').find(row => row.symbol === 'KOR').marketCapUsd), 2286666667 * 0.001107);
    assert.equal(await page.evaluate(() => getBoardRows('bybit').find(row => row.symbol === 'REUSED').marketCapUsd), null);
    await page.getByRole('button', { name: 'Sleepless AI 코인 정보 보기' }).click();
    assert.match(await page.locator('#coinInfoTitle').textContent(), /Sleepless AI/);
    await page.locator('#coinInfoCloseBtn').click();
    const freshSnapshot = await page.evaluate(() => data.generatedAt);
    await page.evaluate(() => {
      data.generatedAt -= 86400;
      render();
    });
    await page.waitForFunction(() => getBoardRows('bybit')[0].marketCapUsd === null
      && !publicSpotBoards.get('bybit').loading);
    assert.equal(await page.evaluate(() => getBoardRows('bybit')[0].circulatingSupply ?? null), null, 'stale reference supply is not presented as current');
    assert.equal(await btc.locator('.price-main').textContent(), '100 USDT', 'live price survives stale cap data');
    assert.match(await page.locator('#marketReferenceStatus').textContent(), /시총·유통량 갱신 지연/);
    assert.equal(await page.locator('#marketReferenceStatus').isVisible(), true);
    const beforeRecovery = requests.length;
    await page.evaluate(at => {
      data.generatedAt = at;
      render();
    }, freshSnapshot);
    await page.waitForFunction(() => getBoardRows('bybit')[0].marketCapUsd === 1e12
      && !publicSpotBoards.get('bybit').loading);
    assert.equal(requests.length, beforeRecovery + 2, 'a new snapshot refreshes caps without waiting five minutes or reloading');
    assert.equal(await page.locator('#marketReferenceStatus').isVisible(), false);
    assert.match(await btc.locator('.supply-main').textContent(), /유통비율 90\.48%/);
    const beforeRenders = requests.length;
    await page.evaluate(() => { render(); render(); render(); });
    assert.equal(requests.length, beforeRenders, 'unchanged snapshots keep the bulk request cooldown');
    await page.locator('#compareBoardSelect').selectOption('upbit');
    assert.deepEqual(await page.evaluate(() => getRows().map(row => row.symbol)), ['BTC']);
    assert.deepEqual(await btc.locator('td[data-label="상장일"] time').allTextContents(), ['2021-07-15', '2017-10-24']);
    await page.locator('.tab[data-board="bitget"]').click();
    await page.waitForFunction(() => window.__sockets.some(socket => socket.url.includes('ws.bitget.com') && socket.sent.length));
    assert.equal(await page.locator('#thPriceDifference').isVisible(), false);
    assert.equal(await btc.locator('.asset-risk-badge.warning').textContent(), '비트겟 유의(ST)');
    assert.deepEqual(await btc.locator('td[data-label="상장일"] time').allTextContents(), ['2018-07-24', '2017-10-24']);
    await page.evaluate(() => {
      const socket = window.__sockets.findLast(socket => socket.url.includes('ws.bitget.com'));
      socket.onmessage({ data: JSON.stringify({ arg: { instType: 'SPOT', channel: 'ticker', instId: 'BTCUSDT' },
        data: [{ instId: 'BTCUSDT', lastPr: '123.45', ts: Date.now() }] }) });
    });
    await page.waitForFunction(() => document.querySelector('[data-live-exchange="bitget"] [data-live-price-main]')?.textContent === '123.45 USDT');
    assert.equal(await page.evaluate(() => getBoardRows('bitget')[0].marketCapUsd), 1e12);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#marketListingSort').click();
    assert.equal(await listingHeader.getAttribute('aria-sort'), 'descending');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: Bybit official fallback, identity-safe comparison, stale-cap warning, snapshot recovery without reload, Bitget spot stream, and mobile layout');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

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
  data.boards.bitget = [{ ...data.boards.binance[0], ...base, exchange: 'bitget' }];
  data.spotMarketStatus = { bybit: { usePublicFeed: true }, bitget: { usePublicFeed: false } };
  data.spotMarketReferences = { bybit: {
    BTC: { englishName: 'Bitcoin', koreanName: '비트코인', referencePriceUsd: 100, marketCapUsd: 1e12,
      capSource: 'spot_coinpaprika_asset', capSourceDetail: 'coinpaprika:btc-bitcoin', capUpdatedAt: Math.floor(now / 1000) },
    AI: { englishName: 'Sleepless AI', referencePriceUsd: 0.02, marketCapUsd: 1e7 },
    KOR: { englishName: 'Kor Protocol', referencePriceUsd: 0.0011, marketCapUsd: 2515333.3337,
      circulatingSupply: 2286666667, totalSupply: 10000000000, capSource: 'spot_coinmarketcap_reported',
      verifiedListingKey: '1331', capUpdatedAt: Math.floor(now / 1000) },
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
    assert.match(await kor.locator('.cap-sub').textContent(), /참고 시총/);
    assert.match(await kor.locator('.supply-main').textContent(), /신고 유통량/);
    assert.equal(await page.evaluate(() => getBoardRows('bybit').find(row => row.symbol === 'REUSED').marketCapUsd), null);
    await page.getByRole('button', { name: 'Sleepless AI 코인 정보 보기' }).click();
    assert.match(await page.locator('#coinInfoTitle').textContent(), /Sleepless AI/);
    await page.locator('#coinInfoCloseBtn').click();
    await page.locator('#compareBoardSelect').selectOption('upbit');
    assert.deepEqual(await page.evaluate(() => getRows().map(row => row.symbol)), ['BTC']);
    await page.locator('.tab[data-board="bitget"]').click();
    await page.waitForFunction(() => window.__sockets.some(socket => socket.url.includes('ws.bitget.com') && socket.sent.length));
    assert.equal(await page.locator('#thPriceDifference').isVisible(), false);
    await page.evaluate(() => {
      const socket = window.__sockets.findLast(socket => socket.url.includes('ws.bitget.com'));
      socket.onmessage({ data: JSON.stringify({ arg: { instType: 'SPOT', channel: 'ticker', instId: 'BTCUSDT' },
        data: [{ instId: 'BTCUSDT', lastPr: '123.45', ts: Date.now() }] }) });
    });
    await page.waitForFunction(() => document.querySelector('[data-live-exchange="bitget"] [data-live-price-main]')?.textContent === '123.45 USDT');
    assert.equal(await page.evaluate(() => getBoardRows('bitget')[0].marketCapUsd), 1e12);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: Bybit official fallback, identity-safe comparison, Bitget spot stream, and mobile layout');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

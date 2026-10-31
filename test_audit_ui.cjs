const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = __dirname;
  const snapshot = require('./test_market_fixture.cjs')();
  snapshot.upbitAssetNames = {
    SHELL: { symbol: 'SHELL', koreanName: '마이쉘', englishName: 'MyShell', source: 'upbit_market_all', active: true, markets: ['BTC-SHELL', 'USDT-SHELL'] },
    FORMER: { symbol: 'FORMER', koreanName: '이전코인', englishName: 'Former Coin', source: 'upbit_market_all', active: false, markets: ['BTC-FORMER'] },
    AI: { symbol: 'AI', koreanName: '젠신', englishName: 'Gensyn', source: 'upbit_market_all', active: true, markets: ['KRW-AI'] },
  };
  snapshot.upbitAuditMarket = {
    SHELL: { symbol: 'SHELL', source: 'upbit_audit_market', supply: { value: 1000, field: 'circulating_supply',
      provider: 'coin_market_cap', baseDate: '2026-10-30', checkedAt: 1793422000 },
      price: { market: 'BTC-SHELL', quote: 'BTC', value: 0.000001, priceKrw: 100, conversionMarket: 'KRW-BTC',
        conversionPrice: 100000000, checkedAt: 1793422000, tradeAt: 1793421999000, conversionTradeAt: 1793421998000 } },
  };
  if (process.env.UPBIT_AUDIT_MARKET_TEST_FILE) Object.assign(snapshot.upbitAuditMarket,
    JSON.parse(fs.readFileSync(process.env.UPBIT_AUDIT_MARKET_TEST_FILE, 'utf8')));
  if (process.env.UPBIT_ASSET_NAMES_TEST_FILE) Object.assign(snapshot.upbitAssetNames,
    JSON.parse(fs.readFileSync(process.env.UPBIT_ASSET_NAMES_TEST_FILE, 'utf8')));
  const make = (month, rows) => ({ reportId: `upbit_asset_report_${month}`, rows,
    publishedLabel: month === '202610' ? '2026년 10월 발행' : '2026년 7월 발행',
    referenceAt: month === '202610' ? '2026-10-01T00:00:00+09:00' : '2026-07-01T00:00:00+09:00',
    referenceLabel: month === '202610' ? '2026년 9월 30일 24시' : '2026년 6월 30일 24시',
    sourceUrl: `https://static.upbit.com/reports/upbit_asset_report_${month}.pdf` });
  const old = snapshot.upbitAudit.rows.map(row => [...row]);
  old.find(row => row[1] === 'BTC').splice(2, 3, '173,911', '174,046', '100.08%');
  old.find(row => row[1] === 'ETH').splice(2, 3, '2,338,007', '2,342,336', '100.19%');
  old.push([old.length + 1, 'REMOVED', '100', '100', '100%'], [old.length + 2, 'ZERO', '0', '0', '100%']);
  old.push([old.length + 1, 'SHELL', '10', '10', '100%'], [old.length + 2, 'FORMER', '10', '10', '100%']);
  const current = old.filter(row => row[1] !== 'REMOVED').map(row => [...row]);
  current.find(row => row[1] === 'BTC').splice(2, 3, '175,473', '175,580', '100.06%');
  current.find(row => row[1] === 'ETH').splice(2, 3, '2,266,575', '2,269,441', '100.13%');
  current.find(row => row[1] === 'ZERO').splice(2, 3, '2', '2', '100%');
  current.push([current.length + 1, 'NEWASSET', '5', '5', '100%']);
  const reports = process.env.AUDIT_REPORTS_TEST_FILE ? JSON.parse(fs.readFileSync(process.env.AUDIT_REPORTS_TEST_FILE, 'utf8'))
    : [make('202610', current), make('202607', old)];
  snapshot.upbitAuditReports = reports; snapshot.upbitAudit = reports[0];
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('window.SERVER_AUTH_API_BASE =', `window.BOARD_DATA=${JSON.stringify(snapshot)};\nwindow.SERVER_AUTH_API_BASE =`);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || (!file.endsWith('data.js') && !fs.existsSync(file))) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript');
    res.end(file.endsWith('index.html') ? html : file.endsWith('data.js') ? `window.BOARD_DATA=${JSON.stringify(snapshot)};` : fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => {
      const url = new URL(route.request().url());
      const data = url.pathname === '/api/session' ? { authenticated: true, role: 'admin' }
        : url.pathname === '/api/market-data' ? snapshot : url.pathname === '/api/news' ? { items: [] }
          : url.pathname === '/api/board/posts' ? { posts: [] } : url.pathname === '/api/board/categories' ? { categories: [] } : {};
      return route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => !document.body.classList.contains('locked'));
    await page.waitForFunction(() => data.upbitAuditReports?.length === 2);
    await page.locator('#resourcesMenuBtn').click();
    await page.locator('[data-resource-view="audit"]').first().click();
    await page.waitForSelector('#auditReportSelect');
    assert.equal(await page.locator('#auditReportSelect').inputValue(), reports[0].reportId);
    assert.equal(await page.locator('#auditComparisonSelect').inputValue(), reports[1].reportId);
    assert.equal(await page.locator('#auditReportSelect option:checked').textContent(), '2026년 3분기');
    assert.equal(await page.locator('#auditComparisonSelect option:checked').textContent(), '2026년 2분기');
    const mapped = await page.evaluate(() => {
      const rows = [
        { symbol: 'SHELL', name: 'MyShell', englishName: 'MyShell' },
        { symbol: 'SHELL', name: 'Unrelated Shell', englishName: 'Unrelated Shell' },
        { symbol: 'AI', name: 'Sleepless AI', englishName: 'Sleepless AI' },
        { symbol: 'FOO', name: 'Other Project', englishName: 'Other Project' },
      ];
      normalizeKoreanAssetNames({ boards: { binance: rows }, upbitAssetNames: { ...data.upbitAssetNames,
        FOO: { symbol: 'FOO', koreanName: '공식푸', englishName: 'FOO', source: 'upbit_market_all' } } });
      return rows.map(row => row.name);
    });
    assert.deepEqual(mapped, ['마이쉘', 'Unrelated Shell', 'Sleepless AI', 'Other Project']);
    for (const query of ['마이쉘', '마이 쉘', 'myshell', 'shell']) {
      await page.locator('#auditSearchForm input').fill(query);
      assert.equal(await page.locator('.audit-table tbody tr').count(), 1);
      assert.match(await page.locator('.audit-table tbody tr').innerText(), /마이쉘/);
    }
    await page.locator('[data-audit-filter="report"]').click();
    await page.locator('#auditSearchForm input').fill('마이쉘');
    assert.equal(await page.locator('.audit-table tbody tr').count(), 1);
    const financial = page.locator('.audit-table tbody tr .audit-market');
    assert.match(await financial.nth(0).innerText(), /1,000|1천/);
    if (!process.env.AUDIT_REPORTS_TEST_FILE) assert.match(await financial.nth(1).innerText(), /1(?:\.00)?%/);
    assert.match(await financial.nth(2).innerText(), /100원.*BTC 원화 환산/s);
    assert.match(await financial.nth(2).getAttribute('title'), /BTC-SHELL.*KRW-BTC/s);
    assert.match(await financial.nth(0).getAttribute('title'), /2026-10-30/);
    await page.evaluate(() => { data.upbitAuditMarket.SHELL.priceError = true; renderAuditPanel(); });
    assert.match(await page.locator('.audit-table tbody tr').innerText(), /이전 시세/);
    await page.evaluate(() => { delete data.upbitAuditMarket.SHELL; renderAuditPanel(); });
    assert.equal(await page.locator('.audit-table tbody tr .audit-market strong').first().innerText(), '-', 'name metadata never invents supply or price');
    if (!process.env.AUDIT_REPORTS_TEST_FILE) {
      await page.locator('#auditSearchForm input').fill('이전코인');
      assert.equal(await page.locator('.audit-table tbody tr').count(), 1);
      await page.locator('[data-audit-filter="listed"]').click();
      assert.equal(await page.locator('.audit-table tbody tr').count(), 0, 'historical names do not claim current listing');
    }
    await page.locator('[data-audit-filter="listed"]').click();
    await page.locator('#auditSearchForm input').fill('BTC');
    assert.match(await page.locator('[data-audit-change="BTC"]').innerText(), /\+1,534개.*\+0\.88%/s);
    assert.match(await page.locator('.audit-ledger-change').innerText(), /\+1,562개/);
    assert.equal(await page.locator('.audit-source-link').getAttribute('href'), reports[0].sourceUrl);
    if (process.env.AUDIT_REPORTS_TEST_FILE) assert.match(await page.locator('.audit-summary').innerText(), /819개/);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      for (const selector of ['#auditReportSelect', '#auditComparisonSelect']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      }
      if (width < 820) {
        assert.ok((await page.locator('[data-audit-change="BTC"] strong').boundingBox()).width > 150);
        assert.ok((await page.locator('.audit-coin').last().boundingBox()).width > 150);
      }
      if (process.env.AUDIT_SCREENSHOT_PREFIX) {
        if (process.env.UPBIT_AUDIT_MARKET_TEST_FILE) await page.locator('#auditSearchForm input').fill('오스모시스');
        await page.screenshot({ path: `${process.env.AUDIT_SCREENSHOT_PREFIX}-${width}.png`, fullPage: true });
        await page.locator('#auditSearchForm input').fill('BTC');
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#auditSearchForm input').fill('ETH');
    assert.match(await page.locator('[data-audit-change="ETH"]').innerText(), /-72,895개.*-3\.11%/s);
    await page.locator('#auditSearchForm input').fill('');
    await page.locator('[data-audit-filter="increase"]').click();
    assert.equal(await page.locator('.audit-change .audit-change-value.decrease').count(), 0);
    await page.locator('[data-audit-filter="decrease"]').click();
    await page.locator('#auditSearchForm input').fill('ETH');
    assert.ok(await page.locator('[data-audit-change="ETH"]').count());
    await page.locator('[data-audit-sort="change"]').click();
    await page.locator('[data-audit-sort="change"]').click();
    assert.equal(await page.locator('[data-audit-sort="change"]').getAttribute('class'), 'audit-column-sort');
    if (!process.env.AUDIT_REPORTS_TEST_FILE) {
      await page.locator('#auditSearchForm input').fill('');
      await page.locator('[data-audit-filter="unmatched"]').click();
      assert.match(await page.locator('[data-audit-change="NEWASSET"]').innerText(), /신규 수록/);
      assert.match(await page.locator('[data-audit-change="REMOVED"]').innerText(), /이번 보고서 미수록/);
      await page.locator('[data-audit-filter="report"]').click();
      await page.locator('#auditSearchForm input').fill('ZERO');
      assert.match(await page.locator('[data-audit-change="ZERO"]').innerText(), /\+2개.*비율 계산 불가/s);
      assert.doesNotMatch(await page.locator('.audit-shell').innerText(), /Infinity|NaN/);
    }
    await page.locator('#auditSearchForm input').fill('BTC');
    await page.locator('#auditReportSelect').selectOption(reports[1].reportId);
    assert.equal(await page.locator('#auditComparisonSelect').isDisabled(), true);
    assert.equal(await page.locator('[data-audit-change]').count(), 0);
    assert.match(await page.locator('.audit-table tbody tr').innerText(), /174,046/);
    assert.equal(await page.locator('.audit-source-link').getAttribute('href'), reports[1].sourceUrl);
    await page.reload(); await page.waitForSelector('#auditReportSelect');
    assert.equal(await page.locator('#auditReportSelect').inputValue(), reports[1].reportId);
    await page.locator('#auditReportSelect').selectOption(reports[0].reportId);
    await page.locator('#auditComparisonSelect').selectOption('none');
    assert.equal(await page.locator('[data-audit-change]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: official non-KRW Korean names, Korean/English/ticker/space searches, collision safety, historical listing flags, quarter selection, A/B changes, history/reload and desktop/mobile layout');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

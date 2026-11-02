const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { withScriptPolicy } = require('./security-policy.cjs');

async function main() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.equal(html, withScriptPolicy(html));
  const snapshot = require('./test_market_fixture.cjs')();
  const real = process.env.REAL_MARKET_CHARTS === '1';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const directory = process.env.MARKET_CHART_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'blockscope-charts-'));
  if (real) fs.mkdirSync(directory, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      if (location.hostname !== 'fnfnfn3232.github.io') return;
      window.__chartPolicyViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__chartPolicyViolations.push(event.blockedURI));
      window.WebSocket = class { static OPEN = 1; constructor() { this.readyState = 0; } close() {} send() {} };
    });
    let remoteParentScripts = 0;
    const page = await context.newPage();
    page.on('request', request => {
      if (request.resourceType() === 'script' && request.frame() === page.mainFrame()
        && !request.url().startsWith('https://fnfnfn3232.github.io/')) remoteParentScripts++;
    });
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'fnfnfn3232.github.io') {
        if (url.pathname === '/coin/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
        if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: `window.BOARD_DATA=${JSON.stringify(snapshot)};`, contentType: 'text/javascript' });
        const file = path.resolve(__dirname, '.' + url.pathname.replace(/^\/coin/, ''));
        return route.fulfill({ body: file.startsWith(__dirname + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '',
          contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      }
      if (url.hostname === 'coin-board-auth.dlatl20000.workers.dev') {
        let result = {};
        if (url.pathname === '/api/session') result = { authenticated: true, role: 'member', subject: 'chart-test',
          expiresAt: Date.now() + 86400000, token: 'synthetic-test-token', boardReadApproved: true };
        else if (url.pathname === '/api/market-data') result = snapshot;
        else if (url.pathname === '/api/news') result = { items: [] };
        else if (url.pathname === '/api/board/posts') result = { posts: [] };
        else if (url.pathname === '/api/board/categories') result = { categories: [] };
        return route.fulfill({ json: result });
      }
      if (real && route.request().frame() !== page.mainFrame()) return route.continue();
      if (url.hostname === 'www.tradingview-widget.com') return route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><title>Hosted chart fixture</title><canvas width="800" height="400"></canvas>' });
      return route.fulfill({ body: '{}' });
    });
    await page.goto('https://fnfnfn3232.github.io/coin/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    await page.locator('#marketToggleBtn').click();
    await page.locator('#marketChartSection').scrollIntoViewIfNeeded();
    const cases = [['bitcoin', 'BINANCE:BTCUSDT'], ['nasdaq', 'OANDA:NAS100USD'], ['gold', 'OANDA:XAUUSD'], ['kospi', 'INDEX:KSIC']];
    for (const [key, symbol] of cases) {
      await page.locator(`[data-market-chart="${key}"]`).click();
      await page.waitForFunction(key => loadedMarketChart === key && document.querySelector('#marketChartHost iframe'), key);
      const frame = page.locator('#marketChartHost iframe');
      const url = new URL(await frame.getAttribute('src'));
      assert.equal(url.origin, 'https://www.tradingview-widget.com');
      assert.equal(url.pathname, '/embed-widget/advanced-chart/');
      const settings = JSON.parse(decodeURIComponent(url.hash.slice(1)));
      assert.equal(settings.symbol, symbol);
      assert.equal(settings.timezone, 'Asia/Seoul');
      assert.equal(settings.locale, 'kr');
      if (key === 'kospi') assert.equal(settings.interval, 'D');
      assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-popups allow-downloads');
      assert.equal(await page.locator('#marketChartHost iframe').count(), 1);
      if (real) {
        await page.waitForFunction(() => marketChartTimeout === 0, { timeout: 30000 });
        let canvasFrame;
        for (let attempt = 0; attempt < 45 && !canvasFrame; attempt++) {
          for (const candidate of page.frames().filter(frame => frame !== page.mainFrame())) {
            if (await candidate.locator('canvas').count()) { canvasFrame = candidate; break; }
          }
          if (!canvasFrame) await page.waitForTimeout(1000);
        }
        if (!canvasFrame) {
          const detail = await Promise.all(page.frames().map(async frame => ({ url: frame.url().slice(0, 160),
            text: (await frame.locator('body').innerText().catch(() => '')).slice(0, 500) })));
          throw new Error(`Chart canvas missing for ${key}: ${JSON.stringify(detail)}`);
        }
        await page.waitForTimeout(1500);
        const nonblank = await canvasFrame.locator('canvas').evaluateAll(canvases => canvases.some(canvas => {
          if (canvas.width < 100 || canvas.height < 100) return false;
          try {
            const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
            if (!pixels) return false;
            const colors = new Set();
            for (let i = 0; i < pixels.length; i += 64) if (pixels[i + 3]) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
            return colors.size > 12;
          } catch (_) { return false; }
        }));
        assert.equal(nonblank, true, `${key} chart must draw nonblank pixels`);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator('#marketChartSection').evaluate(section => section.scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(500);
          const box = await frame.boundingBox();
          assert.ok(box.width >= 250 && box.width <= width && box.height >= 300);
          await page.locator('#marketChartSection').screenshot({ path: path.join(directory, `${key}-${width}.png`) });
        }
      }
    }
    if (!real) {
      await page.evaluate(() => {
        window.__oldChart = document.querySelector('#marketChartHost iframe');
        window.__oldChart.dispatchEvent(new Event('error'));
      });
      assert.equal(await page.locator('#marketChartHost iframe').count(), 0);
      await page.getByRole('button', { name: '\ub2e4\uc2dc \uc2dc\ub3c4', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#marketChartHost iframe'));
      await page.locator('[data-market-chart="bitcoin"]').click();
      await page.waitForFunction(() => loadedMarketChart === 'bitcoin');
      await page.evaluate(() => window.__oldChart.dispatchEvent(new Event('error')));
      assert.equal(await page.locator('#marketChartHost iframe').count(), 1, 'retired frame errors cannot remove the current chart');
      await page.evaluate(() => document.querySelector('#marketChartHost iframe').dispatchEvent(new Event('error')));
      await page.locator('[data-market-chart="bitcoin"]').click();
      await page.waitForFunction(() => loadedMarketChart === 'bitcoin' && document.querySelector('#marketChartHost iframe'));
      await page.locator('#newsToggleBtn').click();
      assert.equal(await page.locator('#marketChartHost iframe').count(), 0);
      assert.equal(await page.evaluate(() => marketChartTimeout), 0);
      await page.evaluate(() => { siteAuthConfirmed = false; scheduleMarketChart(); });
      assert.equal(await page.locator('#marketChartHost iframe').count(), 0);
    }
    assert.equal(remoteParentScripts, 0, 'TradingView code never runs in the authenticated parent');
    assert.deepEqual(await page.evaluate(() => window.__chartPolicyViolations), []);
    console.log(`PASS: ${real ? 'live chart canvases and desktop/mobile screenshots' : 'four chart mappings, strict CSP, retry, retired events and navigation/auth cleanup'}`);
    if (real) console.log(`Screenshots: ${directory}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

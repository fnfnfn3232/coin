const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { withScriptPolicy } = require('./security-policy.cjs');

async function main() {
  const root = __dirname;
  const original = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(original, withScriptPolicy(original), 'production CSP hashes must be current');
  assert.equal(withScriptPolicy(original.replace(/\r?\n/g, '\r\n')).match(/content="script-src[^\"]+/)[0],
    original.match(/content="script-src[^\"]+/)[0], 'browser newline normalization must match the hashes');
  const html = original.replace('<body>', '<body><script>window.__untrustedInline = true;</script>');
  assert.throws(() => withScriptPolicy(html), /Unexpected inline scripts/);
  const snapshot = require('./test_market_fixture.cjs')();
  const tokenKey = 'fdv_server_auth_token_v1', sessionKey = 'fdv_server_auth_session_token_v1';
  let authenticated = true, loginCalls = 0, emailRequests = 0, blockedNetwork = 0;
  const expiry = Date.now() + 24 * 3600000;
  const oldToken = `v3.${Math.floor(expiry / 1000)}.legacy.admin.owner.0.test-signature`;
  const newToken = oldToken.replace('legacy', 'new-session');
  let token = oldToken;
  const session = () => ({ ok: true, token, expiresAt: expiry, role: 'admin', subject: 'owner', extensionsRemaining: 3, extensionCount: 0 });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ tokenKey, oldToken }) => {
      if (!sessionStorage.getItem('security-test-seeded')) {
        localStorage.setItem(tokenKey, oldToken);
        sessionStorage.setItem('security-test-seeded', '1');
      }
      window.__policyViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__policyViolations.push(event.effectiveDirective));
      window.WebSocket = class { static OPEN = 1; constructor() { this.readyState = 0; } close() { this.readyState = 3; } send() {} };
    }, { tokenKey, oldToken });
    await context.route('https://**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'fnfnfn3232.github.io') {
        if (url.pathname === '/coin/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
        if (url.pathname.endsWith('/data.js')) return route.fulfill({ body: `window.BOARD_DATA=${JSON.stringify(snapshot)};`, contentType: 'text/javascript' });
        const file = path.resolve(root, '.' + url.pathname.replace(/^\/coin/, ''));
        return route.fulfill({ body: file.startsWith(root + path.sep) && fs.existsSync(file) ? fs.readFileSync(file) : '',
          contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      }
      if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') {
        if (url.hostname === 'untrusted.example') blockedNetwork++;
        return route.fulfill({ body: 'window.__remoteScript = true;', contentType: 'text/javascript' });
      }
      let result = {}, status = 200;
      if (url.pathname === '/api/session') { result = authenticated ? session() : { error: 'auth_required' }; status = authenticated ? 200 : 401; }
      else if (url.pathname === '/api/login') {
        loginCalls++;
        assert.equal(route.request().postDataJSON().password, 'test-admin-password');
        authenticated = true; token = newToken; result = session();
      } else if (url.pathname === '/api/logout') { authenticated = false; result = { ok: true }; }
      else if (url.pathname === '/api/login/email/request') { emailRequests++; result = { error: 'unexpected_mfa_request' }; status = 500; }
      else if (url.pathname === '/api/login/email/status') result = { enabled: true };
      else if (url.pathname === '/api/market-data') result = snapshot;
      else if (url.pathname === '/api/news') result = { items: [] };
      else if (url.pathname === '/api/board/posts') result = { posts: [] };
      else if (url.pathname === '/api/board/categories') result = { categories: [] };
      return route.fulfill({ status, json: result, headers: { 'Access-Control-Allow-Origin': 'https://fnfnfn3232.github.io', 'Access-Control-Allow-Credentials': 'true' } });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://fnfnfn3232.github.io/coin/');
    await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    const migration = await page.evaluate(({ tokenKey, sessionKey }) => ({ local: localStorage.getItem(tokenKey), session: sessionStorage.getItem(sessionKey) }), { tokenKey, sessionKey });
    assert.equal(migration.local, null); assert.equal(migration.session, oldToken);
    assert.equal(await page.evaluate(() => window.__untrustedInline), undefined, 'injected inline script is blocked');
    await page.evaluate(() => {
      const image = document.createElement('img'); image.src = 'data:image/png;base64,invalid';
      image.setAttribute('onerror', 'window.__inlineHandler = true'); document.body.append(image);
      const script = document.createElement('script'); script.src = 'https://untrusted.example/steal.js'; document.head.append(script);
      const base = document.createElement('base'); base.href = 'https://untrusted.example/'; document.head.append(base);
    });
    await page.waitForFunction(() => window.__policyViolations.includes('script-src-attr') && window.__policyViolations.includes('script-src-elem') && window.__policyViolations.includes('base-uri'));
    assert.equal(await page.evaluate(() => window.__inlineHandler || window.__remoteScript), undefined);
    assert.equal(await page.evaluate(() => document.baseURI), 'https://fnfnfn3232.github.io/coin/');
    assert.equal(blockedNetwork, 0, 'untrusted script is blocked before any request leaves the browser');
    await page.reload(); await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    assert.equal(loginCalls, 0, 'same-tab reload preserves the existing session');
    await page.locator('#lockLogoutBtn').click();
    await page.waitForFunction(() => isSiteLocked());
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sessionKey), null);
    await page.locator('#lockAdminToggleBtn').click();
    await page.locator('#lockPasswordInput').fill('test-admin-password');
    await page.locator('#lockSubmitBtn').click();
    await page.waitForFunction(() => siteAuthConfirmed && !isSiteLocked());
    assert.equal(loginCalls, 1); assert.equal(emailRequests, 0, 'no additional email authentication is introduced');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), tokenKey), null);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sessionKey), newToken);
    assert.equal(await page.evaluate(() => getLockAuthUntil()), expiry);
    const memberToken = newToken.replace('.admin.owner.0.', '.member.test-member.1.');
    await page.evaluate(({ token, expiresAt }) => syncServerSession({ token, expiresAt, role: 'member', subject: 'test-member', boardReadApproved: true }),
      { token: memberToken, expiresAt: expiry });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), tokenKey), memberToken, 'ordinary member compatibility is unchanged');
    await page.evaluate(({ token, expiresAt }) => syncServerSession({ token, expiresAt, role: 'admin' }), { token: newToken, expiresAt: expiry });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), tokenKey), null, 'switching to administrator removes persistent storage');
    assert.equal(await page.locator('.intel-ticker, #tabTriple, [data-board="triple"], option[value="triple"]').count(), 0);
    await page.evaluate(() => { state.board = 'triple'; render(); });
    assert.equal(await page.evaluate(() => MARKET_BOARDS.includes(state.board)), true, 'retired intersection selections return to a valid exchange');
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const header = await page.locator('.intel-header').boundingBox();
      const brand = await page.locator('#brandHomeButton').boundingBox();
      const session = await page.locator('#lockTtlWrap').boundingBox();
      assert.equal(header.y, 0, 'no gap or retired banner remains above the header');
      if (width <= 620) {
        assert.ok(session.y >= 0 && session.y + session.height <= brand.y, 'mobile session controls cannot overlap the brand/navigation');
        assert.ok(session.x >= 0 && session.x + session.width <= width + 1);
      }
      if (process.env.HEADER_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.HEADER_SCREENSHOT_DIR, { recursive: true });
        await page.locator('.intel-header').screenshot({ path: path.join(process.env.HEADER_SCREENSHOT_DIR, `header-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: strict CSP blocks injected scripts/handlers/remote code/base replacement; token migration, same-tab reload, logout, password-only login, fixed expiry and mobile layout remain functional');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

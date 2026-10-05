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
  const news = { query: '', items: [{ id: 'news-test', title: 'Bitcoin news', summary: 'Summary', publishAt: Date.now() }], total: 1, storedCount: 1, nextOffset: 1, hasMore: false };
  snapshot.news = news;
  const feeRow = (slug, name, total24h) => ({ slug, name, total24h, total7d: total24h * 7, total30d: total24h * 30, change1d: 1, url: `https://defillama.com/chain/${slug}`, logo: '' });
  const fees = {
    l1fees: { rows: [feeRow('near', 'Near', 100), feeRow('bitcoin', 'Bitcoin', 200), feeRow('solana', 'Solana', 300), feeRow('bsc', 'BSC', 400)] },
    l2fees: { rows: [feeRow('base', 'Base', 100), feeRow('arbitrum', 'Arbitrum', 200)] },
  };
  const calls = [];
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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('https://**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'coin-board-auth.dlatl20000.workers.dev') return route.fulfill({ body: '' });
      calls.push(url.pathname + url.search);
      let data = {};
      if (url.pathname === '/api/market-data') data = snapshot;
      else if (url.pathname === '/api/l1-fees') data = fees.l1fees;
      else if (url.pathname === '/api/l2-fees') data = fees.l2fees;
      else if (url.pathname === '/api/news') data = { ...news, query: url.searchParams.get('q') || '' };
      else if (url.pathname === '/api/session') data = { authenticated: true, role: 'admin' };
      else if (url.pathname === '/api/screen-settings') data = { settings: {} };
      else if (url.pathname === '/api/board/posts') data = { posts: [] };
      else if (url.pathname === '/api/board/categories') data = { categories: [] };
      else if (url.pathname === '/api/live-prices') data = { boards: {}, futures: {} };
      return route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => !document.body.classList.contains('locked'));
    await page.locator('#marketToggleBtn').click();
    await page.waitForSelector('#tableBody .coin-mark');
    await page.locator('#searchInput').fill('BTC');
    assert.ok(await page.locator('#tableBody tr').count() > 0);
    await page.locator('#searchInput').fill('');
    assert.ok(await page.locator('#tableBody tr').count() > 1);
    await page.locator('#resourcesMenuBtn').click();

    await page.locator('[data-resource-view="l1fees"]').click();
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

    const cases = [
      ['futures', '#futuresSearchForm input', '.futures-table tbody tr', 'BTC'],
      ['ranking', '#rankingSearchForm input', '.ranking-table tbody tr', 'zz-no-protocol'],
      ['audit', '#auditSearchForm input', '.audit-table tbody tr', '비트코인'],
      ['l1fees', '#l2FeesSearchForm input', '.l2-fees-table tbody tr', '니어'],
      ['l2fees', '#l2FeesSearchForm input', '.l2-fees-table tbody tr', '베이스'],
    ];
    for (const [mode, selector, rows, query] of cases) {
      await page.locator(`[data-resource-view="${mode}"]`).click();
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

    await page.locator('[data-resource-view="l1fees"]').click();
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
  const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(__dirname, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  function section(start, end) {
    const from = html.indexOf(start), to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return html.slice(from, to);
  }
  const source = section('      function sendServerUpload(', '      function getProtectedBoardMediaPath(')
    + section('      function formatUploadProgress(', '      function mergeClientNewsItems(');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('https://example.com/**', route => route.fulfill({ body: '<!doctype html><html><body></body></html>', contentType: 'text/html' }));
  async function setup({ fake = true, chunkSize = 100, parallel = 2, origin = 'https://example.com/', apiBase = 'https://worker.example' } = {}) {
    await page.goto(origin);
    await page.addScriptTag({ content: `
      const SERVER_AUTH_API_BASE = ${JSON.stringify(apiBase)};
      const FREE_BOARD_MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024;
      const FREE_BOARD_UPLOAD_PARALLEL_CHUNKS = 8;
      let siteAuthConfirmed = true;
      let expired = 0, synced = 0;
      function getServerAuthToken() { return 'test-token'; }
      function syncServerSession() { synced++; }
      function handleServerAuthExpired() { expired++; }
      function canWriteFreeBoard() { return true; }
      function isLocalPreview() { return false; }
      function hasFreeBoardServer() { return true; }
      function isSafeAttachmentUrl(url) { return url.startsWith(SERVER_AUTH_API_BASE + '/api/board/media/'); }
      function formatBytes(bytes) { return String(bytes); }
      window.requests = []; window.progress = []; window.pendingXHR = []; window.completeResolve = null;
      window.completeStatus = 200;
      window.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/uploads')) {
          await new Promise(resolve => { window.initResolve = resolve; });
          return new Response(JSON.stringify({ uploadId: 'test-upload', chunkSize: ${chunkSize}, parallelChunks: ${parallel} }));
        }
        if (url.endsWith('/complete')) {
          await new Promise(resolve => { window.completeResolve = resolve; });
          return new Response(JSON.stringify({ url: SERVER_AUTH_API_BASE + '/api/board/media/test-media' }), { status: completeStatus });
        }
        throw new Error('Unexpected fetch: ' + url);
      };
      ${fake ? `window.XMLHttpRequest = class {
        constructor() { this.upload = {}; this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.headers[name] = value; }
        send(body) { this.body = body; pendingXHR.push(this); }
        abort() { this.onabort(); }
        progress(loaded) { this.upload.onprogress({ loaded }); }
        finish(status = 200, payload = {}) { this.status = status; this.responseText = JSON.stringify(payload); this.onload(); }
      };` : ''}
      ${source}
      function startUpload(size) {
        window.result = null; window.uploadError = null;
        window.uploadDone = uploadFreeBoardAttachment(new File([new Uint8Array(size)], 'test.bin'), value => progress.push(value))
          .then(value => { window.result = value; }, error => { window.uploadError = { message: error.message, status: error.status }; });
      }
    ` });
  }
  async function start(size) {
    await page.evaluate(size => startUpload(size), size);
    assert.equal(await page.evaluate(() => progress[0].phase), 'preparing');
    assert.match(await page.evaluate(() => formatUploadProgress({ name: 'test.bin' }, progress[0])), /업로드 준비/);
    await page.evaluate(() => initResolve());
    await page.waitForFunction(() => pendingXHR.length > 0);
  }
  async function finalize() {
    await page.waitForFunction(() => completeResolve !== null);
    assert.equal(await page.evaluate(() => progress.at(-1).phase), 'finalizing');
    assert.equal(await page.evaluate(() => result), null);
    assert.match(await page.evaluate(() => formatUploadProgress({ name: 'test.bin' }, progress.at(-1))), /저장 확인/);
    await page.evaluate(async () => { completeResolve(); await uploadDone; });
    assert.equal(await page.evaluate(() => progress.at(-1).phase), 'complete');
    assert.equal(await page.evaluate(() => result.url), 'https://worker.example/api/board/media/test-media');
  }
  try {
    await setup();
    await start(100);
    await page.evaluate(() => pendingXHR[0].progress(25));
    assert.equal(await page.evaluate(() => progress.at(-1).uploadedBytes), 25);
    assert.equal(await page.evaluate(() => progress.at(-1).chunkIndex), 0);
    await page.evaluate(() => pendingXHR[0].progress(100));
    assert.match(await page.evaluate(() => formatUploadProgress({}, progress.at(-1))), /서버 응답 대기/);
    assert.equal(await page.evaluate(() => completeResolve), null);
    assert.deepEqual(await page.evaluate(() => ({ headers: pendingXHR[0].headers, credentials: pendingXHR[0].withCredentials,
      timeout: pendingXHR[0].timeout, size: pendingXHR[0].body.size })), {
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer test-token' }, credentials: true, timeout: 60000, size: 100,
    });
    await page.evaluate(() => pendingXHR[0].finish());
    await finalize();
    console.log('PASS: byte progress before chunk acknowledgment, preparation and finalization states, auth and timeout');

    await setup();
    await start(250);
    assert.equal(await page.evaluate(() => pendingXHR.length), 2);
    await page.evaluate(() => { pendingXHR[0].progress(60); pendingXHR[1].progress(40); });
    assert.equal(await page.evaluate(() => progress.at(-1).uploadedBytes), 100);
    await page.evaluate(() => pendingXHR[0].finish());
    await page.waitForFunction(() => pendingXHR.length === 3);
    await page.evaluate(() => { pendingXHR[2].progress(500); pendingXHR[1].progress(80); });
    assert.equal(await page.evaluate(() => progress.at(-1).uploadedBytes), 230);
    await page.evaluate(() => { pendingXHR[1].finish(); pendingXHR[2].finish(); });
    await finalize();
    assert.ok(await page.evaluate(() => progress.every(value => value.uploadedBytes <= value.totalBytes)));
    console.log('PASS: parallel chunks aggregate in-flight and confirmed bytes without double-counting');

    await setup();
    await start(100);
    await page.evaluate(() => { pendingXHR[0].progress(80); pendingXHR[0].finish(503, { error: 'temporary_failure' }); });
    await page.waitForFunction(() => progress.at(-1).phase === 'retrying');
    assert.equal(await page.evaluate(() => progress.at(-1).uploadedBytes), 0);
    await page.waitForFunction(() => pendingXHR.length === 2);
    await page.evaluate(() => pendingXHR[1].progress(20));
    assert.equal(await page.evaluate(() => progress.at(-1).uploadedBytes), 20);
    await page.evaluate(() => pendingXHR[1].finish());
    await finalize();
    console.log('PASS: retries reset only the failed attempt bytes');

    await setup();
    await start(250);
    await page.evaluate(() => pendingXHR[0].finish(401, { error: 'auth_required' }));
    await page.waitForFunction(() => expired === 1);
    const before = await page.evaluate(() => progress.length);
    await page.evaluate(async () => { pendingXHR[1].progress(90); pendingXHR[1].finish(); await uploadDone; });
    assert.equal(await page.evaluate(() => pendingXHR.length), 2);
    assert.equal(await page.evaluate(() => progress.length), before);
    assert.equal(await page.evaluate(() => uploadError.status), 401);
    assert.equal(await page.evaluate(() => requests.some(value => value.url.endsWith('/complete'))), false);
    console.log('PASS: auth expiry blocks finalization, new chunks and stale progress after a failed worker');

    await setup();
    await page.evaluate(async () => { startUpload(0); await uploadDone; });
    assert.equal(await page.evaluate(() => uploadError.message), 'media_too_large');
    assert.equal(await page.evaluate(() => requests.length), 0);
    await page.evaluate(async () => {
      try { await uploadFreeBoardAttachment({ size: FREE_BOARD_MAX_UPLOAD_FILE_BYTES + 1 }); }
      catch (error) { window.limitError = error.message; }
    });
    assert.equal(await page.evaluate(() => limitError), 'media_too_large');
    console.log('PASS: empty-file and 200MB bounds are unchanged');

    await setup();
    await start(100);
    await page.evaluate(() => pendingXHR[0].ontimeout());
    await page.waitForFunction(() => pendingXHR.length === 2);
    await page.evaluate(() => pendingXHR[1].onerror());
    await page.waitForFunction(() => pendingXHR.length === 3);
    await page.evaluate(async () => { pendingXHR[2].onerror(); await uploadDone; });
    assert.equal(await page.evaluate(() => uploadError.message), 'upload_network_error');
    assert.equal(await page.evaluate(() => completeResolve), null);
    console.log('PASS: timeout and network errors retry at most twice and never finalize a failed upload');

    await setup();
    await start(100);
    await page.evaluate(() => { completeStatus = 503; pendingXHR[0].finish(); });
    await page.waitForFunction(() => completeResolve !== null);
    await page.evaluate(async () => { completeResolve(); await uploadDone; });
    assert.equal(await page.evaluate(() => uploadError.status), 503);
    assert.equal(await page.evaluate(() => progress.some(value => value.phase === 'complete')), false);
    console.log('PASS: finalization failure is not reported as a completed attachment');

    await setup();
    await page.evaluate(async () => {
      window.XMLHttpRequest = undefined;
      window.fetch = async (_url, options) => {
        window.fallbackOptions = options;
        return new Response('{"ok":true}');
      };
      await fetchServerAuth('/test', { method: 'POST', body: new Blob(['test']), onUploadProgress: () => {} });
    });
    assert.deepEqual(await page.evaluate(() => ({ credentials: fallbackOptions.credentials,
      authorization: fallbackOptions.headers.Authorization, hasCallback: 'onUploadProgress' in fallbackOptions })),
    { credentials: 'include', authorization: 'Bearer test-token', hasCallback: false });
    console.log('PASS: fetch fallback preserves authentication and strips transport-only options');

    // Browser routing buffers upload bodies, so use a real loopback socket for native progress.
    const wire = [];
    const server = http.createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin || 'null');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (request.method !== 'POST') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        return response.end('<!doctype html><html><body></body></html>');
      }
      let size = 0;
      for await (const chunk of request) size += chunk.length;
      wire.push({ method: request.method, headers: request.headers, size });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    const frontend = http.createServer((_request, response) => response.end('<!doctype html><html><body></body></html>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve));
    try {
      const apiBase = `http://127.0.0.1:${server.address().port}`;
      await setup({ fake: false, origin: `http://127.0.0.1:${frontend.address().port}`, apiBase });
      await page.evaluate(async () => {
        window.realBytes = [];
        await fetchServerAuth('/api/board/media/uploads/test/chunks/0', { method: 'POST', body: new Blob([new Uint8Array(65536)]),
          headers: { 'Content-Type': 'application/octet-stream' }, onUploadProgress: bytes => realBytes.push(bytes) });
      });
      const post = wire.find(value => value.method === 'POST');
      assert.equal(post.size, 65536);
      assert.equal(post.headers.authorization, 'Bearer test-token');
      assert.ok(await page.evaluate(() => realBytes.includes(65536)));
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => frontend.close(resolve));
    }
    assert.deepEqual(errors, []);
    console.log('PASS: native cross-origin browser XHR sends the binary body and auth header and emits upload progress');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

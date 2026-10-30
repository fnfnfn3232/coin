const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppUpdateGuard } = require('./app-update.js');

function fixture() {
  const now = Date.now(), loaded = now - 3600000, released = now - 1800000;
  const result = { requests: [], replacements: [], allowed: true, modified: released, fail: false };
  const listeners = {};
  const values = new Map();
  const win = {
    location: { href: 'https://site.github.io/coin/?view=futures#coinbase', replace: url => result.replacements.push(url) },
    navigator: { onLine: true }, AbortSignal,
    sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    addEventListener: (key, fn) => { listeners[key] = fn; }, removeEventListener() {},
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 2, clearTimeout() {},
    fetch: async (url, options) => { result.requests.push({ url, options }); if (result.fail) throw Error('offline');
      return { ok: true, headers: { get: () => new Date(result.modified).toUTCString() } }; },
  };
  const doc = { lastModified: new Date(loaded).toUTCString(), hidden: false,
    addEventListener: (key, fn) => { listeners[key] = fn; }, removeEventListener() {} };
  const guard = createAppUpdateGuard({ window: win, document: doc, canReload: () => result.allowed });
  return { ...result, result, win, doc, guard, now, values };
}

test('new application release needs two HEAD observations, preserves current route, and reloads once', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = f.now;
  Date.now = () => now;
  try {
    await f.guard.check();
    assert.equal(f.result.replacements.length, 0);
    await f.guard.check();
    assert.equal(f.result.requests.length, 1, 'no duplicate request before confirmation delay');
    now += 61000;
    f.win.location.href = 'https://site.github.io/coin/?view=l2fees#selected';
    await f.guard.check();
    assert.equal(f.result.requests.every(item => item.options.method === 'HEAD'), true);
    assert.match(f.result.replacements[0], /view=l2fees.*appVersion=.*#selected/);
    await f.guard.check();
    assert.equal(f.result.replacements.length, 1);
  } finally { Date.now = originalNow; f.guard.stop(); }
});

test('editing, hidden/offline state, invalid clocks and network failure never discard work', async () => {
  const originalNow = Date.now;
  const f = fixture();
  let now = f.now;
  Date.now = () => now;
  try {
    f.result.allowed = false;
    await f.guard.check(); now += 61000; await f.guard.check();
    assert.equal(f.result.replacements.length, 0);
    f.doc.hidden = true; f.result.allowed = true; await f.guard.check();
    assert.equal(f.result.replacements.length, 0);
    f.doc.hidden = false; await f.guard.check();
    assert.equal(f.result.replacements.length, 1);
    const bad = fixture(); bad.result.modified = now + 3600000;
    await bad.guard.check(); now += 61000; await bad.guard.check();
    assert.equal(bad.result.replacements.length, 0);
    bad.result.fail = true; now += 600001; await bad.guard.check();
    bad.win.navigator.onLine = false; now += 600001; await bad.guard.check();
    assert.equal(bad.result.replacements.length, 0);
    bad.guard.stop();
  } finally { Date.now = originalNow; f.guard.stop(); }
});

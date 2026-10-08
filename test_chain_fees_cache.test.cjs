const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(process.env.SEARCH_TEST_HTML || path.join(__dirname, 'index.html'), 'utf8');
const source = html.match(/      function primeChainFees\([\s\S]*?(?=      function renderChainFeesPanel)/)[0];
const key = 'blockscope_chain_fees_v1';
const payload = fetchedAt => ({ fetchedAt, rows: [{ name: 'Ethereum', slug: 'ethereum', total24h: 100 }] });

function fixture(cached, options = {}) {
  const stored = new Map(cached ? [[key, JSON.stringify(cached)]] : []);
  const requests = [];
  const env = { locked: false, authenticated: options.authenticated !== false, renders: 0 };
  const states = Object.fromEntries(['l1fees', 'l2fees'].map(mode => [mode, {
    data: null, promise: null, checkedAt: 0, error: '', query: '',
  }]));
  const storage = {
    getItem: name => { if (options.blocked) throw new Error('storage_blocked'); return stored.get(name); },
    setItem: (name, value) => { if (options.blocked) throw new Error('storage_blocked'); stored.set(name, value); },
    removeItem: name => { stored.delete(name); },
  };
  const api = new Function('chainFeesStates', 'sessionStorage', 'env', 'requests', `
    const CHAIN_FEES_CACHE_KEY = '${key}';
    let chainFeesCacheSubject = '', chainFeesGeneration = 0;
    let siteSessionRole = 'admin', siteSessionSubject = 'owner';
    const siteAuthConfirmed = env.authenticated;
    const state = { viewMode: 'l1fees' }, document = { hidden: false };
    const isSiteLocked = () => env.locked;
    const renderContentPanel = () => env.renders++;
    const fetchServerAuth = url => new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
    ${source}
    return { primeChainFees, clearChainFeesCache, requestChainFees };
  `)(states, storage, env, requests);
  return { ...api, states, stored, requests, env };
}

test('fresh authenticated cache displays synchronously and performs no duplicate requests', () => {
  const data = payload(Date.now() - 1000);
  const f = fixture({ subject: 'admin:owner', l1fees: data, l2fees: data });
  f.primeChainFees();
  assert.equal(f.states.l1fees.data.rows[0].name, 'Ethereum');
  assert.equal(f.states.l2fees.data.rows.length, 1);
  assert.equal(f.requests.length, 0);
  f.primeChainFees();
  assert.equal(f.requests.length, 0);
});

test('stale cache stays visible during refresh and survives upstream failure', async () => {
  const data = payload(Date.now() - 11 * 60000);
  const f = fixture({ subject: 'admin:owner', l1fees: data, l2fees: data });
  f.primeChainFees();
  assert.equal(f.requests.length, 2);
  assert.equal(f.states.l1fees.data.stale, true);
  assert.equal(f.states.l1fees.data.fetchedAt, data.fetchedAt);
  const pending = Object.values(f.states).map(state => state.promise);
  f.requests[0].reject(new Error('upstream_unavailable'));
  f.requests[1].resolve(payload(Date.now()));
  await Promise.all(pending);
  assert.equal(f.states.l1fees.data.rows.length, 1);
  assert.ok(f.states.l1fees.error);
  assert.equal(f.states.l2fees.error, '');
  assert.equal(f.states.l2fees.data.stale, undefined);
  f.primeChainFees();
  assert.equal(f.requests.length, 2, 'retry cooldown prevents request storms');
});

test('cold login prefetches both layers once, even when storage is blocked', async () => {
  const f = fixture(null, { blocked: true });
  f.primeChainFees();
  f.primeChainFees();
  assert.equal(f.requests.length, 2);
  const pending = Object.values(f.states).map(state => state.promise);
  for (const request of f.requests) request.resolve(payload(Date.now()));
  await Promise.all(pending);
  assert.equal(f.states.l1fees.data.rows.length, 1);
});

test('locked sessions do not load cache or call the fee APIs', () => {
  const data = payload(Date.now());
  const f = fixture({ subject: 'admin:owner', l1fees: data });
  f.env.locked = true;
  f.primeChainFees();
  assert.equal(f.requests.length, 0);
  assert.equal(f.states.l1fees.data, null);
});

test('cached login state does not trigger retrieval before server session verification', () => {
  const data = payload(Date.now());
  const f = fixture({ subject: 'admin:owner', l1fees: data }, { authenticated: false });
  f.primeChainFees();
  f.requestChainFees('l1fees');
  assert.equal(f.requests.length, 0);
  assert.equal(f.states.l1fees.data, null);
});

test('logout clears cache and late responses cannot restore a previous login', async () => {
  const f = fixture(null);
  f.primeChainFees();
  const pending = Object.values(f.states).map(state => state.promise);
  f.clearChainFeesCache();
  for (const request of f.requests) request.resolve(payload(Date.now()));
  await Promise.all(pending);
  assert.equal(f.states.l1fees.data, null);
  assert.equal(f.states.l2fees.data, null);
  assert.equal(f.stored.has(key), false);
});

test('foreign, over-age and invalid cache entries are ignored', async () => {
  for (const cached of [
    { subject: 'member:another', l1fees: payload(Date.now()) },
    { subject: 'admin:owner', l1fees: payload(Date.now() - 25 * 3600000) },
    { subject: 'admin:owner', l1fees: { fetchedAt: 'invalid', rows: [{}] } },
    { subject: 'admin:owner', l1fees: { fetchedAt: Date.now(), rows: [] } },
  ]) {
    const f = fixture(cached);
    f.primeChainFees();
    assert.equal(f.states.l1fees.data, null);
    assert.equal(f.requests.length, 2);
    const pending = Object.values(f.states).map(state => state.promise);
    for (const request of f.requests) request.reject(new Error('offline'));
    await Promise.all(pending);
  }
});

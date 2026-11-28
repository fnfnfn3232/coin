const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { assessComparisonHealth } = require('./.github/scripts/comparison-health.cjs');
const NOW = 1793300000000;
const row = (symbol, englishName = `${symbol} Network`) => ({ symbol, englishName });
const local = (symbol, board = 'upbit', extra = {}) => ({ board, row: row(symbol), priceAvailable: true, observedAt: NOW, ...extra });
const source = (board, rows, extra = {}) => ({ board, rows, pricedSymbols: rows.map(row => row.symbol), observedAt: NOW, catalogAt: NOW, ...extra });
const audit = (local, references, extra = {}) => ({ monitorVersion: 1, local, references, fxUsable: true, ...extra });
const states = input => assessComparisonHealth(input, NOW).rows;

test('deployment OIDC credentials refresh during long verification and forced retries without changing the audience', async () => {
  const { createOidcTokenProvider } = await import('./.github/scripts/oidc-token.mjs');
  let clock = 0, calls = 0;
  const provider = createOidcTokenProvider({ audience: 'coin-board-auth-market-data',
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/token?existing=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-runner-token' },
    now: () => clock, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.searchParams.get('audience'), 'coin-board-auth-market-data');
      assert.equal(url.searchParams.get('existing'), '1');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-runner-token');
      return Response.json({ value: 'synthetic-oidc-' + calls });
    } });
  assert.deepEqual(await Promise.all([provider(), provider()]), ['synthetic-oidc-1', 'synthetic-oidc-1']);
  clock = 119999; assert.equal(await provider(), 'synthetic-oidc-1'); assert.equal(calls, 1);
  clock = 120000; assert.equal(await provider(), 'synthetic-oidc-2');
  assert.equal(await provider(true), 'synthetic-oidc-3');
});

test('deployment OIDC mint errors fail closed and do not poison later verification retries', async () => {
  const { createOidcTokenProvider } = await import('./.github/scripts/oidc-token.mjs');
  let calls = 0;
  const provider = createOidcTokenProvider({ audience: 'coin-board-auth-market-data',
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-runner-token' },
    fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : calls === 2 ? Response.json({ value: {} }) : Response.json({ value: 'synthetic-valid-token' }) });
  await assert.rejects(provider(), /oidc_mint_failed:503/);
  await assert.rejects(provider(), /oidc_token_missing/);
  assert.equal(await provider(), 'synthetic-valid-token');
});

test('audit covers every domestic listing using the shared verified identity policy', () => {
  const result = states(audit([local('A'), local('B'), local('C')], [source('coinbase', [row('A'), row('B', 'Different Project')])]));
  assert.deepEqual(result, [['upbit', 'A', 'ok', 'coinbase'], ['upbit', 'B', 'identity', ''], ['upbit', 'C', 'no_market', '']]);
});

test('fresh verified alternatives recover a failed preferred source; USDT peg is required', () => {
  const input = audit([local('A')], [source('binance', [row('A')], { observedAt: NOW - 130000 }), source('gateio', [row('A')]), source('coinbase', [row('USDT')])]);
  assert.deepEqual(states(input)[0], ['upbit', 'A', 'ok', 'gateio']);
  input.references[2].observedAt = NOW - 130000;
  assert.equal(states(input)[0][2], 'delayed');
});

test('domestic fallback is used only without a verified overseas identity and needs no FX', () => {
  const input = audit([local('A'), local('A', 'bithumb')], [], { fxUsable: false });
  assert.equal(states(input)[0][2], 'domestic');
  input.references.push(source('coinbase', [row('A')], { observedAt: NOW - 130000 }));
  assert.equal(states(input)[0][2], 'delayed');
});

test('whole-list monitor recognizes reviewed MetaDAO aliases without matching Metadium', () => {
  const input = audit([local('META2', 'upbit', { row: row('META2', 'MetaDAO') }), local('META', 'bithumb', { row: row('META', 'Metadium') })],
    [source('coinbase', [row('META', 'Metadao')])]);
  assert.deepEqual(states(input), [['upbit', 'META2', 'ok', 'coinbase'], ['bithumb', 'META', 'identity', '']]);
});

test('freshness, native quotes, FX, identity expiry and ambiguous candidates fail closed', () => {
  assert.equal(states(audit([local('A', 'upbit', { priceAvailable: false })], [source('coinbase', [row('A')])]))[0][2], 'delayed');
  assert.equal(states(audit([local('A')], [source('coinbase', [row('A')])], { fxUsable: false }))[0][2], 'fx');
  assert.equal(states(audit([local('A')], [source('gateio', [row('A')], { catalogAt: NOW - 86400001 })]))[0][2], 'identity');
  assert.equal(states(audit([local('A')], [source('coinbase', [row('A'), row('A')])]))[0][2], 'identity');
  assert.equal(states(audit([local('A')], [source('coinbase', [row('A')], { observedAt: NOW + 6000 })]))[0][2], 'delayed');
  assert.throws(() => states({}), /invalid_comparison_audit/);
});

test('future or invalid identity catalog clocks cannot be marked healthy', () => {
  for (const catalogAt of [NOW + 6000, Infinity, NaN, 0, 'invalid']) {
    const result = states(audit([local('A')], [source('gateio', [row('A')], { catalogAt }), source('coinbase', [row('USDT')])]));
    assert.equal(result[0][2], 'identity');
  }
});

test('manual and recovery rebuilds verify live health without doubling normal scheduled audits', () => {
  const workflow = readFileSync(require.resolve('./.github/workflows/comparison-monitor.yml'), 'utf8');
  assert.match(workflow, /workflows: \['Deploy Cloudflare Worker', 'Auto Refresh Data'\]/);
  assert.match(workflow, /github\.event\.workflow_run\.event != 'schedule'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(workflow, /push:\s+branches: \[main\]/);
});

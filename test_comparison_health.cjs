const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessComparisonHealth } = require('./.github/scripts/comparison-health.cjs');
const NOW = 1793300000000;
const row = (symbol, englishName = `${symbol} Network`) => ({ symbol, englishName });
const local = (symbol, board = 'upbit', extra = {}) => ({ board, row: row(symbol), priceAvailable: true, observedAt: NOW, ...extra });
const source = (board, rows, extra = {}) => ({ board, rows, pricedSymbols: rows.map(row => row.symbol), observedAt: NOW, catalogAt: NOW, ...extra });
const audit = (local, references, extra = {}) => ({ monitorVersion: 1, local, references, fxUsable: true, ...extra });
const states = input => assessComparisonHealth(input, NOW).rows;

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

test('freshness, native quotes, FX, identity expiry and ambiguous candidates fail closed', () => {
  assert.equal(states(audit([local('A', 'upbit', { priceAvailable: false })], [source('coinbase', [row('A')])]))[0][2], 'delayed');
  assert.equal(states(audit([local('A')], [source('coinbase', [row('A')])], { fxUsable: false }))[0][2], 'fx');
  assert.equal(states(audit([local('A')], [source('gateio', [row('A')], { catalogAt: NOW - 86400001 })]))[0][2], 'identity');
  assert.equal(states(audit([local('A')], [source('coinbase', [row('A'), row('A')])]))[0][2], 'identity');
  assert.equal(states(audit([local('A')], [source('coinbase', [row('A')], { observedAt: NOW + 6000 })]))[0][2], 'delayed');
  assert.throws(() => states({}), /invalid_comparison_audit/);
});

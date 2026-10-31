const test = require('node:test');
const assert = require('node:assert/strict');
const audit = require('./audit-report.js');
const row = (symbol, value, a = value) => [1, symbol, a, value, '100%'];

test('quarter labels follow the audit cutoff, not the later publication month', () => {
  assert.equal(audit.periodLabel({ referenceAt: '2026-10-01T00:00:00+09:00' }), '2026년 3분기');
  assert.equal(audit.periodLabel({ referenceAt: '2026-07-01T00:00:00+09:00' }), '2026년 2분기');
  assert.equal(audit.periodLabel({ referenceAt: '2027-01-01T00:00:00+09:00' }), '2026년 4분기');
  assert.equal(audit.periodLabel({ referenceAt: '2027-04-01T00:00:00+09:00' }), '2027년 1분기');
  assert.match(audit.periodLabel({ referenceAt: '2026-10-01T00:00:00+09:00' }, true), /9\.30 기준/);
});

test('audit quantities retain exact integers beyond JavaScript safe precision', () => {
  const result = audit.compare(row('BIG', '9,007,199,254,740,994'), row('BIG', '9,007,199,254,740,993'));
  assert.equal(result.delta, '1');
  assert.equal(audit.formatDelta(result), '+1개');
  assert.equal(result.percent, '증가 0.01% 미만');
  assert.equal(audit.quantity('1,00'), null);
  assert.equal(audit.quantity('-1'), null);
});

test('official BTC/ETH changes, zero baselines, missing records and no comparison remain distinct', () => {
  const btc = audit.compare(row('BTC', '175,580', '175,473'), row('BTC', '174,046', '173,911'));
  assert.equal(btc.delta, '1534'); assert.equal(btc.percent, '+0.88%');
  const eth = audit.compare(row('ETH', '2,269,441'), row('ETH', '2,342,336'));
  assert.equal(eth.delta, '-72895'); assert.equal(eth.percent, '-3.11%');
  assert.equal(audit.compare(row('X', '1'), row('X', '0')).percent, null);
  assert.equal(audit.compare(row('X', '0'), row('X', '0')).state, 'unchanged');
  assert.equal(audit.compare(row('X', '0'), row('X', '0')).percent, null);
  assert.equal(audit.compare(row('OLD', '1000'), row('NEW', '1')).state, 'invalid');
  assert.equal(audit.compare(row('X', '10'), null).state, 'new');
  assert.equal(audit.compare(null, row('X', '10')).state, 'not_reported');
  assert.equal(audit.compare(row('X', '-'), row('X', '10')).state, 'invalid');
  assert.equal(audit.compare(row('X', '10'), null, 3, false).state, 'no_comparison');
  assert.equal(audit.compare(row('BTC', '175,580', '175,473'), row('BTC', '174,046', '173,911'), 2).delta, '1562');
});

test('symbol indexing never aliases migrations or silently accepts ambiguous duplicate entries', () => {
  const rows = audit.index([row('OLD', '1'), row('NEW', '1000'), row('DUP', '1'), row('DUP', '2')]);
  assert.equal(rows.get('DUP'), null);
  assert.equal(rows.has('OLD'), true); assert.equal(rows.has('NEW'), true);
  assert.equal(audit.compareDelta({ delta: '9007199254740994' }, { delta: '9007199254740993' }), 1);
  assert.equal(audit.compareDelta({ delta: null }, { delta: '0' }), 1);
});

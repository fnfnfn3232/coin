const assert = require('node:assert/strict');
const test = require('node:test');
const identity = require('./comparison-identity.js');

const context = { baseBoard: 'bithumb', referenceBoard: 'gateio' };
const domestic = (symbol, englishName = symbol) => ({ symbol, englishName, koreanName: '\uad6d\ub0b4\ucf54\uc778', marketIdentityVerified: false });
const gate = (symbol, englishName = symbol) => ({ symbol, englishName, paprikaId: `gate-${symbol.toLowerCase()}`, comparisonIdentity: { officialName: true } });

test('official ticker-shaped project names work independently of cap/supply verification', () => {
  for (const symbol of ['SOON', 'FLUID', 'PIEVERSE', 'WAVES', 'KGEN']) {
    const row = domestic(symbol);
    assert.equal(identity.matches(row, gate(symbol), context), true, symbol);
    assert.equal(row.marketIdentityVerified, false);
    assert.equal(row.marketCapUsd, undefined);
    assert.equal(identity.matches({ symbol, englishName: symbol }, { symbol, englishName: symbol }, context), false);
  }
  assert.equal(identity.matches(domestic('CC', 'Canton'), gate('CC', 'Canton Network'), context), true);
  assert.equal(identity.matches(domestic('B3'), gate('B3', 'B3 Base'), context), true);
});

test('gaming BEAM maps to exchange-specific BEAMX, never privacy BEAM', () => {
  const row = domestic('BEAM', 'Beam');
  assert.equal(identity.symbol(gate('BEAMX', 'Beam'), 'gateio'), 'BEAM');
  assert.equal(identity.matches(row, gate('BEAMX', 'Beam'), context), true);
  assert.equal(identity.matches(row, gate('BEAM', 'Beam'), context), false);
  assert.equal(identity.matches(row, { symbol: 'BEAMX', englishName: 'Another Project' }, context), false);
});

test('same-chain contracts resolve name variants but reject conflicting addresses', () => {
  const address = '0x62d0a8458ed7719fdaf978fe5929c6d342b0bfce';
  const row = domestic('BEAM', 'Beam');
  const info = { sources: { bithumb: { englishName: 'Beam', explorer: `https://etherscan.io/token/${address}` } } };
  const candidate = gate('BEAMX', 'Beam');
  candidate.comparisonIdentity.contracts = [['ETH', address]];
  assert.equal(identity.matches(row, candidate, { ...context, info }), true);
  candidate.comparisonIdentity.contracts = [['ETH', '0x1111111111111111111111111111111111111111']];
  assert.equal(identity.matches(row, candidate, { ...context, info }), false);
});

test('explicit project conflicts, legacy FRAX, verified-ID conflicts and shared Korean aliases cannot hide English conflicts', () => {
  assert.equal(identity.matches(domestic('AI', 'Gensyn'), gate('AI', 'Sleepless AI'), context), false);
  assert.equal(identity.matches(domestic('FRAX', 'Frax'), { ...gate('FRAX', 'Frax'), paprikaId: 'frax-frax' }, context), false);
  assert.equal(identity.matches({ ...domestic('X', 'Project'), marketIdentityVerified: true, coingeckoId: 'project-a' },
    { ...gate('X', 'Project'), marketIdentityVerified: true, coingeckoId: 'project-b' }, context), false);
  assert.equal(identity.matches({ ...domestic('X', 'Project A'), nameKeys: ['\uacf5\ud1b5'] },
    { ...gate('X', 'Project B'), nameKeys: ['\uacf5\ud1b5'] }, context), false);
  assert.equal(identity.matches({ ...domestic('X', 'Project'), assetIdentityConflict: true }, gate('X', 'Project'), context), false);
});

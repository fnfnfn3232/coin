const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const identity = require('./comparison-identity.js');

const context = { baseBoard: 'bithumb', referenceBoard: 'gateio' };
const domestic = (symbol, englishName = symbol) => ({ symbol, englishName, koreanName: '\uad6d\ub0b4\ucf54\uc778', marketIdentityVerified: false });
const gate = (symbol, englishName = symbol) => ({ symbol, englishName, paprikaId: `gate-${symbol.toLowerCase()}`, comparisonIdentity: { officialName: true } });

test('browser identity asset URL changes whenever its implementation changes', () => {
  const source = fs.readFileSync(path.join(__dirname, 'comparison-identity.js'), 'utf8').replace(/\r\n/g, '\n');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  assert.ok(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').includes(`comparison-identity.js?v=${hash}`));
});

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
  assert.equal(identity.matches(row, { symbol: 'BEAMX', englishName: 'Beam' }, { ...context, referenceBoard: 'binance' }), true);
  assert.equal(identity.matches(row, { symbol: 'BEAMX', englishName: 'Another Project' }, context), false);
});

test('whole-list audit spelling differences resolve without admitting unrelated project names', () => {
  const pairs = [
    ['ADA', 'Ada', 'Cardano'], ['XLM', 'Lumen', 'Stellar Lumens'], ['SKY', 'Sky Protocol', 'Sky'],
    ['MORPHO', 'Morpho', 'Morpho Labs'], ['RENDER', 'Render Token', 'Render Network'], ['1INCH', '1inch Network', '1inch'],
    ['PROM', 'Prom', 'Prometeus'], ['ZRX', '0x Protocol', '0xProject'], ['CKB', 'Nervos Network', 'CKB'],
    ['MOCA', 'Moca Network', 'Moca Coin'], ['ONG', 'ONG', 'OntologyGas'], ['SNT', 'Status Network Token', 'Status'],
    ['AUCTION', 'Bounce', 'BounceAuction'], ['IQ', 'IQ.wiki', 'IQ'], ['CBK', 'Cobak Token', 'Cobak'],
    ['FOLD', 'The Interfold', 'Interfold'], ['MIRA', 'Mira Network', 'Mira'], ['ORDER', 'Orderly', 'Orderly Network'],
    ['USDT', 'Tether USDt', 'Tether'], ['TFUEL', 'TFUEL', 'Theta Fuel'], ['RON', 'Ronin', 'Ronin Network'],
    ['WAXP', 'WAXP', 'WAX'], ['US', 'Talus', 'Talus Network'], ['BILL', 'Billions', 'Billions Network'], ['SIX', 'SIX', 'SIX Network'],
  ];
  for (const [symbol, local, foreign] of pairs) {
    assert.equal(identity.matches(domestic(symbol, local), gate(symbol, foreign), context), true, symbol);
    assert.equal(identity.matches(domestic(symbol, local), gate(symbol, 'Unrelated Project'), context), false, symbol);
  }
  for (const symbol of ['CAP', 'GRVT']) assert.equal(identity.matches(domestic(symbol), gate(symbol), { ...context, referenceBoard: 'coinbase' }), true);
  assert.equal(identity.matches(domestic('META', 'Metadium'), gate('META', 'MetaDAO'), context), false);
  assert.equal(identity.matches(domestic('BASED', 'Based'), gate('BASED', 'Based One'), context), false);
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

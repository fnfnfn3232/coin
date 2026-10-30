// Synthetic regression data only. Never read or publish the protected production snapshot.
module.exports = function marketFixture() {
  const known = [['BTC', 'Bitcoin', '비트코인'], ['ETH', 'Ethereum', '이더리움'], ['SOL', 'Solana', '솔라나'],
    ['BLAST', 'Blast', '블라스트'], ['SOPH', 'Sophon', '소폰'], ['NEAR', 'Near', '니어'], ['AI', 'Gensyn', '젠신']];
  const assets = [...known, ...Array.from({ length: 74 }, (_, i) => [`MOCK${i}`, `Mock Asset ${i}`, `Mock Asset ${i}`])];
  const boards = {};
  for (const exchange of ['upbit', 'bithumb', 'binance', 'coinbase']) {
    const quote = ['upbit', 'bithumb'].includes(exchange) ? 'KRW' : exchange === 'binance' ? 'USDT' : 'USD';
    boards[exchange] = assets.map(([symbol, englishName, koreanName], i) => ({
      exchange, symbol, name: koreanName, koreanName, englishName, nameKeys: [symbol, englishName, koreanName],
      pair: `${symbol}/${quote}`, nativeCurrency: quote === 'KRW' ? 'KRW' : 'USD',
      priceUsd: symbol === 'AI' ? 0.02 : 100, priceKrw: symbol === 'AI' ? 27 : 135000, marketCapUsd: 1e12 - i * 1e9,
      marketCapKrw: (1e12 - i * 1e9) * 1350, sortCapUsd: 1e12 - i * 1e9,
      circulatingSupply: 10000, totalSupply: 20000, riskFlags: [], capSource: 'synthetic_test',
    }));
  }
  const futures = { binance: boards.binance.map(row => ({ ...row, pair: `${row.symbol}USDT`, contractId: `${row.symbol}USDT`,
    contractType: 'PERPETUAL', contractMarket: 'USDⓈ-M', quoteAsset: 'USDT', marginAsset: 'USDT' })), coinbase: [], bybit: [] };
  const categories = Object.fromEntries(['tvl', 'rwa', 'dexVolume', 'fees', 'perpOpenInterest'].map(key => [key,
    assets.map(([symbol, name], i) => ({ symbol, name, protocol: `Mock Protocol ${i}`, category: 'Test',
      rank: i + 1, valueUsd: 10000 - i, total24hUsd: 100, total7dUsd: 700, total30dUsd: 3000,
      exchanges: ['upbit'], chains: ['Ethereum'], slug: `mock-${i}`, url: `https://example.com/mock-${i}` }))]));
  return { generatedAt: Math.floor(Date.now() / 1000), fxUsdKrw: 1350, autoRefreshMinutes: 10, boards, futures,
    stats: Object.fromEntries(Object.entries(boards).map(([key, rows]) => [key, { total: rows.length, withCap: rows.length }])),
    futuresStats: {}, notes: {}, coinInfo: {}, news: { items: [] },
    defillamaRankings: { generatedAt: Math.floor(Date.now() / 1000), categories },
    upbitAudit: { reportId: 'synthetic', sourceUrl: 'https://example.com/test.pdf',
      rows: assets.map(([symbol], i) => [i + 1, symbol, '100', '101', '101%']) } };
};

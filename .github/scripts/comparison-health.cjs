const identity = require('../../comparison-identity.js');

function assessComparisonHealth(audit, now = Date.now()) {
  if (audit?.monitorVersion !== 1 || !audit.local?.length || !Array.isArray(audit.references)) throw new Error('invalid_comparison_audit');
  const fresh = at => Number.isFinite(at) && at <= now + 5000 && now - at <= 120000;
  const additional = new Set(['gateio', 'bybit', 'bitget', 'okx']);
  const sources = audit.references.map(source => ({ ...source, prices: new Set(source.pricedSymbols || []), index: new Map() }));
  for (const source of sources) for (const row of source.rows || []) {
    const symbol = identity.symbol(row, source.board);
    if (!source.index.has(symbol)) source.index.set(symbol, []);
    source.index.get(symbol).push(row);
  }
  const rows = audit.local.map(item => {
    const key = identity.symbol(item.row, item.board);
    const listed = sources.flatMap(source => (source.index.get(key) || []).map(row => ({ source, row })));
    const matches = listed.filter(({ source, row }) => (!additional.has(source.board) || now - source.catalogAt <= 86400000)
      && identity.matches(item.row, row, { baseBoard: item.board, referenceBoard: source.board, info: item.info }));
    // The browser rejects ambiguous matches within one exchange too.
    const unique = matches.filter(item => matches.filter(other => other.source.board === item.source.board).length === 1);
    const counterpart = audit.local.filter(other => other.board !== item.board
      && identity.matches(item.row, other.row, { baseBoard: item.board, referenceBoard: other.board, info: item.info, referenceInfo: other.info }));
    let state, board = '';
    if (unique.length) {
      const reference = unique.find(({ source, row }) => fresh(source.observedAt) && source.prices.has(row.symbol)) || unique[0];
      board = reference.source.board;
      const needsPeg = board !== 'coinbase';
      const peg = sources.find(source => source.board === 'coinbase');
      state = !item.priceAvailable || !fresh(item.observedAt) || !fresh(reference.source.observedAt) || !reference.source.prices.has(reference.row.symbol)
        || (needsPeg && (!peg?.prices.has('USDT') || !fresh(peg.observedAt))) ? 'delayed' : audit.fxUsable ? 'ok' : 'fx';
    } else if (counterpart.length === 1) {
      board = counterpart[0].board;
      state = item.priceAvailable && fresh(item.observedAt) && counterpart[0].priceAvailable && fresh(counterpart[0].observedAt) ? 'domestic' : 'delayed';
    } else state = listed.length ? 'identity' : 'no_market';
    return [item.board, item.row.symbol, state, board];
  });
  return { rows };
}

module.exports = { assessComparisonHealth };

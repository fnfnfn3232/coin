(function (root) {
  'use strict';
  const quantity = value => {
    const text = String(value ?? '').trim();
    return /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text) ? BigInt(text.replaceAll(',', '')) : null;
  };
  function index(rows) {
    const result = new Map();
    for (const row of rows || []) {
      const symbol = String(row?.[1] || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(symbol)) continue;
      result.set(symbol, result.has(symbol) ? null : row);
    }
    return result;
  }
  function compare(current, previous, field = 3, enabled = true) {
    if (!enabled) return { state: 'no_comparison', delta: null, percent: null };
    if (!current) return { state: 'not_reported', delta: null, percent: null };
    if (!previous) return { state: 'new', delta: null, percent: null };
    if (String(current[1]).toUpperCase() !== String(previous[1]).toUpperCase()) return { state: 'invalid', delta: null, percent: null };
    const before = quantity(previous[field]), after = quantity(current[field]);
    if (before === null || after === null) return { state: 'invalid', delta: null, percent: null };
    const delta = after - before;
    let percent = before > 0n && delta === 0n ? '0.00%' : null;
    if (before > 0n && delta !== 0n) {
      const absolute = delta < 0n ? -delta : delta;
      const hundredths = (absolute * 10000n + before / 2n) / before;
      percent = hundredths ? `${delta > 0n ? '+' : '-'}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`
        : `${delta > 0n ? '증가' : '감소'} 0.01% 미만`;
    }
    return { state: delta > 0n ? 'increase' : delta < 0n ? 'decrease' : 'unchanged',
      delta: String(delta), previous: String(before), current: String(after), percent };
  }
  function formatDelta(change) {
    if (change.delta === null) return { new: '신규 수록', not_reported: '이번 보고서 미수록', invalid: '비교 불가', no_comparison: '-' }[change.state] || '-';
    const number = BigInt(change.delta);
    return `${number > 0n ? '+' : ''}${number.toLocaleString('ko-KR')}개`;
  }
  function compareDelta(a, b) {
    if (a?.delta === null || a?.delta === undefined) return b?.delta === null || b?.delta === undefined ? 0 : 1;
    if (b?.delta === null || b?.delta === undefined) return -1;
    const x = BigInt(a.delta), y = BigInt(b.delta);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const api = { quantity, index, compare, formatDelta, compareDelta };
  root.UpbitAuditReport = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);

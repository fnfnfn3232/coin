const fresh = (at, now) => Number.isFinite(Number(at)) && Number(at) > 0 && Number(at) <= now + 5000 && now - Number(at) <= 120000;

export function futuresTick(exchange, message, now = Date.now()) {
  if (exchange === 'binance') {
    const row = message?.data;
    return row?.s?.endsWith('USDT') && fresh(row.E, now) && Number(row.b) > 0 && Number(row.a) >= Number(row.b) ? row.s : null;
  }
  if (exchange === 'bybit') {
    const row = message?.data;
    return message?.topic === `tickers.${row?.symbol}` && row.symbol.endsWith('USDT') && fresh(message.ts, now)
      && Number(row.lastPrice) > 0 ? row.symbol : null;
  }
  return null;
}

// The same public streams as the browser, not runner-blocked REST proxies.
export function probeFuturesStream(exchange, { WebSocketClass = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  const products = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const url = exchange === 'binance'
    ? `wss://fstream.binance.com/stream?streams=${products.map(symbol => `${symbol.toLowerCase()}@bookTicker`).join('/')}`
    : 'wss://stream.bybit.com/v5/public/linear';
  if (!['binance', 'bybit'].includes(exchange)) throw new Error('unsupported_futures_stream');
  return new Promise(resolve => {
    let socket, timer, finished = false;
    const seen = new Set();
    const finish = ok => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.close(); } catch (_) { /* Connecting sockets may reject close. */ }
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = new WebSocketClass(url);
      socket.addEventListener('open', () => {
        if (exchange === 'bybit') socket.send(JSON.stringify({ op: 'subscribe', args: products.map(symbol => `tickers.${symbol}`) }));
      });
      socket.addEventListener('message', event => {
        try {
          const symbol = futuresTick(exchange, JSON.parse(event.data));
          if (products.includes(symbol)) seen.add(symbol);
          if (seen.size === products.length) finish(true);
        } catch (_) { /* An acknowledgement is not a quote. */ }
      });
      socket.addEventListener('error', () => finish(false));
      socket.addEventListener('close', () => finish(false));
    } catch (_) { finish(false); }
  });
}

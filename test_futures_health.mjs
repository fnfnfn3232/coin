import test from 'node:test';
import assert from 'node:assert/strict';
import { futuresTick, probeFuturesStream } from './.github/scripts/futures-health.mjs';

test('futures probes require prices, correct settlement and current exchange clocks', () => {
  const now = Date.now();
  const tick = { data: { s: 'BTCUSDT', b: '100', a: '101', E: now } };
  assert.equal(futuresTick('binance', tick, now), 'BTCUSDT');
  for (const row of [{ ...tick.data, E: now - 120001 }, { ...tick.data, E: now + 5001 }, { ...tick.data, s: 'BTCUSDC' }, { ...tick.data, a: 0 }]) {
    assert.equal(futuresTick('binance', { data: row }, now), null);
  }
  assert.equal(futuresTick('bybit', { topic: 'tickers.BTCUSDT', ts: now, data: { symbol: 'BTCUSDT', lastPrice: 100 } }, now), 'BTCUSDT');
  assert.equal(futuresTick('bybit', { op: 'subscribe', success: true }, now), null);
  assert.equal(futuresTick('bybit', { topic: 'tickers.BTCUSDT', ts: now, data: { symbol: 'BTCUSDT' } }, now), null);
});

test('stream closes after all representative contracts arrive and sends only public subscriptions', async () => {
  let closed = 0;
  class Socket {
    constructor(url) { assert.match(url, /^wss:\/\//); this.listeners = {}; queueMicrotask(() => this.listeners.open()); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    send(text) {
      const message = JSON.parse(text);
      assert.equal(message.op, 'subscribe');
      assert.equal(message.args.length, 3);
      for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) this.listeners.message({ data: JSON.stringify({ topic: `tickers.${symbol}`, ts: Date.now(), data: { symbol, lastPrice: 100 } }) });
    }
    close() { closed++; this.listeners.close?.(); }
  }
  assert.equal(await probeFuturesStream('bybit', { WebSocketClass: Socket, timeoutMs: 100 }), true);
  assert.equal(closed, 1);
  class Silent extends Socket { send() {} }
  assert.equal(await probeFuturesStream('bybit', { WebSocketClass: Silent, timeoutMs: 5 }), false);
  assert.equal(closed, 2);
});

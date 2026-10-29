# Price Difference (2026-10-29)

## Reference Site Findings

The public HTML and client bundles at https://kimpga.com/ were inspected. The
client contains exchange adapters for Binance, Upbit, Bithumb, Coinbase and other
exchanges. It uses both direct exchange WebSockets and its own Upbit relay at
api.kimpga.com / ws.kimpga.com. Its market-indicator metadata labels USDKRW as
TWELVEDATA. This establishes the client configuration, not the private server's
contracts, reliability, licensing or complete upstream implementation.

Public bundles inspected:
- https://kimpga.com/_next/static/chunks/pages/_app-e8df4215176532d7.js
- https://kimpga.com/_next/static/chunks/pages/index-f76289a822d3071f.js

No private credentials, relay feeds or proprietary code were copied. This site
computes differences locally from its own authenticated snapshot and public
exchange connections.

## Calculation and Sources

- Column: `시세차이`, directly after Price; percentage and signed price delta.
- The reference selector offers Binance USDT and Coinbase USD. A base exchange
  cannot compare with itself. On domestic tabs the base is the KRW exchange price.
- Domestic reference KRW = foreign quote * USD/KRW * USDT/USD, with USDT/USD
  applied only to a USDT quote. Percentage = (base / reference - 1) * 100.
- Foreign base prices are compared in USD; a Binance base quote is also converted
  using USDT/USD. No USDT=USD assumption or domestic-USDT-derived FX is used.
- Existing valuation/cap conversion fields are deliberately unchanged. This
  feature uses a separate fiat FX source and does not rewrite market caps.
- Fiat FX: Frankfurter v2 USD/KRW, daily reference rate, no API key. The source,
  rate and date are visible. It is NOT a live intraday forex feed and can differ
  from the reference site's Twelve Data rate. See https://frankfurter.dev/.
- Authenticated `/api/price-difference-fx` caches the rate for one hour in the
  existing Durable Object, coalesces requests and backs off five minutes on
  failure. Failed/over-seven-day-old FX cannot produce a domestic percentage.
- Quote normalization: Coinbase Advanced Trade USDT-USD ticker.
- Binance spot uses miniTicker last trades, not the midpoint of bid/ask. Existing
  futures bookTicker behavior is unchanged. Upbit/Bithumb/Coinbase retain their
  existing ticker parsers. Both base and reference changes update the delta.

## Safety, Load and Behavior

- Exact comparable symbols AND compatible explicit asset names or matching
  CoinGecko IDs are required. Unknown/conflicting identity and ambiguous matches
  display `-`, not a guessed percentage. Missing listings/currencies also use `-`.
- Prices must have a known receipt timestamp within two minutes. A five-second
  local expiry check hides stalled quotes without another API request. Tooltips
  include the reference, FX provenance, price receipt time and fee exclusion.
- Only visible rows are subscribed on auxiliary streams, with at most two
  auxiliary exchange sockets. Same-signature renders reuse them; view changes,
  offline state, background tabs and logout release them. Reconnect uses backoff.
- No per-coin HTTP polling, new periodic server job or paid subscription was added.
- Sorting is explicit and missing values stay last. Incoming ticks do not move
  rows under the pointer. The existing listing-comparison filters remain distinct.
- Delta excludes fees, slippage, transfer restrictions and execution guarantees.
  Robinhood marks remain indicative, timestamp-gated prices, not WebSocket quotes.

## Verification

- `test_price_difference.cjs`: controlled exchange messages, FX/USDT conversion,
  positive/negative changes, identity collisions, absent listings, sorting,
  stale quotes, failed FX, reference changes, desktop/mobile and stream lifecycle.
- Worker tests: authentication, shared cache, daily provenance and failure backoff.
- `test_resource_search.cjs`: existing market, rating, comparison, search and
  narrow/wide table layout regressions, including the additional column.
- Read-only live checks received Binance BTCUSDT, Coinbase BTC-USD / USDT-USD,
  Upbit KRW-BTC and Bithumb BTC_KRW messages. This does not guarantee continuous availability from every user's
  network or access to a tradable cross-exchange profit.

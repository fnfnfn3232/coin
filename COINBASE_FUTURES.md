# Coinbase Futures Migration (2026-10-31)

The retired INTX instruments endpoint now returns 404. The old collector retained
its previous snapshot and preferred mark price; Coinbase futures were also
explicitly excluded from the live WebSocket target. These were real stale-data
paths, not merely normal differences between spot and futures.

The official Coinbase migration completed October 1, 2026:
- https://help.coinbase.com/en/international-exchange/deribit/coinbase-faqs
- https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/derivatives/technical
- https://docs.cdp.coinbase.com/api-reference/coinbase-deribit-app-api/adv-starbase-openapi.json
- https://docs.cdp.coinbase.com/api-reference/coinbase-deribit-app-api/adv-starbase-asyncapi.json

## Data Path

- Official `drb.coinbase.com/api/v2/public/get_instruments` discovers active,
  open, linear, USDC-settled perpetuals with `underlying_type=crypto`. Options,
  dated contracts, inverse contracts, equities, commodities and crypto indexes
  are excluded. Current instrument names are BASE_USDC-PERPETUAL, not BASE-PERP.
- `get_book_summary_by_currency?currency=USDC&kind=future` supplies bulk `last`
  and separate `mark_price`. The displayed price is LAST, never a mark/index/spot
  fallback. Values are explicitly USDC; the existing KRW conversion is labeled
  approximate rather than treating a USDC quote as a bank-executable dollar rate.
- Browser REST is blocked by CORS in a read-only live check. The authenticated
  Worker shares a one-hour compact catalog and 20-second bulk cache, coalesces
  concurrent readers, and backs off on failure without renewing source clocks.
- One public WebSocket at `wss://streams.drb.coinbase.com/ws/api/v2` subscribes
  visible contracts to `ticker.INSTRUMENT.100ms`. Full ticker messages update
  last price while mark stays separate. No paid feed or exchange API key.
- The existing five-second local watchdog also covers Coinbase futures.
  Stalled streams reconnect with backoff; a once-per-minute bulk cross-check
  repairs quiet streams. Hidden tabs, navigation and logout close connections.
  Generation checks discard late responses after logout. Stale (>2 minute),
  future and out-of-order source timestamps cannot appear as fresh prices.
- Retired INTX contracts are not restored from cached snapshots. New collection
  failure remains recorded in existing refresh health; one missing Coinbase
  list must not abort all other site data collection. No cap/supply values are
  inferred from futures prices. Existing conservative underlying linkage stays.
  Underlying names are resolved by matching the instrument's asset UUID to the
  official Coinbase `/v2/currencies/crypto` catalog. Missing UUID evidence keeps
  caps unknown; conflicting spot names cannot relabel a futures asset.
- The 15-minute Comparison Monitor now probes this futures source too. Failures
  enter the existing private per-source persistence/deduplication policy and
  fresh-admin-password history. The recurring AI task remains paused.

## Verification

`test_coinbase_futures.py`, Worker permission/cache tests,
`test_price_difference.cjs` Coinbase-futures browser cases, and resource UI
regressions cover the migration, last-vs-mark, unsupported assets, clocks,
failure/retry, navigation and stream lifecycle. Live read-only probes verify
the official new gateway and actual public ticker delivery. None of these
point-in-time checks is a guarantee of zero network latency or every client.

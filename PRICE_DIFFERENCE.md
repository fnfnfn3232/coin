# Price Difference (2026-10-29)

## Automatic Detection And Maintenance (2026-10-30)

- The visible domestic market inspects streams locally every five seconds. A
  connection stuck opening for 20 seconds, no messages for 45 seconds, or only
  heartbeats/no valid ticker for 90 seconds closes and reconnects with backoff.
  Both native and auxiliary sockets are covered. Late decoded messages from a
  retired connection cannot refresh a price.
- Stale individual prices trigger shared bulk refresh after 30 seconds. Even
  apparently healthy ticker streams receive an independent bulk refresh at
  most once per minute/source. Fresh bootstrap/session observations suppress
  redundant first-load requests. Failures back off from 15 seconds to five minutes;
  existing metadata ages are preserved rather than restarted on failed fetches.
- The market toolbar displays the current visible comparison counts and oldest
  price receipt age. These are receipt timestamps, not a guarantee of trade-time
  latency, profitable execution, or independently licensed real-time forex.
- GitHub `Comparison Monitor` runs after successful Worker deployments and on
  a 15-minute schedule. It requests exchange-wide quote/catalog refreshes and
  audits every Upbit/Bithumb listing with the SAME identity module as the UI.
  Stale preferred feeds can use a fresh verified overseas alternative; domestic
  fallback is permitted only without a verified overseas candidate. USDT/USD,
  fiat FX, metadata expiry and ambiguous matches are included in assessment.
- The scheduled request uses existing repository/main-bound GitHub OIDC. It
  stores bounded counts, per-coin outcomes and up to 100 state changes in a
  separate Durable Object record. Only the existing refresh-history POST with
  a fresh administrator password returns that record. CI prints counts only;
  ordinary snapshots, member/admin sessions and forged sync headers cannot read
  or write it. A missing monitor run is visibly overdue after 30 minutes.
- No per-coin HTTP polling, purchased feed, guessed price, ticker-only identity
  promotion, automatic permission bypass, or authentication policy change.
  GitHub schedules can be delayed. Metadata with inadequate official evidence
  remains unavailable rather than being force-matched. Blocking/protocol changes
  still need a verified code fix. A separately configured Codex follow-up checks
  persistent problems, tests scoped repairs and verifies deployment; local
  follow-ups require the computer/app and project permissions to be available.

Verification: `test_comparison_health.cjs`, the Worker permission/security suite,
`test_price_difference.cjs` (silent sockets, heartbeat-only feeds, bounded bulk
refresh, backoff and retired events), and `test_resource_search.cjs`.

## Domestic-To-Domestic Alternative

When no verified overseas candidate exists for a domestic row, use the other
Korean exchange only if exactly one identical KRW asset is verified there:
Upbit -> Bithumb, Bithumb -> Upbit (the intersection view uses Bithumb as base).
An existing overseas candidate is never replaced merely because its connection,
FX or latest quote is temporarily unavailable.

Calculation is `(base KRW / reference KRW - 1) * 100`, with the signed KRW
difference underneath. No fiat FX or USDT peg enters this calculation. The source
is explicitly labeled `domestic` in the Korean UI, so it is not presented as an
overseas premium. The shared quote bootstrap and one counterpart WebSocket per
view provide updates in either direction. Existing stale-price, identity-conflict,
single-listing and logout guards still apply. No per-coin HTTP polling is added.

Tests cover both signs/directions, reference/base-only ticks, absent FX/peg,
source labels, both native subscription formats, stale quotes, wrong assets,
overseas priority, reload and connection cleanup. The trusted whole-list audit
also reports the eligible domestic-only alternatives separately.

## Domestic Premium Scope and Whole-List Audit

Production audit: 788 domestic exchange rows checked, 738 identity-matched. The
reported seven assets matched on both domestic exchanges. The remaining three
same-ticker candidates were Metadium versus MetaDAO (two rows) and Based versus
Based One; none were forcibly joined. Another 47 rows had no verified comparator
in the available source coverage. These counts prove identity coverage, not that
every upstream price is continuously fresh or that those 47 assets are unlisted
on every exchange. The browser matcher asset uses a content hash to avoid stale
cached implementations after deployment.

- Premium controls, column, sorting and auxiliary quote/FX requests apply only
  to Upbit/Bithumb (including the four-exchange intersection's Bithumb base).
  Binance/Coinbase/Robinhood keep their normal price streams but no premium UI.
- `comparison-identity.js` is the same matcher used by the browser and trusted
  deployment audit. The audit checks every domestic listing, not just examples,
  and reports matched, unverified and unavailable assets separately.
- `marketIdentityVerified` controls external cap/supply provenance. Its false
  value no longer disqualifies independently verified exchange trade identity.
  This does not create, copy or change any market cap or supply quantity.
- Official Gate project names can be identical to their ticker (SOON, FLUID,
  PIEVERSE, WAVES, etc.). Matching requires an explicit domestic project name
  plus its independently sourced Korean name and official foreign metadata;
  two unqualified raw tickers alone remain insufficient.
- Canton/Canton Network and B3/B3 Base spellings are reviewed project aliases.
  The whole-list audit also reviewed Ada/Cardano, Lumen/Stellar, Render,
  Nervos/CKB, Ontology Gas, Theta Fuel, and other exact symbol-scoped project
  spellings. This is not global suffix stripping or ticker-only guessing.
- Coinbase's official `/currencies` names provide independent evidence for
  CAP/GRVT and other ticker-shaped names, cached separately from cap data.
  Metadium/MetaDAO and Based/Based One are not merged without identity proof.
  Gaming BEAM maps to Binance/Gate BEAMX. The unrelated privacy BEAM is excluded.
  Evidence: https://www.binance.com/en/support/announcement/detail/c8705b752c7c47fc814a373a0f1856ee
- Official explorer contracts can resolve naming differences. Addresses are
  chain-scoped, EVM-normalized, and conflicts reject a match. Gate contract
  metadata is retained only for relevant naming differences/BEAMX, keeping each
  shared catalog bounded. Legacy FRAX and AI/Gensyn collisions remain rejected.

## Current Intraday FX and Startup

The user selected free operation with automatically refreshed intraday reference
rates, not a paid tick-data subscription. The earlier daily FX sections below
describe the previous implementation and are superseded by this section.

- Source: https://currency-converter.live/api. Its published terms permit personal
  and commercial display with caching and attribution. The visible source link
  credits it. It is a reference feed, not an executable bank quote; its provenance
  endpoint explicitly does not verify the original upstream vendor/quote clock.
- Read USD/KRW from `/api/v1/convert?from=USD&to=KRW&amount=1`. Preserve the
  original `quote.ts`/`quote.as_of`, verify the currency direction, source, range,
  timestamp consistency and quote status. Do not substitute USDT/KRW or daily FX.
- Check once per minute while the market is visible/online, with a shared
  one-minute server cache and coalesced background refresh. Existing recent FX
  renders while a refresh is in progress. A temporary failure retries after
  30 seconds and never renews the original quote timestamp.
- Weekday quotes older than five minutes cannot generate a percentage. On UTC
  weekends a mark up to 72 hours old can be shown explicitly as a weekend
  reference with its original date/time, not as a new live observation.
- Authenticated market snapshots also carry already cached recent quotes, asset
  metadata and FX. No upstream HTTP is awaited to build this bootstrap payload.
  Trusted refresh/sync exports do not include this transient bootstrap.
- Known failed Binance proxy paths are bypassed only after normal site-session
  authentication and trusted snapshot hydration. The browser uses the official
  public market API without site tokens/cookies. The hint expires in five minutes.
- Bootstrap is applied before the first market render. Expired/foreign-owner
  caches are rejected; login/logout, drafts, private history and password hashing
  policies are unchanged. Connection prewarming removes avoidable DNS/TLS setup.
- Tests prove a cached initial view needs no quote/FX round trips, a new FX rate
  recalculates differences, invalid clocks/pairs/daily records are rejected, and
  failed background refresh does not block the cached response or forge freshness.

Network/provider latency cannot be guaranteed to be zero, and the free provider
has no uptime or independently verified original-market-vendor guarantee.

## Production Failure Investigation

The deployment's trusted GitHub OIDC probe reproduced failures in the actual
Worker, not just from the developer's network: Binance REST returned 451,
Bybit/Bitget returned 403, and all four CoinPaprika exchange-market catalogs
returned 402. Valid Gate/OKX quotes were discarded because no catalog loaded.

- Binance now uses its officially documented public-market-data REST host
  `data-api.binance.vision`; spot WebSockets use standard port 443, not 9443.
- Gate identities come from its official `/spot/currencies` API and are limited
  to currently quoted USDT spot products. Delisted/ambiguous entries are excluded.
- If an exchange-market catalog is unavailable, the free CoinPaprika coin list
  supplies only active, globally unambiguous symbols present in the exchange's
  actual spot quote response. Prices never come from this metadata source.
- The new OKX XDP identity is supported by its official spot listing announcement:
  https://www.okx.com/help/okx-to-list-xdp-usdt-doppler-finance-for-spot-trading
  This reviewed exception cannot create an unlisted price or apply to another exchange.
- Reviewed name variants cover KGeN, MiL.k/MiL.k Alliance, and the renamed FXS
  governance asset Frax/Frax Finance. Legacy Frax Dollar (`frax-frax`) is rejected.
  FXS migration evidence: https://feed.bithumb.com/notice/1651781
- Login's authenticated snapshot load prewarms bulk quotes and independent FX
  before opening the market view. Existing owner-bound session caching remains.
- Worker upstream restrictions can persist even on the public-data host. After
  an authenticated 503 (or an expired failed cached response), Binance/OKX can
  bootstrap from their official public APIs in the browser, without cookies or
  site Authorization headers. Site 401/403 responses never trigger this fallback.
  OKX retains the server's verified identity metadata; derivatives are excluded.
- Failures and source details are inspectable through the deployment-only probe;
  regular member/admin sessions cannot invoke this diagnostic route.
- A first uncached visit still requires network access. Upstream restrictions,
  ambiguous tokens and stale data must not be concealed with invented values.

Tests cover the five reported symbols, paid-catalog failure/free fallback,
official Gate filtering, legacy FRAX and AI ticker collisions, session caching,
WebSocket lifecycle, authentication and expiry. Production probe results are
checked again after deployment.

Production follow-up confirmed Gate's 2,031 spot identities, including ZBT,
FRAX, KGEN and MLK. A real browser on the site's origin also received Binance's
public bulk quotes (HTTP 200), including ZBT/FRAX, despite the Worker being blocked.
The final Worker probe returned the official XDP identity and fresh OKX price;
immediate repeated Gate/OKX requests returned their shared caches without upstream
waits. The browser-origin OKX check also returned XDP successfully (HTTP 200).
These are point-in-time checks, not a guarantee of zero latency or all-network availability.

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
- The preferred-reference selector offers Binance USDT, Coinbase USD, Gate.io,
  Bybit, Bitget and OKX spot USDT. A base cannot compare with itself. Domestic
  tabs use their own KRW exchange price.
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
  display an unavailable state, not a guessed percentage.
- Prices must have a known receipt timestamp within two minutes. A five-second
  local expiry check hides stalled quotes without another API request. Tooltips
  include the reference, FX provenance, price receipt time and fee exclusion.
- Only visible rows are subscribed on auxiliary streams, with one auxiliary
  socket per needed reference exchange. Same-signature renders reuse them; view changes,
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

## Initial-Display Follow-Up (2026-10-29)

The first version waited for trade-stream events and did not hydrate comparison
prices/FX on reload. Quiet markets could therefore remain blank even though a
valid last trade existed. Filtering every name equal to its ticker also excluded
NEO when the explicit shared Korean name was available.

- Seed prices in parallel from authenticated bulk quote endpoints, independent
  by exchange. Upbit uses ticker/all KRW, Bithumb ALL_KRW, and Binance/Coinbase
  reuse the existing public quote parsers. This path does not wait for unrelated
  exchanges, caps, news or the next trade event.
- Server caches coalesce concurrent requests, reuse 25-second results and serve
  still-recent results while refreshing. Failure backoff preserves the original
  quote observation time; failure never makes an old price look new.
- A session-scoped, owner-bound cache restores valid recent prices and daily FX
  before rendering. WebSocket messages update it with throttled writes; pagehide
  flushes it. Logout clears it and generation checks reject late responses.
- Quiet/stalled visible markets can use throttled bulk refreshes after one minute
  without price observations. No per-coin HTTP requests or periodic server job.
- Preserve explicit Korean asset names for identity checks, fixing NEO without
  accepting bare identical tickers. Conflicting names still cannot be compared.
- Missing states are now distinguished: comparison unavailable, asset identity
  unverified, loading, delayed, missing quote and FX unavailable. Tooltips retain
  detail instead of representing every condition with the same dash.
- Browser regressions test initial display without any WebSocket price event,
  NEO, immediate reload restoration without another bootstrap request, expiry and
  logout. Server tests cover cache coalescing and a blocked source not delaying
  another source. A first-ever load still requires network responses; no fixed
  zero-latency guarantee or fabricated prices are introduced.

## Additional Spot References (2026-10-29)

- Prefer the selected reference when it has a fresh verified quote. Otherwise
  use a verified, fresh alternative in deterministic order: Binance, Coinbase,
  Gate.io, Bybit, Bitget, OKX, excluding the base. No averaging or cherry-picking
  the cheapest price. The actual reference is labeled on every computed row.
- The original preferred stream remains subscribed while a fallback is active,
  allowing immediate recovery when the preferred source resumes.
- Prices come directly from the exchanges' public SPOT REST/WebSocket APIs.
  Only USDT spot pairs are accepted for the four additional sources. Futures,
  swaps, non-USDT pairs, failure envelopes and invalid prices are rejected.
- CoinPaprika's exchange-market metadata supplies asset names/IDs only, never
  prices. Filter Spot/USDT, reject outliers and conflicting IDs, then require
  compatible asset names/symbols against the site's own rows. Bare symbol matches
  are insufficient; missing/expired identity data is not silently guessed.
- Identity catalogs refresh on demand every six hours with five-minute failure
  backoff; previous metadata has a 24-hour hard age limit. Compact metadata and
  short-lived prices use separate Durable Object keys. Actual downloaded catalogs
  serialized to 54 KB or less, below the per-value storage limit.
- Additional-source discovery/negative results use the existing owner-bound
  session cache. Failed additional sources back off five minutes. Bulk requests,
  coalescing, current-quote reuse and visible subscriptions avoid per-coin polling.
- Heartbeats: Gate spot.ping, Bybit ping, Bitget/OKX text ping. Reconnects back off;
  view changes, offline/background state and logout release their timers/sockets.
- OKX uses port 443, not the port 8443 retired on 2026-10-31 per its official log:
  https://www.okx.com/docs-v5/log_en/
- Live read-only checks received Gate XCN_USDT and Bybit/Bitget/OKX BTC-USDT spot
  prices. Controlled browser tests cover all four exclusive fallback assets,
  actual-reference labels, initial REST hydration, live updates, derivatives
  rejection, heartbeat setup and reload restoration. Server tests cover all four
  adapters, identity ambiguity and metadata/quote cache coalescing.

Sources:
- https://www.gate.com/docs/developers/apiv4/en/
- https://www.gate.com/docs/developers/apiv4/ws/en/
- https://bybit-exchange.github.io/docs/v5/market/tickers
- https://bybit-exchange.github.io/docs/v5/websocket/public/ticker
- https://www.bitget.com/legacy-docs/classic/spot/market/Get-Coin-List
- https://www.okx.com/docs-v5/en/
- https://coinpaprika.com/api

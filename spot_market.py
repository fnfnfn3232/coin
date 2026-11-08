"""USDT spot boards. Listings and quotes come from the exchange, not the cap provider."""

import re
import time

from robinhood_market import name_key, positive, same_name

SOURCES = {
    "bybit": (
        "https://api.bybit.com/v5/market/instruments-info?category=spot",
        "https://api.bybit.com/v5/market/tickers?category=spot",
        "bybit-spot",
    ),
    "bitget": (
        "https://api.bitget.com/api/v3/market/instruments?category=SPOT",
        "https://api.bitget.com/api/v2/spot/market/tickers",
        "bitget",
    ),
}
REFERENCE_INTERVAL = 3600
REFERENCE_MAX_AGE = 6 * REFERENCE_INTERVAL
BASE = re.compile(r"[A-Z0-9]{1,30}")


def spot_items(exchange, payload):
    if exchange == "bybit":
        result = payload.get("result") or {}
        rows = result.get("list") if payload.get("retCode") == 0 and result.get("category") == "spot" else None
        if result.get("nextPageCursor"):
            raise ValueError("unexpected_spot_pagination")
    else:
        rows = payload.get("data") if payload.get("code") == "00000" else None
    if not isinstance(rows, list) or not rows:
        raise ValueError("invalid_spot_response")
    return rows


def spot_pairs(exchange, payload):
    pairs = {}
    for item in spot_items(exchange, payload):
        if exchange == "bybit":
            if item.get("status") != "Trading" or item.get("symbolType") not in ("", "adventure", None):
                continue
            key = str(item.get("symbolId") or "")
        else:
            if (item.get("status") != "online" or item.get("category") != "SPOT"
                    or item.get("symbolType") != "crypto" or item.get("instrumentType", "crypto") != "crypto"):
                continue
            key = str(item.get("launchTime") or "")
        base = str(item.get("baseCoin") or "")
        if item.get("quoteCoin") != "USDT" or not BASE.fullmatch(base) or item.get("symbol") != base + "USDT":
            continue
        if base in pairs:
            raise ValueError("duplicate_spot_pair")
        pairs[base] = (str(item.get("fullName") or "").strip(), key)
    if not pairs:
        raise ValueError("empty_spot_listings")
    return pairs


def spot_quotes(exchange, payload, now):
    rows = spot_items(exchange, payload)
    quotes = {}
    for item in rows:
        pair = item.get("symbol")
        price = positive(item.get("lastPrice" if exchange == "bybit" else "lastPr"))
        at = positive(payload.get("time") if exchange == "bybit" else item.get("ts"))
        if isinstance(pair, str) and price is not None and at is not None and now - 900 <= at / 1000 <= now + 60:
            quotes[pair] = (price, int(at / 1000))
    if not quotes:
        raise ValueError("empty_fresh_spot_quotes")
    return quotes


def exchange_asset_names(fetch, exchange_id):
    tickers = fetch(f"https://api.coinpaprika.com/v1/exchanges/{exchange_id}/markets?quotes=USD")
    if not isinstance(tickers, list) or not tickers:
        raise ValueError("invalid_exchange_tickers")
    mappings = {}
    for ticker in tickers:
        base, _, quote = str(ticker.get("pair") or "").partition("/")
        asset_id, name = ticker.get("base_currency_id"), ticker.get("base_currency_name")
        if (ticker.get("category") != "Spot" or quote != "USDT" or ticker.get("quote_currency_id") != "usdt-tether"
                or not BASE.fullmatch(base) or not asset_id or not name):
            continue
        mappings.setdefault(base, set()).add((asset_id, name))
    return {base: next(iter(identities))[1] for base, identities in mappings.items() if len(identities) == 1}


def collect_names(fetch, exchange, previous, now):
    previous = previous or {}
    if now - int(previous.get("checkedAt") or 0) < REFERENCE_INTERVAL:
        return previous
    try:
        names = exchange_asset_names(fetch, SOURCES[exchange][2])
        if not names:
            raise ValueError("empty_exchange_asset_names")
        return {"checkedAt": now, "asOf": now, "names": names}
    except Exception as error:
        return {**previous, "checkedAt": now, "error": f"{type(error).__name__}:{str(error)[:120]}"}


def build_references(names, candidates):
    assets = {}
    for base, name in names.items():
        if not name:
            continue
        matching = [row for row in candidates.get(base, []) if row.get("marketIdentityVerified") is not False
                    and name_key(name) != name_key(base)
                    and same_name(base, name, row.get("englishName")) and positive(row.get("priceUsd"))]
        with_cap = [row for row in matching if positive(row.get("marketCapUsd"))]
        if with_cap:
            # Don't pick between materially inconsistent same-name candidates.
            caps = [float(row["marketCapUsd"]) for row in with_cap]
            matching = with_cap if max(caps) / min(caps) <= 1.5 else []
        ref = matching[0] if matching else {}
        assets[base] = {
            "englishName": name,
            "koreanName": ref.get("koreanName") or "",
            "referencePriceUsd": positive(ref.get("priceUsd")),
            "marketCapUsd": positive(ref.get("marketCapUsd")),
            "circulatingSupply": positive(ref.get("circulatingSupply")) if ref.get("supplyIdentityVerified") is not False else None,
            "totalSupply": positive(ref.get("totalSupply")) if ref.get("supplyIdentityVerified") is not False else None,
            "fdvUsd": positive(ref.get("fdvUsd")),
            "logo": ref.get("logo") or "",
            "capSourceDetail": ref.get("capSourceDetail") or ref.get("supplyDetail") or "",
        }
    return assets


def build_spot_board(fetch, exchange, previous=None, *, fx, candidates, now=None):
    now = int(time.time()) if now is None else now
    previous = previous or {}
    old_rows = previous.get("boards", {}).get(exchange) or []
    old_by_symbol = {row["symbol"]: row for row in old_rows}
    old_catalog = (previous.get("spotMarketCatalogs") or {}).get(exchange)
    status = {}
    pairs = None
    try:
        pairs = spot_pairs(exchange, fetch(SOURCES[exchange][0]))
        if old_rows and len(pairs) < len(old_rows) * 0.8:
            pairs = None
            raise ValueError("suspicious_spot_listing_drop")
    except Exception as error:
        status["listingsError"] = f"{type(error).__name__}:{str(error)[:120]}"
        status["browserSource"] = getattr(error, "code", None) in (403, 451)
    catalog = collect_names(fetch, exchange, old_catalog, now)
    as_of = int(catalog.get("asOf") or 0)
    names = catalog.get("names", {}) if 0 <= now - as_of <= REFERENCE_MAX_AGE else {}
    if pairs is not None:
        names = {base: name or names.get(base) for base, (name, _) in pairs.items()}
    assets = build_references(names, candidates)
    if pairs is None:
        rows = [{**row, "priceStale": True} for row in old_rows]
        for row in rows:
            if now - int(row.get("capUpdatedAt") or 0) > REFERENCE_MAX_AGE:
                for key in ("marketCapUsd", "marketCapKrw", "sortCapUsd", "circulatingSupply", "totalSupply", "fdvUsd", "fdvKrw"):
                    row[key] = None
                row.update(capSource="spot_cap_missing", status="missing", supplyIdentityVerified=False)
        return rows, assets, catalog, status

    try:
        quotes = spot_quotes(exchange, fetch(SOURCES[exchange][1]), now)
    except Exception as error:
        quotes = {}
        status["quotesError"] = f"{type(error).__name__}:{str(error)[:120]}"
    rows = []
    for base, (name, listing_key) in pairs.items():
        quote = quotes.get(base + "USDT")
        old = old_by_symbol.get(base) or {}
        price, at = quote or (None, None)
        if not quote and listing_key and old.get("spotListingKey") == listing_key and old.get("spotListingName") == name:
            price, at = positive(old.get("priceUsd")), old.get("priceUpdatedAt")
        ref = assets.get(base) or {}
        ref_price = positive(ref.get("referencePriceUsd"))
        # A recycled ticker must not inherit the old project's cap on a stale mapping.
        name_matches = not name or name_key(name) == name_key(base) or same_name(base, name, ref.get("englishName"))
        if not name_matches or not (price and ref_price and 0.65 <= price / ref_price <= 1.55):
            ref = {}
        if (not name and as_of < now - 300 and old and listing_key
                and (old.get("spotListingKey"), old.get("spotListingName")) != (listing_key, name)):
            ref = {}
        cap = ref.get("marketCapUsd")
        display_name = name or ref.get("englishName") or base
        rows.append({
            **{key: ref.get(key) for key in ("logo", "circulatingSupply", "totalSupply", "fdvUsd")},
            "exchange": exchange, "symbol": base, "pair": f"{base}/USDT",
            "name": ref.get("koreanName") or display_name, "englishName": display_name,
            "koreanName": ref.get("koreanName") or "", "nativeCurrency": "USDT",
            "spotListingKey": listing_key, "spotListingName": name,
            "priceUsd": price, "priceKrw": price * fx if price else None,
            "priceSource": f"{exchange}_spot_ticker", "priceUpdatedAt": at, "priceStale": quote is None,
            "marketCapUsd": cap, "marketCapKrw": cap * fx if cap else None, "sortCapUsd": cap,
            "capSource": "spot_verified_reference" if cap else "spot_cap_missing",
            "capSourceDetail": ref.get("capSourceDetail") or "",
            "capUpdatedAt": now if cap else None, "marketIdentityVerified": bool(ref) or bool(name),
            "supplyIdentityVerified": bool(ref), "status": "ok" if cap else "missing",
        })
    status.update(total=len(rows), freshQuotes=sum(not row["priceStale"] for row in rows))
    if status["freshQuotes"] < len(rows) * 0.8:
        status.setdefault("quotesError", "incomplete_spot_quotes")
    return rows, assets, catalog, status

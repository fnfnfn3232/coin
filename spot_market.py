"""USDT spot boards. Listings and quotes come from the exchange, not the cap provider."""

import re
import time
from datetime import datetime

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
CMC_LISTINGS = "https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest?start=1&limit=1500&convert=USD"
CMC_QUOTES = "https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/quotes/latest"
BITGET_COINS = "https://api.bitget.com/api/v2/spot/public/coins"
PAPRIKA_TICKERS = "https://api.coinpaprika.com/v1/tickers"
CMC_REFRESH_INTERVAL = 1800
REVIEWED_SPOT_ASSETS = {
    # Both spot listing notices identify this Base contract.
    "KOR": {
        "name": "KOR Protocol",
        "id": "42772",
        "platform": "base",
        "address": "0xd3679306360705ba3580bc4130b56460fb4e6926",
        "listingKeys": {"bybit": "1331", "bitget": "1793800800000"},
        "launchSupply": 2_286_666_667,
        "totalSupply": 10_000_000_000,
        "launchAt": "2026-11-04T14:00:00Z",
        "launchSupplyUntil": "2026-12-04T14:00:00Z",
        "supplySource": "https://www.gate.com/learn/articles/kor-tokenomics-utility-unlocks-and-fee-discounts",
    },
}


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


def exchange_asset_names(fetch, exchange_id, *, include_ids=False):
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
    verified = {base: next(iter(identities)) for base, identities in mappings.items() if len(identities) == 1}
    return verified if include_ids else {base: entry[1] for base, entry in verified.items()}


def collect_names(fetch, exchange, previous, now):
    previous = previous or {}
    if ("ids" in previous or previous.get("error")) and now - int(previous.get("checkedAt") or 0) < REFERENCE_INTERVAL:
        return previous
    try:
        identities = exchange_asset_names(fetch, SOURCES[exchange][2], include_ids=True)
        if not identities:
            raise ValueError("empty_exchange_asset_names")
        return {"checkedAt": now, "asOf": now, "names": {base: entry[1] for base, entry in identities.items()},
                "ids": {base: entry[0] for base, entry in identities.items()}}
    except Exception as error:
        return {**previous, "checkedAt": now, "error": f"{type(error).__name__}:{str(error)[:120]}"}


def cmc_data(payload):
    if not isinstance(payload, dict) or str((payload.get("status") or {}).get("error_code")) != "0":
        raise ValueError("invalid_cmc_response")
    return payload.get("data")


def contract_key(value):
    key = str(value or "").strip()
    return key.lower() if re.fullmatch(r"0x[0-9a-fA-F]{40}", key) else key


def bitget_spot_contracts(fetch):
    payload = fetch(BITGET_COINS)
    return {
        row["coin"]: {key for chain in row.get("chains") or []
                      if (key := contract_key(chain.get("contractAddress")))}
        for row in spot_items("bitget", payload) if BASE.fullmatch(str(row.get("coin") or ""))
    }


def source_timestamp(value):
    try:
        return int(datetime.fromisoformat(str(value or "").replace("Z", "+00:00")).timestamp())
    except (ValueError, OverflowError):
        return 0


def collect_paprika_caps(fetch, catalogs, previous, now):
    previous = previous or {}
    ids = {asset_id for catalog in catalogs.values()
           if 0 <= now - int(catalog.get("asOf") or 0) <= REFERENCE_MAX_AGE
           for asset_id in (catalog.get("ids") or {}).values()}
    assets = {asset_id: ref for asset_id, ref in (previous.get("assets") or {}).items()
              if asset_id in ids and now - ref["capUpdatedAt"] <= REFERENCE_MAX_AGE}
    if not ids or now - int(previous.get("checkedAt") or 0) < CMC_REFRESH_INTERVAL:
        return {**previous, "assets": assets}
    try:
        rows = fetch(PAPRIKA_TICKERS)
        if not isinstance(rows, list) or not rows:
            raise ValueError("invalid_paprika_tickers")
        current = {}
        for row in rows:
            asset_id = row.get("id")
            if asset_id not in ids or not row.get("name"):
                continue
            usd = (row.get("quotes") or {}).get("USD") or {}
            price, cap = positive(usd.get("price")), positive(usd.get("market_cap"))
            at = source_timestamp(row.get("last_updated"))
            if not price or not cap or not -60 <= now - at <= REFERENCE_MAX_AGE:
                continue
            current[asset_id] = {
                "englishName": row["name"], "referencePriceUsd": price, "marketCapUsd": cap, "capUpdatedAt": at,
                "circulatingSupply": positive(row.get("circulating_supply")), "totalSupply": positive(row.get("total_supply")),
                "capSource": "spot_coinpaprika_asset", "capSourceDetail": f"coinpaprika:{asset_id}",
            }
        if not current or len(current) < len(assets) * 0.8:
            raise ValueError("incomplete_paprika_tickers")
        return {"checkedAt": now, "assets": current}
    except Exception as error:
        return {"checkedAt": now, "assets": assets, "error": f"{type(error).__name__}:{str(error)[:100]}"}


def cmc_quote_reference(item, now, *, allow_reported=False):
    if item.get("is_active", 1) != 1 or not item.get("name"):
        return None
    quote = item.get("quote")
    usd = quote.get("USD") if isinstance(quote, dict) else next(
        (entry for entry in quote or [] if entry.get("symbol") == "USD"), None)
    if not isinstance(usd, dict):
        return None
    at = source_timestamp(usd.get("last_updated"))
    price, cap = positive(usd.get("price")), positive(usd.get("market_cap"))
    supply = positive(item.get("circulating_supply"))
    total = positive(item.get("total_supply"))
    if not price or not -60 <= now - at <= REFERENCE_MAX_AGE:
        return None
    source = "spot_coinmarketcap_asset"
    if not cap and not supply and allow_reported:
        reported = positive(item.get("self_reported_circulating_supply"))
        if reported and total and reported <= total:
            supply, cap = reported, reported * price
            source = "spot_coinmarketcap_reported"
    if not cap:
        return None
    if supply and not 0.75 <= cap / (supply * price) <= 1.25:
        return None
    asset_id = str(item["id"])
    return {
        "englishName": item["name"], "referencePriceUsd": price,
        "marketCapUsd": cap, "capUpdatedAt": at, "spotAssetId": asset_id,
        "capSource": source,
        "circulatingSupply": supply, "totalSupply": total,
        "fdvUsd": positive(usd.get("fully_diluted_market_cap")),
        "capSourceDetail": f"coinmarketcap_quotes:{asset_id}",
        "logo": f"https://s2.coinmarketcap.com/static/img/coins/64x64/{asset_id}.png",
    }


def collect_cmc_spot_caps(fetch, exchange, names, existing, previous, now, *, reviewed=None):
    previous = previous or {}
    reviewed = reviewed or {}
    targets = {base for base, name in names.items() if name and (existing.get(base) or {}).get("capSource") != "spot_coinpaprika_asset"}
    reviewed = {base: asset for base, asset in reviewed.items() if base in targets}
    reviewed_ids = sorted(asset["id"] for asset in reviewed.values())
    if not targets or (previous.get("reviewedIds", []) == reviewed_ids
                       and now - int(previous.get("checkedAt") or 0) < CMC_REFRESH_INTERVAL):
        return previous
    refs = {base: ref for base, ref in (previous.get("assets") or {}).items()
            if base in targets and names[base] == ref.get("spotListingName")
            and now - int(ref.get("capUpdatedAt") or 0) <= REFERENCE_MAX_AGE}
    errors = []
    contracts = {}
    if exchange == "bitget":
        try:
            contracts = bitget_spot_contracts(fetch)
        except Exception as error:
            errors.append(f"contracts:{type(error).__name__}:{str(error)[:100]}")
    try:
        items = cmc_data(fetch(CMC_LISTINGS))
        if not isinstance(items, list) or not items:
            raise ValueError("invalid_cmc_spot_quotes")
        by_name, by_contract = {}, {}
        for item in items:
            base = str(item.get("symbol") or "").upper()
            asset_id = str(item.get("id") or "")
            if base not in targets or base in reviewed or not re.fullmatch(r"[1-9][0-9]{0,9}", asset_id):
                continue
            address = contract_key((item.get("platform") or {}).get("token_address"))
            known_addresses = contracts.get(base) or set()
            if address and address in known_addresses:
                by_contract.setdefault(base, {})[asset_id] = item
            elif (not address or not known_addresses) and same_name(base, names[base], item.get("name")):
                # XRP's verified project name is also its ticker. Don't generalize that to other tickers.
                if name_key(names[base]) != name_key(base) or (base == "XRP" and asset_id == "52"):
                    by_name.setdefault(base, {})[asset_id] = item
        for base in targets - reviewed.keys():
            matches = by_contract.get(base) or by_name.get(base) or {}
            ref = cmc_quote_reference(next(iter(matches.values())), now) if len(matches) == 1 else None
            if ref is not None:
                refs[base] = {**ref, "spotListingName": names[base]}
            else:
                refs.pop(base, None)
    except Exception as error:
        errors.append(f"quotes:{type(error).__name__}:{str(error)[:100]}")
    if reviewed_ids:
        try:
            items = cmc_data(fetch(f"{CMC_QUOTES}?id={','.join(reviewed_ids)}&convert=USD"))
            if not isinstance(items, list):
                raise ValueError("invalid_cmc_reviewed_quotes")
            for base, asset in reviewed.items():
                matches = [item for item in items if str(item.get("id")) == asset["id"] and item.get("symbol") == base]
                refs.pop(base, None)
                if len(matches) != 1:
                    continue
                item = matches[0]
                platform = item.get("platform") or {}
                if (platform.get("slug") != asset["platform"]
                        or contract_key(platform.get("token_address")) != asset["address"]
                        or not same_name(base, asset["name"], item.get("name"))):
                    continue
                ref = cmc_quote_reference(item, now, allow_reported=True)
                if ref:
                    refs[base] = {**ref, "spotListingName": names[base], "verifiedListingKey": asset["listingKeys"][exchange]}
        except Exception as error:
            errors.append(f"reviewed_quotes:{type(error).__name__}:{str(error)[:100]}")
    return {"checkedAt": now, "assets": refs, "reviewedIds": reviewed_ids, "error": "; ".join(errors)}


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


def build_spot_board(fetch, exchange, previous=None, *, fx, candidates, catalog=None, paprika_caps=None, now=None):
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
    catalog = catalog if catalog is not None else collect_names(fetch, exchange, old_catalog, now)
    as_of = int(catalog.get("asOf") or 0)
    catalog_fresh = 0 <= now - as_of <= REFERENCE_MAX_AGE
    names = catalog.get("names", {}) if catalog_fresh else {}
    if pairs is not None:
        names = {base: name or names.get(base) for base, (name, _) in pairs.items()}
    reviewed = {}
    names = dict(names)
    for base, asset in REVIEWED_SPOT_ASSETS.items():
        key = asset["listingKeys"].get(exchange)
        if not key or (pairs is not None and pairs.get(base, ("", ""))[1] != key):
            continue
        if names.get(base) and not same_name(base, names[base], asset["name"]):
            continue
        names[base] = asset["name"]
        reviewed[base] = asset
    assets = build_references(names, candidates)
    for base, asset_id in (catalog.get("ids") or {}).items() if catalog_fresh else ():
        ref = (paprika_caps or {}).get(asset_id)
        existing = assets.get(base) or {}
        if ref and same_name(base, names.get(base), ref["englishName"]):
            assets[base] = {**ref, "spotListingName": names[base],
                            "koreanName": existing.get("koreanName") or "", "logo": existing.get("logo")}
    cmc = collect_cmc_spot_caps(fetch, exchange, names, assets, (old_catalog or {}).get("cmc"), now, reviewed=reviewed)
    catalog = {**catalog, "cmc": cmc}
    for base, ref in (cmc.get("assets") or {}).items():
        existing = assets.get(base) or {}
        if (existing.get("capSource") == "spot_coinpaprika_asset" or not names.get(base) or names[base] != ref["spotListingName"]
                or now - ref["capUpdatedAt"] > REFERENCE_MAX_AGE):
            continue
        assets[base] = {**ref, "koreanName": existing.get("koreanName") or ""}
    for base, asset in reviewed.items():
        existing = assets.get(base) or {}
        launch_at = source_timestamp(asset.get("launchAt"))
        expires_at = source_timestamp(asset.get("launchSupplyUntil"))
        if existing.get("marketCapUsd") or not launch_at <= now < expires_at:
            continue
        assets[base] = {
            **existing, "englishName": asset["name"], "marketCapUsd": None,
            "spotListingName": names[base], "verifiedListingKey": asset["listingKeys"][exchange],
            "logo": f"https://s2.coinmarketcap.com/static/img/coins/64x64/{asset['id']}.png",
            "circulatingSupply": asset["launchSupply"], "totalSupply": asset["totalSupply"],
            "launchSupplyAt": launch_at, "launchSupplyUntil": expires_at,
            "capSource": "spot_launch_supply_estimate", "capSourceDetail": asset["supplySource"],
        }
    if pairs is None:
        rows = [{**row, "priceStale": True} for row in old_rows]
        for row in rows:
            if now - int(row.get("capUpdatedAt") or 0) > REFERENCE_MAX_AGE or (
                row.get("launchSupplyUntil") and now >= row["launchSupplyUntil"]
            ):
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
        name_matches = not name or name == ref.get("spotListingName") or same_name(base, name, ref.get("englishName"))
        listing_matches = not ref.get("verifiedListingKey") or ref["verifiedListingKey"] == listing_key
        launch_estimate = ref.get("capSource") == "spot_launch_supply_estimate"
        compatible_quote = bool(quote) if launch_estimate else (price and ref_price and 0.65 <= price / ref_price <= 1.55)
        if not listing_matches or not name_matches or not compatible_quote:
            ref = {}
        if (not name and as_of < now - 300 and old and listing_key
                and (old.get("spotListingKey"), old.get("spotListingName")) != (listing_key, name)):
            ref = {}
        cap = price * ref["circulatingSupply"] if ref and launch_estimate else ref.get("marketCapUsd")
        display_name = name or ref.get("englishName") or base
        rows.append({
            **{key: ref.get(key) for key in ("logo", "circulatingSupply", "totalSupply", "fdvUsd", "spotAssetId", "launchSupplyAt", "launchSupplyUntil")},
            "exchange": exchange, "symbol": base, "pair": f"{base}/USDT",
            "name": ref.get("koreanName") or display_name, "englishName": display_name,
            "koreanName": ref.get("koreanName") or "", "nativeCurrency": "USDT",
            "spotListingKey": listing_key, "spotListingName": name,
            "priceUsd": price, "priceKrw": price * fx if price else None,
            "priceSource": f"{exchange}_spot_ticker", "priceUpdatedAt": at, "priceStale": quote is None,
            "marketCapUsd": cap, "marketCapKrw": cap * fx if cap else None, "sortCapUsd": cap,
            "capSource": (ref.get("capSource") or "spot_verified_reference") if cap else "spot_cap_missing",
            "capSourceDetail": ref.get("capSourceDetail") or "",
            "capUpdatedAt": (at if launch_estimate else ref.get("capUpdatedAt") or now) if cap else None,
            "marketIdentityVerified": bool(ref) or bool(name),
            "supplyIdentityVerified": bool(ref), "status": "ok" if cap else "missing",
        })
    status.update(total=len(rows), freshQuotes=sum(not row["priceStale"] for row in rows))
    if status["freshQuotes"] < len(rows) * 0.8:
        status.setdefault("quotesError", "incomplete_spot_quotes")
    return rows, assets, catalog, status

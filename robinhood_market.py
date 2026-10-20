"""Read-only Robinhood US spot listings and indicative USD quotes."""

import copy
import math
import re
import time
import unicodedata
from datetime import datetime
from urllib.parse import urlsplit

PAIRS_URL = "https://nummus.robinhood.com/currency_pairs/"
QUOTES_URL = "https://api.robinhood.com/marketdata/forex/quotes/?ids="
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
NAME_ALIASES = {
    "XLM": {"stellar", "stellarlumens", "lumen"},
    "ADA": {"cardano", "ada"},
    "FET": {"artificialsuperintelligencealliance", "artificialsuperintelligence", "fetchai"},
    "FLOKI": {"floki", "flokiinu"},
    "USDG": {"globaldollar", "usdglobaldollar"},
    "PEPE": {"pepe", "pepecoin"},
    "CRV": {"curve", "curvedao", "curvedaotoken"},
    "CC": {"canton", "cantoncoin"},
    "HBAR": {"hedera", "hederahashgraph"},
    "AERO": {"aerodrome", "aerodromefinance"},
    "BILL": {"billions", "billionsnetwork"},
    "IMX": {"immutable", "immutablex"},
    "EIGEN": {"eigencloud", "eigenlayer"},
    "ZRX": {"0x", "0xprotocol"},
    "SNX": {"synthetix", "synthetixnetworktoken"},
    "STRK": {"starknet", "starknettoken"},
    "USDC": {"usdc", "usdcoin"},
    "INJ": {"injective", "injectiveprotocol"},
}


def positive(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (ValueError, TypeError):
        return None


def name_key(value):
    return "".join(char for char in unicodedata.normalize("NFKC", str(value or "")).casefold() if char.isalnum())


def same_name(symbol, name, other_name):
    key, other = name_key(name), name_key(other_name)
    return bool(key and other and (key == other or {key, other} <= NAME_ALIASES.get(symbol, set())))


def collect_pairs(fetch):
    url = PAIRS_URL
    seen_pages, pairs = set(), {}
    for _ in range(10):
        if url in seen_pages:
            raise ValueError("robinhood_pagination_loop")
        seen_pages.add(url)
        page = fetch(url)
        if not isinstance(page, dict) or not isinstance(page.get("results"), list):
            raise ValueError("robinhood_invalid_pairs")
        for item in page["results"]:
            if not isinstance(item, dict):
                continue
            asset, quote = item.get("asset_currency") or {}, item.get("quote_currency") or {}
            symbol, pair_id = str(asset.get("code") or ""), str(item.get("id") or "")
            if (item.get("tradability") != "tradable" or item.get("display_only") is not False
                or asset.get("display_only") is not False or item.get("type") != "cryptocurrency"
                or asset.get("type") != "cryptocurrency" or quote.get("code") != "USD"):
                continue
            if not re.fullmatch(r"[A-Z0-9]{1,30}", symbol) or not UUID.fullmatch(pair_id) or not asset.get("name"):
                raise ValueError("robinhood_invalid_pair_identity")
            if item.get("symbol") != f"{symbol}-USD" or symbol in pairs:
                raise ValueError("robinhood_duplicate_or_mismatched_pair")
            pairs[symbol] = {"symbol": symbol, "name": str(asset["name"]), "id": pair_id}
        url = page.get("next")
        if not url:
            if not pairs:
                raise ValueError("robinhood_empty_tradable_pairs")
            return list(pairs.values())
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "nummus.robinhood.com" or parsed.path != "/currency_pairs/":
            raise ValueError("robinhood_invalid_next_page")
    raise ValueError("robinhood_too_many_pages")


def reference_for(pair, boards):
    matches = []
    for board in ("binance", "bithumb", "upbit", "coinbase"):
        for row in boards.get(board, []):
            if str(row.get("compareSymbol") or row.get("symbol") or "").upper() != pair["symbol"]:
                continue
            if row.get("marketIdentityVerified") is False:
                continue
            if same_name(pair["symbol"], pair["name"], row.get("englishName")):
                matches.append((board, row))
    return next(((board, row) for board, row in matches if positive(row.get("marketCapUsd")) is not None),
                matches[0] if matches else ("", {}))


def build_robinhood_board(fetch, boards, previous=None, *, fx=1, now=None):
    now = int(time.time()) if now is None else int(now)
    previous = previous or {}
    old_rows = previous.get("boards", {}).get("robinhood") or []
    old_by_id = {row.get("robinhoodPairId"): row for row in old_rows}
    old_status = previous.get("robinhoodRefresh") or {}
    status = {"checkedAt": now, "source": PAIRS_URL, "scope": "US_USD", "error": ""}
    try:
        pairs = collect_pairs(fetch)
        if old_rows and len(pairs) < len(old_rows) * 0.8:
            raise ValueError("robinhood_suspicious_listing_drop")
    except Exception as error:
        fallback = copy.deepcopy(old_rows)
        for row in fallback:
            row["priceStale"] = True
        return fallback, {**old_status, **status,
            "error": f"robinhood_listings_failed:{type(error).__name__}:{str(error)[:160]}"}

    quotes = {}
    failures = []
    for start in range(0, len(pairs), 25):
        batch = pairs[start:start + 25]
        expected = {pair["id"]: pair for pair in batch}
        try:
            payload = fetch(QUOTES_URL + ",".join(expected))
            if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
                raise ValueError("robinhood_invalid_quotes")
            for quote in payload["results"]:
                if not isinstance(quote, dict):
                    continue
                pair = expected.get(quote.get("id"))
                if not pair or quote.get("symbol") != f"{pair['symbol']}USD":
                    continue
                price = positive(quote.get("mark_price"))
                at = int(datetime.fromisoformat(str(quote.get("updated_at") or "").replace("Z", "+00:00")).timestamp())
                if price is not None and now - 1800 <= at <= now + 300:
                    quotes[pair["id"]] = (price, at)
        except Exception as error:
            failures.append(type(error).__name__)

    rows = []
    for pair in pairs:
        ref_board, reference = reference_for(pair, boards)
        price, price_at = quotes.get(pair["id"], (None, None))
        old = old_by_id.get(pair["id"]) or {}
        if price is None and old.get("symbol") == pair["symbol"]:
            price, price_at = positive(old.get("priceUsd")), old.get("priceUpdatedAt")
        cap = positive(reference.get("marketCapUsd"))
        row = {key: copy.deepcopy(reference.get(key)) for key in (
            "logo", "circulatingSupply", "totalSupply", "fdvUsd", "supplySource", "supplyDetail",
        )}
        row.update({"symbol": pair["symbol"], "pair": f"{pair['symbol']}/USD", "exchange": "robinhood",
            "name": reference.get("koreanName") or pair["name"], "koreanName": reference.get("koreanName") or "",
            "englishName": pair["name"], "nativeCurrency": "USD", "robinhoodPairId": pair["id"],
            "priceUsd": price, "priceKrw": price * fx if price is not None else None,
            "priceSource": "robinhood_mark_price", "priceUpdatedAt": price_at,
            "priceStale": pair["id"] not in quotes,
            "marketCapUsd": cap, "marketCapKrw": cap * fx if cap is not None else None,
            "sortCapUsd": cap, "capSource": "robinhood_verified_reference" if cap else "robinhood_missing",
            "capSourceDetail": reference.get("capSourceDetail") or "", "marketReferenceExchange": ref_board,
            "marketIdentityVerified": bool(reference), "supplyIdentityVerified": bool(reference),
            "riskFlags": [], "nameKeys": [pair["name"], reference.get("englishName") or "", reference.get("koreanName") or ""],
            "status": "ok" if cap is not None else "missing"})
        rows.append(row)
    missing = len(pairs) - len(quotes)
    status.update({"listingCheckedAt": now, "total": len(rows), "freshQuotes": len(quotes),
                   "lastSuccessAt": now if not missing else int(old_status.get("lastSuccessAt") or 0)})
    if missing:
        status["error"] = f"robinhood_quotes_missing:{missing}" + (f":{','.join(sorted(set(failures)))}" if failures else "")
    return rows, status

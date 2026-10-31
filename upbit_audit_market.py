"""Official Upbit issued supply and all-quote prices for audit valuations."""
import math
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

SOURCE = "upbit_audit_market"
SUPPLY_TTL = 86400


def positive(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(str(value).replace(",", ""))
        return value if math.isfinite(value) and value > 0 else None
    except (ValueError, TypeError):
        return None


def issued_supply(document):
    # Upbit calls issued quantity circulating_supply; current_circulating_supply
    # is circulating float, while max_supply is the issuance ceiling, not issued.
    items = [item for category in document.get("categories", []) if isinstance(category, dict)
             for item in category.get("items", []) if isinstance(item, dict)]
    for field in ("total_supply", "circulating_supply"):
        for item in items:
            if item.get("key") != field:
                continue
            entries = item.get("content")
            if not isinstance(entries, list):
                continue
            for provider in ("coin_market_cap", "coin_gecko", "project_team"):
                for entry in entries:
                    if not isinstance(entry, dict) or entry.get("key") != provider:
                        continue
                    value = positive(entry.get("content"))
                    if value is not None:
                        return {"value": value, "field": field, "provider": provider,
                                "baseDate": str(entry.get("baseDate") or "")}
    return {"value": None, "field": "", "provider": "", "baseDate": ""}


def collect_market_data(names, details, previous, fetch_details, fetch_json, *, now=None):
    now = int(time.time()) if now is None else int(now)
    previous = previous if isinstance(previous, dict) else {}
    if not names:
        return {symbol: {**item, "priceError": True, "supplyError": True}
                for symbol, item in previous.items() if isinstance(item, dict) and item.get("source") == SOURCE}, "catalog_unavailable"
    active = {symbol: item for symbol, item in names.items()
              if isinstance(item, dict) and item.get("active") is True and item.get("source") == "upbit_market_all"}
    rows, cached, pending = {}, {}, []
    failures = set()
    for symbol, identity in active.items():
        old = previous.get(symbol) or {}
        if not (old.get("source") == SOURCE and old.get("symbol") == symbol
                and old.get("englishName") == identity.get("englishName")):
            old = {}
        cached[symbol] = old
        rows[symbol] = {"symbol": symbol, "source": SOURCE, "englishName": identity.get("englishName")}
        supply = old.get("supply") or {}
        detail = details.get(symbol) or {}
        if isinstance(detail.get("auditSupply"), dict):
            rows[symbol]["supply"] = {**detail["auditSupply"], "checkedAt": now}
        elif symbol in details:
            rows[symbol]["supply"] = dict(supply)
            rows[symbol]["supplyError"] = True
            failures.add("supply")
        elif 0 <= now - int(supply.get("checkedAt") or 0) < SUPPLY_TTL:
            rows[symbol]["supply"] = dict(supply)
        else:
            pending.append(symbol)
    with ThreadPoolExecutor(max_workers=4) as executor:
        tasks = {executor.submit(fetch_details, symbol): symbol for symbol in pending}
        for task in as_completed(tasks):
            symbol = tasks[task]
            try:
                supply = task.result()["auditSupply"]
                rows[symbol]["supply"] = {**supply, "checkedAt": now}
            except Exception:
                rows[symbol]["supply"] = dict(cached[symbol].get("supply") or {})
                rows[symbol]["supplyError"] = True
                failures.add("supply")

    # One bulk quote per asset, with KRW preferred. Non-KRW quotes need the
    # actual Upbit KRW-BTC / KRW-USDT bridge, never an assumed dollar peg.
    markets = {market for symbol, item in active.items() for market in item.get("markets", [])
               if market in (f"KRW-{symbol}", f"BTC-{symbol}", f"USDT-{symbol}")}
    chosen = {symbol: next((f"{quote}-{symbol}" for quote in ("KRW", "BTC", "USDT")
                            if f"{quote}-{symbol}" in markets), None) for symbol in active}
    requested = set(filter(None, chosen.values()))
    for quote in ("BTC", "USDT"):
        if any(market.startswith(quote + "-") for market in requested) and f"KRW-{quote}" in markets:
            requested.add(f"KRW-{quote}")
    tickers = {}
    ordered = sorted(requested)
    for start in range(0, len(ordered), 80):
        batch = ordered[start:start + 80]
        try:
            payload = fetch_json("https://api.upbit.com/v1/ticker?" + urllib.parse.urlencode({"markets": ",".join(batch)}))
            if not isinstance(payload, list):
                raise ValueError("invalid_upbit_tickers")
            for item in payload:
                if not isinstance(item, dict) or item.get("market") not in batch:
                    continue
                if positive(item.get("trade_price")) is None or positive(item.get("timestamp")) is None:
                    continue
                if float(item["timestamp"]) > (now + 300) * 1000:
                    continue
                tickers[item["market"]] = item
        except Exception:
            failures.add("price")
    for symbol, row in rows.items():
        market = chosen[symbol]
        ticker = tickers.get(market)
        quote = market.split("-", 1)[0] if market else ""
        bridge = tickers.get(f"KRW-{quote}") if quote != "KRW" else None
        if ticker and (quote == "KRW" or bridge):
            price = positive(ticker["trade_price"])
            conversion = positive(bridge["trade_price"]) if bridge else 1
            row["price"] = {"market": market, "quote": quote, "value": price, "priceKrw": price * conversion,
                            "marketAt": ticker["timestamp"], "tradeAt": ticker.get("trade_timestamp"), "checkedAt": now,
                            "conversionMarket": bridge["market"] if bridge else None,
                            "conversionPrice": conversion, "conversionAt": bridge["timestamp"] if bridge else None,
                            "conversionTradeAt": bridge.get("trade_timestamp") if bridge else None}
        else:
            old = cached[symbol].get("price") or {}
            if old.get("market") in active[symbol].get("markets", []):
                row["price"] = dict(old)
            row["priceError"] = True
            failures.add("price")
    return rows, ",".join(sorted(failures))

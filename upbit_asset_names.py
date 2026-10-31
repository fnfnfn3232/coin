"""Official Korean asset names, independent of KRW price/listing coverage."""
import re

SOURCE = "upbit_market_all"


def suspicious_catalog_drop(previous, current):
    previous = previous if isinstance(previous, dict) else {}
    before = sum(isinstance(item, dict) and item.get("source") == SOURCE and item.get("active") is True for item in previous.values())
    after = sum(isinstance(item, dict) for item in current.values())
    return before >= 50 and after < before * 0.7


def normalize_asset_names(markets):
    if not isinstance(markets, list) or not markets:
        raise ValueError("upbit_asset_names_empty")
    grouped = {}
    for item in markets:
        if not isinstance(item, dict):
            continue
        market = str(item.get("market") or "")
        if not re.fullmatch(r"(?:KRW|BTC|USDT)-[A-Z0-9]+", market):
            continue
        symbol = market.split("-", 1)[1]
        korean = str(item.get("korean_name") or "").strip()
        english = str(item.get("english_name") or "").strip()
        if not re.search(r"[가-힣]", korean) or not english or len(korean) > 100 or len(english) > 150:
            continue
        grouped.setdefault(symbol, []).append((korean, english, market))
    result = {}
    for symbol, rows in grouped.items():
        names = {(row[0], row[1]) for row in rows}
        if len(names) != 1:
            result[symbol] = None
            continue
        korean, english = next(iter(names))
        result[symbol] = {"symbol": symbol, "koreanName": korean, "englishName": english,
                          "markets": sorted({row[2] for row in rows}), "source": SOURCE, "active": True}
    if not result:
        raise ValueError("upbit_asset_names_invalid")
    return result


def merge_asset_names(previous, current):
    previous = previous if isinstance(previous, dict) else {}
    names = {symbol: item for symbol, item in previous.items()
             if isinstance(item, dict) and item.get("source") == SOURCE and item.get("symbol") == symbol
             and re.fullmatch(r"[A-Z0-9]+", symbol) and isinstance(item.get("koreanName"), str)
             and re.search(r"[가-힣]", item["koreanName"]) and isinstance(item.get("englishName"), str)}
    if current:
        names = {symbol: {**item, "active": False} for symbol, item in names.items()}
    names.update(current)
    return names

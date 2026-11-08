import unittest
from datetime import datetime, timezone
from urllib.error import HTTPError

from spot_market import (BITGET_COINS, CMC_LISTINGS, CMC_QUOTES, PAPRIKA_TICKERS, SOURCES, build_spot_board,
                         collect_cmc_spot_caps, collect_paprika_caps, exchange_asset_names)

NOW = 1800000000
ISO_NOW = datetime.fromtimestamp(NOW, timezone.utc).isoformat()


class SpotMarketTests(unittest.TestCase):
    def test_bitget_excludes_noncrypto_halted_and_non_usdt(self):
        def pair(base, **updates):
            return {"symbol": base + "USDT", "baseCoin": base, "quoteCoin": "USDT",
                    "category": "SPOT", "status": "online", "symbolType": "crypto",
                    "instrumentType": "crypto", "fullName": "Concrete", **updates}

        pairs = [pair("CT"), pair("HALT", status="offline"), pair("STOCK", symbolType="stock"),
                 pair("OTHER", quoteCoin="USDC"), pair("FUT", category="USDT-FUTURES"), pair("ODD", symbol="OTHERUSDT")]
        candidates = {"CT": [
            {"englishName": "CyberTime", "priceUsd": 0.4, "marketCapUsd": 138e12},
            {"englishName": "Concrete", "priceUsd": 0.4, "marketCapUsd": 10e6, "circulatingSupply": 25e6},
        ]}

        def fetch(url):
            if url == SOURCES["bitget"][0]:
                return {"code": "00000", "data": pairs}
            if url == SOURCES["bitget"][1]:
                return {"code": "00000", "data": [{"symbol": "CTUSDT", "ts": NOW * 1000, "lastPr": "0.4"}]}
            return []

        rows, _, _, status = build_spot_board(fetch, "bitget", fx=1300, candidates=candidates, now=NOW)
        self.assertEqual([row["symbol"] for row in rows], ["CT"])
        self.assertEqual(rows[0]["marketCapUsd"], 10e6)
        self.assertEqual(rows[0]["priceKrw"], 520)
        self.assertEqual(status["freshQuotes"], 1)

    def test_bybit_uses_exchange_specific_name_and_never_ticker_only(self):
        def fetch(url):
            if url == SOURCES["bybit"][0]:
                rows = [{"symbol": f"{base}USDT", "baseCoin": base, "quoteCoin": "USDT", "status": "Trading", "symbolType": kind}
                        for base, kind in (("AI", ""), ("UNKNOWN", ""), ("AAPLX", "xstocks"))]
            elif url == SOURCES["bybit"][1]:
                rows = [{"symbol": f"{base}USDT", "lastPrice": "0.02"} for base in ("AI", "UNKNOWN")]
            else:
                return [{"pair": "AI/USDT", "category": "Spot", "quote_currency_id": "usdt-tether",
                         "base_currency_id": "ai-sleepless-ai", "base_currency_name": "Sleepless AI"}]
            return {"retCode": 0, "time": NOW * 1000, "result": {"category": "spot", "list": rows}}

        candidates = {
            "AI": [{"englishName": "Gensyn", "priceUsd": 0.02, "marketCapUsd": 123},
                   {"englishName": "Sleepless AI", "priceUsd": 0.02, "marketCapUsd": 456}],
            "UNKNOWN": [{"englishName": "Other project", "priceUsd": 0.02, "marketCapUsd": 123}],
        }
        rows, _, _, _ = build_spot_board(fetch, "bybit", fx=1300, candidates=candidates, now=NOW)
        self.assertEqual([(row["symbol"], row["marketCapUsd"]) for row in rows], [("AI", 456), ("UNKNOWN", None)])

    def test_source_block_preserves_previous_timestamp_and_expires_cap(self):
        def fetch(url):
            raise HTTPError(url, 403, "Forbidden", None, None)

        old = {"symbol": "BTC", "priceUsd": 10, "priceUpdatedAt": NOW - 200,
               "marketCapUsd": 100, "capUpdatedAt": NOW - 25000}
        rows, _, _, status = build_spot_board(fetch, "bybit", {"boards": {"bybit": [old]}}, fx=1300, candidates={}, now=NOW)
        self.assertTrue(status["browserSource"])
        self.assertTrue(rows[0]["priceStale"])
        self.assertEqual(rows[0]["priceUpdatedAt"], NOW - 200)
        self.assertIsNone(rows[0]["marketCapUsd"])
        self.assertEqual(old["marketCapUsd"], 100)

    def test_conflicting_identity_is_excluded(self):
        base = {"pair": "AI/USDT", "category": "Spot", "quote_currency_id": "usdt-tether"}
        tickers = [{**base, "base_currency_id": asset, "base_currency_name": name}
                   for asset, name in (("ai-sleepless-ai", "Sleepless AI"), ("ai-gensyn", "Gensyn"))]
        self.assertEqual(exchange_asset_names(lambda _: tickers, "bybit-spot"), {})

    def test_paprika_uses_asset_id_not_symbol_and_does_not_invent_supply(self):
        def ticker(asset_id, cap, updated=ISO_NOW):
            return {"id": asset_id, "name": "XRP", "symbol": "XRP", "last_updated": updated,
                    "quotes": {"USD": {"price": 2, "market_cap": cap}}}

        catalog = {"asOf": NOW, "ids": {"XRP": "xrp-xrp", "OLD": "old-coin"}, "names": {"XRP": "XRP"}}
        payload = [ticker("xrp-xrp", 70e9), ticker("xrp-fake", 138e12), ticker("old-coin", 3, "2020-01-01T00:00:00Z")]
        cache = collect_paprika_caps(lambda url: payload if url == PAPRIKA_TICKERS else None, {"bybit": catalog}, None, NOW)
        self.assertEqual(set(cache["assets"]), {"xrp-xrp"})
        ref = cache["assets"]["xrp-xrp"]
        self.assertEqual(ref["marketCapUsd"], 70e9)
        self.assertIsNone(ref["circulatingSupply"])
        self.assertEqual(ref["capUpdatedAt"], NOW)

        def unavailable(url):
            raise HTTPError(url, 429, "Too Many Requests", None, None)

        fallback = collect_paprika_caps(unavailable, {"bybit": catalog}, cache, NOW + 1900)
        self.assertEqual(fallback["assets"]["xrp-xrp"]["capUpdatedAt"], NOW)
        self.assertIn("429", fallback["error"])

    def test_cmc_uses_bitget_contract_for_shared_ticker_and_rejects_bad_cap(self):
        correct_address = "0x" + "1" * 40

        def candidate(asset_id, address, cap):
            return {"id": asset_id, "symbol": "CT", "name": "Concrete", "circulating_supply": 10,
                    "platform": {"token_address": address},
                    "quote": [{"symbol": "USD", "price": 2, "market_cap": cap, "last_updated": ISO_NOW}]}

        good = candidate(42253, correct_address, 20)
        wrong = candidate(1, "0x" + "2" * 40, 138e12)

        def fetch(url):
            if url == BITGET_COINS:
                return {"code": "00000", "data": [{"coin": "CT", "chains": [{"contractAddress": correct_address}]}]}
            self.assertEqual(url, CMC_LISTINGS)
            return {"status": {"error_code": 0}, "data": [wrong, good]}

        result = collect_cmc_spot_caps(fetch, "bitget", {"CT": "Concrete"}, {}, None, NOW)
        self.assertEqual(result["assets"]["CT"]["spotAssetId"], "42253")
        self.assertEqual(result["assets"]["CT"]["marketCapUsd"], 20)
        good["quote"][0]["market_cap"] = 138e12
        rejected = collect_cmc_spot_caps(fetch, "bitget", {"CT": "Concrete"}, {}, None, NOW)
        self.assertEqual(rejected["assets"], {})

    def test_kor_uses_reviewed_contract_and_reported_supply_outside_bulk_list(self):
        item = {"id": 42772, "symbol": "KOR", "name": "Kor Protocol",
                "platform": {"slug": "base", "token_address": "0xD3679306360705ba3580BC4130b56460FB4e6926"},
                "circulating_supply": 0, "self_reported_circulating_supply": 2286666667,
                "total_supply": 10000000000,
                "quote": [{"symbol": "USD", "price": 0.0011, "market_cap": 0, "last_updated": ISO_NOW}]}

        def fetch(url):
            if url == CMC_LISTINGS:
                return {"status": {"error_code": 0}, "data": [{"id": 1, "symbol": "BTC"}]}
            if url == CMC_QUOTES + "?id=42772&convert=USD":
                return {"status": {"error_code": 0}, "data": [item]}
            if url == SOURCES["bybit"][0]:
                raise HTTPError(url, 403, "Forbidden", None, None)
            raise AssertionError(url)

        rows, refs, cache, status = build_spot_board(fetch, "bybit", fx=1350, candidates={}, catalog={}, now=NOW)
        self.assertTrue(status["browserSource"])
        self.assertEqual(rows, [])
        kor = refs["KOR"]
        self.assertEqual(kor["verifiedListingKey"], "1331")
        self.assertEqual(kor["capSource"], "spot_coinmarketcap_reported")
        self.assertEqual(kor["circulatingSupply"], 2286666667)
        self.assertAlmostEqual(kor["marketCapUsd"], 2286666667 * 0.0011)
        self.assertEqual(cache["cmc"]["error"], "")

        item["quote"][0]["market_cap"] = 2500000
        _, refs, _, _ = build_spot_board(fetch, "bybit", fx=1350, candidates={}, catalog={}, now=NOW)
        self.assertEqual(refs["KOR"]["capSource"], "spot_coinmarketcap_asset")
        self.assertIsNone(refs["KOR"]["circulatingSupply"])

        item["platform"]["token_address"] = "0x" + "1" * 40
        _, refs, _, _ = build_spot_board(fetch, "bybit", fx=1350, candidates={}, catalog={}, now=NOW)
        self.assertIsNone(refs["KOR"]["marketCapUsd"])

    def test_kor_launch_supply_fallback_survives_cmc_rate_limit_and_expires(self):
        now = 1794142256
        instrument = {"symbol": "KORUSDT", "baseCoin": "KOR", "quoteCoin": "USDT", "status": "online",
                      "category": "SPOT", "symbolType": "crypto", "fullName": "KOR Protocol", "launchTime": "1793800800000"}

        def fetch(url):
            if url == SOURCES["bitget"][0]:
                return {"code": "00000", "data": [instrument]}
            if url == SOURCES["bitget"][1]:
                return {"code": "00000", "data": [{"symbol": "KORUSDT", "ts": now * 1000, "lastPr": "0.0011"}]}
            if url == BITGET_COINS:
                return {"code": "00000", "data": [{"coin": "KOR", "chains": []}]}
            if url == SOURCES["bybit"][0]:
                raise HTTPError(url, 403, "Forbidden", None, None)
            raise HTTPError(url, 429, "Too Many Requests", None, None)

        rows, _, _, _ = build_spot_board(fetch, "bitget", fx=1350, candidates={}, catalog={}, now=now)
        self.assertEqual(rows[0]["capSource"], "spot_launch_supply_estimate")
        self.assertAlmostEqual(rows[0]["marketCapUsd"], 2286666667 * 0.0011)
        self.assertEqual(rows[0]["capUpdatedAt"], now)
        _, refs, _, _ = build_spot_board(fetch, "bybit", fx=1350, candidates={}, catalog={}, now=now)
        self.assertEqual(refs["KOR"]["verifiedListingKey"], "1331")
        self.assertEqual(refs["KOR"]["circulatingSupply"], 2286666667)
        self.assertIsNone(refs["KOR"]["marketCapUsd"])
        _, refs, _, _ = build_spot_board(fetch, "bybit", fx=1350, candidates={}, catalog={}, now=NOW)
        self.assertIsNone(refs["KOR"]["circulatingSupply"])

        instrument["launchTime"] = "1794000000000"
        rows, _, _, _ = build_spot_board(fetch, "bitget", fx=1350, candidates={}, catalog={}, now=now)
        self.assertIsNone(rows[0]["marketCapUsd"])


if __name__ == "__main__":
    unittest.main()

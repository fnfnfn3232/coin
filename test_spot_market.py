import unittest
from urllib.error import HTTPError

from spot_market import SOURCES, build_spot_board, exchange_asset_names

NOW = 1800000000


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


if __name__ == "__main__":
    unittest.main()

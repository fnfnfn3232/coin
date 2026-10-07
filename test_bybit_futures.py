import copy
import unittest
import urllib.parse
from unittest.mock import patch

import build_data


class BybitFuturesTests(unittest.TestCase):
    def instrument(self, symbol="BTCUSDT", base="BTC", **extra):
        return {"symbol": symbol, "baseCoin": base, "quoteCoin": "USDT", "settleCoin": "USDT",
                "status": "Trading", "contractType": "LinearPerpetual", "symbolType": "",
                "isPreListing": False, **extra}

    def response(self, rows, cursor=""):
        return {"retCode": 0, "result": {"list": rows, "nextPageCursor": cursor}}

    def test_pagination_deduplicates_and_keeps_every_crypto_contract(self):
        first = [self.instrument(f"COIN{i}USDT", f"COIN{i}") for i in range(500)]
        last = [self.instrument("1000PEPEUSDT", "1000PEPE"),
                self.instrument("10000SATSUSDT", "10000SATS", symbolType="innovation"), first[0]]
        prices = [{"symbol": row["symbol"], "lastPrice": "12.5"} for row in first + last]
        with patch.object(build_data, "fetch_json", side_effect=[self.response(first, "next&cursor"),
                          self.response(last), self.response(prices)]) as fetch:
            rows = build_data.fetch_bybit_futures({"PEPE", "SATS"})
        self.assertEqual(len(rows), 502)
        self.assertEqual(rows[-2]["symbol"], "PEPE")
        self.assertEqual(rows[-1]["symbol"], "SATS")
        self.assertTrue(all(build_data.is_bybit_usdt_future(row) for row in rows))
        self.assertTrue(all(row["priceUsd"] == 12.5 for row in rows))
        query = urllib.parse.parse_qs(urllib.parse.urlparse(fetch.call_args_list[1].args[0]).query)
        self.assertEqual(query["cursor"], ["next&cursor"])
        self.assertEqual(query["limit"], ["1000"])

    def test_excludes_usdc_inverse_dated_closed_pre_market_and_tradfi(self):
        valid = [self.instrument(), self.instrument("0GUSDT", "0G", symbolType="innovation")]
        invalid = [self.instrument("BTCPERP", quoteCoin="USDC", settleCoin="USDC"),
                   self.instrument("BTCUSD", quoteCoin="USD", settleCoin="BTC", contractType="InversePerpetual"),
                   self.instrument("BTCUSDT_261225", contractType="LinearFutures"),
                   self.instrument("CLOSEDUSDT", status="Closed"),
                   self.instrument("WAITUSDT", status="PendingOpen"),
                   self.instrument("NEWUSDT", isPreListing=True),
                   self.instrument("MARGINUSDT", settleCoin="BTC")]
        invalid += [self.instrument(f"{kind.upper()}USDT", symbolType=kind)
                    for kind in ["commodity", "stock", "ETF", "forex", "unknown"]]
        with patch.object(build_data, "fetch_json", side_effect=[self.response(valid + invalid),
                          self.response([{"symbol": "BTCUSDT", "lastPrice": "100"}])]):
            rows = build_data.fetch_bybit_futures()
        self.assertEqual([row["contractId"] for row in rows], ["BTCUSDT", "0GUSDT"])
        self.assertIsNone(rows[1]["priceUsd"], "missing tickers do not silently drop listed contracts")

    def test_partial_or_api_error_never_returns_an_incomplete_snapshot(self):
        for responses in [[{"retCode": 10006}],
                          [self.response([self.instrument()], "same"), self.response([self.instrument()], "same")],
                          [self.response([self.instrument()], "next"), self.response([])],
                          [self.response([self.instrument()]), {"retCode": 10006}]]:
            with self.subTest(responses=responses), patch.object(build_data, "fetch_json", side_effect=responses):
                with self.assertRaises(RuntimeError):
                    build_data.fetch_bybit_futures()

    def test_spot_cap_and_logo_are_shared_not_recomputed_from_contract_price(self):
        with patch.object(build_data, "fetch_json", side_effect=[self.response([self.instrument("1000PEPEUSDT", "1000PEPE")]),
                          self.response([{"symbol": "1000PEPEUSDT", "lastPrice": "0.01"}])]):
            rows = build_data.fetch_bybit_futures({"PEPE"})
        spot = {"symbol": "PEPE", "marketCapUsd": 123456, "circulatingSupply": 999,
                "logo": "https://static.upbit.com/logos/PEPE.png"}
        build_data.apply_futures_underlying_market_data(rows, [("upbit", [spot])])
        build_data.apply_coin_logos({"upbit": [spot]}, {"bybit": rows}, {})
        self.assertEqual(rows[0]["marketCapUsd"], spot["marketCapUsd"])
        self.assertEqual(rows[0]["priceUsd"], 0.01)
        self.assertEqual(rows[0]["logo"], spot["logo"])
        self.assertEqual(rows[0]["capSource"], "futures_underlying_upbit")
        snapshot = {"futures": {"bybit": rows + [{**rows[0], "quoteAsset": "USDC"}]}}
        before = copy.deepcopy(snapshot)
        self.assertEqual(build_data.clone_previous_futures_rows(snapshot, "bybit"), rows)
        self.assertEqual(snapshot, before)


if __name__ == "__main__":
    unittest.main()

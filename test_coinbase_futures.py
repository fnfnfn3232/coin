import copy
import time
import unittest
from unittest.mock import patch

import build_data


class CoinbaseDeribitFuturesTests(unittest.TestCase):
    def setUp(self):
        self.instrument = {"instrument_name": "BTC_USDC-PERPETUAL", "base_currency": "BTC", "kind": "future",
                           "is_active": True, "state": "open", "underlying_type": "crypto", "settlement_period": "perpetual",
                           "instrument_type": "linear", "quote_currency": "USDC", "settlement_currency": "USDC", "contract_size": 1}
        self.quote = {"instrument_name": "BTC_USDC-PERPETUAL", "last": 100, "mark_price": 99,
                      "creation_timestamp": time.time() * 1000}

    def fetch(self, instruments=None, quotes=None, assets=None):
        with patch.object(build_data, "fetch_json", side_effect=[{"result": instruments or [self.instrument]}, {"result": quotes if quotes is not None else [self.quote]}, {"data": assets or []}]) as fetch:
            rows = build_data.fetch_coinbase_futures({"BTC"})
            self.assertEqual([call.args[0] for call in fetch.call_args_list], [build_data.COINBASE_FUTURES_PRODUCTS_ENDPOINT, build_data.COINBASE_FUTURES_QUOTES_ENDPOINT, "https://api.coinbase.com/v2/currencies/crypto"])
            return rows

    def test_new_gateway_exact_crypto_contracts_and_last_trade_not_mark(self):
        excluded = [{**self.instrument, **change} for change in [{"underlying_type": "equity"}, {"underlying_type": "commodity"},
                    {"settlement_period": "month"}, {"is_active": False}, {"state": "closed"}, {"quote_currency": "USD"},
                    {"settlement_currency": "BTC"}, {"instrument_type": "reversed"}, {"instrument_name": "BTC-PERP"}, {"kind": "option"}]]
        rows = self.fetch([self.instrument, *excluded])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["priceUsd"], 100)
        self.assertEqual(rows[0]["markPrice"], 99)
        self.assertEqual(rows[0]["futuresPriceBasis"], "last")
        self.assertTrue(build_data.is_coinbase_usdc_future(rows[0]))

    def test_missing_last_does_not_fall_back_to_mark_or_spot(self):
        with self.assertRaisesRegex(RuntimeError, "empty_coinbase_deribit_prices"):
            self.fetch(quotes=[{**self.quote, "last": None, "mark_price": 500}])
        for stamp in [time.time() * 1000 - 130000, time.time() * 1000 + 60000]:
            with self.assertRaises(RuntimeError):
                self.fetch(quotes=[{**self.quote, "creation_timestamp": stamp}])

    def test_legacy_snapshot_contracts_are_not_kept_as_live_contracts(self):
        current = self.fetch()[0]
        old = {**current, "contractId": "BTC-PERP"}
        data = {"futures": {"coinbase": [old, current]}}
        original = copy.deepcopy(data)
        rows = build_data.clone_previous_futures_rows(data, "coinbase")
        self.assertEqual([row["contractId"] for row in rows], ["BTC_USDC-PERPETUAL"])
        self.assertEqual(data, original)

    def test_official_asset_uuid_prevents_same_ticker_name_and_cap_collision(self):
        instrument = {**self.instrument, "instrument_name": "AI_USDC-PERPETUAL", "base_currency": "AI", "base_currency_uuid": "official-ai"}
        quote = {**self.quote, "instrument_name": instrument["instrument_name"]}
        rows = self.fetch([instrument], [quote], [{"asset_id": "official-ai", "type": "crypto", "name": "Sleepless AI"}])
        references = [("upbit", [{"symbol": "AI", "name": "Gensyn", "englishName": "Gensyn", "priceUsd": 100, "marketCapUsd": 99999}]),
                      ("binance", [{"symbol": "AI", "name": "Sleepless AI", "englishName": "Sleepless AI", "priceUsd": 100, "marketCapUsd": 1000}])]
        build_data.apply_futures_underlying_market_data(rows, references)
        self.assertEqual(rows[0]["englishName"], "Sleepless AI")
        self.assertEqual(rows[0]["marketCapUsd"], 1000)
        unverified = self.fetch([instrument], [quote])
        build_data.apply_futures_underlying_market_data(unverified, references)
        self.assertIsNone(unverified[0]["marketCapUsd"])


if __name__ == "__main__":
    unittest.main()

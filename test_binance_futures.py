import copy
import unittest
from unittest.mock import patch

import build_data


class BinanceUsdtFuturesTests(unittest.TestCase):
    def row(self, contract, quote, **extra):
        return {"contractId": contract, "quoteAsset": quote, "contractMarket": "USD\u24c8-M", **extra}

    def test_exact_quote_and_contract_identity(self):
        for contract in ["BTCUSDT", "1000SHIBUSDT", "USDCUSDT", "USD1USDT"]:
            self.assertTrue(build_data.is_binance_usdt_future(self.row(contract, "USDT")))
        for row in [None, {}, self.row("BTCU", "U"), self.row("BTCUSD1", "USD1"),
                    self.row("BTCUSDC", "USDC"), self.row("ETHBTC", "BTC"),
                    self.row("BTCUSD_PERP", "USD", contractMarket="COIN-M"),
                    self.row("BTCUSDT", "USDC"), self.row("BTCUSDC", "USDT"),
                    self.row("BTCUSDT", "USDT", marginAsset="BTC"),
                    self.row("BTCUSDT", "USDT", contractMarket="COIN-M")]:
            self.assertFalse(build_data.is_binance_usdt_future(row), row)

    def test_official_source_only_fetches_usdm_and_keeps_all_usdt_pairs(self):
        symbols = []
        for contract, base, quote in [("BTCUSDT", "BTC", "USDT"), ("1000SHIBUSDT", "1000SHIB", "USDT"),
                                      ("USDCUSDT", "USDC", "USDT"), ("BTCUSD1", "BTC", "USD1"),
                                      ("BTCUSDC", "BTC", "USDC"), ("BTCU", "BTC", "U"),
                                      ("ETHBTC", "ETH", "BTC")]:
            symbols.append({"symbol": contract, "baseAsset": base, "quoteAsset": quote,
                            "marginAsset": quote, "status": "TRADING", "contractType": "PERPETUAL", "underlyingType": "COIN"})
        symbols.extend([{**symbols[0], "symbol": "INACTIVEUSDT", "status": "SETTLING"},
                        {**symbols[0], "symbol": "BTCUSDT_261225", "contractType": "CURRENT_QUARTER"},
                        {**symbols[0], "symbol": "WRONGUSDT", "marginAsset": "BTC"}])
        prices = [{"symbol": row["symbol"], "price": "12.5"} for row in symbols]
        with patch.object(build_data, "fetch_json", side_effect=[{"symbols": symbols}, prices]) as fetch:
            rows = build_data.fetch_binance_futures_official({"BTC", "SHIB", "USDC"})
        self.assertEqual([row["contractId"] for row in rows], ["BTCUSDT", "1000SHIBUSDT", "USDCUSDT"])
        self.assertTrue(all(row["priceUsd"] == 12.5 and row["marginAsset"] == "USDT" for row in rows))
        self.assertEqual([call.args[0] for call in fetch.call_args_list],
                         [build_data.BINANCE_USDM_FUTURES_INFO_ENDPOINT, build_data.BINANCE_USDM_FUTURES_PRICE_ENDPOINT])

    def test_coingecko_fallback_does_not_reintroduce_other_quotes(self):
        tickers = [{"symbol": contract, "base": "BTC", "target": quote, "contract_type": "perpetual", "last": 20}
                   for contract, quote in [("BTCUSDT", "USDT"), ("BTCUSD1", "USD1"), ("BTCUSDC", "USDC"),
                                           ("BTCUSD_PERP", "USD"), ("BTCU", "U"), ("ETHBTC", "BTC"), ("BTCUSDC", "USDT")]]
        with patch.object(build_data, "fetch_json", return_value={"tickers": tickers}):
            rows = build_data.fetch_binance_futures_coingecko()
        self.assertEqual([row["contractId"] for row in rows], ["BTCUSDT"])

    def test_previous_snapshot_filters_binance_only_without_mutating_cache(self):
        rows = [self.row("BTCUSDT", "USDT"), self.row("BTCUSD1", "USD1"), self.row("BTCUSDC", "USDC"),
                self.row("BTCUSD_PERP", "USD", contractMarket="COIN-M"), self.row("ETHBTC", "BTC")]
        previous = {"futures": {"binance": rows, "coinbase": [self.row("BTC-PERP", "USDC")]}}
        before = copy.deepcopy(previous)
        self.assertEqual([row["contractId"] for row in build_data.clone_previous_futures_rows(previous, "binance")], ["BTCUSDT"])
        self.assertEqual(build_data.clone_previous_futures_rows(previous, "coinbase"), previous["futures"]["coinbase"])
        self.assertEqual(previous, before)


if __name__ == "__main__":
    unittest.main()

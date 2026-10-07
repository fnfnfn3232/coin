import copy
import math
import unittest
from unittest.mock import patch

import build_data as market


class MarketIdentityTests(unittest.TestCase):
    def candidate(self, name, source, cap, price, supply, symbol="CT", **extra):
        return {"symbol": symbol, "name": name, "englishName": name, "sourceId": source,
                "nameKeys": list(market.build_name_keys(name, name, symbol)),
                "marketCapUsd": cap, "priceUsd": price, "circulatingSupply": supply,
                "totalSupply": supply, "supplyDetail": f"coinmarketcap_quotes:{source}", **extra}

    def concrete(self):
        return {"symbol": "CT", "name": "CT", "englishName": "Concrete", "priceUsd": 0.379,
                "nameKeys": ["ct", "concrete"], "marketCapUsd": None, "marketCapKrw": None,
                "contractAddresses": ["0x0A092E544DA31150b439a1aAA1A3a2214a867F46 "]}

    def test_ct_cryptotwitter_supply_and_cap_never_match_concrete(self):
        wrong = self.candidate("CryptoTwitter", "cryptotwitter", 33656, 9.2110659e-11, 365386617983886)
        row = self.concrete()
        self.assertIsNone(market.pick_coingecko_supply_candidate(row, [wrong]))
        self.assertIsNone(market.pick_verified_market_candidate(row, [wrong]))
        market.apply_external_market_cap_fills("coinbase", [row], {"CT": [wrong]},
            cap_source="coinbase_coingecko_market_cap", detail_prefix="coingecko")
        self.assertIsNone(row["marketCapUsd"])
        self.assertNotIn("circulatingSupply", row)

    def test_verified_cmc_concrete_cap_replaces_no_guess_and_shares_with_all_futures(self):
        wrong = self.candidate("CryptoTwitter", "14720", 138230000000000, 0.379, 365386617983886)
        correct = self.candidate("Concrete", "42253", 71947107.75, 0.378668988, 190000000,
            totalSupply=1000000000, contractAddresses=["0x0a092e544da31150b439a1aaa1a3a2214a867f46"])
        row = self.concrete()
        market.apply_external_market_cap_fills("coinbase", [row], {"CT": [wrong, correct]},
            cap_source="coinbase_coinmarketcap", detail_prefix="coinmarketcap_verified_identity")
        self.assertEqual(row["marketCapUsd"], correct["marketCapUsd"])
        self.assertEqual(row["circulatingSupply"], 190000000)
        self.assertTrue(row["marketIdentityVerified"])
        for exchange in ("binance", "coinbase", "bybit"):
            future = {"exchange": exchange, "symbol": "CT", "name": "CT", "priceUsd": 0.379}
            market.apply_futures_underlying_market_data([future], [("coinbase", [row])])
            self.assertEqual(future["marketCapUsd"], correct["marketCapUsd"])
            self.assertEqual(future["englishName"], "Concrete")

    def test_ambiguous_symbols_never_choose_largest_even_if_prices_match(self):
        a = self.candidate("Project A", "1", 1000, 1, 1000, symbol="ONE")
        b = self.candidate("Project B", "2", 100000000, 1, 100000000, symbol="ONE")
        row = {"symbol": "ONE", "name": "ONE", "priceUsd": 1, "marketCapUsd": None}
        self.assertIsNone(market.pick_verified_market_candidate(row, [a, b]))
        market.apply_futures_underlying_market_data([row], [], {"ONE": [a, b]})
        market.apply_futures_external_market_cap_overrides([row], {"ONE": [a, b]})
        self.assertIsNone(row["marketCapUsd"])

    def test_unknown_identity_does_not_inherit_wrong_name_or_nan_cap(self):
        row = {"symbol": "ABC", "name": "Project A", "priceUsd": 1}
        wrong = self.candidate("Project B", "2", 2000, 1, 2000, symbol="ABC")
        self.assertIsNone(market.pick_verified_market_candidate(row, [wrong]))
        invalid = {**wrong, "marketCapUsd": math.inf}
        self.assertIsNone(market.pick_verified_market_candidate(row, [invalid]))
        self.assertIsNone(market.to_float(math.nan))

    def test_bundled_future_price_uses_underlying_units(self):
        row = {"symbol": "PEPE", "rawUnderlyingSymbol": "1000PEPE", "priceUsd": 0.01}
        candidate = self.candidate("Pepe", "24478", 1000, 0.00001, 100000000, symbol="PEPE")
        self.assertIs(market.pick_verified_market_candidate(row, [candidate]), candidate)

    def test_legacy_wrong_snapshot_is_invalidated_without_mutating_original(self):
        row = {**self.concrete(), "contractId": "CTUSDT", "quoteAsset": "USDT",
               "marketCapUsd": 138230000000000, "circulatingSupply": 365386617983886,
               "capSource": "futures_underlying_coinmarketcap"}
        snapshot = {"futures": {"binance": [row]}}
        before = copy.deepcopy(snapshot)
        copied = market.clone_previous_futures_rows(snapshot, "binance")
        self.assertIsNone(copied[0]["marketCapUsd"])
        self.assertIsNone(copied[0]["circulatingSupply"])
        fresh = {"symbol": "CT", "contractId": "CTUSDT"}
        market.apply_previous_futures_coinmarketcap_fallback([fresh], [row])
        self.assertNotIn("marketCapUsd", fresh)
        self.assertEqual(snapshot, before)
        row["marketIdentityVerified"] = True
        row["supplyIdentityVerified"] = True
        row["marketCapUsd"] = 71947107.75
        market.apply_previous_futures_coinmarketcap_fallback([fresh], [row])
        self.assertEqual(fresh["marketCapUsd"], 71947107.75)

    def test_official_coinbase_name_and_contract_are_kept(self):
        products = [{"base_currency": "CT", "quote_currency": "USD", "status": "online"}]
        currencies = [{"id": "CT", "name": "Concrete", "supported_networks": [
            {"id": "ethereum", "contract_address": "0x0a092e544da31150b439a1aaa1a3a2214a867f46 "}]}]
        with patch.object(market, "fetch_json", side_effect=[products, currencies]), \
             patch.object(market, "fetch_coinbase_usd_price_map", return_value={"CT-USD": 0.379}):
            row = market.fetch_coinbase()[0]
        self.assertEqual(row["englishName"], "Concrete")
        self.assertEqual(row["contractAddresses"], ["0x0a092e544da31150b439a1aaa1a3a2214a867f46"])


if __name__ == "__main__":
    unittest.main()

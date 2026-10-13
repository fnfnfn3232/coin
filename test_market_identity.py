import copy
import math
import unittest
from unittest.mock import patch

import build_data as market


class MarketIdentityTests(unittest.TestCase):
    def test_ai_and_aigensyn_are_distinct_assets_with_unchanged_exchange_quantities(self):
        native = [
            {"baseAsset": "AI", "quoteAsset": "USDT", "fullName": "Sleepless AI", "price": "0.0201",
             "marketCap": "12507073.5", "circulatingSupply": "624562498", "totalSupply": "1000000000"},
            {"baseAsset": "AIGENSYN", "quoteAsset": "USDT", "fullName": "Gensyn", "price": "0.01978",
             "marketCap": "36438146.7", "circulatingSupply": "1841937443", "totalSupply": "10000000000"},
        ]
        with patch.object(market, "fetch_json", return_value={"data": native}):
            rows, _ = market.fetch_binance()
        sleepless, gensyn = rows
        reference = {"symbol": "AI", "name": "Gensyn", "englishName": "Gensyn", "koreanName": "젠신",
                     "priceUsd": 0.02, "nameKeys": ["gensyn", "젠신"]}
        market.apply_binance_korean_name_fills(rows, [], [reference])
        self.assertEqual(sleepless["name"], "Sleepless AI")
        self.assertEqual(sleepless["circulatingSupply"], 624562498)
        self.assertEqual(sleepless["totalSupply"], 1000000000)
        self.assertEqual(sleepless["marketCapUsd"], 12507073.5)
        self.assertEqual(gensyn["koreanName"], "젠신")
        self.assertEqual(gensyn["circulatingSupply"], 1841937443)
        self.assertEqual(market.get_row_compare_symbol(reference), "AIGENSYN")
        self.assertNotEqual(market.get_row_compare_symbol(reference), market.get_row_compare_symbol(sleepless))

    def test_polluted_korean_name_does_not_override_trusted_sleepless_identity(self):
        row = {"symbol": "AI", "name": "젠신", "koreanName": "젠신", "englishName": "Sleepless AI"}
        self.assertFalse(market.is_gensyn_identity(row))
        market.apply_binance_korean_name_fills([row], [], [])
        self.assertEqual(row["name"], "Sleepless AI")

    def test_ai_futures_use_their_own_exchange_asset_not_the_colliding_symbol(self):
        sleepless = {"symbol": "AI", "name": "Sleepless AI", "englishName": "Sleepless AI", "priceUsd": 0.02,
                     "marketCapUsd": 12500000, "circulatingSupply": 624562498, "totalSupply": 1000000000}
        gensyn = {"symbol": "AI", "name": "Gensyn", "englishName": "Gensyn", "koreanName": "젠신",
                  "priceUsd": 0.02, "marketCapUsd": 36000000, "circulatingSupply": 1841937443, "totalSupply": 10000000000}
        market.apply_gensyn_identity(gensyn)
        groups = [("bithumb", [gensyn]), ("binance", [sleepless]), ("coinbase", [gensyn])]
        rows = [{"exchange": exchange, "symbol": "AI", "name": "AI", "priceUsd": 0.02} for exchange in ("binance", "coinbase")]
        market.apply_futures_underlying_market_data(rows, groups)
        self.assertEqual(rows[0]["englishName"], "Sleepless AI")
        self.assertEqual(rows[0]["marketCapUsd"], 12500000)
        self.assertEqual(rows[1]["englishName"], "Gensyn")
        self.assertEqual(rows[1]["compareSymbol"], "AIGENSYN")
        self.assertEqual(rows[1]["marketCapUsd"], 36000000)

    def test_coinbase_gensyn_uses_official_currency_name_without_fixed_supply(self):
        products = [{"base_currency": "AI", "quote_currency": "USD", "status": "online"}]
        currencies = [{"id": "AI", "name": "Gensyn"}]
        with patch.object(market, "fetch_json", side_effect=[products, currencies]), \
             patch.object(market, "fetch_coinbase_usd_price_map", return_value={"AI-USD": 0.02}):
            row = market.fetch_coinbase()[0]
        self.assertEqual(row["name"], "Gensyn")
        self.assertEqual(row["compareSymbol"], "AIGENSYN")
        self.assertIsNone(row["circulatingSupply"])
        self.assertIsNone(row["totalSupply"])

    def test_coinbase_unknown_ai_is_not_assumed_to_be_gensyn(self):
        products = [{"base_currency": "AI", "quote_currency": "USD", "status": "online"}]
        with patch.object(market, "fetch_json", side_effect=[products, RuntimeError("offline")]), \
             patch.object(market, "fetch_coinbase_usd_price_map", return_value={}):
            row = market.fetch_coinbase()[0]
        self.assertEqual(row["name"], "AI")
        self.assertEqual(row["compareSymbol"], "AI")
        self.assertIsNone(row["totalSupply"])
        wrong = {"symbol": "AI", "name": "Sleepless AI", "englishName": "Sleepless AI", "nameKeys": ["ai", "sleeplessai"],
                 "priceUsd": 0.02, "marketCapUsd": 12500000, "circulatingSupply": 624562498, "totalSupply": 1000000000}
        self.assertIsNone(market.pick_reference_market_candidate(row, [wrong]))
        self.assertIsNone(market.pick_reference_supply_candidate(row, [wrong]))
        future = {"symbol": "AI", "exchange": "coinbase", "name": "AI", "priceUsd": 0.02, "marketCapUsd": None}
        market.apply_futures_underlying_market_data([future], [("coinbase", [row]), ("binance", [wrong])])
        self.assertIsNone(future["marketCapUsd"])

    def test_coin_info_never_merges_the_other_ai_projects_description(self):
        boards = {
            "binance": [{"symbol": "AI", "name": "Sleepless AI", "englishName": "Sleepless AI"}],
            "bithumb": [{"symbol": "AI", "name": "Gensyn", "englishName": "Gensyn", "koreanName": "젠신",
                         "info": {"description": "Gensyn documentation"}}],
        }
        market.apply_binance_korean_name_fills(boards["binance"], [], boards["bithumb"])
        old = {"coinInfo": {"AI": {"englishName": "Sleepless AI", "sources": {"bithumb": {"description": "Wrong old Gensyn description"}}}}}
        info = market.build_coin_info(boards, old)
        self.assertEqual(info["AI"]["englishName"], "Sleepless AI")
        self.assertNotIn("bithumb", info["AI"]["sources"])
        self.assertEqual(info["AIGENSYN"]["sources"]["bithumb"]["description"], "Gensyn documentation")

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

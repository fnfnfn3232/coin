import copy
import unittest

import build_data


class CoinLogoTests(unittest.TestCase):
    def row(self, symbol, name, **extra):
        return {"symbol": symbol, "name": name, "englishName": name,
                "nameKeys": [build_data.normalize_text(name)], "priceUsd": 12, **extra}

    def test_safe_sources_only(self):
        good = "https://static.upbit.com/logos/BTC.png"
        self.assertEqual(build_data.safe_coin_logo_url(good), good)
        for url in [None, "javascript:alert(1)", "data:image/svg+xml,bad", "http://static.upbit.com/a.png",
                    "https://static.upbit.com.evil.example/a.png", "https://evil.example/a.png",
                    "https://user@static.upbit.com/a.png", "https://static.upbit.com:8080/a.png"]:
            self.assertEqual(build_data.safe_coin_logo_url(url), "")

    def test_shared_identity_aliases_and_unchanged_market_values(self):
        btc = self.row("BTC", "Bitcoin")
        future = self.row("1000BTC", "Bitcoin", compareSymbol="BTC")
        boards = {"upbit": [btc], "coinbase": [self.row("BTC", "Bitcoin")]}
        futures = {"binance": [future]}
        before = copy.deepcopy(boards)
        build_data.apply_coin_logos(boards, futures, {})
        for row in [btc, boards["coinbase"][0], future]:
            self.assertEqual(row["logo"], "https://static.upbit.com/logos/BTC.png")
            self.assertEqual(row["priceUsd"], 12)
        for board in boards:
            for index, row in enumerate(boards[board]):
                self.assertEqual({key: value for key, value in row.items() if key != "logo"}, before[board][index])

    def test_ambiguous_symbol_does_not_borrow_another_projects_logo(self):
        symbol = next(iter(build_data.AMBIGUOUS_SYMBOLS_REQUIRE_NAME_OVERLAP))
        existing = self.row(symbol, "Original Project", logo="https://bin.bnbstatic.com/original.png")
        different = self.row(symbol, "Different Project")
        build_data.apply_coin_logos({"binance": [existing], "coinbase": [different]}, {}, {})
        self.assertEqual(different["logo"], "")

    def test_exact_ids_and_missing_sources(self):
        row = self.row("XYZ", "Project", capSourceDetail="coinmarketcap_market_cap:coinmarketcap_quotes:1234")
        missing = self.row("UNKNOWN", "Unknown")
        build_data.apply_coin_logos({"coinbase": [row, missing]}, {}, {})
        self.assertEqual(row["logo"], "https://s2.coinmarketcap.com/static/img/coins/64x64/1234.png")
        self.assertEqual(missing["logo"], "")

    def test_candidate_preserves_verified_image(self):
        candidate = build_data.make_coingecko_market_candidate({"id": "bitcoin", "symbol": "btc",
            "name": "Bitcoin", "image": "https://coin-images.coingecko.com/coins/images/1/small/bitcoin.png"})
        row = self.row("BTC", "Bitcoin")
        build_data.apply_coin_logos({"coinbase": [row]}, {}, {"BTC": [candidate]})
        self.assertEqual(row["logo"], candidate["logo"])


if __name__ == "__main__":
    unittest.main()

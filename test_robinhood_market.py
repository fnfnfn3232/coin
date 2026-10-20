import copy
import unittest
from datetime import datetime, timezone

from robinhood_market import PAIRS_URL, QUOTES_URL, build_robinhood_board, collect_pairs

NOW = 1792480000
PAIR_ID = "3d961844-d360-45fc-989b-f6fca761d511"


def pair(symbol="BTC", name="Bitcoin", pair_id=PAIR_ID, **extra):
    return {"id": pair_id, "symbol": f"{symbol}-USD", "type": "cryptocurrency", "display_only": False,
            "tradability": "tradable", "asset_currency": {"code": symbol, "name": name, "type": "cryptocurrency", "display_only": False},
            "quote_currency": {"code": "USD"}, **extra}


def quote(symbol="BTC", pair_id=PAIR_ID, price="100", now=NOW):
    return {"id": pair_id, "symbol": f"{symbol}USD", "mark_price": price,
            "updated_at": datetime.fromtimestamp(now, timezone.utc).isoformat()}


class RobinhoodTests(unittest.TestCase):
    def run_build(self, pairs=None, quotes=None, boards=None, previous=None):
        urls = []
        def fetch(url):
            urls.append(url)
            return {"results": (pairs if pairs is not None else [pair()]) if url == PAIRS_URL
                    else (quotes if quotes is not None else [quote()])}
        rows, status = build_robinhood_board(fetch, boards or {}, previous, fx=1350, now=NOW)
        return rows, status, urls

    def test_actual_tradable_usd_only_excludes_display_only_other_currencies_and_assets(self):
        pairs = [pair(), pair("WATCH", tradability="untradable"), pair("VIEW", display_only=True),
                 pair("EUR", quote_currency={"code": "EUR"}), pair("STOCK", type="stock"),
                 pair("ASSETVIEW", asset_currency={"code": "ASSETVIEW", "name": "View", "type": "cryptocurrency", "display_only": True})]
        rows, status, urls = self.run_build(pairs=pairs)
        self.assertEqual([row["symbol"] for row in rows], ["BTC"])
        self.assertEqual(rows[0]["priceUsd"], 100)
        self.assertEqual(rows[0]["priceKrw"], 135000)
        self.assertEqual(rows[0]["priceUpdatedAt"], NOW)
        self.assertEqual(status["freshQuotes"], 1)
        self.assertEqual(urls, [PAIRS_URL, QUOTES_URL + PAIR_ID])

    def test_cap_is_verified_external_value_not_recomputed_with_robinhood_quote(self):
        reference = {"symbol": "BTC", "englishName": "Bitcoin", "marketCapUsd": 999,
                     "circulatingSupply": 200, "koreanName": "Bitcoin Korean", "riskFlags": [{"type": "warning"}]}
        rows, _, _ = self.run_build(boards={"binance": [reference]})
        self.assertEqual(rows[0]["marketCapUsd"], 999)
        self.assertEqual(rows[0]["marketReferenceExchange"], "binance")
        self.assertEqual(rows[0]["capSource"], "robinhood_verified_reference")
        self.assertEqual(rows[0]["riskFlags"], [])
        self.assertTrue(rows[0]["marketIdentityVerified"])
        self.assertNotIn("exchange", reference)

    def test_ticker_collision_and_unverified_legacy_caps_do_not_leak(self):
        for reference in ({"symbol": "BTC", "englishName": "Other Bitcoin", "marketCapUsd": 1e20},
                          {"symbol": "BTC", "englishName": "Bitcoin", "marketCapUsd": 1e20, "marketIdentityVerified": False}):
            rows, _, _ = self.run_build(boards={"coinbase": [reference]})
            self.assertIsNone(rows[0]["marketCapUsd"])
            self.assertEqual(rows[0]["capSource"], "robinhood_missing")

    def test_wrong_quote_id_or_symbol_and_old_quotes_never_become_current_prices(self):
        for invalid in (quote(pair_id="wrong"), quote(symbol="OTHER"), quote(price="nan"), quote(now=NOW - 1801)):
            rows, status, _ = self.run_build(quotes=[invalid])
            self.assertIsNone(rows[0]["priceUsd"])
            self.assertIsNone(rows[0]["priceUpdatedAt"])
            self.assertTrue(rows[0]["priceStale"])
            self.assertTrue(status["error"])

    def test_previous_quote_keeps_timestamp_but_never_crosses_changed_pair_id(self):
        old = {"symbol": "BTC", "robinhoodPairId": PAIR_ID, "priceUsd": 80, "priceUpdatedAt": NOW - 1000}
        previous = {"boards": {"robinhood": [old]}}
        rows, status, _ = self.run_build(quotes=[], previous=previous)
        self.assertEqual(rows[0]["priceUsd"], 80)
        self.assertEqual(rows[0]["priceUpdatedAt"], NOW - 1000)
        self.assertTrue(status["error"])
        old["robinhoodPairId"] = "different"
        rows, _, _ = self.run_build(quotes=[], previous=previous)
        self.assertIsNone(rows[0]["priceUsd"])

    def test_listing_failure_and_suspicious_count_drop_preserve_last_good_board(self):
        old = {"symbol": "BTC", "robinhoodPairId": PAIR_ID, "priceUsd": 80}
        previous = {"boards": {"robinhood": [old] * 10}, "robinhoodRefresh": {"lastSuccessAt": NOW - 100}}
        before = copy.deepcopy(previous)
        for loader in (lambda _: (_ for _ in ()).throw(PermissionError("403")), lambda _: {"results": [pair()]}):
            rows, status = build_robinhood_board(loader, {}, previous, now=NOW)
            self.assertEqual(rows, [{**row, "priceStale": True} for row in previous["boards"]["robinhood"]])
            self.assertTrue(status["error"])
            self.assertEqual(status["lastSuccessAt"], NOW - 100)
        self.assertEqual(previous, before)

    def test_pagination_is_bounded_and_never_follows_foreign_urls(self):
        with self.assertRaisesRegex(ValueError, "invalid_next"):
            collect_pairs(lambda _: {"results": [pair()], "next": "https://other.example/currency_pairs/"})
        with self.assertRaisesRegex(ValueError, "pagination_loop"):
            collect_pairs(lambda _: {"results": [], "next": PAIRS_URL})

    def test_more_than_one_batch_and_paginated_pairs_are_fully_collected(self):
        pairs = [pair(f"COIN{i}", f"Coin {i}", f"{i:08x}-d360-45fc-989b-f6fca761d511") for i in range(26)]
        calls = []
        def fetch(url):
            calls.append(url)
            if url == PAIRS_URL:
                return {"results": pairs[:10], "next": PAIRS_URL + "?cursor=next"}
            if url.startswith(PAIRS_URL):
                return {"results": pairs[10:]}
            ids = url.split("=", 1)[1].split(",")
            return {"results": [quote(symbol=item["asset_currency"]["code"], pair_id=item["id"])
                                for item in pairs if item["id"] in ids]}
        rows, status = build_robinhood_board(fetch, {}, now=NOW)
        self.assertEqual(len(rows), 26)
        self.assertEqual(status["freshQuotes"], 26)
        self.assertEqual(len(calls), 4)

    def test_first_list_is_a_baseline_and_later_changes_are_detected(self):
        from build_data import build_changes
        first = {"symbol": "BTC", "pair": "BTC/USD"}
        next_row = {"symbol": "ETH", "pair": "ETH/USD"}
        changes = build_changes({"robinhood": [first]}, {"boards": {"robinhood": []}})
        self.assertEqual(changes["robinhood"]["added"], [])
        changes = build_changes({"robinhood": [first, next_row]}, {"boards": {"robinhood": [first]}})
        self.assertEqual(changes["robinhood"]["added"][0]["symbol"], "ETH")


if __name__ == "__main__":
    unittest.main()

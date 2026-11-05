import unittest
from upbit_wallet_networks import ENDPOINT, PAGE_URL, SOURCE, MAX_AGE, collect_wallet_networks, normalize_wallet_networks
from refresh_health import build_refresh_health


class WalletNetworkTests(unittest.TestCase):
    def row(self, currency="BMT", net_type="SOL", network_name="Solana", **extra):
        return dict(currency=currency, net_type=net_type, network_name=network_name, **extra)

    def test_exact_exchange_tickers_and_multiple_networks_are_preserved(self):
        rows = [self.row(), self.row("NIL", "ETH", "Ethereum"), self.row("UP2", "BASENET", "Base"),
                self.row("USDT", "ETH", "Ethereum"), self.row("USDT", "TRX", "Tron"),
                self.row("USDT", "ETH", "Ethereum")]
        assets = normalize_wallet_networks(rows)
        self.assertEqual(assets["BMT"], [{"netType": "SOL", "name": "Solana"}])
        self.assertEqual(assets["NIL"][0]["name"], "Ethereum")
        self.assertEqual(assets["UP2"][0]["name"], "Base")
        self.assertNotIn("UP", assets)
        self.assertEqual(len(assets["USDT"]), 2)

    def test_suspended_network_is_not_misrepresented_as_another_chain(self):
        assets = normalize_wallet_networks([self.row(wallet_state="paused"), self.row("ETH", "BASE", "Base")])
        self.assertEqual(assets["BMT"][0]["name"], "Solana")
        self.assertNotIn("wallet_state", assets["BMT"][0])

    def test_errors_conflicts_and_absent_network_names_cannot_invent_a_network(self):
        for rows in ({"error": "auth_required"}, [], [self.row(network_name="")],
                     [self.row(), self.row(network_name="Unrelated")], [self.row(currency="BTC/USDT")]):
            with self.assertRaises(ValueError):
                normalize_wallet_networks(rows)

    def test_one_public_fetch_and_independent_checked_time(self):
        calls = []
        value, error = collect_wallet_networks(None, lambda url: calls.append(url) or [self.row()], now=100000)
        self.assertEqual(calls, [ENDPOINT])
        self.assertIsNone(error)
        self.assertEqual(value["checkedAt"], 100000)
        self.assertFalse(value["stale"])
        self.assertEqual(value["sourceUrl"], PAGE_URL)

    def test_failure_preserves_only_verified_recent_cache_without_renewing_time(self):
        previous, _ = collect_wallet_networks(None, lambda _: [self.row()], now=100000)
        def fail(_):
            raise RuntimeError("blocked")
        value, error = collect_wallet_networks({"upbitWalletNetworks": previous}, fail, now=100100)
        self.assertTrue(error)
        self.assertTrue(value["stale"])
        self.assertEqual(value["checkedAt"], 100000)
        self.assertEqual(value["assets"], previous["assets"])
        for old in (None, [], {**previous, "source": "guessed"}, {**previous, "checkedAt": 200000},
                    {**previous, "checkedAt": 1}):
            value, _ = collect_wallet_networks({"upbitWalletNetworks": old}, fail, now=100000 + MAX_AGE)
            self.assertEqual(value["assets"], {})
            self.assertEqual(value["checkedAt"], 0)

    def test_partial_catalog_retains_last_verified_networks_as_stale(self):
        previous, _ = collect_wallet_networks(None, lambda _: [self.row(f"X{i}") for i in range(100)], now=100000)
        value, error = collect_wallet_networks({"upbitWalletNetworks": previous}, lambda _: [self.row()], now=100100)
        self.assertTrue(error)
        self.assertEqual(value["checkedAt"], 100000)
        self.assertEqual(len(value["assets"]), 100)

    def test_refresh_health_records_source_failures(self):
        health = build_refresh_health({"upbitWalletNetworks": {"assets": {"BMT": []}, "stale": False}}, now=100000)
        self.assertEqual(health["components"]["upbit_wallet_networks"]["state"], "healthy")
        broken = build_refresh_health({"upbitWalletNetworks": {"assets": {"BMT": []}, "stale": True},
                                       "refreshIssues": {"upbit_wallet_networks": "wallet_network_refresh_failed"}},
                                      {"refreshHealth": health}, now=100100)
        self.assertEqual(broken["components"]["upbit_wallet_networks"]["state"], "degraded")


if __name__ == "__main__":
    unittest.main()

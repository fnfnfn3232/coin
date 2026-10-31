import unittest
from upbit_asset_names import normalize_asset_names, merge_asset_names, suspicious_catalog_drop


class AssetNameTests(unittest.TestCase):
    def test_partial_catalog_does_not_mass_delist_cached_names(self):
        old = {f'X{i}': {'source': 'upbit_market_all', 'active': True} for i in range(100)}
        self.assertTrue(suspicious_catalog_drop(old, {'BTC': {'active': True}}))
        self.assertFalse(suspicious_catalog_drop({}, {'BTC': {'active': True}}))
        self.assertFalse(suspicious_catalog_drop(old, {f'X{i}': {} for i in range(80)}))

    def test_non_krw_markets_supply_official_korean_names(self):
        names = normalize_asset_names([
            {"market": "BTC-SHELL", "korean_name": "마이쉘", "english_name": "MyShell"},
            {"market": "USDT-SHELL", "korean_name": "마이쉘", "english_name": "MyShell"}])
        self.assertEqual(names['SHELL']['koreanName'], '마이쉘')
        self.assertEqual(len(names['SHELL']['markets']), 2)
        self.assertTrue(names['SHELL']['active'])

    def test_conflicting_official_names_clear_old_names_instead_of_guessing(self):
        old = normalize_asset_names([{"market": "BTC-SHELL", "korean_name": "마이쉘", "english_name": "MyShell"}])
        current = normalize_asset_names([
            {"market": "BTC-SHELL", "korean_name": "마이쉘", "english_name": "MyShell"},
            {"market": "KRW-SHELL", "korean_name": "다른자산", "english_name": "Other Asset"}])
        self.assertIsNone(merge_asset_names(old, current)['SHELL'])

    def test_historical_names_survive_delisting_without_claiming_a_current_listing(self):
        old = normalize_asset_names([{"market": "BTC-SHELL", "korean_name": "마이쉘", "english_name": "MyShell"}])
        fresh = normalize_asset_names([{"market": "KRW-BTC", "korean_name": "비트코인", "english_name": "Bitcoin"}])
        merged = merge_asset_names(old, fresh)
        self.assertEqual(merged['SHELL']['koreanName'], '마이쉘')
        self.assertFalse(merged['SHELL']['active'])
        self.assertTrue(merged['BTC']['active'])
        self.assertTrue(merge_asset_names(old, {})['SHELL']['active'])

    def test_untrusted_aliases_and_invalid_markets_are_not_retained(self):
        self.assertEqual(merge_asset_names({'BAD': {'symbol': 'BAD', 'koreanName': '거짓', 'source': 'guessed'}}, {}), {})
        for source in ([], {}, [{"market": "FUTURES-SHELL", "korean_name": "마이쉘", "english_name": "MyShell"}]):
            with self.assertRaises(ValueError):
                normalize_asset_names(source)


if __name__ == '__main__':
    unittest.main()

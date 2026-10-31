import copy
import unittest
import urllib.parse
from unittest.mock import Mock, patch

import build_data
from upbit_audit_market import SOURCE, SUPPLY_TTL, collect_market_data, issued_supply
from refresh_health import build_refresh_health

NOW = 1793422000


def name(symbol, quotes):
    return {"symbol": symbol, "englishName": symbol, "source": "upbit_market_all", "active": True,
            "markets": [f"{quote}-{symbol}" for quote in quotes]}


def ticker(market, price):
    return {"market": market, "trade_price": price, "timestamp": (NOW - 1) * 1000,
            "trade_timestamp": (NOW - 5) * 1000}


def detail(symbol):
    return {"auditSupply": {"value": 973272894, "field": "circulating_supply", "provider": "coin_market_cap",
                            "baseDate": "2026-09-30"}}


class AuditMarketTests(unittest.TestCase):
    def setUp(self):
        self.names = {"OSMO": name("OSMO", ["BTC"]), "SHELL": name("SHELL", ["USDT"]),
                      "BTC": name("BTC", ["KRW"]), "USDT": name("USDT", ["KRW"])}
        self.tickers = [ticker("BTC-OSMO", .00000064), ticker("KRW-BTC", 103929000),
                        ticker("USDT-SHELL", .04), ticker("KRW-USDT", 1400)]

    def collect(self, *, names=None, previous=None, details=None, loader=detail, prices=None, now=NOW):
        return collect_market_data(self.names if names is None else names, details or {}, previous or {},
                                   loader, lambda url: self.tickers if prices is None else prices, now=now)

    def test_official_issued_quantity_is_not_max_or_circulating_float(self):
        document = {"categories": [{"items": [
            {"key": field, "content": [{"key": "coin_market_cap", "content": value, "baseDate": "2026-09-30"}]}
            for field, value in [("max_supply", "1000000000"), ("current_circulating_supply", "790271529"),
                                  ("circulating_supply", "973272894")]]}]}
        self.assertEqual(issued_supply(document), detail('OSMO')['auditSupply'])
        document['categories'][0]['items'].pop()
        self.assertIsNone(issued_supply(document)['value'], 'max supply must not stand in for issued supply')

    def test_explicit_total_and_provider_fallback(self):
        doc = {"categories": [{"items": [{"key": "total_supply", "content": [
            {"key": "coin_market_cap", "content": "not provided"},
            {"key": "coin_gecko", "content": "1,234", "baseDate": "2026-10-30"}]}]}]}
        self.assertEqual(issued_supply(doc)['value'], 1234)
        self.assertEqual(issued_supply(doc)['provider'], 'coin_gecko')
        for value in [None, True, 0, -1, 'inf', 'nan']:
            doc['categories'][0]['items'][0]['content'][1]['content'] = value
            self.assertIsNone(issued_supply(doc)['value'])

    def test_btc_usdt_conversion_uses_actual_upbit_quote_not_usd_peg(self):
        rows, error = self.collect()
        self.assertFalse(error)
        self.assertAlmostEqual(rows['OSMO']['price']['priceKrw'], 66.51456)
        self.assertEqual(rows['SHELL']['price']['priceKrw'], 56)
        self.assertEqual(rows['OSMO']['price']['conversionMarket'], 'KRW-BTC')
        self.assertEqual(rows['OSMO']['price']['tradeAt'], (NOW - 5) * 1000)
        self.assertEqual(rows['OSMO']['supply']['value'], 973272894)

    def test_krw_preferred_and_unrequested_foreign_or_wrong_asset_ignored(self):
        names = copy.deepcopy(self.names)
        names['OSMO']['markets'] += ['KRW-OSMO', 'USD1-OSMO']
        rows, error = self.collect(names=names, prices=self.tickers + [ticker('KRW-OSMO', 67), ticker('KRW-FAKE', 999)])
        self.assertFalse(error)
        self.assertEqual(rows['OSMO']['price']['market'], 'KRW-OSMO')
        self.assertEqual(rows['OSMO']['price']['priceKrw'], 67)
        self.assertNotIn('FAKE', rows)

    def test_supply_cache_and_reused_details_avoid_extra_detail_calls(self):
        rows, _ = self.collect()
        loader = Mock(side_effect=AssertionError('unnecessary HTTP request'))
        second, error = self.collect(previous=rows, loader=loader, now=NOW + 60)
        self.assertFalse(error)
        self.assertEqual(second['OSMO']['supply']['checkedAt'], NOW)
        self.assertEqual(loader.call_count, 0)
        reused, error = self.collect(details={symbol: detail(symbol) for symbol in self.names}, loader=loader)
        self.assertFalse(error)
        self.assertEqual(reused['OSMO']['supply']['checkedAt'], NOW)
        self.assertEqual(loader.call_count, 0)

    def test_failures_keep_old_values_and_original_times_then_recover(self):
        old, _ = self.collect()
        rows, error = self.collect(previous=old, loader=Mock(side_effect=TimeoutError()), prices=[], now=NOW + SUPPLY_TTL + 1)
        self.assertEqual(error, 'price,supply')
        self.assertEqual(rows['OSMO']['price'], old['OSMO']['price'])
        self.assertEqual(rows['OSMO']['supply'], old['OSMO']['supply'])
        self.assertTrue(rows['OSMO']['priceError'])
        recovered, error = self.collect(previous=rows, now=NOW + SUPPLY_TTL + 61)
        self.assertFalse(error)
        self.assertNotIn('priceError', recovered['OSMO'])
        self.assertGreater(recovered['OSMO']['supply']['checkedAt'], NOW)

    def test_failed_existing_krw_detail_is_not_requested_twice(self):
        old, _ = self.collect()
        loader = Mock(side_effect=AssertionError('cached KRW failure must retry next run, not twice'))
        rows, error = self.collect(previous=old, details={'BTC': {'status': 'missing'}}, loader=loader)
        self.assertEqual(error, 'supply')
        self.assertTrue(rows['BTC']['supplyError'])
        self.assertEqual(loader.call_count, 0)

    def test_missing_bridge_cannot_create_an_approximate_or_fake_krw_price(self):
        rows, error = self.collect(prices=[ticker('BTC-OSMO', .00000064)])
        self.assertIn('price', error)
        self.assertNotIn('price', rows['OSMO'])

    def test_catalog_failure_preserves_cache_as_delayed_not_fresh(self):
        old, _ = self.collect()
        rows, error = self.collect(names={}, previous=old)
        self.assertEqual(error, 'catalog_unavailable')
        self.assertEqual(rows['OSMO']['price']['checkedAt'], NOW)
        self.assertTrue(rows['OSMO']['priceError'])
        names = copy.deepcopy(self.names)
        names['OSMO']['active'] = False
        rows, _ = self.collect(names=names)
        self.assertNotIn('OSMO', rows)

    def test_invalid_or_future_quotes_are_rejected(self):
        for bad in [ticker('BTC-OSMO', 0), ticker('BTC-OSMO', True),
                    {**ticker('BTC-OSMO', 1), 'timestamp': (NOW + 1000) * 1000}]:
            rows, error = self.collect(prices=[bad, ticker('KRW-BTC', 103929000)])
            self.assertIn('price', error)
            self.assertNotIn('price', rows['OSMO'])

    def test_bulk_ticker_requests_are_bounded_and_supply_identity_not_guessed(self):
        names = {f'X{i}': name(f'X{i}', ['KRW']) for i in range(185)}
        calls = []
        def prices(url):
            markets = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['markets'][0].split(',')
            calls.append(markets)
            return [ticker(market, 1) for market in markets]
        rows, error = collect_market_data(names, {}, {}, detail, prices, now=NOW)
        self.assertFalse(error)
        self.assertEqual(len(rows), 185)
        self.assertEqual([len(call) for call in calls], [80, 80, 25])
        old, _ = self.collect()
        old['OSMO']['englishName'] = 'Different Project'
        rows, _ = self.collect(previous=old, loader=Mock(side_effect=TimeoutError()), prices=[])
        self.assertNotIn('price', rows['OSMO'])
        self.assertIsNone(rows['OSMO']['supply'].get('value'))

    def test_detail_wrong_currency_is_rejected_before_financial_use(self):
        with patch.object(build_data, 'fetch_json', return_value={'currency': 'OTHER', 'document': {'categories': [{}]}}):
            with self.assertRaises(ValueError):
                build_data.fetch_upbit_details('OSMO')

    def test_health_records_missing_market_data_and_recovery(self):
        payload = {'upbitAuditMarket': {'OSMO': {'source': SOURCE}}, 'refreshIssues': {'upbit_audit_market': 'price'}}
        bad = build_refresh_health(payload, now=NOW)
        self.assertEqual(bad['components']['upbit_audit_market']['state'], 'degraded')
        payload['refreshIssues'] = {}
        good = build_refresh_health(payload, {'refreshHealth': bad}, now=NOW + 60)
        self.assertTrue(any(event['component'] == 'upbit_audit_market' and event['kind'] == 'recovered' for event in good['events']))


if __name__ == '__main__':
    unittest.main()

import copy
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import build_data as market
from refresh_health import ProviderCoolingDown, build_refresh_health, call_notice_provider, incident_report


class RefreshHealthTests(unittest.TestCase):
    def snapshot(self):
        return {"generatedAt": 10000, "boards": {name: [{}] for name in ('upbit', 'bithumb', 'binance', 'coinbase')},
                "futures": {name: [{}] for name in ('binance', 'coinbase')},
                "noticeRefresh": {name: {"checkedAt": 10000} for name in ('upbit', 'bithumb', 'binance')},
                "defillamaRankings": {"categories": {"tvl": [{}]}}, "refreshIssues": {}}

    def test_403_opens_circuit_and_does_not_hammer_until_retry_time(self):
        states = {}
        loader = Mock(side_effect=HTTPError('https://official.example', 403, 'Forbidden', {}, None))
        with self.assertRaises(HTTPError):
            call_notice_provider('official', loader, states, now=10000)
        self.assertEqual(states['official']['nextRetryAt'], 11800)
        with self.assertRaises(ProviderCoolingDown):
            call_notice_provider('official', loader, states, now=10010)
        self.assertEqual(loader.call_count, 1)
        self.assertEqual(states['official']['consecutiveFailures'], 1)

    def test_recovered_provider_is_probed_and_automatically_closes_circuit(self):
        states = {'official': {'consecutiveFailures': 2, 'nextRetryAt': 10000}}
        self.assertEqual(call_notice_provider('official', lambda: 'fresh', states, now=10000), 'fresh')
        self.assertEqual(states['official'], {'lastSuccessAt': 10000, 'consecutiveFailures': 0, 'nextRetryAt': 0})

    def test_429_respects_bounded_retry_after(self):
        states = {}
        def load():
            raise HTTPError('official', 429, 'Rate limited', {'Retry-After': '900'}, None)
        with self.assertRaises(HTTPError):
            call_notice_provider('official', load, states, now=10000)
        self.assertEqual(states['official']['nextRetryAt'], 10900)

    def test_repeated_failures_have_bounded_exponential_delay(self):
        states = {'official': {'consecutiveFailures': 19}}
        with self.assertRaises(TimeoutError):
            call_notice_provider('official', Mock(side_effect=TimeoutError()), states, now=10000)
        self.assertEqual(states['official']['nextRetryAt'], 13600)
        self.assertEqual(states['official']['consecutiveFailures'], 20)

    def test_fallback_success_does_not_hide_per_source_failures_and_survives_next_run(self):
        notice = {'title': '[거래] 소폰(SOPH) 거래지원 종료 (11/16 15:00)', 'uuid': '1383330097', 'listed_at': '2026-10-15T07:00:00+00:00', 'channel': True}
        with patch.object(market, 'NOTICE_REFRESH_STATUS', {}), \
             patch.object(market, 'ACTIVE_SCHEDULED_DELISTINGS', {}), \
             patch.object(market, 'fetch_json', side_effect=HTTPError('official', 403, 'Forbidden', {}, None)) as fetch, \
             patch.object(market, 'fetch_upbit_official_channel_notices', side_effect=lambda: ([notice], {'source': market.UPBIT_OFFICIAL_CHANNEL_URL, 'checkedAt': 10000})), \
             patch.object(market, 'fetch_bithumb_scheduled_delistings', return_value={}), \
             patch.object(market, 'fetch_binance_scheduled_delistings', return_value={}):
            issues = {}
            market.refresh_scheduled_delistings(None, issues)
            previous = {'noticeRefresh': copy.deepcopy(market.NOTICE_REFRESH_STATUS), 'scheduledDelistings': copy.deepcopy(market.ACTIVE_SCHEDULED_DELISTINGS)}
            self.assertEqual(fetch.call_count, 2)
            market.refresh_scheduled_delistings(previous, issues)
            self.assertEqual(fetch.call_count, 2, 'blocked endpoints remain on cooldown across independent builds')
            self.assertNotIn('upbit_notices', issues)
            self.assertIn('SOPH', market.ACTIVE_SCHEDULED_DELISTINGS['upbit'])

    def test_all_sources_down_preserve_health_state_and_known_data(self):
        with patch.object(market, 'NOTICE_REFRESH_STATUS', {}), \
             patch.object(market, 'ACTIVE_SCHEDULED_DELISTINGS', {}), \
             patch.object(market, 'fetch_json', side_effect=TimeoutError()), \
             patch.object(market, 'fetch_notice_channel_html', side_effect=TimeoutError()), \
             patch.object(market, 'fetch_bithumb_scheduled_delistings', return_value={}), \
             patch.object(market, 'fetch_binance_scheduled_delistings', return_value={}):
            previous = {'scheduledDelistings': {'upbit': {'SOPH': {'expires': '2099-01-01'}}}}
            issues = {}
            market.refresh_scheduled_delistings(previous, issues)
            self.assertIn('upbit_notices', issues)
            self.assertEqual(len(market.NOTICE_REFRESH_STATUS['upbit']['providers']), 3)
            self.assertIn('SOPH', market.ACTIVE_SCHEDULED_DELISTINGS['upbit'])

    def test_old_200_feed_does_not_erase_a_newer_verified_announcement(self):
        fresh = {'title': '소폰(SOPH) 거래지원 종료 (11/16 15:00)', 'uuid': '1383330097', 'listed_at': '2026-10-15T07:00:00+00:00'}
        old = {**fresh, 'listed_at': '2026-09-01T07:00:00+00:00'}
        def load(url, **kwargs):
            return {'data': {'notices': [old if url.startswith(market.UPBIT_ANNOUNCEMENTS_ENDPOINT) else fresh] if 'page=1&' in url else []}}
        with patch.object(market, 'NOTICE_REFRESH_STATUS', {'upbit': {'latestPublishedAt': fresh['listed_at']}}), \
             patch.object(market, 'fetch_json', side_effect=load):
            result = market.fetch_upbit_scheduled_delistings()
            status = copy.deepcopy(market.NOTICE_REFRESH_STATUS['upbit'])
        self.assertIn('SOPH', result)
        self.assertEqual(status['source'], market.UPBIT_ANNOUNCEMENTS_BACKUP_ENDPOINT)
        self.assertEqual(status['providers'][market.UPBIT_ANNOUNCEMENTS_ENDPOINT]['consecutiveFailures'], 1)

    def test_malformed_200_response_is_a_failure_not_success(self):
        for fetcher in (market.fetch_bithumb_scheduled_delistings, market.fetch_binance_scheduled_delistings):
            for data in ({}, [], [{}], {'articles': [{}]}):
                with patch.object(market, 'fetch_json', return_value={'data': data}), self.assertRaises(ValueError):
                    fetcher()

    def test_success_stamps_real_component_freshness(self):
        health = build_refresh_health(self.snapshot(), now=10000)
        self.assertEqual(health['state'], 'healthy')
        self.assertEqual(health['components']['upbit_notices']['lastSuccessAt'], 10000)

    def test_new_snapshot_timestamp_does_not_make_cached_component_fresh(self):
        payload = self.snapshot()
        previous = {'refreshHealth': build_refresh_health(payload, now=10000)}
        payload['generatedAt'] = 11000
        payload['refreshIssues']['upbit'] = 'fallback_previous_payload:403'
        health = build_refresh_health(payload, previous, now=11000)
        self.assertEqual(health['components']['upbit']['lastSuccessAt'], 10000)
        self.assertEqual(health['components']['upbit']['state'], 'degraded')
        self.assertFalse(health['needsAttention'])

    def test_three_failures_escalate_and_recovery_clears_failure_history(self):
        payload = self.snapshot()
        payload['refreshIssues']['upbit_notices'] = 'blocked'
        previous = None
        for now in (10000, 10300, 10600):
            health = build_refresh_health(payload, previous, now=now)
            previous = {'refreshHealth': health}
        self.assertTrue(health['components']['upbit_notices']['needsAttention'])
        self.assertEqual(health['components']['upbit_notices']['firstFailureAt'], 10000)
        payload['refreshIssues'].clear()
        recovered = build_refresh_health(payload, previous, now=11000)
        self.assertEqual(recovered['state'], 'healthy')
        self.assertEqual(recovered['components']['upbit_notices']['consecutiveFailures'], 0)

    def test_thirty_minute_failure_escalates_even_if_scheduler_skips_runs(self):
        payload = self.snapshot()
        payload['refreshIssues']['bithumb'] = 'offline'
        previous = {'refreshHealth': build_refresh_health(payload, now=10000)}
        health = build_refresh_health(payload, previous, now=11801)
        self.assertTrue(health['components']['bithumb']['needsAttention'])

    def test_expected_browser_direct_bybit_fallback_is_not_a_false_server_incident(self):
        payload = self.snapshot()
        payload['refreshIssues']['bybit_futures'] = 'runner 403; browser direct available'
        self.assertEqual(build_refresh_health(payload, now=10000)['state'], 'healthy')

    def test_incident_report_never_exports_quotes_or_raw_errors(self):
        payload = self.snapshot()
        payload['refreshHealth'] = build_refresh_health(payload, now=10000)
        self.assertEqual(incident_report(payload, now=10000), {'state': 'healthy', 'affected': [], 'pending': []})
        for now in (12000, 9000):
            with self.assertRaises(ValueError):
                incident_report(payload, now=now)
        payload.pop('refreshHealth')
        with self.assertRaises(ValueError):
            incident_report(payload, now=10000)


if __name__ == '__main__':
    unittest.main()

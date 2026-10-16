import copy
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import build_data as market
from refresh_health import HISTORY_MAX_EVENTS, HISTORY_RETENTION_SECONDS, ProviderCoolingDown, build_refresh_health, call_notice_provider, incident_report


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

    def test_history_records_failure_once_and_recovery_only_after_success(self):
        payload = self.snapshot()
        baseline = {'refreshHealth': build_refresh_health(payload, now=10000)}
        self.assertEqual(baseline['refreshHealth']['events'], [])
        payload['refreshIssues']['upbit_notices'] = 'HTTP Error 403: Forbidden'
        failure = build_refresh_health(payload, baseline, now=10300)
        self.assertEqual([event['kind'] for event in failure['events']], ['failure'])
        retry = build_refresh_health(payload, {'refreshHealth': failure}, now=10600)
        self.assertEqual(retry['events'], failure['events'])
        payload['refreshIssues'].clear()
        recovered = build_refresh_health(payload, {'refreshHealth': retry}, now=10900)
        self.assertEqual([event['kind'] for event in recovered['events']], ['recovered', 'failure'])
        self.assertEqual(recovered['events'][0]['durationSeconds'], 600)
        stable = build_refresh_health(payload, {'refreshHealth': recovered}, now=11200)
        self.assertEqual(stable['events'], recovered['events'])

    def test_existing_degraded_state_is_imported_without_fake_past_repair(self):
        payload = self.snapshot()
        payload['refreshIssues']['coinbase_futures'] = 'upstream failure'
        old = build_refresh_health(payload, now=10000)
        old.pop('events')
        old.pop('historyStartedAt')
        current = build_refresh_health(payload, {'refreshHealth': old}, now=10600)
        self.assertIn({'id': '10000:coinbase_futures:failure', 'kind': 'failure', 'component': 'coinbase_futures', 'at': 10000}, current['events'])
        self.assertNotIn('recovered', [event['kind'] for event in current['events']])

    def test_fallback_baseline_and_actual_source_switch_are_distinct(self):
        payload = self.snapshot()
        payload['noticeRefresh']['upbit']['source'] = market.UPBIT_OFFICIAL_CHANNEL_URL
        initial = build_refresh_health(payload, now=10000)
        self.assertEqual(initial['events'][0]['kind'], 'fallback_active')
        previous = {'refreshHealth': initial, 'noticeRefresh': copy.deepcopy(payload['noticeRefresh'])}
        stable = build_refresh_health(payload, previous, now=10300)
        self.assertEqual(stable['events'], initial['events'])
        payload['noticeRefresh']['upbit']['source'] = market.UPBIT_ANNOUNCEMENTS_ENDPOINT
        restored = build_refresh_health(payload, previous, now=10600)
        self.assertEqual(restored['events'][0]['kind'], 'source_changed')
        previous = {'refreshHealth': restored, 'noticeRefresh': copy.deepcopy(payload['noticeRefresh'])}
        payload['noticeRefresh']['upbit']['source'] = market.UPBIT_OFFICIAL_CHANNEL_URL
        switched = build_refresh_health(payload, previous, now=10900)
        self.assertEqual(switched['events'][0]['kind'], 'fallback')

    def test_pending_fallback_does_not_claim_successful_route_switch(self):
        payload = self.snapshot()
        payload['noticeRefresh']['upbit'].update({'source': market.UPBIT_OFFICIAL_CHANNEL_URL, 'error': 'partial page failure'})
        health = build_refresh_health(payload, now=10000)
        self.assertEqual([event['kind'] for event in health['events']], ['failure'])

    def test_attention_is_logged_only_on_escalation(self):
        payload = self.snapshot()
        payload['refreshIssues']['bithumb'] = 'offline'
        previous = None
        for now in (10000, 10300, 10600, 10900):
            health = build_refresh_health(payload, previous, now=now)
            previous = {'refreshHealth': health}
        self.assertEqual([event['kind'] for event in health['events']], ['attention', 'failure'])

    def test_republishing_after_long_gap_is_not_invented_component_recovery(self):
        payload = self.snapshot()
        previous = {'generatedAt': 10000, 'refreshHealth': build_refresh_health(payload, now=10000)}
        health = build_refresh_health(payload, previous, now=12000)
        self.assertEqual([event['kind'] for event in health['events']], ['pipeline_resumed'])
        self.assertEqual(health['events'][0]['gapSeconds'], 2000)

    def test_history_is_bounded_retained_and_does_not_export_raw_errors(self):
        now = 20000000
        events = [{'at': now - index, 'component': 'upbit', 'kind': 'recovered', 'rawError': 'private'} for index in range(250)]
        events += [{'at': now - HISTORY_RETENTION_SECONDS - 1, 'component': 'upbit', 'kind': 'failure'},
                   {'at': now + 1, 'component': 'upbit', 'kind': 'failure'},
                   {'at': now, 'component': 'unknown', 'kind': 'failure'}]
        health = build_refresh_health(self.snapshot(), {'refreshHealth': {'historyStartedAt': now - 500, 'events': events}}, now=now)
        self.assertEqual(len(health['events']), HISTORY_MAX_EVENTS)
        self.assertNotIn('rawError', str(health['events']))
        self.assertEqual(health['events'][0]['at'], now)
        again = build_refresh_health(self.snapshot(), {'refreshHealth': health}, now=now + 1)
        self.assertEqual(again['events'], health['events'])

    def test_maintenance_has_verified_commit_shape_and_is_distinct_from_automatic_repair(self):
        entry = {'kind': 'maintenance', 'component': 'pipeline', 'at': 9900, 'commit': 'a' * 40, 'title': '개발 수정', 'detail': '검증된 코드 변경'}
        health = build_refresh_health(self.snapshot(), now=10000, maintenance=[entry, {**entry, 'commit': 'https://bad.example'}])
        self.assertEqual(len(health['events']), 1)
        self.assertEqual(health['events'][0]['kind'], 'maintenance')
        self.assertEqual(health['events'][0]['commit'], 'a' * 40)
        second = build_refresh_health(self.snapshot(), {'refreshHealth': health}, now=10300, maintenance=[entry])
        self.assertEqual(second['events'], health['events'])

    def test_maintenance_file_contains_only_valid_nonfuture_commit_entries(self):
        import json
        entries = json.loads((Path(__file__).parent / '.github' / 'maintenance_history.json').read_text(encoding='utf-8'))
        now = max(entry['at'] for entry in entries) + 1
        health = build_refresh_health(self.snapshot(), now=now, maintenance=entries)
        self.assertEqual(sum(event['kind'] == 'maintenance' for event in health['events']), len(entries))
        self.assertTrue(all(len(event['commit']) == 40 for event in health['events']))


if __name__ == '__main__':
    unittest.main()

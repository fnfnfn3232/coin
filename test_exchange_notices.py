import copy
import unittest
import urllib.parse
from datetime import datetime
from unittest.mock import patch

import build_data as market


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 17, 12, tzinfo=market.SEOUL_TIMEZONE).astimezone(tz) if tz else cls(2026, 10, 17, 12)


class ExchangeNoticeTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        patch.object(market, "datetime", FrozenDatetime).start()
        patch.object(market, "ACTIVE_SCHEDULED_DELISTINGS", {}).start()
        patch.object(market, "NOTICE_REFRESH_STATUS", {}).start()
        self.soph = {"id": 6662, "uuid": "1383330097", "listed_at": "2026-10-15T16:00:00+09:00",
                     "title": "소폰(SOPH) 거래지원 종료 안내 (11/16 15:00)"}
        self.blast = {"id": 6658, "uuid": "81183086", "listed_at": "2026-10-14T16:00:41+09:00",
                      "title": "블라스트(BLAST) 거래지원 종료 및 네트워크 전환에 따른 출금 일시 중단 안내"}

    def feed(self, url, **_kwargs):
        parsed = urllib.parse.urlsplit(url)
        if parsed.path.endswith('/6658'):
            return {"success": True, "data": {"body": "출금 중단 일정 : 2026-10-19\n거래지원 종료 예정일 : **2026-10-26(월) 12:00 KST**"}}
        page = int(urllib.parse.parse_qs(parsed.query).get('page', ['1'])[0])
        return {"success": True, "data": {"notices": [self.soph, self.blast] if page == 1 else []}}

    def refresh(self, previous=None):
        with patch.object(market, 'fetch_bithumb_scheduled_delistings', return_value={}), \
             patch.object(market, 'fetch_binance_scheduled_delistings', return_value={}):
            issues = {}
            market.refresh_scheduled_delistings(previous, issues)
            return issues

    def test_blast_body_deadline_is_not_the_withdrawal_or_network_change_date(self):
        with patch.object(market, 'fetch_json', side_effect=self.feed):
            scheduled = market.fetch_upbit_scheduled_delistings()
        self.assertEqual(scheduled['BLAST']['deadline'], '2026-10-26')
        self.assertEqual(scheduled['SOPH']['deadline'], '2026-11-16')
        self.assertIn('81183086', scheduled['BLAST']['url'])

    def test_malformed_primary_feed_uses_official_backup_instead_of_silent_success(self):
        def fetch(url, **kwargs):
            if url.startswith(market.UPBIT_ANNOUNCEMENTS_ENDPOINT):
                return {"success": True, "data": {"renamed_notices": []}}
            return self.feed(url, **kwargs)
        with patch.object(market, 'fetch_json', side_effect=fetch):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertIn('SOPH', result)
        self.assertEqual(market.NOTICE_REFRESH_STATUS['upbit']['source'], market.UPBIT_ANNOUNCEMENTS_BACKUP_ENDPOINT)
        self.assertTrue(market.NOTICE_REFRESH_STATUS['upbit']['feedErrors'])

    def test_newer_backup_feed_is_not_hidden_by_a_valid_but_old_primary_feed(self):
        def fetch(url, **kwargs):
            if url.startswith(market.UPBIT_ANNOUNCEMENTS_ENDPOINT) and 'page=1&' in url:
                return {"data": {"notices": [{"title": "예전 공지", "listed_at": "2026-09-01T00:00:00+09:00"}]}}
            return self.feed(url, **kwargs)
        with patch.object(market, 'fetch_json', side_effect=fetch):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertIn('BLAST', result)
        self.assertEqual(market.NOTICE_REFRESH_STATUS['upbit']['source'], market.UPBIT_ANNOUNCEMENTS_BACKUP_ENDPOINT)

    def test_feed_outage_is_recorded_and_preserves_known_termination(self):
        previous = {"scheduledDelistings": {"upbit": {'SOPH': {'deadline': '2026-11-16', 'detail': 'Known termination'}}}}
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('offline')):
            issues = self.refresh(previous)
        self.assertIn('upbit_notices', issues)
        self.assertIn('error', market.NOTICE_REFRESH_STATUS['upbit'])
        self.assertEqual(market.scheduled_delisting_flags('upbit', 'SOPH')[0]['type'], 'delisting')

    def test_newer_cancellation_cannot_be_overwritten_by_an_older_closing_notice(self):
        cancel = {**self.soph, 'id': 6670, 'listed_at': '2026-10-16T16:00:00+09:00', 'title': '소폰(SOPH) 거래지원 종료 취소 안내'}
        original = self.feed
        def fetch(url, **kwargs):
            result = original(url, **kwargs)
            if 'page=1&' in url:
                result['data']['notices'] = [self.soph, cancel]
            return result
        previous = {'scheduledDelistings': {'upbit': {'SOPH': {'deadline': '2026-11-16'}}}}
        with patch.object(market, 'fetch_json', side_effect=fetch):
            self.refresh(previous)
        self.assertNotIn('SOPH', market.ACTIVE_SCHEDULED_DELISTINGS['upbit'])
        rows = {'upbit': [{'symbol': 'SOPH', 'riskFlags': [{'type': 'delisting', 'source': 'upbit_official_notice'}]}]}
        market.apply_scheduled_delisting_flags(rows)
        self.assertEqual(rows['upbit'][0]['riskFlags'], [])

    def test_newest_closing_notice_wins_even_if_an_older_cancellation_is_present(self):
        cancel = {**self.soph, 'listed_at': '2026-10-01T16:00:00+09:00', 'title': '소폰(SOPH) 거래지원 종료 취소 안내'}
        original = self.feed
        def fetch(url, **kwargs):
            result = original(url, **kwargs)
            if 'page=1&' in url:
                result['data']['notices'].append(cancel)
            return result
        with patch.object(market, 'fetch_json', side_effect=fetch):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertEqual(result['SOPH']['deadline'], '2026-11-16')

    def test_cached_warning_rows_are_updated_for_all_exchanges_without_changing_quotes(self):
        market.ACTIVE_SCHEDULED_DELISTINGS.update({exchange: {'SOPH': {'deadline': '2026-11-16', 'detail': 'Termination'}}
                                                 for exchange in ['upbit', 'bithumb', 'binance', 'coinbase']})
        boards = {exchange: [{'symbol': 'SOPH', 'priceUsd': 0.002, 'marketCapUsd': 100, 'riskFlags': [{'type': 'warning'}]}]
                  for exchange in market.ACTIVE_SCHEDULED_DELISTINGS}
        original = copy.deepcopy(boards)
        market.apply_scheduled_delisting_flags(boards)
        market.validate_scheduled_delisting_flags({'boards': boards, 'scheduledDelistings': market.ACTIVE_SCHEDULED_DELISTINGS})
        for exchange, rows in boards.items():
            self.assertEqual(rows[0]['riskFlags'][0]['type'], 'delisting')
            self.assertEqual(rows[0]['priceUsd'], original[exchange][0]['priceUsd'])
            self.assertEqual(rows[0]['marketCapUsd'], original[exchange][0]['marketCapUsd'])

    def test_partial_pagination_failure_keeps_newly_discovered_termination_and_reports_it(self):
        def fetch(url, **kwargs):
            if 'page=2&' in url:
                raise RuntimeError('page_offline')
            return self.feed(url, **kwargs)
        with patch.object(market, 'fetch_json', side_effect=fetch):
            issues = self.refresh()
        self.assertIn('SOPH', market.ACTIVE_SCHEDULED_DELISTINGS['upbit'])
        self.assertIn('partial_page_2', issues['upbit_notices'])

    def test_withdrawal_cancellation_does_not_cancel_the_trading_termination(self):
        self.blast['title'] += ' (출금 중단 취소)'
        with patch.object(market, 'fetch_json', side_effect=self.feed):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertEqual(result['BLAST']['deadline'], '2026-10-26')


if __name__ == '__main__':
    unittest.main()

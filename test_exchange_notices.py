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
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('offline')), \
             patch.object(market, 'fetch_notice_channel_html', side_effect=RuntimeError('offline')):
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

    def channel_post(self, title, notice_id='1383330097', published='2026-10-15T07:00:00+00:00', host='www.upbit.com'):
        return (f'<div class="tgme_widget_message" data-post="upbit_news/1942"><div class="nested">'
                f'<div class="tgme_widget_message_text">{title}<br/>'
                f'<a href="https://{host}/service_center/notice?id={notice_id}&amp;amp;view=share"><b>공지사항</b></a></div>'
                f'<time datetime="{published}">07:00</time></div></div>')

    def test_official_channel_handles_api_403_and_keeps_termination_dates_when_present(self):
        document = self.channel_post('[거래] ' + self.soph['title']) + self.channel_post('[거래] ' + self.blast['title'], '81183086')
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('HTTP Error 403: Forbidden')), \
             patch.object(market, 'fetch_notice_channel_html', return_value=document):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertEqual(result['SOPH']['deadline'], '2026-11-16')
        self.assertEqual(result['BLAST']['deadline'], '')
        self.assertEqual(result['BLAST']['expires'], '2026-11-29')
        self.assertIn('81183086', result['BLAST']['url'])
        self.assertEqual(market.NOTICE_REFRESH_STATUS['upbit']['source'], market.UPBIT_OFFICIAL_CHANNEL_URL)
        self.assertNotIn('error', market.NOTICE_REFRESH_STATUS['upbit'])

    def test_channel_ignores_nft_notices_unofficial_links_and_missing_dates(self):
        document = (self.channel_post('[NFT] 컬렉션(ABSIO) 거래지원 종료 안내')
                    + self.channel_post('[거래] 소폰(SOPH) 거래지원 종료 안내', host='www.upbit.com.evil.example')
                    + self.channel_post('[거래] 블라스트(BLAST) 거래지원 종료 안내', published='invalid')
                    + self.channel_post('[거래] 질리카(ZIL) 거래지원 종료 안내 (11/16 15:00)', '1529230200'))
        parser = market.UpbitOfficialChannelParser()
        parser.feed(document)
        self.assertEqual(len(parser.notices), 1)
        self.assertIn('ZIL', parser.notices[0]['title'])

    def test_channel_newest_cancellation_wins_regardless_of_message_order(self):
        document = (self.channel_post('[거래] ' + self.soph['title'])
                    + self.channel_post('[거래] 소폰(SOPH) 거래지원 종료 철회 안내', '9999', '2026-10-16T07:00:00+00:00'))
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('blocked')), \
             patch.object(market, 'fetch_notice_channel_html', return_value=document):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertTrue(result['SOPH']['cancelled'])

    def test_channel_paginates_and_preserves_first_page_on_partial_failure(self):
        document = self.channel_post('[거래] ' + self.soph['title']) + '<a class="tme_messages_more" data-before="1942"></a>'
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('blocked')), \
             patch.object(market, 'fetch_notice_channel_html', side_effect=[document, RuntimeError('offline')]) as fetch:
            issues = self.refresh()
        self.assertEqual(fetch.call_args.args[0], market.UPBIT_OFFICIAL_CHANNEL_URL + '?before=1942')
        self.assertIn('SOPH', market.ACTIVE_SCHEDULED_DELISTINGS['upbit'])
        self.assertIn('partial_channel_page_2', issues['upbit_notices'])

    def test_channel_stops_pagination_at_retention_window(self):
        document = (self.channel_post('[거래] ' + self.soph['title'], published='2026-08-01T07:00:00+00:00')
                    + '<a class="tme_messages_more" data-before="1000"></a>')
        with patch.object(market, 'fetch_notice_channel_html', return_value=document) as fetch:
            market.fetch_upbit_official_channel_notices()
        self.assertEqual(fetch.call_count, 1)

    def test_invalid_channel_page_is_not_reported_as_success(self):
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('blocked')), \
             patch.object(market, 'fetch_notice_channel_html', return_value='<html>Access denied</html>'):
            issues = self.refresh()
        self.assertIn('upbit_notices', issues)

    def test_channel_does_not_erase_a_previously_verified_deadline_for_the_same_notice(self):
        url = 'https://www.upbit.com/service_center/notice?id=81183086&view=share'
        previous = {'scheduledDelistings': {'upbit': {'BLAST': {'deadline': '2026-10-26', 'url': url}}}}
        with patch.object(market, 'fetch_json', side_effect=RuntimeError('blocked')), \
             patch.object(market, 'fetch_notice_channel_html', return_value=self.channel_post('[거래] ' + self.blast['title'], '81183086')):
            self.refresh(previous)
        self.assertEqual(market.ACTIVE_SCHEDULED_DELISTINGS['upbit']['BLAST']['deadline'], '2026-10-26')

    def test_mixed_notice_only_terminates_the_asset_in_the_termination_clause(self):
        title = '만트라(MANTRA) 거래유의종목 지정 연장, 질리카(ZIL) 거래지원 종료'
        self.assertEqual(market.extract_delisting_symbols(title), ['ZIL'])
        self.assertEqual(market.extract_delisting_symbols('아지트(AZIT), 쿠디스(CUDIS), 템코(TEMCO) 거래지원 종료'), ['AZIT', 'CUDIS', 'TEMCO'])
        self.assertEqual(market.extract_delisting_symbols(self.blast['title']), ['BLAST'])
        self.assertEqual(market.extract_delisting_symbols('거래지원 종료 안내 (STORJ, JASMY)'), ['STORJ', 'JASMY'])
        self.assertEqual(market.extract_delisting_symbols('달오픈네트워크(D), 훅트프로토콜(HOOK) 거래지원 종료'), ['D', 'HOOK'])
        payload = {'data': [{'title': title, 'categoryName1': '거래지원종료', 'publicationDateTime': '2026-10-16T16:30:00+09:00'}]}
        with patch.object(market, 'fetch_json', return_value=payload):
            result = market.fetch_bithumb_scheduled_delistings()
        self.assertTrue(result['MANTRA']['cancelled'])
        self.assertIn('ZIL', result)

    def test_mixed_upbit_notice_does_not_reuse_older_wrong_termination(self):
        self.soph['title'] = '만트라(MANTRA) 거래 유의 종목 지정 연장 및 소폰(SOPH) 거래지원 종료 (11/16 15:00)'
        with patch.object(market, 'fetch_json', side_effect=self.feed):
            result = market.fetch_upbit_scheduled_delistings()
        self.assertTrue(result['MANTRA']['cancelled'])
        self.assertEqual(result['SOPH']['deadline'], '2026-11-16')

    def test_mixed_bithumb_notice_clears_previous_misclassification_even_with_older_notice(self):
        payload = {'data': [
            {'title': '만트라(MANTRA) 거래지원 종료', 'categoryName1': '거래지원종료', 'publicationDateTime': '2026-10-01T10:00:00+09:00'},
            {'title': '만트라(MANTRA) 거래유의종목 지정 연장, 질리카(ZIL) 거래지원 종료', 'categoryName1': '거래지원종료', 'publicationDateTime': '2026-10-16T16:00:00+09:00'}]}
        with patch.object(market, 'fetch_json', return_value=payload), \
             patch.object(market, 'fetch_upbit_scheduled_delistings', return_value={}), \
             patch.object(market, 'fetch_binance_scheduled_delistings', return_value={}):
            issues = {}
            market.refresh_scheduled_delistings({'scheduledDelistings': {'bithumb': {'MANTRA': {'expires': '2026-11-01'}}}}, issues)
        self.assertNotIn('MANTRA', market.ACTIVE_SCHEDULED_DELISTINGS['bithumb'])
        self.assertIn('ZIL', market.ACTIVE_SCHEDULED_DELISTINGS['bithumb'])


if __name__ == '__main__':
    unittest.main()

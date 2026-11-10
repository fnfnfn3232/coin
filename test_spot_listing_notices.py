import unittest
from datetime import datetime, timezone

from spot_listing_notices import (
    BITGET_LABELS, BITGET_SYMBOLS, NoticeBlocks, bitget_ends, bitget_special_treatment,
    collect_listing_notices, parse_bithumb_listing, parse_bybit_delisting, parse_bybit_listing,
    parse_upbit_listing, upbit_dates, UPBIT, UPBIT_BACKUP,
)


class SpotListingNoticeTests(unittest.TestCase):
    def test_bybit_listing_does_not_use_deposit_date(self):
        lines = NoticeBlocks("<p>New Spot Trading Pairs: KOR/USDT</p>"
                             "<p>KOR Deposits: Nov 3, 2026, 10:00AM UTC</p>"
                             "<p>KOR Listing: Nov 4, 2026, 4:00PM UTC</p>").blocks
        title = "Bybit to List KOR Protocol (KOR) on Spot"
        self.assertEqual(parse_bybit_listing(title, lines, "source")["KOR/USDT"]["date"], "2026-11-05")
        self.assertEqual(parse_bybit_listing(title, lines[:-1], "source"), {})
        self.assertEqual(parse_bybit_listing(title, [line.replace("KOR/USDT", "KOR/USDC") for line in lines], "source"), {})

    def test_bybit_delisting_uses_only_the_list_under_spot_deadline(self):
        lines = ["We will delist the following Spot trading pairs on Nov 16, 2026, 8:00AM UTC:",
                 "MANAUSDC, ABCUSDT, DEF/USDT", "Important notes", "BTCUSDT"]
        title = "Bybit to Delist 3 Trading Pair(s) on Nov 16, 2026"
        now = int(datetime(2026, 11, 11, tzinfo=timezone.utc).timestamp())
        results = parse_bybit_delisting(title, lines, "source", now)
        self.assertEqual(set(results), {"ABC/USDT", "DEF/USDT"})
        self.assertEqual(parse_bybit_delisting(title, lines, "source", results["ABC/USDT"]["at"]), {})
        self.assertEqual(parse_bybit_delisting("Bybit to Delist Futures", ["Perpetual contracts", *lines[1:]], "source", now), {})

    def test_domestic_notices_use_trading_date_and_quote(self):
        body = "<tr><td>예시(AAA)</td><td>BTC, USDT</td><td>Ethereum</td><td>12월 31일 18시</td><td>1월 1일 15시 예정</td></tr>"
        upbit = parse_upbit_listing(body, datetime(2026, 12, 31), "source")
        self.assertEqual(set(upbit), {"AAA/BTC", "AAA/USDT"})
        self.assertEqual(upbit["AAA/BTC"]["date"], "2027-01-01")
        bithumb = parse_bithumb_listing(
            "<p>[ 예시(AAA) 거래지원 ]</p><li>입금/출금 개시 시점 : 2026.11.09</li>"
            "<li>거래 개시 시점 : 2026.11.10(화) 오후 4:00 예정</li>", "source"
        )
        self.assertEqual(bithumb["AAA/KRW"]["date"], "2026-11-10")

    def test_bitget_st_is_not_a_scheduled_delisting(self):
        def product(base, label, quote="USDT"):
            return {"bs": base, "ps": quote, "cd": base + quote, "nl": label, "st": 2}
        version = "a" * 32
        payload = {"code": "00000", "data": {"md5Value": version, "items": [
            {"businessLine": 2, "symbolDTOList": [product("FUT", 3)]},
            {"businessLine": 1, "symbolDTOList": [product("BTC", 0), product("AAA", 3),
                                                   product("BBB", 4), product("CCC", 3, "USDC")]},
        ]}}
        self.assertEqual(bitget_special_treatment(lambda url: payload, {}), ({"AAA/USDT": True}, version))
        def unchanged(url):
            self.assertEqual(url, BITGET_LABELS + version)
            return {"code": "00000", "data": {"md5Value": version}}
        self.assertEqual(bitget_special_treatment(unchanged, {"version": version, "items": {"AAA/USDT": True}}),
                         ({"AAA/USDT": True}, version))
        now = 1794320000
        data = [{"baseCoin": symbol, "quoteCoin": quote, "symbol": symbol + quote, "status": "online", "offTime": end}
                for symbol, quote, end in [("AAA", "USDT", "1794564000000"), ("BBB", "USDC", "1794564000000"),
                                           ("CCC", "USDT", "1794124000000"), ("DDD", "USDT", "")]]
        self.assertEqual(bitget_ends(lambda url: {"code": "00000", "data": data}, now),
                         {"AAA/USDT": {"at": 1794564000, "url": BITGET_SYMBOLS}})

    def test_failed_refresh_keeps_dates_and_drops_expired_risk(self):
        now = 1794320000
        previous = {
            "upbit": {"items": {"AAA/KRW": {"date": "2026-10-01"}}},
            "bybit_end": {"items": {"AAA/USDT": {"at": now - 1}, "BBB/USDT": {"at": now + 1}}},
            "bitget_st": {"confirmedAt": now - 3601, "items": {"AAA/USDT": True}},
        }
        def unavailable(_url):
            raise TimeoutError()
        state, dates, ends, st = collect_listing_notices(unavailable, unavailable, previous, now)
        self.assertEqual(state["upbit"]["error"], "TimeoutError")
        self.assertEqual(dates["upbit"]["AAA/KRW"]["date"], "2026-10-01")
        self.assertEqual(dates["upbit"]["HYPE/KRW"]["date"], "2026-11-10")
        self.assertNotIn("REZ/KRW", dates["upbit"])
        self.assertEqual(list(ends["bybit"]), ["BBB/USDT"])
        self.assertEqual(st, {})

    def test_upbit_secondary_official_endpoint(self):
        title = "예시(AAA) 신규 거래지원 안내 (KRW 마켓)"
        body = "<tr><td>예시(AAA)</td><td>KRW</td><td>Base</td><td>12월 1일 10시</td><td>12월 1일 13시</td></tr>"
        def fetch(url):
            if url.startswith(UPBIT):
                raise PermissionError("403")
            self.assertTrue(url.startswith(UPBIT_BACKUP))
            data = {"body": body} if "/123?" in url else {"notices": [
                {"id": 123, "title": title, "listed_at": "2025-12-01T09:00:00+09:00"}
            ]}
            return {"data": data}
        self.assertEqual(upbit_dates(fetch)["AAA/KRW"]["date"], "2025-12-01")


if __name__ == "__main__":
    unittest.main()

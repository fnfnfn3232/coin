import copy
import unittest
from unittest.mock import Mock

from apywa_ratings import SOURCE, apply_ratings, collect_ratings, parse_page
from refresh_health import build_refresh_health

NOW = 1792454400  # 2026-10-20 UTC


def page(slug="bitcoin", symbol="BTC", name="Bitcoin", grade="A+", score="95.26", total=1, date="2026.10.19"):
    return f'''<table><tbody id="cryptocurrency_items"><tr data-slug="{slug}">
      <td class="name"><img alt="{name}" />{name}<span>{symbol}</span></td>
      <td class="rating_revision m_hide">AW-0165</td><td class="rating_date m_hide">{date}</td>
      <td class="bf_rating_grade"><span>B</span>(60)</td>
      <td class="n_lebel"><span class="level_box">{grade}</span><em>{score}</em></td>
      </tr></tbody></table><div>Total Records : <b>{total}</b></div>'''


class ApywaTests(unittest.TestCase):
    def test_reads_current_not_previous_grade(self):
        rows, total = parse_page(page())
        self.assertEqual(total, 1)
        self.assertEqual(rows[0], {"slug": "bitcoin", "symbol": "BTC", "name": "Bitcoin",
                                 "grade": "A+", "score": 95.26, "round": "AW-0165", "date": "2026-10-19"})

    def test_daily_cache_reuses_full_verified_collection(self):
        loader = Mock(return_value=page())
        old = collect_ratings(now=NOW, loader=loader)
        self.assertEqual(old["error"], "")
        self.assertEqual(collect_ratings(old, now=NOW + 600, loader=loader), old)
        self.assertEqual(loader.call_count, 1)
        collect_ratings(old, now=NOW + 86400, loader=loader)
        self.assertEqual(loader.call_count, 2)

    def test_mixed_case_official_tickers_are_normalized(self):
        rows, _ = parse_page(page(symbol="stWEMIX", name="Staked WEMIX", slug="staked-wemix"))
        self.assertEqual(rows[0]["symbol"], "STWEMIX")

    def test_collects_all_public_pages_atomically(self):
        first = ''.join(page(slug=f"token-{i}", symbol=f"T{i}", total=201) for i in range(200))
        loader = Mock(side_effect=[first, page(slug="token-200", symbol="T200", total=201)])
        result = collect_ratings(now=NOW, loader=loader)
        self.assertEqual(result["total"], 201)
        self.assertEqual(len(result["rows"]), 201)
        self.assertTrue(loader.call_args.args[0].endswith("perPage=200&page=2"))

    def test_block_or_partial_result_keeps_last_success_and_retries_later(self):
        old = collect_ratings(now=NOW, loader=lambda _: page())
        frozen = copy.deepcopy(old)
        for response in ("Forbidden", page(total=3), page(grade="FAKE"), page(score="nan"),
                         page(date="2026.10.12"), page(date="2030.01.01")):
            result = collect_ratings(old, now=NOW + 86400, loader=lambda _: response)
            self.assertTrue(result["error"])
            self.assertEqual(result["rows"], old["rows"])
            self.assertEqual(result["lastSuccessAt"], NOW)
            loader = Mock()
            self.assertEqual(collect_ratings(result, now=NOW + 86410, loader=loader), result)
            loader.assert_not_called()
        self.assertEqual(old, frozen)

    def test_failure_without_history_does_not_invent_ratings(self):
        result = collect_ratings(now=NOW, loader=Mock(side_effect=TimeoutError()))
        self.assertNotIn("rows", result)
        self.assertTrue(result["error"])

    def test_inconsistent_round_pages_rejected(self):
        first = ''.join(page(slug=f"token-{i}", symbol=f"T{i}", total=201) for i in range(200))
        result = collect_ratings(now=NOW, loader=Mock(side_effect=[first, page(total=201, date="2026.10.12")]))
        self.assertIn("inconsistent_evaluation_date", result["error"])

    def test_identity_requires_name_and_symbol_not_ticker_alone(self):
        ratings = collect_ratings(now=NOW, loader=lambda _: page(slug="sleepless-ai", symbol="AI", name="Sleepless AI"))
        rows = [
            {"symbol": "AI", "englishName": "Sleepless AI"},
            {"symbol": "AI", "englishName": "Gensyn"},
            {"symbol": "AI", "compareSymbol": "AIGENSYN", "englishName": "Gensyn"},
            {"symbol": "AI", "englishName": "AI", "apywaRating": {"grade": "A+"}},
            {"symbol": "FAKE", "englishName": "Sleepless AI"},
        ]
        self.assertEqual(apply_ratings({"binance": rows}, ratings), 1)
        self.assertEqual(rows[0]["apywaRating"]["slug"], "sleepless-ai")
        for row in rows[1:]:
            self.assertNotIn("apywaRating", row)

    def test_ambiguous_identity_is_not_attached(self):
        rating = collect_ratings(now=NOW, loader=lambda _: page())["rows"][0]
        data = {"source": SOURCE, "rows": [rating, {**rating, "slug": "other-bitcoin"}]}
        rows = [{"symbol": "BTC", "name": "Bitcoin"}]
        self.assertEqual(apply_ratings({"upbit": rows}, data), 0)

    def test_source_duplicates_merge_only_when_identity_date_grade_agree(self):
        rating = collect_ratings(now=NOW, loader=lambda _: page())["rows"][0]
        rows = [{"symbol": "BTC", "name": "Bitcoin"}]
        data = {"rows": [rating, {**rating, "score": 95.1}]}
        self.assertEqual(apply_ratings({"upbit": rows}, data), 1)
        self.assertNotIn("score", rows[0]["apywaRating"])
        data["rows"][1]["grade"] = "A"
        self.assertEqual(apply_ratings({"upbit": rows}, data), 0)

    def test_source_row_without_detail_slug_is_counted_but_not_mapped(self):
        data = collect_ratings(now=NOW, loader=lambda _: page(slug=""))
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["error"], "")
        self.assertEqual(apply_ratings({"upbit": [{"symbol": "BTC", "name": "Bitcoin"}]}, data), 0)

    def test_official_ticker_names_are_explicit_and_missing_remains_unrated(self):
        data = collect_ratings(now=NOW, loader=lambda _: page(symbol="XRP", name="XRP", slug="xrp"))
        rows = [{"symbol": "XRP", "englishName": "XRP"}, {"symbol": "MISSING", "name": "Missing"}]
        self.assertEqual(apply_ratings({"upbit": rows}, data), 1)
        self.assertNotIn("apywaRating", rows[1])

    def test_aliases_are_scoped_to_symbol_and_official_asset_slug(self):
        for symbol, name, slug, legacy_name in (
            ("ADA", "Cardano", "cardano", "Ada"),
            ("XLM", "Stellar", "stellar", "Stellar Lumens"),
            ("SUI", "Sui", "sui", "Sui"),
        ):
            data = collect_ratings(now=NOW, loader=lambda _: page(symbol=symbol, name=name, slug=slug))
            rows = [{"symbol": symbol, "englishName": legacy_name}]
            self.assertEqual(apply_ratings({"upbit": rows}, data), 1)
            data["rows"][0]["slug"] = "unrelated-token"
            self.assertEqual(apply_ratings({"upbit": rows}, data), 0)

    def test_stale_ratings_keep_evaluation_date_and_health_failure(self):
        data = collect_ratings(now=NOW, loader=lambda _: page())
        data.update(error="blocked", checkedAt=NOW + 86400)
        rows = [{"symbol": "BTC", "name": "Bitcoin"}]
        apply_ratings({"upbit": rows}, data)
        self.assertTrue(rows[0]["apywaRating"]["stale"])
        self.assertEqual(rows[0]["apywaRating"]["date"], "2026-10-19")
        health = build_refresh_health({"apywaRatings": data}, now=NOW + 86400)
        self.assertEqual(health["components"]["apywa"]["lastSuccessAt"], NOW)
        self.assertEqual(health["components"]["apywa"]["state"], "degraded")


if __name__ == "__main__":
    unittest.main()

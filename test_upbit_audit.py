import copy
import hashlib
import unittest
from unittest.mock import Mock, patch

from upbit_audit import archive_complete, collect_reports, parse_report_pdf, parse_rows, rows_digest, verified_rows


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.rows = [[1, "BTC", "100", "101", "101.00%"], [2, "ZERO", "0", "0", "100.00%"]]
        self.specs = [{"reportId": key, "sourceUrl": f"https://static.upbit.com/reports/{key}.pdf", "rowCount": 2,
                       "sourceSha256": hashlib.sha256(b"%PDF-test").hexdigest(), "rowsSha256": rows_digest(self.rows)} for key in ("new", "old")]

    def test_parser_accepts_only_complete_table_lines_and_preserves_zero(self):
        text = "header\n1 BTC 100 101 101.00%\n2 ZERO 0 0 100.00%\n31\n1 BROKEN 100 101\n"
        self.assertEqual(parse_rows(text), self.rows)

    def test_digest_rejects_partial_duplicate_reordered_and_poisoned_cache(self):
        self.assertTrue(verified_rows(self.rows, self.specs[0]))
        for rows in (self.rows[:1], self.rows[::-1], [self.rows[0], self.rows[0]], [[1, "BTC", "100", "999", "101.00%"], self.rows[1]]):
            self.assertFalse(verified_rows(rows, self.specs[0]))
        with self.assertRaises(ValueError):
            parse_report_pdf(b"not a pdf", self.specs[0])

    def test_verified_archive_is_reused_without_network_or_pdf_dependency(self):
        fetcher = Mock(side_effect=AssertionError("unexpected network"))
        old = {"reportId": "old", "rows": copy.deepcopy(self.rows)}
        previous = {"upbitAuditReports": [{"reportId": "new", "rows": self.rows}], "upbitAudit": old}
        self.assertTrue(archive_complete(previous, specs=self.specs))
        self.assertFalse(archive_complete({"upbitAudit": old}, specs=self.specs))
        reports, errors = collect_reports(previous, fetcher=fetcher, specs=self.specs)
        self.assertEqual([report["reportId"] for report in reports], ["new", "old"])
        self.assertEqual(reports[1]["rows"], old["rows"])
        self.assertEqual(errors, [])
        fetcher.assert_not_called()

    def test_new_report_is_added_without_removing_legacy_rows(self):
        old = {"reportId": "old", "rows": copy.deepcopy(self.rows)}
        with patch("upbit_audit.parse_report_pdf", return_value=self.rows) as parser:
            fetcher = Mock(return_value=b"%PDF-test")
            reports, errors = collect_reports({"upbitAudit": old}, fetcher=fetcher, specs=self.specs)
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[1]["rows"], old["rows"])
        self.assertEqual(errors, [])
        self.assertEqual(fetcher.call_count, 1)
        self.assertEqual(parser.call_count, 1)

    def test_failed_new_source_preserves_old_report_and_is_not_a_silent_success(self):
        old = {"reportId": "old", "rows": self.rows}
        reports, errors = collect_reports({"upbitAudit": old}, fetcher=Mock(side_effect=TimeoutError()), specs=self.specs)
        self.assertEqual([report["reportId"] for report in reports], ["old"])
        self.assertEqual(errors, ["new"])


if __name__ == '__main__':
    unittest.main()

# Upbit audit archive

The October 2026 report is the default; July 2026 remains selectable. This is a dated user-custody audit, not live exchange inventory or a list of exchange-owned coins.

Official sources:
- https://static.upbit.com/reports/upbit_asset_report_202610.pdf (819 rows, September 30 at 24:00 KST)
- https://static.upbit.com/reports/upbit_asset_report_202607.pdf (783 rows, June 30 at 24:00 KST)

`upbit_audit.py` contains reviewed source/row hashes and metadata only. Actual parsed quantities remain in authenticated Worker snapshots, including `upbitAuditReports`. `upbitAudit` remains the latest available report for older clients. No public JSON/PDF mirror is added and the original local July file is not overwritten.

Both source PDFs were independently parsed with pypdf and pdfplumber, with identical rows, unique symbols and sequential report numbers. July also exactly matches the previous dataset. A cold collector downloads missing official reports with bounded size/time and validates the PDF SHA-256, row count, uniqueness and canonical row hash. Subsequent rebuilds reuse verified archives without PDF downloads. Failure retains available verified reports and records `upbit_audit` as delayed instead of inventing fresh data.

The UI compares the same official report symbol, without cross-symbol aliases or migration assumptions. B is blockchain user-custody quantity; A is internal-ledger user-custody quantity. Both quantity changes are shown, with a sortable B column and increase/decrease/unmatched filters. New and omitted records are not treated as zero. A zero baseline has no percentage growth rate. Integer quantities/deltas use BigInt, preserving values above 2^53. Percentages are rounded to two decimal places, with tiny nonzero changes explicitly labeled. Source quantities are rounded to whole tokens, as noted in each PDF; changes are not price returns or inferred purchases/sales.

Tests: `python -m unittest test_upbit_audit.py test_refresh_health.py`; `node --test test_audit_report.cjs`; `node test_audit_ui.cjs`. The UI test uses synthetic data by default; `AUDIT_REPORTS_TEST_FILE` optionally supplies a locally verified extraction without committing report data.

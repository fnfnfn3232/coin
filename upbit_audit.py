"""Verified, immutable Upbit audit archives; quantities never live in public source."""

import hashlib
import io
import json
import re
import urllib.request

REPORTS = (
    {"reportId": "upbit_asset_report_202610", "publishedLabel": "2026년 10월 발행",
     "referenceAt": "2026-10-01T00:00:00+09:00", "referenceLabel": "2026년 9월 30일 24시 (2026년 10월 1일 00시)",
     "sourceUrl": "https://static.upbit.com/reports/upbit_asset_report_202610.pdf", "rowCount": 819,
     "sourceSha256": "cecb3309fdb8d123313190095d7f70713931643236ba7b61533c40685352c69d",
     "rowsSha256": "4fc04629a11098bd45d57e4690d20b380200b8f32b3de64a7b41e857239d366a"},
    {"reportId": "upbit_asset_report_202607", "publishedLabel": "2026년 7월 발행",
     "referenceAt": "2026-07-01T00:00:00+09:00", "referenceLabel": "2026년 6월 30일 24시 (2026년 7월 1일 00시)",
     "sourceUrl": "https://static.upbit.com/reports/upbit_asset_report_202607.pdf", "rowCount": 783,
     "sourceSha256": "b6cc12ed9e9a0ee852e556925551ea722973562ac55348fcf47a1e5dccf7c3b6",
     "rowsSha256": "21367725566d23651ab6685e1dcac3589cba953446825c0cbaf9aae40134b490"},
)
ROW = re.compile(r"^([0-9]+)\s+([A-Z0-9][A-Z0-9._-]*)\s+([0-9,]+)\s+([0-9,]+)\s+([0-9,.]+%)$")
MAX_PDF_BYTES = 8 * 1024 * 1024


def rows_digest(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def verified_rows(rows, spec):
    if not isinstance(rows, list) or len(rows) != spec["rowCount"]:
        return False
    if any(not isinstance(row, list) or len(row) != 5 or type(row[0]) is not int or row[0] != i
           or not all(isinstance(value, str) for value in row[1:]) for i, row in enumerate(rows, 1)):
        return False
    return len({row[1] for row in rows}) == len(rows) and rows_digest(rows) == spec["rowsSha256"]


def parse_rows(text):
    return [[int(match[1]), *match.groups()[1:]] for line in text.splitlines()
            if (match := ROW.fullmatch(line.strip()))]


def parse_report_pdf(content, spec):
    if not content.startswith(b"%PDF-") or hashlib.sha256(content).hexdigest() != spec["sourceSha256"]:
        raise ValueError("upbit_audit_pdf_integrity_failed")
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(content))
    if not 1 <= len(reader.pages) <= 100:
        raise ValueError("upbit_audit_pdf_page_count")
    rows = parse_rows("\n".join(page.extract_text() or "" for page in reader.pages))
    if not verified_rows(rows, spec):
        raise ValueError("upbit_audit_rows_integrity_failed")
    return rows


def fetch_pdf(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/pdf"})
    with urllib.request.urlopen(request, timeout=20) as response:
        content = response.read(MAX_PDF_BYTES + 1)
    if len(content) > MAX_PDF_BYTES:
        raise ValueError("upbit_audit_pdf_too_large")
    return content


def cached_report(spec, previous=None, legacy=None):
    previous = previous or {}
    candidates = [*(previous.get("upbitAuditReports") or []), previous.get("upbitAudit"), legacy]
    return next((item for item in candidates if isinstance(item, dict) and item.get("reportId") == spec["reportId"]
                 and verified_rows(item.get("rows"), spec)), None)


def archive_complete(previous=None, *, specs=REPORTS):
    return all(cached_report(spec, previous) for spec in specs)


def collect_reports(previous=None, legacy=None, *, fetcher=fetch_pdf, specs=REPORTS):
    reports, failures = [], []
    for spec in specs:
        cached = cached_report(spec, previous, legacy)
        try:
            rows = cached["rows"] if cached else parse_report_pdf(fetcher(spec["sourceUrl"]), spec)
            reports.append({**spec, "title": "업비트 디지털 자산 실사 보고서", "quantityUnit": "수량 단위: 개", "rows": rows})
        except Exception:
            failures.append(spec["reportId"])
    return reports, failures

"""Verified spot trading dates and pair-scoped exchange notices."""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

KST = timezone(timedelta(hours=9))
PAIR = r"[A-Z0-9]{1,30}"
BYBIT = "https://announcements.bybit.com"
BINANCE_CMS = "https://www.binance.com/bapi/composite/v1/public/cms/article"
UPBIT = "https://pub-info.upbit.com/api/v1/announcements"
UPBIT_BACKUP = "https://api-manager.upbit.com/api/v1/announcements"
COINBASE = "https://status.exchange.coinbase.com/api/v2/incidents.json"
BITGET_SYMBOLS = "https://api.bitget.com/api/v2/spot/public/symbols"
BITGET_LABELS = "https://www.bitget.com/v1/mix/symbol/getAllSymbolV2?languageType=0&md5="
BITHUMB_NOTICES = "https://gw.bithumb.com/feed/v2/customer-support/articles/notices/recent?count=20"
LISTING_INTERVAL = 6 * 3600
RISK_INTERVAL = 600

# Official articles with day-level precision, including Robinhood US re-listings.
REVIEWED_DATES = {
    "bithumb": (
        ("2026-11-10", "https://feed.bithumb.com/notice/1655585", ("HYPE/KRW", "CARDS/KRW")),
        ("2026-11-05", "https://feed.bithumb.com/notice/1655524", ("MAGMA/KRW",)),
    ),
    "robinhood": (
        ("2024-11-13", "https://robinhood.com/newsroom/robinhood-crypto-expands-offering-with-solana-sol-pepe-pepe-cardano-ada-amp-xrp-xrp-for-u-s-customers/",
         ("SOL/USD", "PEPE/USD", "ADA/USD", "XRP/USD")),
        ("2018-08-06", "https://robinhood.com/newsroom/ethereum-classic-is-now-on-robinhood-crypto/", ("ETC/USD",)),
        ("2018-07-12", "https://robinhood.com/newsroom/litecoin-and-bitcoin-cash-now-on-robinhood-crypto/", ("LTC/USD", "BCH/USD")),
    ),
}

# Initial coverage verified against the trading-start table in each official notice.
UPBIT_REVIEWED_STARTS = (
    (6758, 1794290400, "HYPE", "KRW BTC USDT"),
    (6739, 1793863800, "CARDS", "KRW BTC USDT"),
    (6687, 1792587600, "AXIS", "KRW BTC USDT"),
    (6675, 1792400400, "CT", "KRW BTC USDT"),
    (6645, 1791538200, "KAIA", "KRW BTC USDT"),
    (6644, 1791435600, "PONS", "KRW BTC USDT"),
    (6635, 1790924400, "POD", "KRW BTC USDT"),
    (6618, 1790582400, "CASHCAT", "KRW BTC USDT"),
    (6580, 1789614000, "PYUSD JPYC", "KRW BTC USDT"),
    (6560, 1789020000, "REZ", "USDT"),
    (6558, 1788870600, "HEMI USELESS", "BTC USDT"),
    (6555, 1788845400, "CP", "KRW BTC USDT"),
)


def ms_timestamp(value):
    value = str(value or "")
    return int(value) // 1000 if re.fullmatch(r"1[0-9]{12}", value) else None


def iso_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(parsed.timestamp()) if parsed.tzinfo is not None else None
    except (ValueError, AttributeError, OverflowError):
        return None


def kst_date(at):
    return datetime.fromtimestamp(at, KST).date().isoformat()


def trading_date(at, url):
    return {"date": kst_date(at), "at": at, "url": url}


class NoticeBlocks(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.blocks = []
        self.text = []
        self.feed(source)
        self.flush()

    def flush(self):
        value = " ".join("".join(self.text).split())
        if value:
            self.blocks.append(value)
        self.text.clear()

    def handle_starttag(self, tag, attrs):
        if tag in ("p", "li", "h2", "h3", "br", "tr"):
            self.flush()
        if tag in ("td", "th"):
            self.text.append(" | ")

    def handle_endtag(self, tag):
        if tag in ("p", "li", "h2", "h3", "tr"):
            self.flush()

    def handle_data(self, data):
        self.text.append(data)


def next_props(html):
    data = re.search(r'<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not data:
        raise ValueError("missing_notice_page_data")
    return json.loads(data[1])["props"]["pageProps"]


def english_utc(text):
    match = re.search(r"\b([A-Z][a-z]{2,8}) (\d{1,2}), (\d{4}),? (\d{1,2}:\d\d)\s*([AP]M)\s+UTC\b", text, re.I)
    if not match:
        return None
    try:
        month, day, year, clock, period = match.groups()
        value = f"{month[:3]} {day} {year} {clock} {period}"
        return int(datetime.strptime(value, "%b %d %Y %I:%M %p").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def parse_bybit_listing(title, blocks, url):
    match = re.match(rf"^Bybit to List .+? \(({PAIR})\)\s+on Spot\b", title)
    if not match:
        return {}
    base = match[1]
    if not any(re.search(rf"(?<![A-Z0-9]){base}\s*/\s*USDT\b", line) for line in blocks):
        return {}
    for line in blocks:
        if re.match(rf"^{base} (?:Listing|Trading)(?: Time)?:", line, re.I):
            if at := english_utc(line):
                return {f"{base}/USDT": trading_date(at, url)}
    return {}


def parse_bybit_delisting(title, blocks, url, now):
    if not re.match(r"^Bybit to Delist\b", title, re.I) or re.search(r"\b(?:postpone|cancel|update)\w*\b", title, re.I):
        return {}
    for index, line in enumerate(blocks[:-1]):
        if not re.search(r"\bdelist the following Spot trading pairs\b", line, re.I):
            continue
        at = english_utc(line)
        if not at or not now < at < now + 90 * 86400:
            continue
        # The list immediately after the trading deadline is authoritative, not later margin/withdrawal sections.
        result = {}
        for row in blocks[index + 1:index + 12]:
            tokens = [token.strip() for token in re.split(r"[,;、]", row)]
            if not all(re.fullmatch(rf"{PAIR}(?:\s*/\s*{PAIR})?", token) for token in tokens):
                break
            for token in tokens:
                if match := re.fullmatch(rf"({PAIR}?)\s*/?\s*USDT", token):
                    result[f"{match[1]}/USDT"] = {"at": at, "url": url}
        return result
    return {}


def bybit_content_lines(article):
    if article.get("content_html"):
        return NoticeBlocks(article["content_html"]).blocks

    def node_text(node):
        return str(node.get("text") or "") + "".join(node_text(child) for child in node.get("children", []))

    doc = (article.get("content") or {}).get("json") or {}
    return [" ".join(value.split()) for node in doc.get("children", []) if (value := node_text(node)).strip()]


def bybit_records(fetch_html, category, now, history_page=7):
    output = {}
    seen = set()
    pages = (1, 2) if category == "delistings" else (*range(1, 7), *range(history_page, history_page + 3))
    for page in pages:
        records = next_props(fetch_html(f"{BYBIT}/en/?category={category}&page={page}"))["articleInitEntity"]["list"]
        for item in records:
            path = str(item.get("url") or "")
            title = str(item.get("title") or "")
            listing = category == "new_crypto"
            eligible = (re.match(r"^Bybit to List .+? \([A-Z0-9]+\)\s+on Spot\b", title) if listing
                        else re.match(r"^Bybit to Delist\b", title, re.I) and not re.search(r"\b(?:margin|contract|perpetual|futures)\b", title, re.I))
            if not eligible or path in seen or not re.fullmatch(r"/article/[a-z0-9-]+--art[a-z0-9]+/", path):
                continue
            if len(seen) >= 12:
                break
            seen.add(path)
            url = BYBIT + "/en" + path
            article = next_props(fetch_html(url))["articleDetail"]
            lines = bybit_content_lines(article)
            if not lines:
                continue
            entries = parse_bybit_listing(article["title"], lines, url) if listing else parse_bybit_delisting(article["title"], lines, url, now)
            for pair, entry in entries.items():
                output.setdefault(pair, entry)
    return output


def parse_upbit_listing(body, published, url):
    result = {}
    for line in NoticeBlocks(body).blocks:
        cells = [cell.strip() for cell in line.strip(" |").split("|")]
        if len(cells) != 5:
            continue
        base = re.search(rf"\(({PAIR})\)$", cells[0])
        date = re.fullmatch(r"(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2})시(?:\s*(\d{1,2})분)?\s*(?:예정)?", cells[4])
        quotes = re.split(r"\s*,\s*", cells[1])
        if not base or not date or any(quote not in ("KRW", "BTC", "USDT") for quote in quotes):
            continue
        month, day, hour, minute = [int(part or 0) for part in date.groups()]
        try:
            year = published.year + (published.month == 12 and month == 1)
            at = int(datetime(year, month, day, hour, minute, tzinfo=KST).timestamp())
        except ValueError:
            continue
        if not published - timedelta(days=1) <= datetime.fromtimestamp(at, KST).replace(tzinfo=published.tzinfo) <= published + timedelta(days=30):
            continue
        for quote in quotes:
            result[f"{base[1]}/{quote}"] = trading_date(at, url)
    return result


def upbit_dates(fetch):
    last_error = None
    for endpoint in (UPBIT, UPBIT_BACKUP):
        try:
            return upbit_dates_from_endpoint(fetch, endpoint)
        except Exception as error:
            last_error = error
    raise last_error


def upbit_dates_from_endpoint(fetch, endpoint):
    notices = []
    for page in (1, 2, 3):
        notices.extend(fetch(f"{endpoint}?os=web&page={page}&per_page=20&category=trade")["data"]["notices"])
    if not notices:
        raise ValueError("empty_upbit_listing_feed")
    output = {}
    eligible = [item for item in notices if "신규 거래지원" in item.get("title", "")]
    for item in eligible[:12]:
        id_ = str(item.get("id") or "")
        if not id_.isdigit() or not (at := iso_timestamp(item.get("listed_at"))):
            continue
        detail = fetch(f"{endpoint}/{id_}?os=web")["data"]
        url = f"https://www.upbit.com/service_center/notice?id={id_}"
        for pair, entry in parse_upbit_listing(detail.get("body") or "", datetime.fromtimestamp(at, KST), url).items():
            output.setdefault(pair, entry)
    return output


def parse_bithumb_listing(body, url):
    result = {}
    symbol = None
    for line in NoticeBlocks(body).blocks:
        if match := re.fullmatch(rf"\[\s*[^\[]+?\(({PAIR})\)\s*거래지원\s*\]", line):
            symbol = match[1]
        if not symbol:
            continue
        if match := re.match(r"^(?:\*\s*)?거래\s*개시\s*시점\s*:\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\b", line):
            try:
                value = datetime(*map(int, match.groups()), tzinfo=KST).date().isoformat()
            except ValueError:
                continue
            result[f"{symbol}/KRW"] = {"date": value, "url": url}
            symbol = None
    return result


def bithumb_dates(fetch, fetch_html):
    notices = fetch(BITHUMB_NOTICES)["data"]
    output = {}
    failed = False
    for item in [row for row in notices if row.get("categoryName1") == "마켓 추가"][:8]:
        url = str(item.get("pcUrl") or "")
        if not re.fullmatch(r"https://feed\.bithumb\.com/notice/\d+", url) or "원화 마켓 추가" not in item.get("title", ""):
            continue
        if any(url == seed_url for _, seed_url, _ in REVIEWED_DATES["bithumb"]):
            continue
        try:
            for pair, entry in parse_bithumb_listing(fetch_html(url), url).items():
                output.setdefault(pair, entry)
        except Exception:  # Keep valid notices when the CDN rejects only some articles.
            failed = True
    if failed and not output:
        raise ValueError("bithumb_listing_details_unavailable")
    return output


def binance_text(node):
    if node.get("node") == "text":
        return node.get("text", "")
    return "".join(binance_text(child) for child in node.get("child", []))


def binance_dates(fetch):
    items = []
    for page in (1, 2, 3):
        items.extend(fetch(f"{BINANCE_CMS}/catalog/list/query?catalogId=48&pageNo={page}&pageSize=50")["data"]["articles"])
    output = {}
    eligible = [item for item in items if re.match(r"^Binance Will (?:List\b|Add .+ Trading Pairs\b)", item.get("title", ""))]
    for item in eligible[:12]:
        code = str(item.get("code") or "")
        if not re.fullmatch(r"[0-9a-f]{32}", code):
            continue
        article = fetch(f"{BINANCE_CMS}/detail/query?articleCode={code}")["data"]
        if not article or not article.get("body"):
            continue
        url = f"https://www.binance.com/en/support/announcement/detail/{code}"
        body = json.loads(article["body"])
        lines = [binance_text(block) for block in body.get("child", [])]
        for index, line in enumerate(lines):
            match = re.search(r"(?:open|start|enable) trading (?:for|on) the following spot trading pairs at (\d{4}-\d{2}-\d{2} \d\d:\d\d) \(UTC\)", line, re.I)
            if not match or not (at := iso_timestamp(match[1] + "+00:00")):
                continue
            pairs_text = line[match.end():]
            if not re.search(rf"\b{PAIR}/USDT\b", pairs_text) and index + 1 < len(lines):
                next_line = re.match(r"^\s*New Spot Trading Pairs?:\s*((?:[A-Z0-9]+/[A-Z0-9]+[ ,]*(?:and\s+)?)+)", lines[index + 1])
                pairs_text = next_line[1] if next_line else ""
            for pair in re.findall(rf"\b{PAIR}/USDT\b", pairs_text):
                output.setdefault(pair, trading_date(at, url))
    return output


def coinbase_dates(fetch):
    output = {}
    for incident in fetch(COINBASE)["incidents"]:
        match = re.fullmatch(rf"({PAIR})-USD Markets Open", incident["name"])
        if not match or not re.fullmatch(r"[a-z0-9]{12}", incident["id"]):
            continue
        base = match[1]
        updates = incident.get("incident_updates") or []
        starts = [at for item in updates
                  if re.search(rf"\b{base}-USD trading pair will now enter limit-only mode\b", item.get("body", ""), re.I)
                  and (at := iso_timestamp(item.get("display_at")))]
        completed = any(re.search(r"\bfull-trading mode\b", item.get("body", ""), re.I) for item in updates)
        if starts and completed:
            output.setdefault(f"{base}/USD", trading_date(min(starts), f"https://status.exchange.coinbase.com/incidents/{incident['id']}"))
    return output


def bitget_ends(fetch, now):
    payload = fetch(BITGET_SYMBOLS)
    if payload.get("code") != "00000" or not isinstance(payload.get("data"), list) or not payload["data"]:
        raise ValueError("invalid_bitget_symbol_schedule")
    return {f"{row['baseCoin']}/USDT": {"at": at, "url": BITGET_SYMBOLS}
            for row in payload["data"] if row.get("quoteCoin") == "USDT"
            and re.fullmatch(PAIR, str(row.get("baseCoin") or ""))
            and row.get("symbol") == row["baseCoin"] + "USDT"
            and row.get("status") == "online"
            and (at := ms_timestamp(row.get("offTime"))) and now < at < now + 90 * 86400}


def bitget_special_treatment(fetch, previous):
    old_version = str(previous.get("version") or "")
    payload = fetch(BITGET_LABELS + (old_version if re.fullmatch(r"[0-9A-Fa-f]{32}", old_version) else ""))
    data = payload.get("data") or {}
    version = str(data.get("md5Value") or "")
    if payload.get("code") != "00000" or not re.fullmatch(r"[0-9A-Fa-f]{32}", version):
        raise ValueError("invalid_bitget_spot_labels")
    if version == old_version and "items" not in data:
        return previous.get("items") or {}, version
    group = next((item.get("symbolDTOList") for item in data.get("items", []) if item.get("businessLine") == 1), None)
    if not group or not any(row.get("cd") == "BTCUSDT" and "nl" in row for row in group):
        raise ValueError("missing_bitget_spot_labels")
    # Bitget's spot page uses newLabelId (nl) == 3 for the official ST warning.
    return {f"{row['bs']}/USDT": True for row in group if row.get("nl") == 3 and row.get("ps") == "USDT"
            and row.get("st") == 2 and re.fullmatch(PAIR, str(row.get("bs") or ""))
            and row.get("cd") == row["bs"] + "USDT"}, version


def collect_listing_notices(fetch, fetch_html, previous, now):
    history_page = int((previous.get("bybit") or {}).get("historyPage") or 7)
    jobs = {
        "upbit": (LISTING_INTERVAL, lambda: upbit_dates(fetch)),
        "bithumb": (LISTING_INTERVAL, lambda: bithumb_dates(fetch, fetch_html)),
        "binance": (LISTING_INTERVAL, lambda: binance_dates(fetch)),
        "coinbase": (LISTING_INTERVAL, lambda: coinbase_dates(fetch)),
        "bybit": (LISTING_INTERVAL, lambda: bybit_records(fetch_html, "new_crypto", now, history_page)),
        "bybit_end": (RISK_INTERVAL, lambda: bybit_records(fetch_html, "delistings", now)),
        "bitget_end": (RISK_INTERVAL, lambda: bitget_ends(fetch, now)),
        "bitget_st": (RISK_INTERVAL, lambda: bitget_special_treatment(fetch, previous.get("bitget_st") or {})),
    }

    def refresh(name, interval, load):
        old = previous.get(name) or {}
        if 0 <= now - (old.get("checkedAt") or 0) < interval:
            return name, old
        try:
            items = load()
            if name == "bitget_st":
                flags, version = items
                return name, {"checkedAt": now, "confirmedAt": now, "items": flags, "version": version}
            if not name.endswith("_end"):
                archive = dict(old.get("items") or {})
                for pair, item in items.items():
                    if item["date"] >= (archive.get(pair) or {}).get("date", ""):
                        archive[pair] = item
                items = archive
            if name == "bybit":
                return name, {"checkedAt": now, "items": items, "historyPage": history_page + 3 if history_page < 25 else 7}
            return name, {"checkedAt": now, "items": items}
        except Exception as error:
            return name, {**old, "checkedAt": now, "items": old.get("items") or {}, "error": type(error).__name__}

    with ThreadPoolExecutor(max_workers=5) as pool:
        state = dict(pool.map(lambda job: refresh(job[0], *job[1]), jobs.items()))
    listings = {name: entry["items"] for name, entry in state.items() if "_" not in name}
    reviewed_upbit = {
        f"{symbol}/{quote}": trading_date(at, f"https://www.upbit.com/service_center/notice?id={notice}")
        for notice, at, symbols, quotes in UPBIT_REVIEWED_STARTS
        for symbol in symbols.split() for quote in quotes.split()
    }
    listings["upbit"] = {**reviewed_upbit, **listings["upbit"]}
    for exchange, seeds in REVIEWED_DATES.items():
        reviewed = {pair: {"date": day, "url": url} for day, url, pairs in seeds for pair in pairs}
        listings[exchange] = {**reviewed, **listings.get(exchange, {})}
    ends = {name[:-4]: {pair: item for pair, item in entry["items"].items() if item["at"] > now}
            for name, entry in state.items() if name.endswith("_end")}
    bitget_st = state["bitget_st"]
    special = {"bitget": {"pairs": list(bitget_st["items"]), "observedAt": bitget_st["confirmedAt"]}} if 0 <= now - bitget_st.get("confirmedAt", 0) < 3600 else {}
    return state, listings, ends, special

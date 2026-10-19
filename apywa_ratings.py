"""Public APYWA ratings, collected once daily and matched by asset identity."""

import copy
import math
import re
import time
import unicodedata
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

SOURCE = "https://www.apywa.io/en/cryptocurrencies"
GRADES = {"A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "D-", "NR"}
CACHE_SECONDS = 86400
RETRY_SECONDS = 3600
PAGE_SIZE = 200
MAX_PAGES = 10
# These official asset names are themselves ticker symbols, not identity evidence
# for arbitrary tokens that happen to reuse the same ticker.
TICKER_NAME_IDENTITIES = {
    "XRP": {"xrp", "ripple", "리플", "엑스알피리플", "엑스알피"},
    "BNB": {"bnb", "binancecoin", "바이낸스코인", "비앤비"},
    "USDC": {"usdc", "usdcoin", "유에스디코인"},
}
OFFICIAL_TICKER_NAMES = set("""USDS SUI GRAM AAVE ONDO ASTER SKY PEPE MORPHO RENDER
PENDLE NEXO SEI KITE BONK ZAMA FLOKI KAIA NEO IOTA DEXE ORCA KAITO PLUME MINA
DYDX GALA 0G QTUM RE LINEA GAS GMX VANA KAVA TURBO CELO AMP BLUR FLOW ANKR ARK
API3 COTI UMA SIGN STEEM HIVE FLUX HEMI IOST SAPIEN ENSO DIA USUAL AEVO WOO
CYBER IQ ARPA JOE XAI DODO TURTLE RESOLV TOWNS EURC PIEVERSE SOON FLUID BEAM
CAP SAFE TOSHI AZTEC IRYS WAVES B3 ZORA ORBS MVL BORA CARV GRVT TAIKO BLAST
STABLE GRASS EDGEX PEAQ XYO POPCAT CORE AEON BASED PONKE PUFFER RECALL AVAIL
BOB SIX FANC RSS3 STAT TEMCO AZIT CUDIS AURORA DEGEN DIMO NKN AERGO""".split())
# Verified legacy exchange names, scoped to APYWA's precise asset slug.
NAME_ALIASES = {
    ("XLM", "stellar"): ("Stellar Lumens", "Lumen"),
    ("USDT", "tether-usdt"): ("Tether",),
    ("USDE", "ethena-usde"): ("USD Ethena",),
    ("ADA", "cardano"): ("Ada",),
    ("HBAR", "hedera"): ("Hedera Hashgraph",),
    ("ETH", "ethereum"): ("Ether",),
    ("ETC", "ethereum-classic"): ("Ether Classic",),
    ("IMX", "immutable"): ("Immutable X", "ImmutableX"),
    ("STRK", "starknet"): ("Starknet Token",),
    ("CFX", "conflux"): ("Conflux Network",),
    ("CRV", "curve-dao-token"): ("Curve",),
    ("AERO", "aerodrome-finance"): ("Aerodrome",),
    ("ONDO", "ondo"): ("Ondo Finance",),
    ("SKY", "sky"): ("Sky Protocol",),
    ("MORPHO", "morpho"): ("Morpho Token",),
    ("RENDER", "render"): ("Render Network", "Render Token"),
    ("THETA", "theta-network"): ("Theta Token",),
    ("1INCH", "1inch-network"): ("1inch",),
    ("ZRX", "0x-protocol"): ("0x",),
    ("SNX", "synthetix"): ("Synthetix Network Token",),
    ("SUSHI", "sushiswap"): ("Sushi",),
    ("TRB", "tellor"): ("Tellor Tributes",),
    ("REQ", "request"): ("Request Network",),
    ("ROSE", "oasis"): ("Oasis Network",),
    ("ANKR", "ankr"): ("Ankr Network",),
    ("MANTA", "manta-network"): ("Manta",),
    ("SKL", "skale"): ("SKALE Network",),
    ("METIS", "metis"): ("MetisDAO",),
    ("WCT", "walletconnect-token"): ("WalletConnect",),
    ("DEEP", "deepbook-protocol"): ("DeepBook",),
    ("INJ", "injective"): ("Injective Protocol",),
    ("GLM", "golem"): ("Golem Network",),
    ("VTHO", "vethor-token"): ("VeThor",),
    ("CRO", "cronos"): ("Crypto.com Coin",),
}


class RatingsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.text = []
        self.row = None
        self.cell = ""
        self.part = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr" and "data-slug" in attrs:
            self.row = {"slug": attrs["data-slug"]}
        if self.row is None:
            return
        if tag == "td":
            self.cell = attrs.get("class", "").split()[0]
            self.part = ""
        elif tag == "img" and self.cell == "name":
            self.row["name"] = attrs.get("alt", "").strip()
        elif tag == "span" and self.cell in {"name", "n_lebel"}:
            self.part = "symbol" if self.cell == "name" else "grade"
        elif tag == "em" and self.cell == "n_lebel":
            self.part = "score"

    def handle_data(self, text):
        self.text.append(text)
        if self.row is None:
            return
        key = self.part or {"rating_date": "date", "rating_revision": "round"}.get(self.cell)
        if key:
            self.row[key] = self.row.get(key, "") + text.strip()

    def handle_endtag(self, tag):
        if tag in {"span", "em"}:
            self.part = ""
        elif tag == "td":
            self.cell = self.part = ""
        elif tag == "tr" and self.row is not None:
            self.rows.append(validate_rating(self.row, allow_unlinked=True))
            self.row = None


def validate_rating(raw, *, allow_unlinked=False):
    rating = {key: str(raw.get(key) or "").strip() for key in ("slug", "symbol", "name", "grade", "date", "round")}
    rating["symbol"] = rating["symbol"].upper()
    if not (allow_unlinked and not rating["slug"]) and not re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", rating["slug"]):
        raise ValueError("apywa_invalid_slug")
    if not re.fullmatch(r"[A-Z0-9._-]{1,40}", rating["symbol"]) or not rating["name"]:
        raise ValueError("apywa_invalid_identity")
    if rating["grade"] not in GRADES:
        raise ValueError("apywa_invalid_grade")
    score = float(raw.get("score"))
    if not math.isfinite(score) or not 0 <= score <= 100:
        raise ValueError("apywa_invalid_score")
    rating["date"] = datetime.strptime(rating["date"].replace(".", "-"), "%Y-%m-%d").date().isoformat()
    rating["score"] = score
    return rating


def parse_page(html):
    parser = RatingsParser()
    parser.feed(html)
    total = re.search(r"Total Records\s*:\s*([\d,]+)", " ".join(parser.text))
    if not total or not parser.rows:
        raise ValueError("apywa_rating_table_missing")
    return parser.rows, int(total[1].replace(",", ""))


def fetch_page(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Blockscope/1.0 (+https://fnfnfn3232.github.io/coin/)"})
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read(4_000_001)
    if len(body) > 4_000_000:
        raise ValueError("apywa_response_too_large")
    return body.decode("utf-8")


def collect_ratings(previous=None, *, now=None, loader=None):
    now = int(time.time()) if now is None else int(now)
    loader = fetch_page if loader is None else loader
    old = copy.deepcopy(previous or {})
    if old.get("source") != SOURCE:
        old = {}
    if now < min(int(old.get("nextCheckAt") or 0), now + CACHE_SECONDS):
        return old
    try:
        query = f"{SOURCE}?sortby=name_kr&sortby_key=asc&perPage={PAGE_SIZE}"
        rows, total = parse_page(loader(f"{query}&page=1"))
        if not 1 <= total <= MAX_PAGES * PAGE_SIZE:
            raise ValueError("apywa_unexpected_total")
        for page in range(2, math.ceil(total / PAGE_SIZE) + 1):
            page_rows, page_total = parse_page(loader(f"{query}&page={page}"))
            if page_total != total:
                raise ValueError("apywa_page_total_changed")
            rows.extend(page_rows)
        if len(rows) != total or len({row["slug"] for row in rows}) < total * 0.95:
            raise ValueError("apywa_incomplete_pages")
        if old.get("rows") and total < len(old["rows"]) * 0.8:
            raise ValueError("apywa_suspicious_count_drop")
        # A weekly round must not be partially replaced or roll back through an old CDN page.
        dates = {row["date"] for row in rows}
        if len(dates) != 1 or max(dates) < str(old.get("evaluationDate") or ""):
            raise ValueError("apywa_inconsistent_evaluation_date")
        if max(dates) > datetime.fromtimestamp(now + 86400, timezone.utc).date().isoformat():
            raise ValueError("apywa_future_evaluation_date")
        return {"source": SOURCE, "checkedAt": now, "lastSuccessAt": now,
                "nextCheckAt": now + CACHE_SECONDS, "evaluationDate": max(dates),
                "total": total, "rows": rows, "error": ""}
    except Exception as error:
        return {**old, "source": SOURCE, "checkedAt": now,
                "nextCheckAt": now + RETRY_SECONDS,
                "error": f"apywa_refresh_failed:{type(error).__name__}:{str(error)[:180]}"}


def name_key(value):
    return "".join(char for char in unicodedata.normalize("NFKC", str(value or "")).casefold() if char.isalnum())


def apply_ratings(boards, ratings):
    by_symbol = {}
    for raw in ratings.get("rows") or []:
        try:
            rating = validate_rating(raw)
        except (ValueError, TypeError):
            continue
        by_symbol.setdefault(rating["symbol"], []).append(rating)
    matched = 0
    for rows in boards.values():
        for row in rows:
            row.pop("apywaRating", None)
            symbol = str(row.get("compareSymbol") or row.get("symbol") or "").upper()
            names = {name_key(row.get(key)) for key in ("englishName", "name", "koreanName")}
            names.update(name_key(value) for value in row.get("nameKeys") or [])
            names.discard("")
            alias_names = set(names)
            names.discard(name_key(symbol))
            if symbol in TICKER_NAME_IDENTITIES and any(
                name_key(row.get(key)) in TICKER_NAME_IDENTITIES[symbol]
                for key in ("englishName", "name", "koreanName")
            ):
                names.add(name_key(symbol))
            candidates = [item for item in by_symbol.get(symbol, [])
                          if name_key(item["name"]) in names or name_key(item["slug"]) in names
                          or (symbol in OFFICIAL_TICKER_NAMES and item["slug"] == symbol.lower()
                              and name_key(row.get("englishName")) == name_key(item["name"]))
                          or alias_names.intersection(name_key(alias) for alias in NAME_ALIASES.get((symbol, item["slug"]), ()))]
            identities = {(item["slug"], item["name"], item["date"], item["grade"]) for item in candidates}
            # APYWA can publish duplicate rows for one asset. Only an identical
            # identity/date/grade is mergeable; conflicting grades stay unrated.
            if len(identities) != 1:
                continue
            row["apywaRating"] = {**{key: value for key, value in candidates[0].items() if key != "score"}, "lastSuccessAt": ratings.get("lastSuccessAt"),
                                  "stale": bool(ratings.get("error"))}
            matched += 1
    return matched

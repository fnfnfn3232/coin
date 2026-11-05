"""Deposit/withdrawal network names from Upbit's public wallet-status page feed."""
import re
import time

SOURCE = "upbit_wallet_status"
ENDPOINT = "https://ccx.upbit.com/api/v1/status/network/wallet"
PAGE_URL = "https://upbit.com/service_center/wallet_status"
MAX_AGE = 86400


def normalize_wallet_networks(rows):
    if not isinstance(rows, list) or not rows or len(rows) > 10000:
        raise ValueError("invalid_wallet_network_catalog")
    grouped = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("currency") or "")
        net_type = str(row.get("net_type") or "")
        name = str(row.get("network_name") or "").strip()
        if not re.fullmatch(r"[A-Z0-9]{1,40}", symbol) or not re.fullmatch(r"[A-Z0-9_]{1,40}", net_type):
            continue
        if not name or len(name) > 100 or any(ord(char) < 32 for char in name):
            continue
        networks = grouped.setdefault(symbol, {})
        if net_type in networks and networks[net_type] != name:
            raise ValueError("conflicting_wallet_network_name")
        networks[net_type] = name
    if not grouped or len(grouped) > 2000:
        raise ValueError("empty_wallet_network_catalog")
    return {symbol: [{"netType": net_type, "name": name} for net_type, name in networks.items()]
            for symbol, networks in grouped.items()}


def collect_wallet_networks(previous, fetch_json, *, now=None):
    now = int(time.time()) if now is None else int(now)
    old = previous.get("upbitWalletNetworks") if isinstance(previous, dict) else None
    old = old if isinstance(old, dict) else {}
    old_at = old.get("checkedAt")
    cached = {}
    if old.get("source") == SOURCE and old.get("sourceUrl") == PAGE_URL and type(old_at) is int and 0 < old_at <= now + 60:
        try:
            cached = normalize_wallet_networks([
                {"currency": symbol, "net_type": item.get("netType"), "network_name": item.get("name")}
                for symbol, networks in (old.get("assets") or {}).items() if isinstance(networks, list)
                for item in networks if isinstance(item, dict)])
        except (ValueError, AttributeError, TypeError):
            cached = {}
    try:
        assets = normalize_wallet_networks(fetch_json(ENDPOINT))
        if len(cached) >= 50 and len(assets) < len(cached) * 0.7:
            raise ValueError("suspicious_wallet_network_catalog_drop")
        return {"source": SOURCE, "sourceUrl": PAGE_URL, "checkedAt": now, "assets": assets, "stale": False}, None
    except Exception:  # Keep the existing site usable when the public feed fails.
        retained = cached if cached and now - old_at <= MAX_AGE else {}
        return {"source": SOURCE, "sourceUrl": PAGE_URL, "checkedAt": old_at if retained else 0,
                "assets": retained, "stale": True}, "wallet_network_refresh_failed"

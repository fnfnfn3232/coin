"""Bounded source recovery and honest freshness for protected market snapshots."""

import json
import time
from urllib.error import HTTPError


class ProviderCoolingDown(RuntimeError):
    pass


def call_notice_provider(source, loader, providers, *, now=None):
    now = int(time.time()) if now is None else int(now)
    previous = providers.get(source) or {}
    retry_at = min(int(previous.get("nextRetryAt") or 0), now + 21600)
    if retry_at > now:
        raise ProviderCoolingDown(f"provider_cooldown_until:{retry_at}")
    try:
        result = loader()
    except Exception as error:
        failures = min(20, int(previous.get("consecutiveFailures") or 0) + 1)
        code = error.code if isinstance(error, HTTPError) else 0
        base = 1800 if code in (401, 403) else 300
        delay = min(21600 if code in (401, 403) else 3600, base * 2 ** min(failures - 1, 6))
        if code == 429:
            retry_after = str(error.headers.get("Retry-After", "")) if error.headers else ""
            if retry_after.isdigit():
                delay = max(delay, min(21600, int(retry_after)))
        providers[source] = {"lastSuccessAt": int(previous.get("lastSuccessAt") or 0),
                             "lastFailureAt": now, "consecutiveFailures": failures,
                             "nextRetryAt": now + delay, "httpStatus": code}
        raise
    providers[source] = {"lastSuccessAt": now, "consecutiveFailures": 0, "nextRetryAt": 0}
    return result


def build_refresh_health(payload, previous=None, *, now=None):
    now = int(time.time()) if now is None else int(now)
    previous_components = ((previous or {}).get("refreshHealth") or {}).get("components") or {}
    issues = payload.get("refreshIssues") or {}
    notices = payload.get("noticeRefresh") or {}
    checks = {}
    for exchange in ("upbit", "bithumb", "binance", "coinbase"):
        checks[exchange] = bool((payload.get("boards") or {}).get(exchange)) and exchange not in issues
    for exchange in ("upbit", "bithumb", "binance"):
        status = notices.get(exchange) or {}
        checks[f"{exchange}_notices"] = bool(status.get("checkedAt")) and not status.get("error") and f"{exchange}_notices" not in issues
    for exchange in ("binance", "coinbase"):
        key = f"{exchange}_futures"
        checks[key] = bool((payload.get("futures") or {}).get(exchange)) and key not in issues
    defi = payload.get("defillamaRankings") or {}
    checks["defillama"] = bool(defi.get("categories")) and not any(key == "defillama" or key.startswith("defillama_") for key in issues)
    components = {}
    for name, success in checks.items():
        old = previous_components.get(name) or {}
        failures = 0 if success else int(old.get("consecutiveFailures") or 0) + 1
        first_failure = 0 if success else int(old.get("firstFailureAt") or now)
        last_success = now if success else int(old.get("lastSuccessAt") or 0)
        components[name] = {"state": "healthy" if success else "degraded", "checkedAt": now,
                            "lastSuccessAt": last_success, "firstFailureAt": first_failure,
                            "consecutiveFailures": failures,
                            "needsAttention": not success and (failures >= 3 or now - first_failure >= 1800)}
    return {"checkedAt": now, "state": "degraded" if not all(checks.values()) else "healthy",
            "needsAttention": any(item["needsAttention"] for item in components.values()),
            "components": components}


def incident_report(payload, *, now=None):
    now = int(time.time()) if now is None else int(now)
    health = payload.get("refreshHealth") or {}
    if not isinstance(health.get("components"), dict) or not health["components"]:
        raise ValueError("refresh_health_missing")
    generated_at = int(payload.get("generatedAt") or 0)
    if not generated_at or now - generated_at > 1800 or generated_at > now + 300:
        raise ValueError("refresh_snapshot_not_current")
    affected = sorted(name for name, state in health["components"].items() if state.get("needsAttention"))
    pending = sorted(name for name, state in health["components"].items() if state.get("state") != "healthy")
    # No prices, holdings, raw upstream responses, or account data leave the protected snapshot.
    return {"state": health.get("state"), "affected": affected, "pending": pending}


if __name__ == "__main__":
    import sys
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.dumps(incident_report(json.load(handle)), separators=(",", ":")))

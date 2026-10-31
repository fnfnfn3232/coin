"""Bounded source recovery and honest freshness for protected market snapshots."""

import json
import time
from urllib.error import HTTPError

HISTORY_RETENTION_SECONDS = 90 * 86400
HISTORY_MAX_EVENTS = 200
HISTORY_KINDS = {"failure", "recovered", "attention", "fallback", "fallback_active", "source_changed", "pipeline_resumed", "maintenance"}


def build_refresh_events(payload, previous, components, maintenance, now):
    old_health = (previous or {}).get("refreshHealth") or {}
    old_components = old_health.get("components") or {}
    started_at = int(old_health.get("historyStartedAt") or now)
    events = {}

    def add(event):
        if not isinstance(event, dict) or event.get("kind") not in HISTORY_KINDS:
            return
        at = event.get("at")
        component = event.get("component")
        if not isinstance(at, int) or not now - HISTORY_RETENTION_SECONDS <= at <= now:
            return
        if component not in components and component != "pipeline":
            return
        normalized = {"id": f"{at}:{component}:{event['kind']}", "at": at, "component": component, "kind": event["kind"]}
        if event["kind"] == "maintenance":
            commit = str(event.get("commit") or "")
            if len(commit) != 40 or any(char not in "0123456789abcdef" for char in commit):
                return
            normalized.update({"id": f"maintenance:{commit}", "commit": commit,
                               "title": str(event.get("title") or "개발 수정")[:140],
                               "detail": str(event.get("detail") or "")[:500]})
        for key in ("durationSeconds", "gapSeconds"):
            if isinstance(event.get(key), int) and event[key] >= 0:
                normalized[key] = min(HISTORY_RETENTION_SECONDS, event[key])
        events[normalized["id"]] = normalized

    for event in old_health.get("events") or []:
        add(event)
    for event in maintenance or []:
        add(event)
    for name, current in components.items():
        old = old_components.get(name) or {}
        if current["state"] == "degraded" and (old.get("state") != "degraded" or not old_health.get("historyStartedAt")):
            add({"kind": "failure", "component": name, "at": int(current.get("firstFailureAt") or now)})
        if current["state"] == "healthy" and old.get("state") == "degraded":
            duration = now - int(old.get("firstFailureAt") or now)
            add({"kind": "recovered", "component": name, "at": now, "durationSeconds": max(0, duration)})
        if current.get("needsAttention") and not old.get("needsAttention"):
            add({"kind": "attention", "component": name, "at": now})
    for exchange, status in (payload.get("noticeRefresh") or {}).items():
        name = f"{exchange}_notices"
        if name not in components or components[name]["state"] != "healthy":
            continue
        source = str(status.get("source") or "")
        old_source = str(((previous or {}).get("noticeRefresh") or {}).get(exchange, {}).get("source") or "")
        if source == "https://t.me/s/upbit_news":
            if old_source and source != old_source:
                add({"kind": "fallback", "component": name, "at": now})
            elif not old_health.get("historyStartedAt"):
                add({"kind": "fallback_active", "component": name, "at": now})
        elif source and old_source and source != old_source:
            add({"kind": "source_changed", "component": name, "at": now})
    previous_generated_at = int((previous or {}).get("generatedAt") or 0)
    if previous_generated_at > 0 and now - previous_generated_at > 1800:
        add({"kind": "pipeline_resumed", "component": "pipeline", "at": now, "gapSeconds": now - previous_generated_at})
    return started_at, sorted(events.values(), key=lambda event: (event["at"], event["id"]), reverse=True)[:HISTORY_MAX_EVENTS]


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


def build_refresh_health(payload, previous=None, *, now=None, maintenance=None):
    now = int(time.time()) if now is None else int(now)
    previous_components = ((previous or {}).get("refreshHealth") or {}).get("components") or {}
    issues = payload.get("refreshIssues") or {}
    notices = payload.get("noticeRefresh") or {}
    checks = {}
    for exchange in ("upbit", "bithumb", "binance", "coinbase"):
        checks[exchange] = bool((payload.get("boards") or {}).get(exchange)) and exchange not in issues
    if "robinhood" in (payload.get("boards") or {}):
        checks["robinhood"] = bool(payload["boards"]["robinhood"]) and "robinhood" not in issues
    for exchange in ("upbit", "bithumb", "binance"):
        status = notices.get(exchange) or {}
        checks[f"{exchange}_notices"] = bool(status.get("checkedAt")) and not status.get("error") and f"{exchange}_notices" not in issues
    for exchange in ("binance", "coinbase"):
        key = f"{exchange}_futures"
        checks[key] = bool((payload.get("futures") or {}).get(exchange)) and key not in issues
    defi = payload.get("defillamaRankings") or {}
    checks["defillama"] = bool(defi.get("categories")) and not any(key == "defillama" or key.startswith("defillama_") for key in issues)
    ratings = payload.get("apywaRatings") or {}
    if payload.get("upbitAuditReports") or "upbit_audit" in issues:
        checks["upbit_audit"] = bool(payload.get("upbitAuditReports")) and "upbit_audit" not in issues
    if payload.get("upbitAssetNames") or "upbit_asset_names" in issues:
        checks["upbit_asset_names"] = bool(payload.get("upbitAssetNames")) and "upbit_asset_names" not in issues
    if payload.get("upbitAuditMarket") or "upbit_audit_market" in issues:
        checks["upbit_audit_market"] = bool(payload.get("upbitAuditMarket")) and "upbit_audit_market" not in issues
    if ratings or "apywa" in issues:
        checks["apywa"] = bool(ratings.get("rows")) and not ratings.get("error") and "apywa" not in issues
    components = {}
    for name, success in checks.items():
        old = previous_components.get(name) or {}
        failures = 0 if success else int(old.get("consecutiveFailures") or 0) + 1
        first_failure = 0 if success else int(old.get("firstFailureAt") or now)
        last_success = now if success else int(old.get("lastSuccessAt") or 0)
        if name == "apywa":
            last_success = int(ratings.get("lastSuccessAt") or last_success)
        if name == "robinhood":
            last_success = int((payload.get("robinhoodRefresh") or {}).get("lastSuccessAt") or last_success)
        components[name] = {"state": "healthy" if success else "degraded", "checkedAt": now,
                            "lastSuccessAt": last_success, "firstFailureAt": first_failure,
                            "consecutiveFailures": failures,
                            "needsAttention": not success and (failures >= 3 or now - first_failure >= 1800)}
    started_at, events = build_refresh_events(payload, previous, components, maintenance, now)
    return {"checkedAt": now, "state": "degraded" if not all(checks.values()) else "healthy",
            "needsAttention": any(item["needsAttention"] for item in components.values()),
            "components": components, "historyStartedAt": started_at, "events": events}


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

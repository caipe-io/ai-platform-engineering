"""Best-effort audit-service writer for OpenFGA bridge decisions."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

# assisted-by Codex Codex-sonnet-4-6

SUBJECT_SALT = os.getenv("AUDIT_SUBJECT_SALT", "caipe-098-audit")

# A single MCP tools/call fans out into several ext_authz checks (coarse gate,
# per-server invoke, per-tool, caller-keyed), so posting every decision as its
# own durable event makes audit volume scale with raw request count instead of
# anything security-relevant. Denials stay full-fidelity — they're rare and
# the signal that matters for review. Routine allows are counted in memory,
# keyed by subject/action/resource/reason, and flushed as periodic aggregate
# rows (see flush_allow_rollups). AUDIT_FULL_FIDELITY_ALLOWS restores one
# durable event per allow for a bounded investigation/compliance window.
ALLOW_ROLLUP_FLUSH_SECONDS = float(os.getenv("AUDIT_ALLOW_ROLLUP_FLUSH_SECONDS", "60"))
FULL_FIDELITY_ALLOWS = os.getenv("AUDIT_FULL_FIDELITY_ALLOWS", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

_ROLLUP_KEY_FIELDS = (
    "tenant_id",
    "subject_hash",
    "subject_ref",
    "component",
    "action",
    "resource_ref",
    "pdp",
    "source",
    "reason_code",
)

_rollup_lock = threading.Lock()
_rollup_counts: dict[tuple[Any, ...], dict[str, Any]] = {}
_flush_timer: threading.Timer | None = None


def _hash_subject(subject: str) -> str:
    digest = hashlib.sha256(f"{SUBJECT_SALT}:{subject}".encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _audit_service_url() -> str | None:
    backend = os.getenv("AUDIT_LOG_BACKEND", "service").strip().lower()
    if backend != "service":
        return None
    url = os.getenv("AUDIT_SERVICE_URL", "").strip()
    return url.rstrip("/") if url else None


def _post_to_audit_service(event: dict[str, Any]) -> None:
    service_url = _audit_service_url()
    if not service_url:
        return
    try:
        with httpx.Client(timeout=1.0) as client:
            response = client.post(f"{service_url}/v1/audit/events", json={"events": [event]})
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        print(f"[bridge-audit] Failed to submit audit event to audit-service: {exc}", file=sys.stderr)


def _rollup_key(event: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(event.get(field) for field in _ROLLUP_KEY_FIELDS)


def _record_allow(event: dict[str, Any]) -> None:
    key = _rollup_key(event)
    ts = event["ts"]
    with _rollup_lock:
        entry = _rollup_counts.get(key)
        if entry is None:
            entry = {"sample": event, "count": 0, "window_start": ts}
            _rollup_counts[key] = entry
        entry["count"] += 1
        entry["window_end"] = ts


def flush_allow_rollups() -> None:
    """Emit one aggregated event per distinct key accumulated since the last flush."""
    with _rollup_lock:
        pending = list(_rollup_counts.values())
        _rollup_counts.clear()
    for entry in pending:
        sample = entry["sample"]
        rollup: dict[str, Any] = {
            "audit_event_id": str(uuid.uuid4()),
            "ts": entry["window_end"],
            "type": sample["type"],
            "tenant_id": sample["tenant_id"],
            "subject_hash": sample["subject_hash"],
            "action": sample["action"],
            "outcome": "allow",
            "reason_code": sample["reason_code"],
            # This row summarizes `count` decisions, not one request — there is
            # no single correlation_id to attach.
            "correlation_id": f"rollup:{uuid.uuid4()}",
            "component": sample["component"],
            "resource_ref": sample["resource_ref"],
            "pdp": sample["pdp"],
            "source": sample["source"],
            "count": entry["count"],
            "window_start": entry["window_start"],
            "window_end": entry["window_end"],
        }
        if sample.get("subject_ref"):
            rollup["subject_ref"] = sample["subject_ref"]
        print(json.dumps(rollup, separators=(",", ":")), file=sys.stderr)
        _post_to_audit_service(rollup)


def _schedule_next_flush() -> None:
    global _flush_timer
    _flush_timer = threading.Timer(ALLOW_ROLLUP_FLUSH_SECONDS, _flush_and_reschedule)
    _flush_timer.daemon = True
    _flush_timer.start()


def _flush_and_reschedule() -> None:
    flush_allow_rollups()
    _schedule_next_flush()


def start_allow_rollup_flusher() -> None:
    """Start the periodic background flush. Call once from the server entrypoint."""
    if getattr(start_allow_rollup_flusher, "_started", False) or FULL_FIDELITY_ALLOWS:
        return
    start_allow_rollup_flusher._started = True
    _schedule_next_flush()


def log_authz_decision(
    *,
    subject: str,
    outcome: str,
    reason_code: str,
    correlation_id: str | None,
    action: str,
    component: str,
    resource_ref: str,
    pdp: str,
    source: str,
    duration_ms: float | None = None,
    tenant_id: str | None = None,
    extra: dict[str, Any] | None = None,
    subject_ref: str | None = None,
) -> dict[str, Any]:
    """Submit a bridge authorization decision without affecting the request path."""
    event: dict[str, Any] = {
        "audit_event_id": str(uuid.uuid4()),
        "ts": datetime.now(timezone.utc).isoformat(),
        "type": "openfga_rebac",
        "tenant_id": tenant_id or os.getenv("TENANT_ID", "default"),
        "subject_hash": _hash_subject(subject or "anonymous"),
        "action": action,
        "outcome": outcome,
        "reason_code": reason_code,
        "correlation_id": correlation_id or str(uuid.uuid4()),
        "component": component,
        "resource_ref": resource_ref,
        "pdp": pdp,
        "source": source,
    }
    # Real, resolvable identity alongside subject_hash — audit logs exist to
    # support audits, so this event type is no longer anonymized. Omitted when
    # the caller has no verifiable subject (e.g. DENY_NO_TOKEN).
    if subject_ref:
        event["subject_ref"] = subject_ref
    if duration_ms is not None:
        event["duration_ms"] = round(duration_ms, 2)
    if extra:
        event["extra"] = extra

    if outcome == "allow" and not FULL_FIDELITY_ALLOWS:
        _record_allow(event)
        return event

    print(json.dumps(event, separators=(",", ":")), file=sys.stderr)
    _post_to_audit_service(event)
    return event

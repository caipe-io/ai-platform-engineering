"""Append-only authorization decision audit log.

Writes one document per decision to audit-service.
Schema is defined by `tests/rbac/contracts/audit-event.schema.json`.
This Python implementation MUST stay schema-equivalent to the TypeScript writer in
`ui/src/lib/rbac/audit.ts`. The matrix-driver tests assert that both runtimes write
documents that validate against the same schema (FR-007, SC-007).

Failure mode: writes are best-effort. A failure to write the audit document MUST
NEVER block or mutate the authorization decision. Failures are logged at WARN with
structured fields so operators can detect a degraded audit pipeline.

Sinks:

  - audit-service (default; URL from AUDIT_SERVICE_URL).
  - Stdout JSON line, one per decision, gated on AUDIT_STDOUT_ENABLED=true.
    The line is a single-line JSON object suitable for fluent-bit / loki /
    datadog / vector / cloudwatch logs. The marker prefix `AUDIT ` is
    included so log aggregators can filter on it cheaply.

Both sinks are best-effort and independent: failure of one never affects
the other or the in-flight authorization decision.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)
SUBJECT_SALT = os.environ.get("AUDIT_SUBJECT_SALT", "caipe-098-audit")


def _stdout_enabled() -> bool:
    """Whether the stdout JSON sink is active (Spec 102 Phase 11.3)."""
    return os.environ.get("AUDIT_STDOUT_ENABLED", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


_REQUIRED_REASONS = frozenset(
    {
        "OK",
        "OK_ROLE_FALLBACK",
        "OK_BOOTSTRAP_ADMIN",
        "DENY_NO_CAPABILITY",
        "DENY_PDP_UNAVAILABLE",
        "DENY_INVALID_TOKEN",
        "DENY_RESOURCE_UNKNOWN",
    }
)
_REQUIRED_PDP = frozenset({"keycloak", "local", "cache"})


def _audit_service_url() -> str | None:
    backend = os.environ.get("AUDIT_LOG_BACKEND", "service").strip().lower()
    if backend != "service":
        return None
    value = os.environ.get("AUDIT_SERVICE_URL", "").strip()
    return value.rstrip("/") if value else None


def _hash_subject(subject: str) -> str:
    digest = hashlib.sha256(f"{SUBJECT_SALT}:{subject}".encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _write_service_event(doc: dict[str, Any]) -> None:
    service_url = _audit_service_url()
    if not service_url:
        return
    event = {
        **doc,
        "type": "auth",
        "tenant_id": os.environ.get("TENANT_ID", "default"),
        "subject_hash": _hash_subject(str(doc["userId"])),
        "action": f"{doc['resource']}#{doc['scope']}",
        "outcome": "allow" if doc["allowed"] else "deny",
        "correlation_id": doc.get("requestId") or str(uuid.uuid4()),
        "component": doc["resource"],
        "source": doc["service"],
    }
    if "userEmail" in doc:
        event["user_email"] = doc["userEmail"]
    try:
        with httpx.Client(timeout=1.0) as client:
            response = client.post(f"{service_url}/v1/audit/events", json={"events": [event]})
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning("audit.log_authz_decision service write failed: %s", exc)


def log_authz_decision(
    *,
    user_id: str,
    resource: str,
    scope: str,
    allowed: bool,
    reason: str,
    service: str,
    user_email: str | None = None,
    route: str | None = None,
    request_id: str | None = None,
    pdp: str | None = None,
) -> None:
    """Append one decision document to audit-service.

    Best-effort; never raises. The caller MUST already have made the
    authorization decision; this function only persists it.

    All keyword arguments mirror `audit-event.schema.json`. `source` is
    hard-coded to "py" — this is the Python writer.
    """
    if reason not in _REQUIRED_REASONS:
        logger.warning("audit.log_authz_decision: invalid reason=%s, skipping write", reason)
        return
    if pdp is not None and pdp not in _REQUIRED_PDP:
        logger.warning("audit.log_authz_decision: invalid pdp=%s, dropping field", pdp)
        pdp = None

    doc: dict[str, Any] = {
        "userId": user_id or "anonymous",
        "resource": resource,
        "scope": scope,
        "allowed": bool(allowed),
        "reason": reason,
        "source": "py",
        "service": service,
        "ts": datetime.now(timezone.utc),
    }
    if user_email:
        doc["userEmail"] = user_email
    if route:
        doc["route"] = route
    if request_id:
        doc["requestId"] = request_id
    if pdp:
        doc["pdp"] = pdp

    _write_service_event(doc)

    # Spec 102 Phase 11.3 — optional stdout JSON sink for centralized log
    # aggregators. Independent of the service write — service failure must not
    # suppress this and vice versa.
    if _stdout_enabled():
        try:
            payload = {**doc}
            # `ts` is a datetime; serialize as ISO-8601 UTC for log aggregators.
            ts = payload.get("ts")
            if isinstance(ts, datetime):
                payload["ts"] = ts.isoformat()
            sys.stdout.write("AUDIT " + json.dumps(payload, default=str) + "\n")
            sys.stdout.flush()
        except Exception as exc:  # noqa: BLE001
            logger.warning("audit stdout sink failed: %s", exc)


__all__ = ["log_authz_decision"]

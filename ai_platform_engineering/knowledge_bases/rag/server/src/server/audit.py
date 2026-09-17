"""Best-effort audit-service writer for RAG server OpenFGA decisions.

One user question ("what is SCS?") can fan out into several RAG tool calls
(search, then a handful of get_full_doc calls, etc.), each its own OpenFGA
decision. Logging each individually would scatter one logical question
across several unrelated-looking audit rows. There is no session/turn id
threaded through the MCP tool-call path to group by explicitly (FastMCP
sessions, if used, span a whole connection - often a whole conversation -
not one question), so routine allows are instead grouped by a short time
window per subject: every distinct (action, resource) an allowed subject
touches within the window is collected into one rollup event listing all of
them, rather than one row per decision. Denials and PDP-unavailable errors
are never grouped - they are rare and are the signal reviewers act on, so
they are written immediately, one row per decision.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from common import utils

logger = utils.get_logger(__name__)

SUBJECT_SALT = os.getenv("AUDIT_SUBJECT_SALT", "caipe-098-audit")
ALLOW_ROLLUP_FLUSH_SECONDS = float(os.getenv("AUDIT_RAG_ROLLUP_FLUSH_SECONDS", "10"))
FULL_FIDELITY_ALLOWS = os.getenv("AUDIT_FULL_FIDELITY_ALLOWS", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

_rollup_by_subject: dict[tuple[str, str, str | None], dict[str, Any]] = {}
_flush_task: asyncio.Task[None] | None = None


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
        logger.warning("Failed to submit audit event to audit-service: %s", exc)


def log_openfga_decision(
    *,
    subject: str,
    subject_ref: str | None,
    relation: str,
    object_type: str,
    object_id: str,
    outcome: str,
    reason_code: str,
) -> dict[str, Any]:
    """Record one denial or PDP-unavailable decision. Best-effort; never raises."""
    event: dict[str, Any] = {
        "audit_event_id": str(uuid.uuid4()),
        "ts": datetime.now(timezone.utc).isoformat(),
        "type": "openfga_rebac",
        "tenant_id": os.getenv("TENANT_ID", "default"),
        "subject_hash": _hash_subject(subject),
        "action": f"{object_type}#{relation}",
        "outcome": outcome,
        "reason_code": reason_code,
        "correlation_id": str(uuid.uuid4()),
        "component": "rag_server",
        "resource_ref": f"{object_type}:{object_id}",
        "pdp": "openfga",
        "source": "rag_server",
    }
    if subject_ref:
        event["subject_ref"] = subject_ref
    _post_to_audit_service(event)
    return event


def record_allow(
    *,
    subject: str,
    subject_ref: str | None,
    relation: str,
    object_type: str,
    object_id: str,
) -> None:
    """Buffer one allowed decision for the next rollup flush."""
    tenant_id = os.getenv("TENANT_ID", "default")
    subject_hash = _hash_subject(subject)
    key = (tenant_id, subject_hash, subject_ref)
    now = datetime.now(timezone.utc).isoformat()
    resource_key = (f"{object_type}#{relation}", f"{object_type}:{object_id}")

    entry = _rollup_by_subject.get(key)
    if entry is None:
        entry = {"tenant_id": tenant_id, "subject_hash": subject_hash, "resources": {}, "window_start": now}
        _rollup_by_subject[key] = entry
    entry["resources"][resource_key] = entry["resources"].get(resource_key, 0) + 1
    entry["window_end"] = now


def flush_allow_rollups() -> None:
    """Emit one event per subject, listing every distinct resource touched since the last flush."""
    pending = list(_rollup_by_subject.items())
    _rollup_by_subject.clear()
    for (_tenant_id, _subject_hash, subject_ref), entry in pending:
        resources = [
            {"action": action, "resource_ref": resource_ref, "count": count}
            for (action, resource_ref), count in entry["resources"].items()
        ]
        event: dict[str, Any] = {
            "audit_event_id": str(uuid.uuid4()),
            "ts": entry["window_end"],
            "type": "openfga_rebac",
            "tenant_id": entry["tenant_id"],
            "subject_hash": entry["subject_hash"],
            "action": "rag_access",
            "outcome": "allow",
            "reason_code": "OK",
            # This row summarizes many decisions across possibly many resources,
            # not one request — there is no single correlation_id to attribute
            # it to.
            "correlation_id": f"rollup:{uuid.uuid4()}",
            "component": "rag_server",
            # Best-effort single-string summary for consumers that only read
            # resource_ref; `resources` below is the authoritative list.
            "resource_ref": ", ".join(sorted(r["resource_ref"] for r in resources)),
            "pdp": "openfga",
            "source": "rag_server",
            "resources": resources,
            "count": sum(r["count"] for r in resources),
            "window_start": entry["window_start"],
            "window_end": entry["window_end"],
        }
        if subject_ref:
            event["subject_ref"] = subject_ref
        _post_to_audit_service(event)


async def _flush_loop() -> None:
    while True:
        try:
            await asyncio.sleep(ALLOW_ROLLUP_FLUSH_SECONDS)
            flush_allow_rollups()
        except asyncio.CancelledError:
            flush_allow_rollups()
            break


def start_allow_rollup_flusher() -> None:
    """Start the periodic background flush. Call once from the app lifespan startup."""
    global _flush_task
    if _flush_task is not None or FULL_FIDELITY_ALLOWS:
        return
    _flush_task = asyncio.create_task(_flush_loop(), name="rag-audit-rollup-flusher")


async def stop_allow_rollup_flusher() -> None:
    """Stop the flush task and flush whatever is still pending. Call from app lifespan shutdown."""
    global _flush_task
    if _flush_task is None:
        return
    _flush_task.cancel()
    try:
        await _flush_task
    except asyncio.CancelledError:
        logger.info("Allow rollup flusher cancelled")  # expected: we just cancelled it ourselves
    _flush_task = None
    flush_allow_rollups()

"""Structured audit events for Webex bot RBAC decisions."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Literal, Optional

import requests

logger = logging.getLogger("caipe.rbac.audit")

SUBJECT_SALT = os.environ.get("AUDIT_SUBJECT_SALT", "caipe-098-audit")
WEBEX_BOT_COMPONENT = "webex_bot"

AuditOutcome = Literal["allow", "deny"]
AuditPdp = Literal["keycloak", "agent_gateway", "openfga"]

WebexAuditReasonCode = Literal[
    "OK",
    "WEBEX_USER_NOT_LINKED",
    "WEBEX_IDENTITY_UNAVAILABLE",
    "WEBEX_WORKSPACE_UNCONFIGURED",
    "WEBEX_SPACE_TEAM_NOT_FOUND",
    "WEBEX_OBO_FAILED",
    "WEBEX_IGNORED_BOT",
    "WEBEX_IGNORED_SELF",
    "WEBEX_IGNORED_MALFORMED",
    "WEBEX_REBAC_DENIED",
    "WEBEX_ROUTE_DENIED",
    "WEBEX_DISPATCH_ALLOWED",
    "WEBEX_DM_NOT_ONBOARDED",
    "WEBEX_DM_DISABLED",
    "DENY_PDP_UNAVAILABLE",
    "DENY_NO_CAPABILITY",
]


def _hash_subject(sub: str) -> str:
    digest = hashlib.sha256(f"{SUBJECT_SALT}:{sub}".encode()).hexdigest()
    return f"sha256:{digest}"


def _write_audit_service_event(record: dict[str, object]) -> None:
    if os.environ.get("AUDIT_LOG_BACKEND", "service").strip().lower() != "service":
        return
    service_url = os.environ.get("AUDIT_SERVICE_URL", "").strip().rstrip("/")
    if not service_url:
        return
    event = {
        **record,
        "type": "auth",
        "action": record.get("capability"),
        "source": "webex",
    }
    try:
        requests.post(
            f"{service_url}/v1/audit/events",
            headers={"Content-Type": "application/json"},
            json={"events": [event]},
            timeout=1,
        ).raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Failed to submit Webex audit event to audit-service: %s", exc)


@dataclass(frozen=True)
class WebexAuditEvent:
    ts: str
    tenant_id: str
    subject_hash: str
    capability: str
    component: str
    outcome: str
    reason_code: str
    pdp: str
    correlation_id: str
    actor_hash: Optional[str] = None
    resource_ref: Optional[str] = None
    webex_space_id: Optional[str] = None
    webex_person_hash: Optional[str] = None


def log_webex_authz_decision(
    *,
    tenant_id: str,
    sub: str,
    outcome: AuditOutcome,
    reason_code: WebexAuditReasonCode,
    pdp: AuditPdp = "openfga",
    actor_sub: Optional[str] = None,
    resource_ref: Optional[str] = None,
    webex_space_id: Optional[str] = None,
    webex_person_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
    capability: str = "webex#invoke",
) -> WebexAuditEvent:
    """Emit a structured Webex authorization audit event (no raw tokens or person IDs)."""
    person_hash = _hash_subject(webex_person_id) if webex_person_id else None
    event = WebexAuditEvent(
        ts=datetime.now(timezone.utc).isoformat(),
        tenant_id=tenant_id,
        subject_hash=_hash_subject(sub),
        actor_hash=_hash_subject(actor_sub) if actor_sub else None,
        capability=capability,
        component=WEBEX_BOT_COMPONENT,
        resource_ref=resource_ref,
        outcome=outcome,
        reason_code=reason_code,
        pdp=pdp,
        correlation_id=correlation_id or str(uuid.uuid4()),
        webex_space_id=webex_space_id,
        webex_person_hash=person_hash,
    )
    record = {k: v for k, v in asdict(event).items() if v is not None}
    logger.info(json.dumps(record))
    _write_audit_service_event(record)
    return event

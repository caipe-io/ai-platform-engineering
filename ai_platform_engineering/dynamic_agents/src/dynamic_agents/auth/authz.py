"""Agent-use authorization for Dynamic Agents.

DA is a thin Policy Enforcement Point (PEP): it validates the caller's bearer and
asks the Centralized Authorization Service (CAS) for the decision. CAS is the
single PDP — it evaluates the OpenFGA capability and any org-admin bypass, and
records the decision audit (`cas_decision`). DA performs no in-process OpenFGA
checks and writes no audit of its own.

Config:
    AUTHZ_SERVICE_URL   base URL of the authz service (the BFF/CAS), e.g.
                        http://caipe-ui:3000. DA POSTs to
                        {AUTHZ_SERVICE_URL}/api/authz/v1/decisions.

assisted-by claude code claude-sonnet-4-6
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Any

import httpx
from fastapi import HTTPException

from dynamic_agents.auth.token_context import current_traceparent, current_user_token

logger = logging.getLogger(__name__)

# Safe id charset for agent ids and subjects (alnum plus . _ -).
_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")

# CAS decision endpoint, relative to AUTHZ_SERVICE_URL.
_DECISIONS_PATH = "/api/authz/v1/decisions"


def _error_detail(error: str, code: str, reason: str, action: str) -> dict[str, Any]:
    return {"success": False, "error": error, "code": code, "reason": reason, "action": action}


def _raise_authz(status_code: int, error: str, code: str, reason: str, action: str) -> None:
    raise HTTPException(status_code=status_code, detail=_error_detail(error, code, reason, action))


def _is_valid_id(value: str | None) -> bool:
    return bool(value and _ID_PATTERN.fullmatch(value))


def _subject_from_token(token: str) -> tuple[str, str] | None:
    """Read `(subject_type, sub)` from an already-validated bearer. The JWT
    signature is verified upstream (gateway / middleware); here we only decode the
    claims.

    A token is a service account iff its `preferred_username` starts with
    `service-account-`. This MUST match the BFF (`jwt-validation.ts`) and the
    bridge so the subject is namespaced consistently — CAS's
    subject-binding compares this against its own caller resolution, so sending
    `user` for a service-account token fails the bind and 403s."""
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        body = json.loads(base64.urlsafe_b64decode(f"{payload}{padding}").decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    sub = body.get("sub")
    if not (isinstance(sub, str) and sub.strip()):
        return None
    preferred = body.get("preferred_username")
    is_sa = isinstance(preferred, str) and preferred.startswith("service-account-")
    return ("service_account" if is_sa else "user", sub)


def _authz_service_url() -> str | None:
    """Base URL of the authz service (CAS, served by the BFF)."""
    url = os.getenv("AUTHZ_SERVICE_URL", "").strip().rstrip("/")
    return url or None


def _organization_key() -> str:
    """Return the organization id shared with the UI/OpenFGA model."""
    configured = os.getenv("CAIPE_ORG_KEY", "caipe").strip()
    return configured if _is_valid_id(configured) else "caipe"


class _CasMetaError(Exception):
    """A CAS non-200 response. Carries the upstream status so the caller can
    distinguish a definitive 4xx (not-retriable — bad request / unauthorized /
    forbidden binding) from a transient 5xx or network failure (retriable)."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"CAS decision endpoint returned HTTP {status_code}")
        self.status_code = status_code


async def _decide_action(
    subject_type: str,
    subject: str,
    resource_type: str,
    resource_id: str,
    bearer: str,
    action: str,
) -> bool:
    """Ask CAS whether ``subject`` may perform ``action`` on a resource.

    ``action`` is a CAS verb (for example ``use`` or ``automate``). Forwards
    the caller's bearer (OBO) so CAS's
    subject-binding (caller == subject) is satisfied; CAS evaluates the capability
    and the org-admin bypass. A DENY is a 200 with ``decision: DENY``; any non-200
    raises ``_CasMetaError`` (carrying the upstream status) and missing config
    raises ``RuntimeError`` — either way the caller fails closed."""
    base = _authz_service_url()
    if not base:
        raise RuntimeError("AUTHZ_SERVICE_URL is not configured")
    headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
    traceparent = current_traceparent.get()
    if traceparent:
        headers["traceparent"] = traceparent
    body = {
        "subject": {"type": subject_type, "id": subject},
        "resource": {"type": resource_type, "id": resource_id},
        "action": action,
    }
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(f"{base}{_DECISIONS_PATH}", headers=headers, json=body)
    if response.status_code != 200:
        raise _CasMetaError(response.status_code)
    return response.json().get("decision") == "ALLOW"


async def _decide_agent_use(subject_type: str, subject: str, agent_id: str, bearer: str) -> bool:
    """Back-compat thin alias for the ``use`` action."""
    return await _decide_action(subject_type, subject, "agent", agent_id, bearer, "use")


async def _require_action(
    resource_type: str,
    resource_id: str,
    action: str,
    deny_code: str,
    delegated_user_sub: str | None = None,
) -> None:
    """Require the current bearer's subject to perform an action on a resource.

    Delegates the decision to CAS (the single PDP). Raises ``HTTPException`` with a
    structured detail on deny (403, code ``deny_code``) or any meta-failure
    (400/401/503).

    ``delegated_user_sub`` supports unattended, on-behalf-of execution: the
    autonomous scheduler authenticates as a service principal but runs each task
    for a specific owner. When a *service-account* bearer supplies the owner's
    Keycloak subject (via ``X-User-Context``), the decision is evaluated on the
    OWNER (``user:<sub>``) rather than the service account — so group-shared
    agents resolve correctly and access revocation takes effect on the next run.
    CAS still binds this cross-subject evaluation: the service principal must
    itself hold ``can_audit`` on the org, or CAS rejects it. An interactive
    (user) bearer may never assert a different subject — the delegation branch is
    gated on the bearer being a service account."""
    if not _is_valid_id(resource_id):
        _raise_authz(400, "Invalid resource identifier", "invalid_resource_id", "invalid_request", "fix_request")

    token = current_user_token.get()
    if not token:
        _raise_authz(401, "Bearer token is required", "missing_bearer", "not_signed_in", "sign_in")

    decoded = _subject_from_token(token)
    if not decoded or not _is_valid_id(decoded[1]):
        _raise_authz(401, "Bearer token subject could not be verified", "bearer_invalid", "bearer_invalid", "sign_in")
    subject_type, subject = decoded

    # On-behalf-of delegation (autonomous / unattended runs). Only a service
    # principal may assert the owner subject; a user bearer is always evaluated
    # as itself so it cannot impersonate another user.
    if subject_type == "service_account" and delegated_user_sub:
        if not _is_valid_id(delegated_user_sub):
            _raise_authz(
                400,
                "Invalid delegated subject",
                "invalid_delegated_subject",
                "invalid_request",
                "fix_request",
            )
        subject_type, subject = "user", delegated_user_sub

    try:
        allowed = await _decide_action(
            subject_type,
            subject,
            resource_type,
            resource_id,
            token,
            action,
        )
    except _CasMetaError as exc:
        # A definitive 4xx from CAS (e.g. 403 subject-binding, 400 bad request, 401)
        # is not transient — surface it as the same status so the caller sees a
        # real "denied / misconfigured" signal instead of a misleading
        # "retry later". Transient 5xx (and anything else below) stays 503/retry.
        if 400 <= exc.status_code < 500:
            logger.warning(
                "CAS %s-%s rejected request for resource=%s: HTTP %s",
                resource_type,
                action,
                resource_id,
                exc.status_code,
            )
            _raise_authz(
                exc.status_code,
                "Authorization was refused for this request.",
                "CAS_REJECTED",
                "pdp_rejected",
                "contact_admin",
            )
        logger.warning("CAS %s-%s decision unavailable for resource=%s: %s", resource_type, action, resource_id, exc)
        _raise_authz(
            503,
            "Authorization service is temporarily unavailable. Please try again in a moment.",
            "PDP_UNAVAILABLE",
            "pdp_unavailable",
            "retry",
        )
    except Exception as exc:  # noqa: BLE001 — any other failure to get a decision fails closed
        logger.warning("CAS %s-%s decision unavailable for resource=%s: %s", resource_type, action, resource_id, exc)
        _raise_authz(
            503,
            "Authorization service is temporarily unavailable. Please try again in a moment.",
            "PDP_UNAVAILABLE",
            "pdp_unavailable",
            "retry",
        )

    if not allowed:
        logger.info("CAS denied %s-%s: resource=%s", resource_type, action, resource_id)
        _raise_authz(403, "Permission denied", deny_code, "pdp_denied", "contact_admin")

    logger.debug("CAS allowed %s-%s: resource=%s", resource_type, action, resource_id)


async def require_agent_use_permission(
    agent_id: str, delegated_user_sub: str | None = None
) -> None:
    """Require the current bearer's subject to be allowed to use ``agent_id``"""
    await _require_action("agent", agent_id, "use", "agent#use", delegated_user_sub)


async def require_autonomous_permission(delegated_user_sub: str | None = None) -> None:
    """Require membership in any autonomous-enabled team (or org admin).

    Agent access is checked separately with :func:`require_agent_use_permission`.
    This makes Autonomous a user entitlement instead of an agent-owner-team
    grant while still re-evaluating both permissions on every unattended run.
    """
    await _require_action(
        "organization",
        _organization_key(),
        "automate",
        "organization#automate",
        delegated_user_sub,
    )

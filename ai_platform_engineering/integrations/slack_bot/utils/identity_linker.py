"""Slack-to-Keycloak identity linking (FR-025).

Links a Slack identity to a Keycloak user by matching Slack profile email
to an existing Keycloak account, or (if enabled) just-in-time provisioning
a new federated-only Keycloak user. There is no interactive/bearer-link
onboarding path: a signed link is redeemable by whoever holds it, not
provably by the intended Slack user, so it is not offered as a fallback.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

from .email_masking import mask_email
from .keycloak_admin import (
    JitError,
    create_user_from_slack,
    get_user_by_attribute,
    get_user_by_email,
    set_user_attribute,
)

logger = logging.getLogger("caipe.slack_bot.identity_linker")


def _jit_enabled() -> bool:
    """Read the JIT feature flag at call time (not import time) so tests
    and runtime config changes both apply without re-importing the module.

    Spec 103 FR-001 / G3: defaults to ``true`` so the user-visible value
    (no more "Slack account could not be automatically linked" dead-end)
    ships on by default in dev. Operators in production explicitly opt
    out by setting ``SLACK_JIT_CREATE_USER=false`` in their values.yaml /
    .env, in which case an unmatched user is treated as unlinked and told
    to contact an admin.
    """
    return os.environ.get("SLACK_JIT_CREATE_USER", "true").lower() == "true"


def _jit_allowed_email_domains() -> Optional[set[str]]:
    """Optional comma-separated allowlist of email domains eligible for JIT.

    Empty/unset => any domain is allowed. Spec FR-006 — defense-in-depth
    against accidentally provisioning external users from a federated IdP
    that returns a non-corporate email.
    """
    raw = os.environ.get("SLACK_JIT_ALLOWED_EMAIL_DOMAINS", "").strip()
    if not raw:
        return None
    return {d.strip().lower() for d in raw.split(",") if d.strip()}


def _email_domain(email: str) -> str:
    at = email.rfind("@")
    return email[at + 1:].lower() if at >= 0 else ""

_SLACK_BOT_TOKEN = os.environ.get(
    "SLACK_INTEGRATION_BOT_TOKEN",
    os.environ.get("SLACK_BOT_TOKEN", ""),
)


async def _get_slack_user_email(slack_user_id: str) -> Optional[str]:
    """Fetch the primary email for a Slack user via the Web API."""
    token = _SLACK_BOT_TOKEN
    if not token:
        logger.warning("No Slack bot token configured — cannot auto-bootstrap user %s", slack_user_id)
        return None

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://slack.com/api/users.info",
                params={"user": slack_user_id},
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                logger.warning("Slack users.info error for %s: %s", slack_user_id, data.get("error"))
                return None
            return data.get("user", {}).get("profile", {}).get("email")
    except Exception as exc:
        logger.warning("Failed to fetch Slack email for %s: %s", slack_user_id, exc)
        return None


async def auto_bootstrap_slack_user(slack_user_id: str) -> Optional[str]:
    """Auto-link a Slack user to Keycloak by matching their email.

    Fetches the user's Slack profile email and:

    1. If a Keycloak user with that email already exists, write the
       ``slack_user_id`` attribute to complete the link (the original
       behaviour, unchanged).
    2. Else, if ``SLACK_JIT_CREATE_USER=true`` (the default) and the
       email domain passes the optional
       ``SLACK_JIT_ALLOWED_EMAIL_DOMAINS`` allowlist, create a
       federated-only Keycloak shell user via
       :func:`keycloak_admin.create_user_from_slack` and return its
       UUID. Spec 103 G1 / FR-002.
    3. Else, return ``None`` so the caller treats the user as unlinked
       (minimum-access fallback, contact-admin messaging).

    Logging contract (FR-010, FR-011): all log lines that reference the
    Slack profile email do so via :func:`mask_email`. JIT failures log
    a stable ``error_kind=...`` token so SIEM rules can group on it.
    """
    email = await _get_slack_user_email(slack_user_id)
    if not email:
        logger.debug("Auto-bootstrap: no email for slack_user_id=%s", slack_user_id)
        return None

    kc_user = await get_user_by_email(email)
    if kc_user is not None:
        if not kc_user.get("enabled", True):
            logger.warning(
                "Auto-bootstrap: Keycloak user %s (email=%s) is disabled",
                kc_user.get("id"), mask_email(email),
            )
            return None

        kc_user_id = kc_user["id"]
        await set_user_attribute(kc_user_id, "slack_user_id", slack_user_id)
        logger.info(
            "Auto-bootstrapped (existing user): slack=%s -> keycloak=%s (email=%s)",
            slack_user_id, kc_user_id, mask_email(email),
        )
        return kc_user_id

    # No Keycloak user with that email yet. Decide whether to JIT.
    if not _jit_enabled():
        logger.info(
            "JIT disabled (SLACK_JIT_CREATE_USER=false); treating as "
            "unlinked for slack=%s email=%s",
            slack_user_id, mask_email(email),
        )
        return None

    allowlist = _jit_allowed_email_domains()
    if allowlist is not None:
        domain = _email_domain(email)
        if domain not in allowlist:
            logger.info(
                "JIT skipped: domain=%s not in SLACK_JIT_ALLOWED_EMAIL_DOMAINS "
                "for slack=%s email=%s",
                domain, slack_user_id, mask_email(email),
            )
            return None

    try:
        kc_user_id = await create_user_from_slack(slack_user_id, email)
    except JitError as jerr:
        logger.warning(
            "JIT user creation failed: event=jit_failed error_kind=%s "
            "slack=%s email=%s detail=%s",
            jerr.error_kind, slack_user_id, mask_email(email), jerr,
        )
        return None
    except Exception as exc:  # noqa: BLE001 — last-resort guard
        # Belt-and-suspenders: any unexpected exception falls back to the
        # link flow rather than blowing up the Slack request handler.
        logger.warning(
            "JIT user creation failed (unexpected): event=jit_failed "
            "error_kind=unexpected slack=%s email=%s detail=%s",
            slack_user_id, mask_email(email), exc,
        )
        return None

    logger.info(
        "JIT user provisioned: event=jit_created slack=%s keycloak=%s email=%s",
        slack_user_id, kc_user_id, mask_email(email),
    )
    return kc_user_id


async def resolve_slack_user(slack_user_id: str) -> Optional[str]:
    """Resolve a Slack user ID to a Keycloak user ID.

    Queries Keycloak Admin API for a user with ``slack_user_id`` attribute
    matching the given value. Returns the Keycloak user ID or ``None`` if
    there is no match, the user record has no ``id``, or the account is
    disabled (invalidated link — treated as unlinked).
    """
    user = await get_user_by_attribute("slack_user_id", slack_user_id)
    if user is None:
        return None

    if not user.get("enabled", True):
        logger.warning(
            "Linked Keycloak user %s is disabled for slack_user_id=%s",
            user.get("id"),
            slack_user_id,
        )
        return None

    return user.get("id")


async def complete_linking(slack_user_id: str, keycloak_user_id: str) -> bool:
    """Finalize the identity link.

    Writes ``slack_user_id`` as a Keycloak user attribute via the Admin API.
    Returns True on success.
    """
    await set_user_attribute(
        user_id=keycloak_user_id,
        attr="slack_user_id",
        value=slack_user_id,
    )

    logger.info(
        "Identity linked: slack=%s → keycloak=%s",
        slack_user_id,
        keycloak_user_id,
    )
    return True



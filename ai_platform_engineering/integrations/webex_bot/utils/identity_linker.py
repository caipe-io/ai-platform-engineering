"""Webex-to-Keycloak identity linking."""

from __future__ import annotations

import logging
import os
import base64
from typing import Any, Optional

import httpx
from pymongo.errors import PyMongoError

from .audit import log_webex_authz_decision
from .identity_write_lock import webex_identity_write_lock
from .webex_bot_catalog import configured_webex_bot

from .keycloak_admin import WEBEX_USER_ATTRIBUTE, get_user_by_attribute, get_user_by_id, get_unique_verified_user_by_email, set_user_attribute
from .webex_ids import is_valid_webex_person_id

logger = logging.getLogger("caipe.webex_bot.identity_linker")

_LINK_BASE_URL = os.environ.get(
    "WEBEX_LINKING_BASE_URL",
    os.environ.get("CAIPE_UI_BASE_URL", "http://localhost:3000"),
)

async def generate_linking_url(webex_user_id: str) -> str:
    """Return the CAIPE UI's Webex OAuth account-linking entry point.

    The link does not carry the Webex person id or any bot-issued token —
    ``/api/auth/webex-link/start`` requires its own CAIPE login and then
    verifies the caller's Webex identity via a real Webex OAuth round trip
    (see ``ui/src/app/api/auth/webex-link/{start,callback}/route.ts``), so
    the URL is not a bearer credential someone else could redeem to claim
    a different Webex identity.
    """
    del webex_user_id  # unused: identity is proven by Webex OAuth, not the URL
    base = _LINK_BASE_URL.rstrip("/")
    url = f"{base}/api/auth/webex-link/start"

    if os.environ.get("NODE_ENV") == "production" and not url.startswith("https://"):
        raise ValueError("Linking URLs must use HTTPS in production")

    return url


async def resolve_webex_user(webex_user_id: str) -> Optional[str]:
    """Resolve a Webex person ID to a Keycloak user ID via ``webex_user_id``."""
    if not is_valid_webex_person_id(webex_user_id):
        logger.warning("Rejected identity lookup for invalid Webex person id shape")
        return None

    user = await get_user_by_attribute(WEBEX_USER_ATTRIBUTE, webex_user_id)
    if user is None:
        return None
    if not user.get("enabled", True):
        logger.warning(
            "Linked Keycloak user %s is disabled for webex_user_id=%s",
            user.get("id"),
            webex_user_id,
        )
        return None
    keycloak_user_id = user.get("id")
    return keycloak_user_id


async def complete_linking(webex_user_id: str, keycloak_user_id: str) -> bool:
    """Write ``webex_user_id`` on the Keycloak user."""
    async with webex_identity_write_lock():
        existing = await get_user_by_attribute(WEBEX_USER_ATTRIBUTE, webex_user_id)
        if existing and existing.get("id") != keycloak_user_id:
            return False
        user = await get_user_by_id(keycloak_user_id)
        linked = _attribute(user or {}, WEBEX_USER_ATTRIBUTE)
        if linked and linked != webex_user_id:
            return False
        await set_user_attribute(user_id=keycloak_user_id, attr=WEBEX_USER_ATTRIBUTE, value=webex_user_id)
    logger.info("Identity linked: webex=%s → keycloak=%s", webex_user_id, keycloak_user_id)
    return True


def _attribute(user: dict[str, Any], name: str) -> str:
    value = (user.get("attributes") or {}).get(name, [])
    return str(value[0]) if isinstance(value, list) and value else ""


def webex_auto_link_status() -> dict[str, bool]:
    """Expose configuration posture without tokens or organization identities."""
    enabled = os.environ.get("WEBEX_DM_AUTO_LINK_ENABLED", "false").strip().lower() == "true"
    return {"enabled": enabled, "configured": enabled and bool(os.environ.get("WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID", "").strip()) and bool(os.environ.get("MONGODB_URI", "").strip())}


def _organization_id(value: str) -> str:
    try:
        decoded = base64.b64decode(value + "=" * (-len(value) % 4)).decode()
        if "/ORGANIZATION/" in decoded:
            return decoded.rsplit("/", 1)[-1]
    except (ValueError, UnicodeDecodeError):
        pass
    return value


async def auto_link_webex_user(webex_user_id: str, bot_id: str) -> Optional[str]:
    """Link a trusted provider profile to one verified existing account in a DM."""
    status = webex_auto_link_status()
    if not status["configured"] or not is_valid_webex_person_id(webex_user_id):
        return None
    bot = configured_webex_bot(bot_id)
    if bot is None or bot.direct_messages_access_mode == "disabled":
        return None
    token = os.environ.get(bot.token_env, "").strip()
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            profile = await client.get(f"https://webexapis.com/v1/people/{webex_user_id}", headers={"Authorization": f"Bearer {token}"})
            profile.raise_for_status()
            person = profile.json()
        emails = person.get("emails")
        allowed_org = os.environ["WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID"].strip()
        if person.get("id") != webex_user_id or person.get("type") != "person" or _organization_id(str(person.get("orgId", ""))) != _organization_id(allowed_org):
            return None
        if not isinstance(emails, list) or len(emails) != 1 or not isinstance(emails[0], str) or "@" not in emails[0]:
            return None
        email = emails[0].strip()
        async with webex_identity_write_lock():
            # Re-read inside the cross-runtime lock; concurrent messages reuse the first claim.
            existing = await get_user_by_attribute(WEBEX_USER_ATTRIBUTE, webex_user_id)
            user = await get_unique_verified_user_by_email(email)
            if user is None or not isinstance(user.get("id"), str):
                return None
            owner = user["id"]
            if _attribute(user, "webex_auto_link_disabled") == "true":
                return None
            if existing:
                return owner if existing.get("id") == owner and existing.get("enabled") is True else None
            linked = _attribute(user, WEBEX_USER_ATTRIBUTE)
            if linked and linked != webex_user_id:
                return None
            await set_user_attribute(owner, WEBEX_USER_ATTRIBUTE, webex_user_id)
            persisted = await get_user_by_id(owner)
            if persisted is None or not persisted.get("enabled") or _attribute(persisted, WEBEX_USER_ATTRIBUTE) != webex_user_id:
                return None
        log_webex_authz_decision(tenant_id=_organization_id(allowed_org), sub=owner, outcome="allow", reason_code="WEBEX_IDENTITY_AUTO_LINKED", pdp="keycloak", webex_person_id=webex_user_id)
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                reply = await client.post(
                    "https://webexapis.com/v1/messages",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"toPersonId": webex_user_id, "markdown": (
                        "Your Webex identity was linked automatically under this deployment's policy. "
                        "I will now check agent access and process your message. You can unlink your identity in account settings."
                    )},
                )
                reply.raise_for_status()
        except httpx.HTTPError:
            logger.warning("Webex automatic identity-link acknowledgement could not be delivered")
        return owner
    except (httpx.HTTPError, PyMongoError, ValueError, KeyError, TypeError):
        logger.warning("Webex automatic identity linking unavailable; falling back to explicit linking")
        return None


class WebexIdentityLinker:
    """Injectable identity linker for the Webex runtime gate."""

    async def resolve(self, webex_user_id: str) -> Optional[str]:
        return await resolve_webex_user(webex_user_id)

    async def auto_link(self, webex_user_id: str, bot_id: str) -> Optional[str]:
        return await auto_link_webex_user(webex_user_id, bot_id)

    async def linking_url(self, webex_user_id: str) -> Optional[str]:
        try:
            return await generate_linking_url(webex_user_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not mint Webex linking URL: %s", exc)
            return None

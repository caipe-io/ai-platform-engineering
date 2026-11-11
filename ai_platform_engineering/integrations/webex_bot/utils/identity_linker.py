"""Webex-to-Keycloak identity linking."""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from pymongo.errors import PyMongoError

from .audit import log_webex_authz_decision
from .identity_write_lock import (
    IdentityLinkRejected, identity_binding_collection, identity_key, webex_identity_write_lock,
)
from .keycloak_admin import (
    WEBEX_USER_ATTRIBUTE,
    get_unique_verified_user_by_email,
    get_user_by_attribute,
    get_user_by_id,
    merge_user_attributes,
    webex_identity_owners,
)
from .webex_bot_catalog import configured_webex_bot
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
        logger.warning("Linked Webex platform identity is disabled")
        return None
    keycloak_user_id = user.get("id")
    return keycloak_user_id


def auto_link_enabled() -> bool:
    """Explicit deployment opt-in; DM admission policy is independent."""
    return os.environ.get("WEBEX_DM_AUTO_LINK_ENABLED", "false").strip().lower() == "true"


def webex_auto_link_status() -> dict[str, bool]:
    """Expose configuration posture without tokens or organization identities."""
    enabled = auto_link_enabled()
    return {
        "enabled": enabled,
        "configured": enabled and bool(os.environ.get("WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID", "").strip())
        and bool(os.environ.get("MONGODB_URI", "").strip()),
    }


@dataclass(frozen=True)
class AutoLinkResult:
    user_id: str | None = None
    created: bool = False
    outcome: str = "disabled"


def _org_id(raw: str) -> str:
    try:
        decoded = base64.b64decode(raw + "=" * (-len(raw) % 4), validate=True).decode("utf-8")
    except ValueError, UnicodeDecodeError:
        return raw
    return decoded.rsplit("/ORGANIZATION/", 1)[-1] if "/ORGANIZATION/" in decoded else raw


async def _provider_profile(person_id: str, bot_id: str) -> dict[str, Any]:
    bot = configured_webex_bot(bot_id)
    token = os.environ.get(bot.token_env, "").strip() if bot else ""
    if not bot or bot.direct_messages_access_mode == "disabled" or not token:
        raise IdentityLinkRejected("bot_unavailable")
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
        response = await client.get(
            f"https://webexapis.com/v1/people/{person_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        return response.json()


async def _claim_identity(
    person_id: str, user_id: str, *, email: str | None = None
) -> AutoLinkResult:
    async with webex_identity_write_lock():
        try:
            collection = identity_binding_collection()
            if await asyncio.to_thread(
                collection.find_one, {"_id": identity_key("blocked", person_id)}
            ):
                raise IdentityLinkRejected("unlinked")
            binding = await asyncio.to_thread(
                collection.find_one, {"_id": identity_key("binding", person_id)}
            )
            account = await asyncio.to_thread(
                collection.find_one, {"_id": identity_key("account", user_id)}
            )
            if (binding and binding.get("user_id") != user_id) or (
                account and account.get("person_id") != person_id
            ):
                raise IdentityLinkRejected("conflicting_binding")
            if email:
                unique = await get_unique_verified_user_by_email(email)
                if unique is None or unique.get("id") != user_id:
                    raise IdentityLinkRejected("no_unique_match")
            user = await get_user_by_id(user_id)
            if not user or user.get("enabled") is not True:
                raise IdentityLinkRejected("disabled_identity")
            attrs = user.get("attributes") or {}
            if attrs.get("webex_auto_link_disabled") == ["true"]:
                raise IdentityLinkRejected("unlinked")
            if email and (
                user.get("emailVerified") is not True
                or str(user.get("email", "")).strip().lower() != email
            ):
                raise IdentityLinkRejected("untrusted_email")
            owners = await webex_identity_owners(person_id)
            if len(owners) > 1 or any(owner != user_id for owner in owners):
                raise IdentityLinkRejected("conflicting_binding")
            current = attrs.get(WEBEX_USER_ATTRIBUTE) or []
            if current and current != [person_id]:
                raise IdentityLinkRejected("conflicting_binding")
        except IdentityLinkRejected:
            raise
        except (httpx.HTTPError, PyMongoError):
            # No writes were issued; a transient lookup outage must not strand
            # the global mutex and prevent the explicit SSO fallback.
            raise IdentityLinkRejected("lookup_unavailable") from None
        # Durable reciprocal claims protect against directory search-index lag.
        await asyncio.to_thread(
            collection.update_one,
            {"_id": identity_key("binding", person_id)},
            {"$set": {"user_id": user_id}},
            upsert=True,
        )
        await asyncio.to_thread(
            collection.update_one,
            {"_id": identity_key("account", user_id)},
            {"$set": {"person_id": person_id}},
            upsert=True,
        )
        created = not current
        if created:
            await merge_user_attributes(
                user_id,
                {
                    WEBEX_USER_ATTRIBUTE: [person_id],
                    **({"webex_user_email": [email]} if email else {}),
                    "webex_link_method": ["provider_email" if email else "programmatic"],
                    "webex_linked_at": [datetime.now(timezone.utc).isoformat()],
                },
            )
        persisted = await get_user_by_id(user_id)
        if (not persisted or persisted.get("enabled") is not True
                or (persisted.get("attributes") or {}).get(WEBEX_USER_ATTRIBUTE) != [person_id]):
            # The write may have committed partially. Keep its lock until the
            # operator reconciles the directory and durable ownership records.
            raise RuntimeError("Webex identity write could not be verified")
        # Bind only existing routes. No account, admission or permission is created.
        routes = collection.database["webex_direct_user_routes"]
        await asyncio.to_thread(
            routes.update_many,
            {"keycloak_user_id": user_id},
            {
                "$set": {
                    "webex_user_id": person_id,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            },
        )
        return AutoLinkResult(user_id, created, "linked" if created else "already_linked")


async def _auto_link_webex_user(
    person_id: str, bot_id: str, *, tenant_id: str = "default"
) -> AutoLinkResult:
    """Match provider-owned data to one enabled, verified existing realm user."""
    if not webex_auto_link_status()["configured"]:
        return AutoLinkResult()
    try:
        if not is_valid_webex_person_id(person_id):
            raise IdentityLinkRejected("invalid_person")
        profile = await _provider_profile(person_id, bot_id)
        if profile.get("id") != person_id or profile.get("type") != "person":
            raise IdentityLinkRejected("untrusted_profile")
        org = profile.get("orgId")
        if not isinstance(org, str) or _org_id(org) != _org_id(
            os.environ["WEBEX_DM_AUTO_LINK_ALLOWED_ORG_ID"].strip()
        ):
            raise IdentityLinkRejected("disallowed_org")
        emails = profile.get("emails")
        if not isinstance(emails, list) or len(emails) != 1 or not isinstance(emails[0], str):
            raise IdentityLinkRejected("untrusted_email")
        email = emails[0].strip().lower()
        if len(email) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise IdentityLinkRejected("untrusted_email")
        user = await get_unique_verified_user_by_email(email)
        if not user or not isinstance(user.get("id"), str) or not user["id"]:
            raise IdentityLinkRejected("no_unique_match")
        if user.get("enabled") is not True or user.get("emailVerified") is not True:
            raise IdentityLinkRejected("untrusted_identity")
        result = await _claim_identity(person_id, user["id"], email=email)
    except IdentityLinkRejected as exc:
        result = AutoLinkResult(outcome=str(exc))
    except Exception as exc:  # noqa: BLE001 - optional matching always falls back to SSO
        logger.warning("Webex auto-link unavailable (type=%s)", type(exc).__name__)
        result = AutoLinkResult(outcome="unavailable")
    log_webex_authz_decision(
        tenant_id=tenant_id,
        sub=result.user_id or person_id,
        webex_person_id=person_id,
        outcome="allow" if result.user_id else "deny",
        reason_code="WEBEX_IDENTITY_AUTO_LINKED" if result.user_id else "WEBEX_IDENTITY_AUTO_LINK_REJECTED",
        pdp="keycloak",
        capability="webex#identity_auto_link",
        resource_ref=result.outcome,
    )
    return result


async def auto_link_webex_user(webex_user_id: str, bot_id: str) -> Optional[str]:
    """Link one existing trusted account; retain explicit SSO as the fallback."""
    result = await _auto_link_webex_user(webex_user_id, bot_id)
    if result.created:
        bot = configured_webex_bot(bot_id)
        token = os.environ.get(bot.token_env, "").strip() if bot else ""
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                response = await client.post(
                    "https://webexapis.com/v1/messages",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"toPersonId": webex_user_id, "markdown": (
                        "Your Webex identity was linked automatically under this deployment's policy. "
                        "Your existing access permissions apply. You can unlink your identity in account settings."
                    )},
                )
                response.raise_for_status()
        except httpx.HTTPError:
            logger.warning("Webex automatic identity-link acknowledgement could not be delivered")
    return result.user_id


async def complete_linking(webex_user_id: str, keycloak_user_id: str) -> bool:
    """Legacy programmatic claim; uses the same ownership and unlink guards."""
    if not is_valid_webex_person_id(webex_user_id):
        return False
    result = await _claim_identity(webex_user_id, keycloak_user_id)
    return result.user_id is not None


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

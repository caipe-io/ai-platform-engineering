"""Webex-to-Keycloak identity linking."""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

from .keycloak_admin import WEBEX_USER_ATTRIBUTE, get_user_by_attribute, set_user_attribute
from .webex_ids import is_valid_webex_person_id

logger = logging.getLogger("caipe.webex_bot.identity_linker")

_LINK_BASE_URL = os.environ.get(
    "WEBEX_LINKING_BASE_URL",
    os.environ.get("CAIPE_UI_BASE_URL", "http://localhost:3000"),
)

# Brief positive cache so a just-completed SSO link is visible before Keycloak
# attribute search catches up on the next Webex message.
_RESOLVE_CACHE_TTL_SECONDS = 60
_resolve_cache: dict[str, tuple[str, float]] = {}


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

    cached = _resolve_cache.get(webex_user_id)
    if cached is not None:
        keycloak_user_id, expires_at = cached
        if time.time() < expires_at:
            return keycloak_user_id
        _resolve_cache.pop(webex_user_id, None)

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
    if keycloak_user_id:
        _resolve_cache[webex_user_id] = (keycloak_user_id, time.time() + _RESOLVE_CACHE_TTL_SECONDS)
    return keycloak_user_id


async def complete_linking(webex_user_id: str, keycloak_user_id: str) -> bool:
    """Write ``webex_user_id`` on the Keycloak user."""
    await set_user_attribute(
        user_id=keycloak_user_id,
        attr=WEBEX_USER_ATTRIBUTE,
        value=webex_user_id,
    )
    _resolve_cache[webex_user_id] = (
        keycloak_user_id,
        time.time() + _RESOLVE_CACHE_TTL_SECONDS,
    )
    logger.info("Identity linked: webex=%s → keycloak=%s", webex_user_id, keycloak_user_id)
    return True


class WebexIdentityLinker:
    """Injectable identity linker for the Webex runtime gate."""

    async def resolve(self, webex_user_id: str) -> Optional[str]:
        return await resolve_webex_user(webex_user_id)

    async def linking_url(self, webex_user_id: str) -> Optional[str]:
        try:
            return await generate_linking_url(webex_user_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not mint Webex linking URL: %s", exc)
            return None

"""Keycloak Admin API helpers for Webex identity linking."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .webex_ids import is_valid_webex_person_id

logger = logging.getLogger("caipe.webex_bot.keycloak_admin")

WEBEX_USER_ATTRIBUTE = "webex_user_id"

_USER_PROFILE_ROUNDTRIP_FIELDS = (
    "username",
    "email",
    "firstName",
    "lastName",
    "emailVerified",
    "enabled",
)


@dataclass(frozen=True)
class KeycloakAdminConfig:
    server_url: str = field(
        default_factory=lambda: os.environ.get("KEYCLOAK_URL", "http://localhost:7080")
    )
    realm: str = field(default_factory=lambda: os.environ.get("KEYCLOAK_REALM", "caipe"))
    client_id: str = field(
        default_factory=lambda: os.environ.get(
            "KEYCLOAK_WEBEX_BOT_ADMIN_CLIENT_ID", "caipe-platform"
        )
    )
    client_secret: Optional[str] = field(
        default_factory=lambda: os.environ.get("KEYCLOAK_WEBEX_BOT_ADMIN_CLIENT_SECRET")
    )


_default_config = KeycloakAdminConfig()


async def _get_admin_token(config: KeycloakAdminConfig) -> str:
    endpoint = f"{config.server_url}/realms/{config.realm}/protocol/openid-connect/token"
    async with httpx.AsyncClient(timeout=10.0) as client:
        data: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": config.client_id,
        }
        if config.client_secret:
            data["client_secret"] = config.client_secret
        resp = await client.post(endpoint, data=data)
        resp.raise_for_status()
        return resp.json()["access_token"]


async def get_user_by_attribute(
    attr: str,
    value: str,
    config: KeycloakAdminConfig | None = None,
) -> Optional[dict[str, Any]]:
    """Find a Keycloak user whose attribute *attr* equals *value*."""
    if attr == WEBEX_USER_ATTRIBUTE and not is_valid_webex_person_id(value):
        logger.warning("Rejected Keycloak lookup for invalid webex_user_id shape")
        return None
    cfg = config or _default_config
    token = await _get_admin_token(cfg)
    url = f"{cfg.server_url}/admin/realms/{cfg.realm}/users"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            url,
            params={"q": f"{attr}:{value}", "max": 5},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        users = resp.json()
        matches = []
        for user in users:
            attrs = user.get("attributes") or {}
            raw = attrs.get(attr)
            values = raw if isinstance(raw, list) else [raw]
            if any(isinstance(stored, str) and stored.strip() == value for stored in values):
                matches.append(user)
        return matches[0] if len(matches) == 1 else None


def _user_profile_roundtrip(user_repr: dict[str, Any]) -> dict[str, Any]:
    return {
        field: user_repr[field] for field in _USER_PROFILE_ROUNDTRIP_FIELDS if field in user_repr
    }


async def set_user_attribute(
    user_id: str,
    attr: str,
    value: str,
    config: KeycloakAdminConfig | None = None,
) -> None:
    """Set a single-valued Keycloak user attribute."""
    await merge_user_attributes(user_id, {attr: [value]}, config)


async def merge_user_attributes(
    user_id: str,
    attributes: dict[str, list[str]],
    config: KeycloakAdminConfig | None = None,
) -> None:
    """Merge identity metadata without losing the existing user profile."""
    cfg = config or _default_config
    token = await _get_admin_token(cfg)
    url = f"{cfg.server_url}/admin/realms/{cfg.realm}/users/{user_id}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        resp.raise_for_status()
        user_repr = resp.json()
        attrs = user_repr.get("attributes") or {}
        attrs.update(attributes)
        body = {**_user_profile_roundtrip(user_repr), "attributes": attrs}
        put = await client.put(
            url,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        put.raise_for_status()


async def get_user_by_id(
    user_id: str,
    config: KeycloakAdminConfig | None = None,
) -> Optional[dict[str, Any]]:
    """Fetch a Keycloak user by UUID."""
    cfg = config or _default_config
    token = await _get_admin_token(cfg)
    url = f"{cfg.server_url}/admin/realms/{cfg.realm}/users/{user_id}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


async def get_unique_verified_user_by_email(email: str, config: KeycloakAdminConfig | None = None) -> Optional[dict[str, Any]]:
    """Require one exact, verified, enabled existing account; never create users."""
    cfg = config or _default_config
    token = await _get_admin_token(cfg)
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{cfg.server_url}/admin/realms/{cfg.realm}/users",
            params={"email": email, "exact": "true", "max": 2},
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        users = response.json()
    if not isinstance(users, list) or len(users) != 1:
        return None
    user = users[0]
    if user.get("enabled") is not True or user.get("emailVerified") is not True or str(user.get("email", "")).casefold() != email.casefold():
        return None
    return user


async def webex_identity_owners(webex_user_id: str) -> list[str]:
    """Return all exact owners, rejecting truncated/ambiguous search results."""
    cfg = _default_config
    token = await _get_admin_token(cfg)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{cfg.server_url}/admin/realms/{cfg.realm}/users",
            params={"q": f"{WEBEX_USER_ATTRIBUTE}:{webex_user_id}", "max": 2},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        users = resp.json()
        # Conservatively reject any multi-result query, including legacy duplicates.
        if len(users) > 1:
            return [str(user.get("id") or "") for user in users]
        owners = []
        for user in users:
            raw = (user.get("attributes") or {}).get(WEBEX_USER_ATTRIBUTE, [])
            values = raw if isinstance(raw, list) else [raw]
            if webex_user_id in values:
                owners.append(str(user["id"]))
        return owners

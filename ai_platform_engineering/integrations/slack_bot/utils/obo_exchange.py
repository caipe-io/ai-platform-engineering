"""On-Behalf-Of (OBO) token exchange client (RFC 8693).

Slack bot OBO tokens are team-agnostic platform tokens. Team scope is
resolved from channel context by the Web UI BFF, RAG server, and Dynamic
Agents.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Optional

import httpx

logger = logging.getLogger("caipe.slack_bot.obo_exchange")


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")


def _is_valid_slug(slug: str) -> bool:
    """Mirror of `isValidTeamSlug` in `ui/src/lib/rbac/keycloak-admin.ts`.

    Other modules, including channel team resolution, depend on the same
    slug contract.
    """
    return bool(slug) and len(slug) <= 63 and bool(_SLUG_RE.match(slug))


@dataclass(frozen=True)
class OboToken:
    access_token: str
    token_type: str
    expires_in: int
    scope: Optional[str] = None


@dataclass(frozen=True)
class OboExchangeConfig:
    server_url: str = field(
        default_factory=lambda: os.environ.get("KEYCLOAK_URL", "http://localhost:7080")
    )
    realm: str = field(
        default_factory=lambda: os.environ.get("KEYCLOAK_REALM", "caipe")
    )
    bot_client_id: str = field(
        default_factory=lambda: os.environ.get("KEYCLOAK_BOT_CLIENT_ID", "caipe-slack-bot")
    )
    bot_client_secret: Optional[str] = field(
        default_factory=lambda: os.environ.get("KEYCLOAK_BOT_CLIENT_SECRET")
    )
    # Bot OBO tokens are sent first to the CAIPE UI BFF access-check/proxy
    # routes. Dynamic Agents and AgentGateway accept this audience as a
    # platform token when the BFF forwards the same bearer downstream.
    caipe_platform_audience: str = field(
        default_factory=lambda: os.environ.get(
            "KEYCLOAK_BOT_AUDIENCE",
            os.environ.get("CAIPE_PLATFORM_AUDIENCE", "caipe-platform"),
        )
    )


_default_config = OboExchangeConfig()


async def exchange_token(
    subject_token: str,
    config: OboExchangeConfig | None = None,
) -> OboToken:
    """Exchange a user access token for an OBO token via RFC 8693.

    Team-agnostic: the bot asks Keycloak only for the platform audience;
    team scope is derived downstream from channel context.
    """
    cfg = config or _default_config
    endpoint = (
        f"{cfg.server_url}/realms/{cfg.realm}/protocol/openid-connect/token"
    )

    data: dict[str, str] = {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "subject_token": subject_token,
        "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "client_id": cfg.bot_client_id,
        "audience": cfg.caipe_platform_audience,
    }
    if cfg.bot_client_secret:
        data["client_secret"] = cfg.bot_client_secret

    return await _do_exchange(endpoint, data)


async def impersonate_user(
    keycloak_user_id: str,
    config: OboExchangeConfig | None = None,
) -> OboToken:
    """Mint a token impersonating ``keycloak_user_id``.

    Team-agnostic: the bot does NOT select a Keycloak client scope per
    team. Team scope is derived downstream from channel context by the
    Web UI BFF, RAG server, and Dynamic Agents using
    ``channel_team_mappings`` (FR-017).

    Delegates to :func:`impersonate_subject`.

    Args:
        keycloak_user_id: User's Keycloak ``sub`` (UUID).
        config: Optional Keycloak config override.

    Returns:
        :class:`OboToken` whose JWT carries ``sub=<user>`` and
        ``aud=caipe-platform`` by default. The token does not carry a
        team claim — downstream services use channel context.
    """
    return await impersonate_subject(keycloak_user_id, config)


async def impersonate_subject(
    subject_sub: str,
    config: OboExchangeConfig | None = None,
) -> OboToken:
    """Mint a token impersonating any Keycloak subject by ``sub`` (UUID).

    Core implementation shared by :func:`impersonate_user` and
    :func:`impersonate_service_account`.  Callers should prefer the
    named delegates for readability; this function exists so the two
    helpers don't duplicate the request body.
    """
    cfg = config or _default_config
    endpoint = (
        f"{cfg.server_url}/realms/{cfg.realm}/protocol/openid-connect/token"
    )

    data: dict[str, str] = {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "requested_subject": subject_sub,
        "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "client_id": cfg.bot_client_id,
        "audience": cfg.caipe_platform_audience,
    }
    if cfg.bot_client_secret:
        data["client_secret"] = cfg.bot_client_secret

    return await _do_exchange(endpoint, data)


async def impersonate_service_account(
    sa_user_sub: str,
    config: OboExchangeConfig | None = None,
) -> OboToken:
    """Mint a token authenticating AS a service account via naked impersonation.

    Uses the same RFC 8693 token-exchange mechanism as :func:`impersonate_user`,
    but targets the Keycloak *service-account user* that backs the SA's
    Keycloak client.  The ``caipe-slack-bot`` client already holds the
    ``impersonation`` role and token-exchange permission for this realm, so no
    additional setup is required.

    VERIFIED against live Keycloak 26.3 (2026-06-08): the minted token carries::

        sub                = <sa_user_sub>         # SA service-account-user UUID
        preferred_username = service-account-<clientId>
        aud                = caipe-platform

    Because ``preferred_username`` starts with ``service-account-``, all three
    enforcement layers (BFF ``jwt-validation.ts``, DA ``authz.py``,
    bridge ``main.py``) namespace the subject as ``service_account:<sub>``
    rather than ``user:<sub>``.  The absent ``client_id`` claim in the
    impersonated token does **not** affect detection.

    Delegates to :func:`impersonate_subject`.

    Args:
        sa_user_sub: The SA's Keycloak service-account-user ``sub`` (UUID),
            stored as ``sa_sub`` in the Mongo ``service_accounts`` collection.
        config: Optional Keycloak config override (defaults to env vars).

    Returns:
        :class:`OboToken` whose JWT namespaces downstream as
        ``service_account:<sa_user_sub>``.
    """
    return await impersonate_subject(sa_user_sub, config)


async def _do_exchange(
    endpoint: str,
    data: dict[str, str],
) -> OboToken:
    """Shared token exchange request logic."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(endpoint, data=data)

        if resp.status_code != 200:
            body = resp.text
            logger.error(
                "OBO token exchange failed: status=%s body=%s",
                resp.status_code,
                body[:200],
            )
            raise OboExchangeError(
                f"Token exchange failed with status {resp.status_code}"
            )

        payload = resp.json()

    return OboToken(
        access_token=payload["access_token"],
        token_type=payload.get("token_type", "Bearer"),
        expires_in=payload.get("expires_in", 300),
        scope=payload.get("scope"),
    )


class OboExchangeError(Exception):
    """Raised when OBO token exchange fails."""


def downstream_auth_headers(access_token: str) -> dict[str, str]:
    """Headers for outbound platform calls using an OBO token.

    Team scope is derived from channel context by the receiving service,
    not signalled by the caller.
    """
    return {"Authorization": f"Bearer {access_token}"}

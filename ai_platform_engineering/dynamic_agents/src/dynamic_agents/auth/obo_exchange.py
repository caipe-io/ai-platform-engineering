"""OBO (On-Behalf-Of) token exchange for Dynamic Agents.

Spec 102 Phase 8 / T105.

Mints an OBO token via Keycloak token-exchange (RFC 8693) so that
outbound calls from DA to ``agentgateway`` and downstream MCP servers
carry the **user's** identity (``sub=<user>``, ``act.sub=<dynamic-agents-svc>``)
rather than the DA service account's.

Today the runtime simply forwards whatever Bearer JWT the BFF sent us
(see ``services/mcp_client.py`` factory). Token exchange becomes
mandatory when:

- The downstream resource (e.g. an MCP server) requires a different
  audience than the BFF-issued token.
- We need an `act.sub` chain so the audit trail reflects the DA
  service identity in addition to the user.

This module exposes a single ``async def impersonate_user(user_token,
target_audience)`` helper. It caches results per ``(user_sub, audience)``
with a 30s safety margin before expiry. The cache is in-memory and
per-process; a shared Redis cache is tracked as a follow-up in spec
102's ``research.md`` "Open follow-ups" section.

Env vars consumed:

- ``KEYCLOAK_DA_CLIENT_ID``: client id for the dynamic-agents service
  (defaults to ``dynamic-agents`` to match Helm + compose).
- ``KEYCLOAK_DA_CLIENT_SECRET``: client secret for the same.
- ``OIDC_DISCOVERY_URL`` (or ``OIDC_ISSUER``): used to resolve the
  server-side token endpoint. The discovery URL is preferred so a
  browser-facing issuer can differ from the in-cluster Keycloak URL.

If any of these are missing, ``impersonate_user`` returns ``None`` and
logs one WARNING per process startup; callers MUST treat ``None`` as
"forward the original token unchanged" so that local development
without OBO wired still works.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_TOKEN_CACHE_SAFETY_MARGIN_SECONDS = 30
_OBO_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"

_warned_once = False


@dataclass(frozen=True)
class _CacheKey:
    user_sub: str
    audience: str


@dataclass
class _CacheEntry:
    token: str
    expires_at: float


_obo_cache: dict[_CacheKey, _CacheEntry] = {}


def _resolve_token_endpoint() -> Optional[str]:
    """Resolve the Keycloak token endpoint from issuer or discovery URL."""
    discovery = os.environ.get("OIDC_DISCOVERY_URL", "").strip()
    if discovery:
        # Allow either a bare issuer base or the full well-known URL
        if discovery.endswith("/.well-known/openid-configuration"):
            base = discovery[: -len("/.well-known/openid-configuration")]
        else:
            base = discovery.rstrip("/")
        return f"{base}/protocol/openid-connect/token"
    issuer = os.environ.get("OIDC_ISSUER", "").strip()
    if issuer:
        return f"{issuer.rstrip('/')}/protocol/openid-connect/token"
    return None


def _client_credentials() -> Optional[tuple[str, str]]:
    """Resolve dynamic-agents client credentials from env."""
    client_id = os.environ.get("KEYCLOAK_DA_CLIENT_ID", "dynamic-agents").strip()
    client_secret = os.environ.get("KEYCLOAK_DA_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None
    return client_id, client_secret


def _user_sub_from_token(token: str) -> Optional[str]:
    """Extract the user sub claim from an unverified JWT (cache-key only).

    Validation already happened in JwtAuthMiddleware; here we only need a
    stable per-user identifier to key the cache. We deliberately decode
    without verification (and without pulling jose / pyjwt into DA's
    runtime dependency surface) — the cache key would still be valid
    even for a forged token, because the OBO exchange itself rejects
    unsigned tokens.
    """
    import base64
    import json as _json

    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload_b64 = parts[1]
        # Pad for urlsafe base64.
        padding = "=" * (-len(payload_b64) % 4)
        decoded = base64.urlsafe_b64decode(payload_b64 + padding)
        claims = _json.loads(decoded)
        sub = claims.get("sub")
        return str(sub) if sub else None
    except Exception:  # noqa: BLE001
        return None


async def impersonate_user(
    user_token: str,
    target_audience: str,
) -> Optional[str]:
    """Mint an OBO token for ``target_audience`` on behalf of the user.

    Returns the new access token on success, ``None`` if OBO is not
    configured or the exchange failed. Callers MUST fall through to
    forwarding ``user_token`` unchanged on ``None``.
    """
    global _warned_once

    creds = _client_credentials()
    endpoint = _resolve_token_endpoint()
    if creds is None or endpoint is None:
        if not _warned_once:
            logger.warning(
                "OBO not configured (missing KEYCLOAK_DA_CLIENT_SECRET or "
                "OIDC_ISSUER); falling back to forwarding the user token unchanged"
            )
            _warned_once = True
        return None

    user_sub = _user_sub_from_token(user_token)
    if user_sub is None:
        # Cannot key the cache; fall back to forwarding the original.
        return None

    key = _CacheKey(user_sub=user_sub, audience=target_audience)
    cached = _obo_cache.get(key)
    now = time.time()
    if cached and cached.expires_at > now + _TOKEN_CACHE_SAFETY_MARGIN_SECONDS:
        return cached.token

    client_id, client_secret = creds
    data = {
        "grant_type": _OBO_GRANT_TYPE,
        "client_id": client_id,
        "client_secret": client_secret,
        "subject_token": user_token,
        "subject_token_type": _SUBJECT_TOKEN_TYPE,
        "audience": target_audience,
        "requested_token_type": _SUBJECT_TOKEN_TYPE,
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.post(
                endpoint,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        if resp.status_code != 200:
            logger.warning(
                "OBO exchange failed: status=%s body=%s",
                resp.status_code,
                resp.text[:200],
            )
            return None
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("OBO exchange raised: %s", exc)
        return None

    access_token = payload.get("access_token")
    expires_in = int(payload.get("expires_in", 60))
    if not access_token:
        return None

    _obo_cache[key] = _CacheEntry(
        token=access_token,
        expires_at=now + expires_in,
    )
    return access_token


def clear_obo_cache() -> None:
    """Test helper: drop all cached OBO tokens."""
    _obo_cache.clear()
    global _warned_once
    _warned_once = False

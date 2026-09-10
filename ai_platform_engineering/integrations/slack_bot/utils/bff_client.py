# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Shared helpers for Slack-bot → CAIPE BFF (Next.js) HTTP calls.

Several Slack-bot utilities call first-party BFF endpoints. Historically each
one re-derived the base URL, headers, and auth handling independently, which
let them drift (different env precedence, a stale ``User-Agent``, etc.). This
module centralises the pieces every BFF call should share:

* :func:`resolve_bff_base_url` — one canonical base-URL precedence
  (``CAIPE_UI_URL`` → ``CAIPE_API_URL``).
* :func:`bff_headers` — the canonical request headers, including
  ``X-Client-Source: slack-bot`` so the BFF can attribute calls to the bot.
* :func:`service_account_token` — fetch the bot's own client-credentials
  (service-account) token for service-to-service calls that have no user in
  context, gated on ``SLACK_INTEGRATION_ENABLE_AUTH``.

There are two distinct call patterns this module supports:

* **OBO / user-scoped** — the caller already holds the signed-in user's
  bearer token and passes it to :func:`bff_headers` as ``bearer_token``.
* **Service-to-service** — no user in context; the caller asks for the bot's
  own service-account token via :func:`service_account_token` and passes that.

Only :mod:`platform_settings` uses this module today; the OBO clients
(``accessible_agents_client``, ``dm_authz_client``, ``user_preferences_client``)
are slated to adopt it in a follow-up.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger("caipe.slack_bot.bff_client")

# Identifies the Slack bot to the BFF (audit/log attribution). Prefer this over
# a versioned ``User-Agent`` string — the source is stable and meaningful,
# whereas a hardcoded version only goes stale.
BFF_CLIENT_SOURCE = "slack-bot"


def resolve_bff_base_url(explicit: Optional[str] = None) -> str:
    """Return the CAIPE BFF base URL (no trailing slash).

    Precedence: an explicit argument, then ``CAIPE_UI_URL``, then
    ``CAIPE_API_URL``. Returns ``""`` when none are set so callers can treat
    an unconfigured BFF as "no override / unavailable" rather than crashing.
    """
    value = (
        explicit
        if explicit is not None
        else (os.environ.get("CAIPE_UI_URL") or os.environ.get("CAIPE_API_URL") or "")
    )
    return value.rstrip("/")


def bff_headers(
    *,
    bearer_token: Optional[str] = None,
    json_body: bool = False,
) -> dict[str, str]:
    """Build the canonical headers for a BFF request.

    Always sets ``Accept: application/json`` and ``X-Client-Source``. Adds
    ``Authorization: Bearer <token>`` when ``bearer_token`` is provided and
    ``Content-Type: application/json`` when ``json_body`` is True.
    """
    headers = {
        "Accept": "application/json",
        "X-Client-Source": BFF_CLIENT_SOURCE,
    }
    if json_body:
        headers["Content-Type"] = "application/json"
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    return headers


def auth_enabled() -> bool:
    """True when the bot is configured to send a service-account bearer token."""
    return os.environ.get("SLACK_INTEGRATION_ENABLE_AUTH", "false").lower() == "true"


class _ServiceAccountTokenProvider:
    """Lazily build and reuse the bot's OAuth2 client-credentials client.

    The underlying :class:`OAuth2ClientCredentials` caches and refreshes the
    token internally, so we only need to construct it once. Any init/fetch
    failure is logged and surfaced as ``None`` so service-to-service callers
    degrade gracefully (fall back to env/YAML defaults) instead of raising.
    """

    def __init__(self) -> None:
        self._client: Any = None
        self._init_failed = False

    def token(self) -> Optional[str]:
        if not auth_enabled():
            return None
        if self._client is None and not self._init_failed:
            try:
                from .oauth2_client import OAuth2ClientCredentials

                self._client = OAuth2ClientCredentials.from_env()
            except RuntimeError as exc:
                logger.warning("bff_client: OAuth2 client init failed: %s", exc)
                self._init_failed = True
                return None
        if self._client is None:
            return None
        try:
            return self._client.get_access_token()
        except RuntimeError as exc:
            logger.warning("bff_client: OAuth2 token fetch failed: %s", exc)
            return None


_default_token_provider = _ServiceAccountTokenProvider()


def service_account_token() -> Optional[str]:
    """Return the bot's service-account bearer token, or ``None``.

    Returns ``None`` when auth is disabled or the token can't be obtained, so
    service-to-service callers can proceed unauthenticated (and the BFF /
    caller decides how to degrade).
    """
    return _default_token_provider.token()

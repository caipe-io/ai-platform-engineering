# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Resolve the platform unlinked service account via the BFF API.

Replaces the previous direct-MongoDB implementation (PRC-4/5) to keep all
persistence concerns in the BFF tier rather than opening a second database
connection from the bot process.

BFF contract (GET /api/integrations/unlinked-service-account):
    Request:  Authorization: Bearer <bot service-account token>
    Response: { "success": true, "data": { "sa_sub": "<uuid>" | null } }

Auth assumption: the bot authenticates with its own service-account token
obtained via :func:`~bff_client.service_account_token` (the same
``client_credentials`` token used for dynamic-agents requests when
``SLACK_INTEGRATION_ENABLE_AUTH=true``).  When auth is disabled the request
is sent without a bearer token and the BFF must permit unauthenticated calls
to this endpoint.

The public API surface (:func:`get_unlinked_service_account_sub`) and the
TTL-cache + negative-TTL behavior are unchanged so ``app.py`` is not affected.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Optional

import requests as _requests
from requests.exceptions import RequestException

from .bff_client import bff_headers, resolve_bff_base_url, service_account_token

logger = logging.getLogger("caipe.slack_bot.service_account_resolver")

# Positive-result TTL: 5 minutes (the unlinked SA is stable; no need to
# re-query on every event).
_UNLINKED_SA_TTL = float(os.environ.get("UNLINKED_SA_RESOLVER_TTL_SECONDS", "300"))

# Negative-result TTL: much shorter so that a freshly-bootstrapped unlinked SA
# is picked up within ~30 s instead of waiting the full positive TTL.
# Set UNLINKED_SA_RESOLVER_NEGATIVE_TTL_SECONDS=0 to disable negative caching.
_UNLINKED_SA_NEGATIVE_TTL = float(os.environ.get("UNLINKED_SA_RESOLVER_NEGATIVE_TTL_SECONDS", "30"))

# BFF endpoint path for unlinked SA lookup.
_UNLINKED_SA_ENDPOINT = "/api/integrations/unlinked-service-account"


class ServiceAccountResolver:
    """Resolve service account information via the CAIPE BFF."""

    def __init__(self) -> None:
        # Cache: (sub, timestamp) — None means "confirmed not found"
        self._unlinked_cache: tuple[Optional[str], float] = (None, 0.0)

    def get_unlinked_service_account_sub(self) -> Optional[str]:
        """Return ``sa_sub`` for the platform unlinked SA, or ``None``.

        Calls ``GET {CAIPE_API_URL}/api/integrations/unlinked-service-account``
        authenticated with the bot's service-account token.

        Positive results (SA found) are cached for :data:`_UNLINKED_SA_TTL`
        seconds.  Negative results (SA not yet bootstrapped) are cached for
        the shorter :data:`_UNLINKED_SA_NEGATIVE_TTL` so that a freshly-started
        unlinked SA is discovered within ~30 s rather than up to 5 min.

        Never raises; logs a warning on HTTP errors.
        """
        now = time.monotonic()
        cached_sub, cached_at = self._unlinked_cache
        ttl = _UNLINKED_SA_TTL if cached_sub is not None else _UNLINKED_SA_NEGATIVE_TTL
        if now - cached_at < ttl:
            return cached_sub

        sub = self._fetch_unlinked_sub()
        self._unlinked_cache = (sub, now)
        return sub

    def _fetch_unlinked_sub(self) -> Optional[str]:
        base_url = resolve_bff_base_url()
        if not base_url:
            logger.debug(
                "ServiceAccountResolver: no BFF base URL configured "
                "(CAIPE_UI_URL / CAIPE_API_URL unset)"
            )
            return None

        url = f"{base_url}{_UNLINKED_SA_ENDPOINT}"
        token = service_account_token()
        headers = bff_headers(bearer_token=token)

        try:
            resp = _requests.get(url, headers=headers, timeout=5)
            resp.raise_for_status()
        except RequestException as exc:
            logger.warning(
                "ServiceAccountResolver: BFF request failed (%s): %s", url, exc
            )
            return None

        try:
            payload = resp.json()
        except Exception as exc:
            logger.warning(
                "ServiceAccountResolver: BFF response is not valid JSON: %s", exc
            )
            return None

        if not payload.get("success"):
            logger.warning(
                "ServiceAccountResolver: BFF returned success=false: %s",
                payload,
            )
            return None

        data = payload.get("data") or {}
        sub = data.get("sa_sub")
        if sub is None:
            logger.debug("ServiceAccountResolver: BFF returned sa_sub=null (not yet bootstrapped)")
            return None
        if not isinstance(sub, str) or not sub.strip():
            logger.warning(
                "ServiceAccountResolver: BFF returned invalid sa_sub value: %r", sub
            )
            return None

        logger.debug("ServiceAccountResolver: resolved unlinked SA sa_sub=%s", sub)
        return sub.strip()

    def invalidate_unlinked_cache(self) -> None:
        """Force the next call to re-query the BFF."""
        self._unlinked_cache = (None, 0.0)


_default_resolver: Optional[ServiceAccountResolver] = None


def get_service_account_resolver() -> ServiceAccountResolver:
    """Return the process-wide :class:`ServiceAccountResolver` instance."""
    global _default_resolver
    if _default_resolver is None:
        _default_resolver = ServiceAccountResolver()
    return _default_resolver


def get_unlinked_service_account_sub() -> Optional[str]:
    """Convenience wrapper around the default resolver instance."""
    return get_service_account_resolver().get_unlinked_service_account_sub()

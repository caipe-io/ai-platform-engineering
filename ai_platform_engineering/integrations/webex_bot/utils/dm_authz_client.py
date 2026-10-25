"""BFF client for the 1:1 / DM agent-access decision (Webex).

Phase 2 of spec 2026-05-24-derive-team-from-channel. Mirror of the
Slack-bot ``dm_authz_client``. Kept separate because the Webex and
Slack bots ship as independent images and we don't want a cross-import
during build / wheel construction.

See ``slack_bot.utils.dm_authz_client`` for the full design rationale.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

from .interaction_signing import signed_interaction_headers

logger = logging.getLogger("caipe.webex_bot.dm_authz_client")


@dataclass(frozen=True)
class DmAgentAccessDecision:
    allowed: bool
    reason: str
    path: str
    available: bool


def _default_base_url() -> str:
    return (
        os.environ.get("CAIPE_UI_URL")
        or os.environ.get("CAIPE_API_URL")
        or ""
    ).rstrip("/")


_UNAVAILABLE = DmAgentAccessDecision(
    allowed=False,
    reason="PDP_UNAVAILABLE",
    path="unavailable",
    available=False,
)


class DmAuthzClient:
    """Thin wrapper around the BFF ``/api/user/check_agent_access`` route."""

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        timeout_seconds: float = 3.0,
    ) -> None:
        self._base_url = (
            base_url if base_url is not None else _default_base_url()
        ).rstrip("/")
        self._timeout = max(0.5, timeout_seconds)

    @staticmethod
    def _open(request: urllib.request.Request, *, timeout: float):  # noqa: D401
        """urllib.urlopen wrapper that exists solely as a patch point for tests."""
        return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 — internal HTTPS endpoint

    def check_agent_access(
        self,
        *,
        agent_id: str,
        bearer_token: str,
    ) -> DmAgentAccessDecision:
        if not self._base_url or not bearer_token:
            return _UNAVAILABLE

        url = f"{self._base_url}/api/user/check_agent_access"
        body = json.dumps({"agent_id": agent_id}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {bearer_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                **signed_interaction_headers(
                    method="POST",
                    path="/api/user/check_agent_access",
                    kind="direct",
                ),
            },
        )

        try:
            with self._open(request, timeout=self._timeout) as response:  # noqa: S310
                status = (
                    getattr(response, "status", None)
                    or getattr(response, "code", 0)
                )
                if status < 200 or status >= 300:
                    logger.info("dm_authz BFF non-2xx (status=%s)", status)
                    return _UNAVAILABLE
                raw = response.read()
        except urllib.error.HTTPError as exc:
            logger.info("dm_authz BFF HTTPError (status=%s)", exc.code)
            return _UNAVAILABLE
        except (OSError, urllib.error.URLError) as exc:
            logger.info(
                "dm_authz BFF unreachable (%s): %s", type(exc).__name__, exc
            )
            return _UNAVAILABLE

        try:
            payload = json.loads(raw)
        except (ValueError, TypeError) as exc:
            logger.info("dm_authz BFF returned malformed JSON: %s", exc)
            return _UNAVAILABLE

        if not isinstance(payload, dict):
            return _UNAVAILABLE
        data = payload.get("data")
        if not isinstance(data, dict):
            return _UNAVAILABLE

        allowed = bool(data.get("allowed"))
        reason = str(data.get("reason") or "")
        path = str(data.get("path") or "")
        return DmAgentAccessDecision(
            allowed=allowed,
            reason=reason or ("ALLOW" if allowed else "DENY"),
            path=path or ("allowed" if allowed else "denied"),
            available=True,
        )

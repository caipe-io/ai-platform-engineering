# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Webex webhook / websocket event ingestion for the runtime gate."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Optional

from .app import WebexMessageResult, handle_webex_message, parse_webex_event

logger = logging.getLogger("caipe.webex_bot.webex_websocket")

MessageHandler = Callable[..., Awaitable[WebexMessageResult]]

REASON_WEBHOOK_SIGNATURE_INVALID = "WEBEX_WEBHOOK_SIGNATURE_INVALID"


@dataclass(frozen=True)
class WebexIncomingMessage:
    """Normalized Webex message event for dispatch."""

    raw: dict[str, Any]
    event_type: str
    person_id: str
    space_id: str
    text: str


def configured_webhook_secret() -> str | None:
    """Return the configured Webex webhook signing secret, if any."""

    for env_name in ("WEBEX_WEBHOOK_SECRET", "WEBEX_SIGNING_SECRET"):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value
    return None


def verify_webex_webhook_signature(
    raw_body: bytes,
    headers: Mapping[str, str] | None,
) -> bool:
    """Verify Cisco Webex ``X-Spark-Signature`` when a webhook secret is configured."""

    secret = configured_webhook_secret()
    if not secret:
        return True

    if not raw_body:
        return False

    header_map = {key.lower(): value for key, value in (headers or {}).items()}
    signature = header_map.get("x-spark-signature", "").strip()
    if not signature:
        return False

    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha1).hexdigest()
    return hmac.compare_digest(expected, signature)


def normalize_webex_payload(payload: dict[str, Any]) -> Optional[WebexIncomingMessage]:
    """Parse a Webex webhook or websocket payload into gate inputs."""

    event_type = str(payload.get("event") or payload.get("type") or "message").strip()
    if event_type not in {"message", "created", "messages/created"}:
        return None

    parsed = parse_webex_event(payload)
    if parsed is None:
        return None

    return WebexIncomingMessage(
        raw=payload,
        event_type=event_type,
        person_id=parsed.person_id,
        space_id=parsed.space_id,
        text=parsed.text,
    )


class WebexWebSocketRuntime:
    """Receive Webex events and forward them through the RBAC runtime gate."""

    def __init__(
        self,
        *,
        message_handler: MessageHandler | None = None,
        bot_person_id: Optional[str] = None,
        tenant_id: str = "default",
        webhook_secret: str | None = None,
    ) -> None:
        self._handler = message_handler or handle_webex_message
        self._bot_person_id = bot_person_id
        self._tenant_id = tenant_id
        self._webhook_secret = webhook_secret

    def _signature_valid(
        self,
        payload: dict[str, Any],
        *,
        raw_body: bytes | None,
        headers: Mapping[str, str] | None,
    ) -> bool:
        secret = self._webhook_secret if self._webhook_secret is not None else configured_webhook_secret()
        if not secret:
            return True

        body = raw_body
        if body is None:
            body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        return verify_webex_webhook_signature(body, headers)

    async def handle_payload(
        self,
        payload: dict[str, Any],
        *,
        raw_body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> WebexMessageResult:
        """Parse *payload* and run the configured message handler."""

        if not self._signature_valid(payload, raw_body=raw_body, headers=headers):
            return WebexMessageResult(
                allowed=False,
                dispatched=False,
                ignored=False,
                reason_code=REASON_WEBHOOK_SIGNATURE_INVALID,
                deny_message="Webex webhook signature verification failed.",
            )

        normalized = normalize_webex_payload(payload)
        if normalized is None:
            return await self._handler(
                payload,
                bot_person_id=self._bot_person_id,
                tenant_id=self._tenant_id,
            )

        return await self._handler(
            normalized.raw,
            bot_person_id=self._bot_person_id,
            tenant_id=self._tenant_id,
        )

    async def handle_raw_message(
        self,
        *,
        person_id: str,
        space_id: str,
        text: str,
        **extra: Any,
    ) -> WebexMessageResult:
        """Convenience entry for tests and direct message injection."""

        event = {
            "person_id": person_id,
            "space_id": space_id,
            "text": text,
            **extra,
        }
        return await self.handle_payload(event)

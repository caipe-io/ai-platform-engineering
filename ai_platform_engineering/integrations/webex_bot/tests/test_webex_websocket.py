# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex websocket / webhook event dispatch."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any

import pytest

from ai_platform_engineering.integrations.webex_bot.app import REASON_IGNORED_MALFORMED, WebexMessageResult
from ai_platform_engineering.integrations.webex_bot.webex_websocket import (
    REASON_WEBHOOK_SIGNATURE_INVALID,
    WebexWebSocketRuntime,
    normalize_webex_payload,
    verify_webex_webhook_signature,
)


@dataclass
class CapturingHandler:
    calls: list[dict[str, Any]]

    async def __call__(self, event: dict[str, Any], **kwargs: Any) -> WebexMessageResult:
        self.calls.append(event)
        return WebexMessageResult(
            allowed=True,
            dispatched=False,
            ignored=False,
            reason_code="WEBEX_DISPATCH_ALLOWED",
        )


def test_normalize_webex_payload_parses_webhook_shape() -> None:
    payload = {
        "event": "message",
        "data": {
            "botId": "primary",
            "personId": "person1234",
            "roomId": "space12345",
            "text": "hello team",
        },
    }

    normalized = normalize_webex_payload(payload)

    assert normalized is not None
    assert normalized.person_id == "person1234"
    assert normalized.space_id == "space12345"
    assert normalized.text == "hello team"


def test_websocket_runtime_dispatches_to_handler() -> None:
    handler = CapturingHandler(calls=[])
    runtime = WebexWebSocketRuntime(message_handler=handler)

    result = asyncio.run(
        runtime.handle_raw_message(
            person_id="person1234",
            space_id="space12345",
            text="ping",
        )
    )

    assert result.allowed is True
    assert len(handler.calls) == 1
    assert handler.calls[0]["person_id"] == "person1234"
    assert handler.calls[0]["space_id"] == "space12345"


def test_malformed_payload_reaches_gate_for_ignore() -> None:
    runtime = WebexWebSocketRuntime()

    result = asyncio.run(runtime.handle_payload({"event": "message", "data": {"text": "no ids"}}))

    assert result.reason_code == REASON_IGNORED_MALFORMED
    assert result.ignored is True


def _signed_headers(body: bytes, secret: str) -> dict[str, str]:
    signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()
    return {"X-Spark-Signature": signature}


def test_verify_webhook_signature_rejects_unsigned_when_secret_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBEX_WEBHOOK_SECRET", "test-secret")
    body = b'{"event":"message"}'

    assert verify_webex_webhook_signature(body, {}) is False
    assert verify_webex_webhook_signature(body, _signed_headers(body, "test-secret")) is True


def test_runtime_rejects_unsigned_webhook_when_secret_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEBEX_WEBHOOK_SECRET", "test-secret")
    payload = {
        "event": "message",
        "data": {"personId": "person1234", "roomId": "space12345", "text": "hi"},
    }
    runtime = WebexWebSocketRuntime()

    result = asyncio.run(runtime.handle_payload(payload))

    assert result.reason_code == REASON_WEBHOOK_SIGNATURE_INVALID
    assert result.allowed is False


def test_runtime_accepts_signed_webhook_when_secret_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "test-secret"
    monkeypatch.setenv("WEBEX_WEBHOOK_SECRET", secret)
    payload = {
        "event": "message",
        "data": {"personId": "person1234", "roomId": "space12345", "text": "hi"},
    }
    raw_body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    runtime = WebexWebSocketRuntime()

    result = asyncio.run(
        runtime.handle_payload(
            payload,
            raw_body=raw_body,
            headers=_signed_headers(raw_body, secret),
        )
    )

    assert result.reason_code != REASON_WEBHOOK_SIGNATURE_INVALID

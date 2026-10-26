"""Bot proofs bind a native app turn to its trusted event context and OBO token."""

import base64
import hashlib
import hmac
import json

import pytest

from ai_platform_engineering.integrations.webex_bot.utils.native_assistant_context import native_assistant_headers


def test_native_context_binds_actual_body_token_room_and_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "example-shared-key-" * 3
    monkeypatch.setenv("WEBEX_LINK_HMAC_SECRET", secret)
    payload = {"conversation_id": "example-chat", "agent_id": "example-agent", "message": "Hello 🌍",
               "client_context": {"webex_room_id": "example-room", "webex_space_id": "example-space",
                                  "webex_thread_parent_id": "example-thread", "webex_is_direct": True}}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    headers = native_assistant_headers(url="https://example.test/api/v1/chat/stream/start", payload=payload,
                                       body=body, bearer_token="example-token")
    encoded = headers["x-caipe-webex-context"]
    proof = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    assert proof["bodyHash"] == hashlib.sha256(body).hexdigest()
    assert proof["tokenHash"] == hashlib.sha256(b"example-token").hexdigest()
    assert proof["kind"] == "direct"
    assert proof["roomId"] == "example-room"
    assert proof["threadId"] == "example-thread"
    assert proof["path"] == "/api/v1/chat/stream/start"
    assert headers["x-caipe-webex-signature"] == hmac.new(secret.encode(), ("caipe.webex.assistant.v1\n" + encoded).encode(), hashlib.sha256).hexdigest()


def test_missing_proof_configuration_leaves_legacy_transport_unsigned(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEBEX_LINK_HMAC_SECRET", raising=False)
    assert native_assistant_headers(url="https://example.test/api/v1/chat/stream/start", payload={}, body=b"{}", bearer_token="example-token") == {}


def test_unsigned_public_context_is_not_promoted_to_a_room_assertion(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBEX_LINK_HMAC_SECRET", "example-shared-key-" * 3)
    assert native_assistant_headers(url="https://example.test/api/v1/chat/stream/start",
        payload={"client_context": {"surface_kind": "dm"}}, body=b"{}", bearer_token="example-token") == {}

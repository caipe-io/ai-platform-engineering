from unittest.mock import patch

from ai_platform_engineering.integrations.webex_bot.utils.interaction_signing import (
    signed_interaction_headers,
)
from ai_platform_engineering.integrations.webex_bot.a2a_client import _interaction_kind


def test_signs_direct_interaction(monkeypatch):
    monkeypatch.setenv("WEBEX_LINK_HMAC_SECRET", "test-secret")
    with patch(
        "ai_platform_engineering.integrations.webex_bot.utils.interaction_signing.time.time",
        return_value=1_750_000_000,
    ):
        headers = signed_interaction_headers(
            method="POST", path="/api/v1/chat/invoke", kind="direct"
        )

    assert headers["X-CAIPE-Interaction-Source"] == "webex"
    assert headers["X-CAIPE-Interaction-Kind"] == "direct"
    assert len(headers["X-CAIPE-Interaction-Signature"]) == 64


def test_authoritative_room_type_prevents_surface_kind_escalation():
    assert _interaction_kind({"room_type": "group", "surface_kind": "dm"}) == "group"
    assert _interaction_kind({"room_type": "direct", "surface_kind": "channel"}) == "direct"

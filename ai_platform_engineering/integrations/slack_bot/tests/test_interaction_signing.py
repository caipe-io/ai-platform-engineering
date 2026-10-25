import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from ai_platform_engineering.integrations.slack_bot.utils.interaction_signing import (
    signed_interaction_headers,
)
from ai_platform_engineering.integrations.slack_bot.sse_client import _interaction_kind


def test_signs_direct_interaction(monkeypatch):
    monkeypatch.setenv("SLACK_LINK_HMAC_SECRET", "test-secret")
    with patch(
        "ai_platform_engineering.integrations.slack_bot.utils.interaction_signing.time.time",
        return_value=1_750_000_000,
    ):
        headers = signed_interaction_headers(
            method="POST", path="/api/v1/chat/invoke", kind="direct"
        )

    assert headers["X-CAIPE-Interaction-Source"] == "slack"
    assert headers["X-CAIPE-Interaction-Kind"] == "direct"
    assert headers["X-CAIPE-Interaction-Timestamp"] == "1750000000"
    assert len(headers["X-CAIPE-Interaction-Signature"]) == 64


def test_fails_closed_without_secret(monkeypatch):
    monkeypatch.delenv("SLACK_LINK_HMAC_SECRET", raising=False)
    monkeypatch.delenv("SLACK_SIGNING_SECRET", raising=False)
    assert signed_interaction_headers(method="POST", path="/test", kind="direct") == {}


def test_authoritative_channel_type_prevents_surface_kind_escalation():
    assert _interaction_kind({"channel_type": "channel", "surface_kind": "dm"}) == "group"
    assert _interaction_kind({"channel_type": "im", "surface_kind": "channel"}) == "direct"


def test_sse_client_supports_compose_top_level_import():
    bot_dir = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-c", "import sse_client"],
        cwd=bot_dir,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

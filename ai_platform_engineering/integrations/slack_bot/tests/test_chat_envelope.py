"""Tests for slack_bot.utils.chat_envelope.

Phase 1 spec FR-016: bots MUST include the originating channel_id and
workspace_id (and surface_kind, thread_ts) in the chat request envelope
forwarded to Dynamic Agents. Dynamic Agents' ClientContext model uses
extra="allow", so this stays a pure dict-augmentation surface — no DA
model changes.
"""

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.chat_envelope import (
    augment_slack_client_context,
)


class TestAugmentSlackClientContext:
    def test_delivery_id_identifies_the_message_instead_of_the_thread(self) -> None:
        contexts = [augment_slack_client_context(
            {}, channel_id="example-channel", workspace_id="example-workspace",
            thread_ts="100.1", surface_kind="channel", message_ts=message_ts,
        ) for message_ts in ("100.2", "100.2", "100.3")]
        assert contexts[0]["delivery_id"] == contexts[1]["delivery_id"]
        assert contexts[0]["delivery_id"] != contexts[2]["delivery_id"]

    def test_adds_channel_workspace_thread_and_surface_for_channel_message(self):
        base = {"source": "slack", "channel_type": "channel"}
        result = augment_slack_client_context(
            base,
            channel_id="C123CHANNEL",
            workspace_id="T123TEAM",
            thread_ts="1700000000.123456",
            surface_kind="channel",
        )
        assert result["source"] == "slack"
        assert result["channel_type"] == "channel"
        assert result["channel_id"] == "C123CHANNEL"
        assert result["workspace_id"] == "T123TEAM"
        assert result["thread_ts"] == "1700000000.123456"
        assert result["surface_kind"] == "channel"

    def test_dm_surface_kind(self):
        base = {"source": "slack", "channel_type": "dm"}
        result = augment_slack_client_context(
            base,
            channel_id="D123DIRECT",
            workspace_id="T123TEAM",
            thread_ts=None,
            surface_kind="dm",
        )
        assert result["surface_kind"] == "dm"
        assert result["channel_id"] == "D123DIRECT"
        assert result["workspace_id"] == "T123TEAM"
        # thread_ts intentionally omitted when None (it's optional for DMs)
        assert "thread_ts" not in result

    def test_does_not_mutate_input(self):
        base = {"source": "slack", "channel_type": "channel"}
        augment_slack_client_context(
            base,
            channel_id="C1",
            workspace_id="T1",
            thread_ts="t",
            surface_kind="channel",
        )
        assert "channel_id" not in base
        assert "workspace_id" not in base
        assert "surface_kind" not in base

    def test_preserves_existing_keys_added_by_caller(self):
        base = {
            "source": "slack",
            "channel_type": "channel",
            "channel_name": "engineering",
            "user_email": "alice@example.com",
        }
        result = augment_slack_client_context(
            base,
            channel_id="C1",
            workspace_id="T1",
            thread_ts="t",
            surface_kind="channel",
        )
        assert result["channel_name"] == "engineering"
        assert result["user_email"] == "alice@example.com"

    def test_skips_empty_string_workspace_id(self):
        """In some edge events Slack omits team_id; we don't lie by sending ''."""
        base = {"source": "slack", "channel_type": "channel"}
        result = augment_slack_client_context(
            base,
            channel_id="C1",
            workspace_id="",
            thread_ts="t",
            surface_kind="channel",
        )
        assert result["channel_id"] == "C1"
        assert "workspace_id" not in result

    def test_skips_none_channel_id_returns_unchanged_envelope(self):
        """channel_id is the primary derivation key; without it the augment
        is a no-op (callers should only invoke this when channel_id exists)."""
        base = {"source": "slack", "channel_type": "channel"}
        result = augment_slack_client_context(
            base,
            channel_id=None,
            workspace_id="T1",
            thread_ts="t",
            surface_kind="channel",
        )
        assert "channel_id" not in result
        assert "workspace_id" not in result
        assert "surface_kind" not in result

    def test_rejects_invalid_surface_kind(self):
        base = {"source": "slack"}
        with pytest.raises(ValueError, match="surface_kind"):
            augment_slack_client_context(
                base,
                channel_id="C1",
                workspace_id="T1",
                thread_ts="t",
                surface_kind="invalid",  # type: ignore[arg-type]
            )

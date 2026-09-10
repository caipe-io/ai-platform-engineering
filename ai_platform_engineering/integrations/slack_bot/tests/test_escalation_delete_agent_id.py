# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Regression tests: `agent_id` must reach `_resolve_conversation_id`.

`_resolve_conversation_id` performs a get-or-create lookup keyed by
`idempotency_key=thread_ts`, but the conversation-creation API validates
that `agent_id` is non-empty in the request body before it even reaches
that lookup — an empty `agent_id` gets a 400 from the server.

`handle_escalation_get_help` and `handle_delete_message` both parse (or,
before this fix, failed to parse) `agent_id` from the button's pipe-
delimited action value (`f"{channel_id}|{thread_ts}|{ts}|{agent_id}"`,
the same format used by `caipe_feedback` and `caipe_retry`) and must pass
it through to `_resolve_conversation_id`.
"""

from __future__ import annotations

import importlib
import pathlib
import sys
from unittest.mock import MagicMock

import pytest

_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"
_APP_DIR = _APP_PY.parent
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))


class _HealthResponse:
    ok = True
    status_code = 200
    text = "ok"


class _Client:
    def __init__(self) -> None:
        self.ephemeral_posts: list[dict[str, object]] = []
        self.reactions_added: list[dict[str, object]] = []

    def auth_test(self) -> dict[str, str]:
        return {"user_id": "UBOT"}

    def chat_postEphemeral(self, **kwargs: object) -> None:
        self.ephemeral_posts.append(kwargs)

    def chat_postMessage(self, **kwargs: object) -> None:
        pass

    def chat_delete(self, **kwargs: object) -> None:
        pass

    def reactions_add(self, **kwargs: object) -> None:
        self.reactions_added.append(kwargs)


def _load_slack_app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(_APP_DIR))
    monkeypatch.setenv("SLACK_INTEGRATION_BOT_TOKEN", "xoxb-test-token")
    monkeypatch.setenv("CAIPE_API_URL", "http://localhost:3000")
    monkeypatch.setenv("CAIPE_CONNECT_RETRIES", "1")
    monkeypatch.setenv("SLACK_RBAC_ENABLED", "false")
    monkeypatch.setenv("SLACK_INTEGRATION_ENABLE_AUTH", "false")
    monkeypatch.setattr(
        "slack_sdk.web.client.WebClient.auth_test",
        lambda _self, **_kwargs: {"ok": True, "user_id": "UBOT"},
    )
    monkeypatch.setattr("requests.get", lambda *_args, **_kwargs: _HealthResponse())

    for module_name in ("app", "utils.config", "utils.config_models"):
        sys.modules.pop(module_name, None)

    app_module = importlib.import_module("app")

    # submit_feedback_score talks to the CAIPE UI's /api/feedback endpoint —
    # not under test here, and would otherwise make a real HTTP call.
    monkeypatch.setattr(app_module, "submit_feedback_score", MagicMock(return_value=True))
    return app_module


def _action_body(action_id: str, channel_id: str, thread_ts: str, message_ts: str, agent_id: str) -> dict:
    value = f"{channel_id}|{thread_ts}|{message_ts}|{agent_id}"
    return {
        "user": {"id": "U555"},
        "channel": {"id": channel_id},
        "message": {"ts": message_ts, "thread_ts": thread_ts},
        "actions": [{"action_id": action_id, "value": value}],
    }


class TestEscalationGetHelpPassesAgentId:
    """`caipe_escalation_get_help` must thread agent_id through to _resolve_conversation_id."""

    def test_get_help_passes_agent_id_to_resolve_conversation_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        app_module = _load_slack_app(monkeypatch)

        from utils.config_models import EmojiEscalation, EscalationConfig

        esc_config = EscalationConfig(emoji=EmojiEscalation(enabled=True, name="sos"))
        monkeypatch.setattr(app_module, "_resolve_escalation", lambda *_a, **_k: esc_config)
        monkeypatch.setattr(app_module, "resolve_victorops_agent_id", lambda *_a, **_k: None)

        resolve_conversation_id = MagicMock(return_value="conv-123")
        monkeypatch.setattr(app_module, "_resolve_conversation_id", resolve_conversation_id)

        client = _Client()
        body = _action_body(
            "caipe_escalation_get_help",
            channel_id="C123",
            thread_ts="1700000000.000100",
            message_ts="1700000000.000200",
            agent_id="agent-xyz",
        )

        app_module.handle_escalation_get_help(ack=MagicMock(), body=body, client=client)

        resolve_conversation_id.assert_called_once_with("1700000000.000100", "C123", "agent-xyz")

    def test_get_help_emoji_reaction_fires_when_agent_id_present(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """End-to-end: the whole handler must reach execute_escalation() and add the reaction.

        Regression for the bug where an empty agent_id made the conversation-
        creation call 400, which was swallowed by the handler's try/except —
        so execute_escalation() (and the emoji reaction) never ran at all.
        """
        app_module = _load_slack_app(monkeypatch)

        from utils.config_models import EmojiEscalation, EscalationConfig

        esc_config = EscalationConfig(emoji=EmojiEscalation(enabled=True, name="sos"))
        monkeypatch.setattr(app_module, "_resolve_escalation", lambda *_a, **_k: esc_config)
        monkeypatch.setattr(app_module, "resolve_victorops_agent_id", lambda *_a, **_k: None)

        def _fake_resolve_conversation_id(_thread_ts, _channel_id, agent_id="", _owner_id=""):
            # Mirrors the real /api/chat/conversations endpoint, which 400s
            # when agent_id is empty regardless of whether the conversation
            # already exists (idempotency lookup happens after validation).
            if not agent_id:
                raise Exception("Failed to create conversation: HTTP 400 agent_id is required")
            return "conv-123"

        monkeypatch.setattr(app_module, "_resolve_conversation_id", _fake_resolve_conversation_id)
        monkeypatch.setattr(app_module.sse_client, "update_conversation_metadata", MagicMock())

        client = _Client()
        body = _action_body(
            "caipe_escalation_get_help",
            channel_id="C123",
            thread_ts="1700000000.000100",
            message_ts="1700000000.000200",
            agent_id="agent-xyz",
        )

        app_module.handle_escalation_get_help(ack=MagicMock(), body=body, client=client)

        assert client.reactions_added == [
            {"name": "sos", "channel": "C123", "timestamp": "1700000000.000100"}
        ]

    def test_get_help_conversation_lookup_failure_does_not_silently_swallow(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: if _resolve_conversation_id still raises, escalation must not fire.

        This pins down the failure mode of the original bug — if the
        conversation lookup 400s, execute_escalation() (and the emoji
        reaction) never runs, and the exception is swallowed by the
        handler's outer try/except rather than propagating.
        """
        app_module = _load_slack_app(monkeypatch)

        from utils.config_models import EmojiEscalation, EscalationConfig

        esc_config = EscalationConfig(emoji=EmojiEscalation(enabled=True, name="sos"))
        monkeypatch.setattr(app_module, "_resolve_escalation", lambda *_a, **_k: esc_config)
        monkeypatch.setattr(app_module, "resolve_victorops_agent_id", lambda *_a, **_k: None)
        resolve_conversation_id = MagicMock(
            side_effect=Exception("Failed to create conversation: HTTP 400")
        )
        monkeypatch.setattr(app_module, "_resolve_conversation_id", resolve_conversation_id)

        client = _Client()
        body = _action_body(
            "caipe_escalation_get_help",
            channel_id="C123",
            thread_ts="1700000000.000100",
            message_ts="1700000000.000200",
            agent_id="agent-xyz",
        )

        # Handler catches internally and must not raise.
        app_module.handle_escalation_get_help(ack=MagicMock(), body=body, client=client)

        # The call itself must carry agent_id — a pre-fix caller that dropped
        # it wouldn't have failed this loudly in a way distinguishable from
        # "the endpoint was just down", so pin the exact call args too.
        resolve_conversation_id.assert_called_once_with(
            "1700000000.000100", "C123", "agent-xyz"
        )
        assert client.reactions_added == []


class TestDeleteMessagePassesAgentId:
    """`caipe_delete_message` must also parse and thread agent_id through."""

    def test_delete_message_passes_agent_id_to_resolve_conversation_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        app_module = _load_slack_app(monkeypatch)

        resolve_conversation_id = MagicMock(return_value="conv-123")
        monkeypatch.setattr(app_module, "_resolve_conversation_id", resolve_conversation_id)

        client = _Client()
        body = _action_body(
            "caipe_delete_message",
            channel_id="C123",
            thread_ts="1700000000.000100",
            message_ts="1700000000.000200",
            agent_id="agent-xyz",
        )

        app_module.handle_delete_message(ack=MagicMock(), body=body, client=client)

        resolve_conversation_id.assert_called_once_with("1700000000.000100", "C123", "agent-xyz")

    def test_delete_message_with_empty_agent_id_still_passes_empty_string(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When the button value has no agent_id segment, pass "" explicitly
        (matching caipe_feedback/caipe_retry) rather than omitting the arg."""
        app_module = _load_slack_app(monkeypatch)

        resolve_conversation_id = MagicMock(return_value="conv-123")
        monkeypatch.setattr(app_module, "_resolve_conversation_id", resolve_conversation_id)

        client = _Client()
        body = _action_body(
            "caipe_delete_message",
            channel_id="C123",
            thread_ts="1700000000.000100",
            message_ts="1700000000.000200",
            agent_id="",
        )

        app_module.handle_delete_message(ack=MagicMock(), body=body, client=client)

        resolve_conversation_id.assert_called_once_with("1700000000.000100", "C123", "")

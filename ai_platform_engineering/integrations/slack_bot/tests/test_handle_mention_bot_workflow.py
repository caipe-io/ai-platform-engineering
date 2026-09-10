"""Tests for handle_mention's bot/workflow @mention identity resolution.

A Slack Workflow Builder step that @mentions the bot delivers an app_mention
event with `bot_id` set and no `user`. Ephemeral messages can never reach a
bot/workflow (Slack requires a human `user`), so denial paths must silently
drop for bot senders instead of calling chat_postEphemeral with a None user.
Human-sender paths must be unaffected (regression coverage).
"""

from __future__ import annotations

import pathlib
import sys
from unittest.mock import MagicMock

import pytest

_APP_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

from .handler_test_utils import load_handler_module  # noqa: E402

class _Client:
    def __init__(self) -> None:
        self.ephemeral_posts: list[dict[str, object]] = []
        self.channel_posts: list[dict[str, object]] = []

    def auth_test(self) -> dict[str, str]:
        # CAIPE's own bot user id — deliberately distinct from any sender
        # bot's resolved user id so a variable-shadowing regression is
        # caught: the sender's resolved id must never be replaced by this.
        return {"user_id": "UOWNBOT"}

    def users_info(self, **_kwargs: object) -> dict[str, object]:
        return {"user": {"real_name": "Human User", "profile": {"email": "human@example.com"}}}

    def chat_postEphemeral(self, **kwargs: object) -> None:
        self.ephemeral_posts.append(kwargs)

    def chat_postMessage(self, **kwargs: object) -> None:
        self.channel_posts.append(kwargs)


def _load_slack_app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(_APP_DIR))
    app_module = load_handler_module("channel_routing")

    # Isolate handle_mention from network-backed collaborators that aren't
    # under test here — the default agent lookup and thread-deletion check.
    monkeypatch.setattr(app_module, "resolve_default_agent_id", lambda _default: "default-agent")
    monkeypatch.setattr(app_module.utils, "verify_thread_exists", lambda *_a, **_k: True)
    return app_module


def _bot_mention_event(text: str = "run the workflow") -> dict[str, object]:
    return {
        "type": "app_mention",
        "channel": "C123",
        "bot_id": "BWORKFLOW1",
        "ts": "1700000000.000100",
        "text": text,
    }


def _human_mention_event(text: str = "help me") -> dict[str, object]:
    return {
        "type": "app_mention",
        "channel": "C123",
        "user": "U555",
        "ts": "1700000000.000200",
        "text": text,
    }


def test_bot_mention_channel_grant_denied_silently_drops(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ephemeral messages can't reach a bot — a channel-grant denial must log and drop, not call chat_postEphemeral."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module.utils, "get_bot_info_by_id", lambda _bot_id: ("WorkflowBot", "UWORKFLOWUSER"))
    monkeypatch.setattr(app_module, "_slack_agent_channel_grant_check", lambda *_a, **_k: "denied")
    create_conversation = MagicMock()
    monkeypatch.setattr(app_module.sse_client, "create_conversation", create_conversation)

    client = _Client()
    app_module.handle_mention(_bot_mention_event(), say=MagicMock(), client=client, context={})

    assert client.ephemeral_posts == []
    assert client.channel_posts == []
    create_conversation.assert_not_called()


def test_human_mention_channel_grant_denied_posts_ephemeral(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: a human sender's channel-grant denial still posts the ephemeral notice."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module, "_slack_agent_channel_grant_check", lambda *_a, **_k: "denied")

    client = _Client()
    app_module.handle_mention(_human_mention_event(), say=MagicMock(), client=client, context={})

    assert len(client.ephemeral_posts) == 1
    assert client.ephemeral_posts[0]["user"] == "U555"
    assert client.channel_posts == []


def test_bot_mention_agent_access_denied_silently_drops(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bot/workflow sender denied at conversation-create time must drop silently."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module.utils, "get_bot_info_by_id", lambda _bot_id: ("WorkflowBot", "UWORKFLOWUSER"))
    monkeypatch.setattr(app_module, "_slack_agent_channel_grant_check", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module.sse_client,
        "create_conversation",
        MagicMock(side_effect=app_module.AgentAccessDeniedError("default-agent")),
    )

    client = _Client()
    app_module.handle_mention(_bot_mention_event(), say=MagicMock(), client=client, context={})

    assert client.ephemeral_posts == []
    assert client.channel_posts == []


def test_human_mention_agent_access_denied_posts_ephemeral(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: a human sender denied at conversation-create time still gets an ephemeral notice."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module, "_slack_agent_channel_grant_check", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module.sse_client,
        "create_conversation",
        MagicMock(side_effect=app_module.AgentAccessDeniedError("default-agent")),
    )

    client = _Client()
    app_module.handle_mention(_human_mention_event(), say=MagicMock(), client=client, context={})

    assert len(client.ephemeral_posts) == 1
    assert client.ephemeral_posts[0]["user"] == "U555"


def test_bot_mention_empty_text_silently_drops(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bot/workflow mention with no message text drops silently instead of prompting for one."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module.utils, "get_bot_info_by_id", lambda _bot_id: ("WorkflowBot", "UWORKFLOWUSER"))
    say = MagicMock()

    client = _Client()
    app_module.handle_mention(_bot_mention_event(text=""), say=say, client=client, context={})

    say.assert_not_called()
    assert client.ephemeral_posts == []
    assert client.channel_posts == []


def test_human_mention_empty_text_prompts_for_question(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: a human mention with no message text still gets the 'include a question' prompt."""
    app_module = _load_slack_app(monkeypatch)
    say = MagicMock()

    client = _Client()
    app_module.handle_mention(_human_mention_event(text=""), say=say, client=client, context={})

    say.assert_called_once()
    assert "include a question" in say.call_args.kwargs["text"]


def test_bot_mention_flags_conversation_owner_is_bot(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bot/app-owned thread must persist metadata.owner_is_bot so stats can
    exclude it from the human leaderboard (bot user IDs look like humans)."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module.utils, "get_bot_info_by_id", lambda _bot_id: ("GitLab", "U05LC2AV99N"))
    monkeypatch.setattr(app_module, "_slack_agent_channel_grant_check", lambda *_a, **_k: None)
    create_conversation = MagicMock(return_value={"conversation_id": "conv-1", "created": True, "metadata": {}})
    monkeypatch.setattr(app_module.sse_client, "create_conversation", create_conversation)
    # Stop right after create so we only assert on the create call.
    monkeypatch.setattr(app_module.sse_client, "update_conversation_metadata", MagicMock())
    monkeypatch.setattr(app_module, "_route_to_agent", MagicMock())

    client = _Client()
    app_module.handle_mention(_bot_mention_event(), say=MagicMock(), client=client, context={})

    create_conversation.assert_called_once()
    metadata = create_conversation.call_args.kwargs["metadata"]
    assert metadata["owner_is_bot"] is True
    # The app's display name is persisted so stats can label the "U…" owner_id.
    assert metadata["owner_display_name"] == "GitLab"


def test_human_mention_does_not_flag_owner_is_bot(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: human-owned threads must NOT carry owner_is_bot."""
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module, "_slack_agent_channel_grant_check", lambda *_a, **_k: None)
    create_conversation = MagicMock(return_value={"conversation_id": "conv-1", "created": True, "metadata": {}})
    monkeypatch.setattr(app_module.sse_client, "create_conversation", create_conversation)
    monkeypatch.setattr(app_module.sse_client, "update_conversation_metadata", MagicMock())
    monkeypatch.setattr(app_module, "_route_to_agent", MagicMock())

    client = _Client()
    app_module.handle_mention(_human_mention_event(), say=MagicMock(), client=client, context={})

    create_conversation.assert_called_once()
    metadata = create_conversation.call_args.kwargs["metadata"]
    assert "owner_is_bot" not in metadata
    assert "owner_display_name" not in metadata


def test_bot_mention_passes_resolved_sender_id_not_own_bot_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """The sender bot's resolved user id must reach routing — not CAIPE's own bot_user_id from auth_test().

    Regression for a variable-shadowing bug where the local name holding the
    sender's resolved bot user id was later overwritten by CAIPE's own
    bot_user_id (from client.auth_test()), silently breaking bot_list
    matching by user id.
    """
    app_module = _load_slack_app(monkeypatch)
    monkeypatch.setattr(app_module.utils, "get_bot_info_by_id", lambda _bot_id: ("WorkflowBot", "UWORKFLOWUSER"))

    captured: dict[str, object] = {}

    def _capture_and_stop(*_args: object, **kwargs: object):
        captured.update(kwargs)
        raise RuntimeError("stop after capturing match kwargs")

    monkeypatch.setattr(app_module, "_match_channel_agents", _capture_and_stop)

    client = _Client()
    app_module.handle_mention(_bot_mention_event(), say=MagicMock(), client=client, context={})

    assert captured["is_bot"] is True
    assert captured["bot_username"] == "WorkflowBot"
    assert captured["bot_user_id"] == "UWORKFLOWUSER"
    assert captured["bot_user_id"] != "UOWNBOT"

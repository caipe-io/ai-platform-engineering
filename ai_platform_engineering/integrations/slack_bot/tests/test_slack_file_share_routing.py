"""Regression tests for Slack attachment messages on ambient channel routes."""

from __future__ import annotations

import base64
import importlib
import pathlib
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest

_APP_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

from .handler_test_utils import load_handler_module  # noqa: E402

_PNG = b"\x89PNG\r\n\x1a\nreal-image-bytes"


class _SlackFileResponse:
    def __init__(self, content: bytes, content_type: str) -> None:
        self.content = content
        self.headers = {"Content-Type": content_type}

    def raise_for_status(self) -> None:
        return None


class _Client:
    token = "xoxb-test-token"

    def users_info(self, **_kwargs: object) -> dict[str, object]:
        return {
            "user": {
                "real_name": "Test User",
                "profile": {"email": "test-user@example.com"},
            }
        }


def _load_slack_app(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.syspath_prepend(str(_APP_DIR))
    app_module = load_handler_module("channel_routing")
    monkeypatch.setattr(app_module, "_bind_obo_for_handler", lambda _context: None)
    monkeypatch.setattr(
        app_module.utils,
        "verify_thread_exists",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        app_module.utils,
        "get_channel_context",
        lambda *_args, **_kwargs: {"topic": "", "purpose": ""},
    )
    monkeypatch.setattr(app_module, "_track_interaction", MagicMock())
    monkeypatch.setattr(app_module, "_record_message_turns", MagicMock())
    monkeypatch.setattr(app_module.session_manager, "set_thread_owner", MagicMock())
    return app_module


def _route_fixture(
    monkeypatch: pytest.MonkeyPatch,
    *,
    text: str,
    subtype: str | None,
    file_content: bytes,
    content_type: str,
) -> tuple[Any, MagicMock, MagicMock, MagicMock, MagicMock]:
    app_module = _load_slack_app(monkeypatch)
    config_models = importlib.import_module("utils.config_models")
    file_ingest = importlib.import_module("utils.file_ingest")
    agent_match = config_models.AgentBinding(
        agent_id="example-agent",
        users=config_models.UsersConfig(
            enabled=True,
            listen="message",
            overthink=config_models.OverthinkConfig(enabled=True),
        ),
    )
    channel_config = config_models.ChannelConfig(
        name="#example",
        agents=[agent_match],
    )
    event: dict[str, object] = {
        "type": "message",
        "channel": "C-EXAMPLE",
        "user": "U-EXAMPLE",
        "team": "T-EXAMPLE",
        "ts": "1700000000.000100",
        "text": text,
        "files": [
            {
                "name": "image.png",
                "mimetype": "image/png",
                "url_private": "https://files.example.com/image.png",
            }
        ],
    }
    if subtype is not None:
        event["subtype"] = subtype

    download = MagicMock(
        return_value=_SlackFileResponse(file_content, content_type),
    )
    call_ai = MagicMock(return_value=[])
    create_conversation = MagicMock(
        return_value={
            "conversation_id": "conversation-example",
            "created": True,
            "metadata": {},
        }
    )
    log = MagicMock()
    monkeypatch.setattr(file_ingest.requests, "get", download)
    monkeypatch.setattr(app_module, "_call_ai", call_ai)
    monkeypatch.setattr(app_module, "logger", log)
    monkeypatch.setattr(
        app_module.sse_client,
        "create_conversation",
        create_conversation,
    )

    app_module._route_to_agent(
        event,
        say=MagicMock(),
        client=_Client(),
        channel_config=channel_config,
        agent_match=agent_match,
        is_bot=False,
        context={},
    )
    return app_module, download, call_ai, create_conversation, log


@pytest.mark.parametrize("subtype", [None, "file_share"])
def test_caption_continues_when_attachment_is_inaccessible(
    monkeypatch: pytest.MonkeyPatch,
    subtype: str | None,
) -> None:
    """A real missing-scope response must preserve text and invoke CAIPE."""
    _, download, call_ai, create_conversation, log = _route_fixture(
        monkeypatch,
        text="Please investigate this alert",
        subtype=subtype,
        file_content=b"<!DOCTYPE html><html>sign in</html>",
        content_type="text/html; charset=utf-8",
    )

    download.assert_called_once()
    create_conversation.assert_called_once()
    call_ai.assert_called_once()
    assert "Please investigate this alert" in call_ai.call_args.kwargs["message_text"]
    assert "files:read" in call_ai.call_args.kwargs["message_text"]
    assert call_ai.call_args.kwargs["files"] == []
    assert call_ai.call_args.kwargs["overthink_config"].enabled is True
    attachment_logs = [
        call
        for call in log.info.call_args_list
        if "Processing Slack message attachments" in str(call.args[0])
    ]
    assert len(attachment_logs) == 1
    assert attachment_logs[0].args[1:] == (
        "1700000000.000100",
        1,
        True,
        subtype or "none",
    )


def test_file_only_message_routes_usable_attachment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real downloaded file must reach CAIPE when Slack supplies no text."""
    _, download, call_ai, create_conversation, _ = _route_fixture(
        monkeypatch,
        text="",
        subtype="file_share",
        file_content=_PNG,
        content_type="image/png",
    )

    download.assert_called_once()
    create_conversation.assert_called_once()
    call_ai.assert_called_once()
    assert call_ai.call_args.kwargs["message_text"] == ""
    assert call_ai.call_args.kwargs["files"] == [
        {
            "name": "image.png",
            "mime_type": "image/png",
            "data": base64.b64encode(_PNG).decode("ascii"),
        }
    ]


def test_system_subtype_remains_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Allowing file shares must not route Slack system messages."""
    app_module = _load_slack_app(monkeypatch)
    config_models = importlib.import_module("utils.config_models")
    agent_match = config_models.AgentBinding(
        agent_id="example-agent",
        users=config_models.UsersConfig(enabled=True, listen="message"),
    )
    channel_config = config_models.ChannelConfig(
        name="#example",
        agents=[agent_match],
    )
    download = MagicMock()
    create_conversation = MagicMock()
    log = MagicMock()
    file_ingest = importlib.import_module("utils.file_ingest")
    monkeypatch.setattr(file_ingest.requests, "get", download)
    monkeypatch.setattr(
        app_module.sse_client,
        "create_conversation",
        create_conversation,
    )
    monkeypatch.setattr(app_module, "logger", log)

    app_module._route_to_agent(
        {
            "type": "message",
            "subtype": "channel_topic",
            "channel": "C-EXAMPLE",
            "user": "U-EXAMPLE",
            "ts": "1700000000.000200",
            "text": "topic changed",
        },
        say=MagicMock(),
        client=_Client(),
        channel_config=channel_config,
        agent_match=agent_match,
        is_bot=False,
        context={},
    )

    download.assert_not_called()
    create_conversation.assert_not_called()
    assert any(
        "Ignoring ambient Slack message subtype" in str(call.args[0])
        for call in log.debug.call_args_list
    )

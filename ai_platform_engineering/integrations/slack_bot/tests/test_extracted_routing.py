# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Direct characterization tests for personal and conversation routing."""

from unittest.mock import MagicMock

from .handler_test_utils import load_handler_module


def test_empty_direct_message_keeps_user_visible_prompt(monkeypatch) -> None:
  module = load_handler_module("personal_routing")
  say = MagicMock()
  client = MagicMock()
  event = {
    "channel": "D123",
    "user": "U123",
    "ts": "1700000000.000100",
    "text": "",
  }

  monkeypatch.setattr(module, "_bind_obo_for_handler", lambda _context: None)
  monkeypatch.setattr(module.utils, "verify_thread_exists", lambda *_args: True)
  monkeypatch.setattr(
    module.utils,
    "get_message_author_info",
    lambda *_args: ("Test User", "test-user@example.com"),
  )

  module.handle_dm_message(event, say, client, context={})

  say.assert_called_once_with(
    text="Please include a question or message!",
    thread_ts="1700000000.000100",
  )
  module.sse_client.create_conversation.assert_not_called()


def test_conversation_invocation_selects_stream_for_human_user(monkeypatch) -> None:
  module = load_handler_module("conversation")
  stream_response = MagicMock(return_value=[{"type": "context"}])
  invoke_response = MagicMock()
  monkeypatch.setattr(module.ai, "stream_response", stream_response)
  monkeypatch.setattr(module.ai, "invoke_response", invoke_response)

  result = module._call_ai(
    client=MagicMock(),
    channel_id="C123",
    thread_ts="1700000000.000100",
    message_text="example question",
    user_id="U123",
    team_id="T123",
    agent_id="example-agent",
    conversation_id="example-conversation",
  )

  assert result == [{"type": "context"}]
  stream_response.assert_called_once()
  invoke_response.assert_not_called()


def test_conversation_invocation_selects_invoke_for_bot_user(monkeypatch) -> None:
  module = load_handler_module("conversation")
  stream_response = MagicMock()
  invoke_response = MagicMock(return_value=[{"type": "context"}])
  monkeypatch.setattr(module.ai, "stream_response", stream_response)
  monkeypatch.setattr(module.ai, "invoke_response", invoke_response)

  result = module._call_ai(
    client=MagicMock(),
    channel_id="C123",
    thread_ts="1700000000.000100",
    message_text="example event",
    user_id="B123",
    team_id="T123",
    agent_id="example-agent",
    conversation_id="example-conversation",
  )

  assert result == [{"type": "context"}]
  invoke_response.assert_called_once()
  stream_response.assert_not_called()

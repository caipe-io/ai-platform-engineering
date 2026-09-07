# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for threaded Webex replies and Dynamic Agent streaming dispatch."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from ai_platform_engineering.integrations.webex_bot.app import WebexMessageResult
from ai_platform_engineering.integrations.webex_bot.a2a_client import (
    AgentAccessDeniedError,
    SSEEvent,
    SSEEventType,
)
from ai_platform_engineering.integrations.webex_bot.utils.thread_ownership import ThreadOwnerCache
from ai_platform_engineering.integrations.webex_bot.webex_responder import (
    WebexResponder,
    WebexThreadedStreamDispatcher,
    _BOT_REPLY_MARKER,
    _agent_reply_markdown,
    _format_thread_context,
    _is_webex_bot_reply,
)


@dataclass
class FakeWebexApi:
    created: list[dict[str, Any]] = field(default_factory=list)
    updated: list[dict[str, Any]] = field(default_factory=list)
    messages_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    thread_messages: list[dict[str, Any]] = field(default_factory=list)
    get_calls: list[str] = field(default_factory=list)
    list_calls: list[dict[str, Any]] = field(default_factory=list)

    def create_message(
        self,
        *,
        markdown: str,
        room_id: str | None = None,
        parent_id: str | None = None,
        person_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        record: dict[str, Any] = {"markdown": markdown}
        if room_id is not None:
            record["room_id"] = room_id
        if parent_id is not None:
            record["parent_id"] = parent_id
        if person_id is not None:
            record["person_id"] = person_id
        if attachments is not None:
            record["attachments"] = attachments
        self.created.append(record)
        return f"created-{len(self.created)}"

    def update_message(self, *, message_id: str, room_id: str, markdown: str) -> None:
        self.updated.append({"message_id": message_id, "room_id": room_id, "markdown": markdown})

    def get_message(self, *, message_id: str) -> dict[str, Any] | None:
        self.get_calls.append(message_id)
        return self.messages_by_id.get(message_id)

    def list_messages(
        self,
        *,
        room_id: str,
        parent_id: str | None = None,
        before_message_id: str | None = None,
        max_messages: int = 10,
    ) -> list[dict[str, Any]]:
        self.list_calls.append(
            {
                "room_id": room_id,
                "parent_id": parent_id,
                "before_message_id": before_message_id,
                "max_messages": max_messages,
            }
        )
        return self.thread_messages[:max_messages]


@dataclass
class FakeSseClient:
    events: list[SSEEvent]
    calls: list[dict[str, Any]] = field(default_factory=list)
    conversations: list[dict[str, Any]] = field(default_factory=list)
    conversation_metadata: dict[str, Any] = field(default_factory=dict)
    metadata_updates: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)

    def create_conversation(self, **kwargs: Any) -> dict[str, Any]:
        self.conversations.append(kwargs)
        return {
            "conversation_id": "server-conversation-id",
            "created": True,
            "metadata": self.conversation_metadata,
        }

    def stream_chat(self, **kwargs: Any):
        self.calls.append(kwargs)
        yield from self.events

    def update_conversation_metadata(
        self, conversation_id: str, metadata: dict[str, Any], bearer_token: str | None = None
    ) -> None:
        self.metadata_updates.append(
            {"conversation_id": conversation_id, "metadata": metadata, "bearer_token": bearer_token}
        )

    def add_message(self, **kwargs: Any) -> None:
        self.messages.append(kwargs)


class FailingThreadContextWebexApi(FakeWebexApi):
    def get_message(self, *, message_id: str) -> dict[str, Any] | None:
        raise RuntimeError("webex unavailable")


def _webex_timestamp(age: timedelta = timedelta()) -> str:
    return (datetime.now(timezone.utc) - age).isoformat().replace("+00:00", "Z")


def test_unlinked_user_gets_private_card_and_generic_thread_notice(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_NAME", "Grid")
    api = FakeWebexApi()
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url="http://localhost:3000/api/auth/webex-link?x=1",
    )

    asyncio.run(responder.reply_to_result(event, result))

    assert len(api.created) == 2
    direct_message = api.created[0]
    assert direct_message["person_id"] == "person-public-id"
    assert direct_message["markdown"] == "Link your Grid account to Webex to continue."
    card = direct_message["attachments"][0]["content"]
    assert card["type"] == "AdaptiveCard"
    assert card["body"][1]["text"] == "Verify your identity to interface with Grid agents."
    assert card["actions"][0] == {
        "type": "Action.OpenUrl",
        "title": "Link with SSO",
        "url": "http://localhost:3000/api/auth/webex-link?x=1",
    }

    group_notice = api.created[1]
    assert group_notice == {
        "room_id": "room-public-id",
        "parent_id": "message-public-id",
        "markdown": (
            "I sent you a 1:1 Webex message to link your Grid account. "
            "Complete linking there, then retry your request."
        ),
    }
    assert "webex-link" not in group_notice["markdown"]


def test_unlinked_user_does_not_get_duplicate_linking_cards_within_cooldown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_platform_engineering.integrations.webex_bot import webex_responder as responder_module

    monkeypatch.setenv("APP_NAME", "Grid")
    responder_module._recent_linking_cards_sent.clear()
    api = FakeWebexApi()
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url="http://localhost:3000/api/auth/webex-link?x=1",
    )

    asyncio.run(responder.reply_to_result(event, result))
    asyncio.run(responder.reply_to_result(event, result))

    direct_messages = [msg for msg in api.created if msg.get("person_id")]
    thread_messages = [msg for msg in api.created if msg.get("room_id")]
    assert len(direct_messages) == 1
    assert len(thread_messages) == 2
    assert "card I sent earlier" in thread_messages[1]["markdown"]


def test_unlinked_user_does_not_get_duplicate_card_when_room_already_has_link_card(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_platform_engineering.integrations.webex_bot import webex_responder as responder_module

    monkeypatch.setenv("APP_NAME", "Grid")
    responder_module._recent_linking_cards_sent.clear()
    api = FakeWebexApi(
        thread_messages=[
            {
                "markdown": "Link your Grid account to Webex to continue.",
                "created": _webex_timestamp(),
                "attachments": [
                    {
                        "content": {
                            "type": "AdaptiveCard",
                            "body": [{"text": "Link Grid to Webex"}],
                            "actions": [{"title": "Link with SSO"}],
                        }
                    }
                ],
            }
        ]
    )
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url="http://localhost:3000/api/auth/webex-link?x=2",
    )

    asyncio.run(responder.reply_to_result(event, result))

    direct_messages = [msg for msg in api.created if msg.get("person_id")]
    assert direct_messages == []
    assert api.created == [
        {
            "room_id": "room-public-id",
            "parent_id": "message-public-id",
            "markdown": (
                "Your Webex account still needs to be linked to Grid. "
                "Open your **1:1 chat with me** and tap **Link with SSO** on the card I sent earlier "
                "(links expire after 10 minutes). After linking, retry here — no need to wait for a new card."
            ),
        }
    ]


def test_unlinked_user_gets_new_card_when_existing_card_is_expired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_platform_engineering.integrations.webex_bot import webex_responder as responder_module

    monkeypatch.setenv("APP_NAME", "Grid")
    responder_module._recent_linking_cards_sent.clear()
    api = FakeWebexApi(
        thread_messages=[
            {
                "markdown": "Link your Grid account to Webex to continue.",
                "created": _webex_timestamp(timedelta(minutes=11)),
                "attachments": [
                    {
                        "content": {
                            "type": "AdaptiveCard",
                            "body": [{"text": "Link Grid to Webex"}],
                            "actions": [{"title": "Link with SSO"}],
                        }
                    }
                ],
            }
        ]
    )
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url="http://localhost:3000/api/auth/webex-link?x=3",
    )

    asyncio.run(responder.reply_to_result(event, result))

    direct_messages = [msg for msg in api.created if msg.get("person_id")]
    assert len(direct_messages) == 1
    assert direct_messages[0]["attachments"][0]["content"]["actions"][0]["url"].endswith("x=3")


def test_unlinked_user_dm_failure_does_not_post_signed_link_publicly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_platform_engineering.integrations.webex_bot import webex_responder as responder_module

    monkeypatch.setenv("APP_NAME", "Grid")
    responder_module._recent_linking_cards_sent.clear()

    class FailingDirectMessageApi(FakeWebexApi):
        def create_message(self, **kwargs: Any) -> str:
            if kwargs.get("person_id"):
                raise RuntimeError("dm failed")
            return super().create_message(**kwargs)

    api = FailingDirectMessageApi()
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url="http://localhost:3000/api/auth/webex-link?x=1",
    )

    asyncio.run(responder.reply_to_result(event, result))

    assert api.created == [
        {
            "room_id": "room-public-id",
            "parent_id": "message-public-id",
            "markdown": (
                "I could not send you a 1:1 Webex linking message. Open Grid and "
                "try account linking, then retry your request."
            ),
        }
    ]
    assert "webex-link" not in api.created[0]["markdown"]


def test_unlinked_explicit_mention_gets_fallback_text_when_linking_url_mint_fails() -> None:
    api = FakeWebexApi()
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url=None,
        explicit_invocation=True,
    )

    asyncio.run(responder.reply_to_result(event, result))

    assert api.created == [
        {
            "room_id": "room-public-id",
            "parent_id": "message-public-id",
            "markdown": (
                "Your Webex account could not be linked because the bot is "
                "not configured to mint linking URLs. Please contact your admin."
            ),
        }
    ]


def test_unlinked_passive_message_stays_silent_when_linking_url_mint_fails() -> None:
    api = FakeWebexApi()
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
            "personId": "person-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_USER_NOT_LINKED",
        deny_message="Your Webex account is not linked.",
        linking_url=None,
        explicit_invocation=False,
    )

    asyncio.run(responder.reply_to_result(event, result))

    assert api.created == []


def test_reason_code_fallback_is_user_friendly() -> None:
    api = FakeWebexApi()
    responder = WebexResponder(webex_api=api)
    event = {
        "data": {
            "id": "message-public-id",
            "webexRoomId": "room-public-id",
        }
    }
    result = WebexMessageResult(
        allowed=False,
        dispatched=False,
        ignored=False,
        reason_code="WEBEX_OBO_FAILED",
        explicit_invocation=True,
    )

    asyncio.run(responder.reply_to_result(event, result))

    assert api.created == [
        {
            "room_id": "room-public-id",
            "parent_id": "message-public-id",
            "markdown": (
                "I couldn't start your CAIPE session for this Webex space. "
                "Ask an admin to refresh this space's team setup in CAIPE."
            ),
        }
    ]
    assert "WEBEX_OBO_FAILED" not in api.created[0]["markdown"]


def test_threaded_stream_dispatcher_updates_reply_from_sse_events() -> None:
    api = FakeWebexApi()
    sse = FakeSseClient(
        events=[
            SSEEvent(SSEEventType.TEXT_MESSAGE_CONTENT, delta="hello "),
            SSEEvent(SSEEventType.TEXT_MESSAGE_CONTENT, delta="world"),
            SSEEvent(SSEEventType.RUN_FINISHED),
        ]
    )
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
        update_every_chars=1,
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
                "webex_room_id": "room-public-id",
                "message_id": "message-public-id",
                "text": "neo-coder hello",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert api.created == [
        {
            "room_id": "room-public-id",
            "parent_id": "message-public-id",
            "markdown": (
                "Working on it...\n\n"
                "_Agent: incident-agent_ • **Mention @CAIPE to continue**"
                f"{_BOT_REPLY_MARKER}"
            ),
        }
    ]
    assert api.updated[-1] == {
        "message_id": "created-1",
        "room_id": "room-public-id",
        "markdown": (
            "hello world\n\n"
            "_Agent: incident-agent_ • **Mention @CAIPE to continue**"
            f"{_BOT_REPLY_MARKER}"
        ),
    }
    assert sse.conversations == [
        {
            "title": "neo-coder hello",
            "agent_id": "incident-agent",
            "idempotency_key": "webex:6f91b070-531a-11f1-926d-6fd3c20dfdc4:message-public-id",
            "metadata": {
                "surface": "webex",
                "webex_space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
                "webex_message_id": "message-public-id",
                "webex_room_id": "room-public-id",
                "webex_is_direct": False,
            },
            "bearer_token": "obo-access-token",
        }
    ]
    assert sse.calls[0]["conversation_id"] == "server-conversation-id"
    assert sse.calls[0]["agent_id"] == "incident-agent"
    assert sse.calls[0]["bearer_token"] == "obo-access-token"
    assert sse.calls[0]["client_context"] == {
        "source": "webex",
        "surface": "webex",
        "webex_space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
        "webex_message_id": "message-public-id",
        # Phase 1 channel-derived team binding (spec FR-016/FR-017):
        "channel_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
        "surface_kind": "channel",
    }


def test_threaded_stream_dispatcher_tags_message_turns_with_webex_source() -> None:
    """A successful Webex dispatch records source="webex" message turns.

    Mirrors the Slack bot's equivalent per-turn tagging (source="slack") so
    Insights can count Webex activity the same way as web and Slack.
    """
    api = FakeWebexApi()
    sse = FakeSseClient(
        events=[
            SSEEvent(SSEEventType.TEXT_MESSAGE_CONTENT, delta="hello"),
            SSEEvent(SSEEventType.RUN_FINISHED),
        ]
    )
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
        update_every_chars=1,
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "space-id",
                "webex_room_id": "room-id",
                "message_id": "trigger-message-id",
                "text": "neo-coder hello",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert len(sse.messages) == 2
    user_turn, assistant_turn = sse.messages
    assert user_turn["conversation_id"] == "server-conversation-id"
    assert user_turn["message_id"] == "webex-server-conversation-id-trigger-message-id-user"
    assert user_turn["role"] == "user"
    assert user_turn["metadata"]["source"] == "webex"
    assert user_turn["metadata"]["agent_id"] == "incident-agent"
    assert user_turn["metadata"]["webex_space_id"] == "space-id"
    assert user_turn["metadata"]["webex_room_id"] == "room-id"
    assert user_turn["metadata"]["webex_thread_parent_id"] == "trigger-message-id"
    assert user_turn["metadata"]["webex_message_id"] == "trigger-message-id"
    assert user_turn["metadata"]["webex_is_direct"] is False
    assert user_turn["bearer_token"] == "obo-access-token"

    assert assistant_turn["role"] == "assistant"
    assert assistant_turn["metadata"]["source"] == "webex"
    assert assistant_turn["metadata"]["is_final"] is True
    assert isinstance(assistant_turn["metadata"]["latency_ms"], int)


def test_threaded_stream_dispatcher_tags_direct_messages_as_is_direct() -> None:
    """A Webex 1:1 DM propagates ``is_direct`` into conversation and turn metadata.

    Insights must be able to tell DM conversations apart from real spaces so it
    can exclude them from the Top Spaces / Configured Spaces breakdowns while
    still counting their activity in aggregate totals.
    """
    api = FakeWebexApi()
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(webex_api=api, sse_client=sse)

    asyncio.run(
        dispatcher(
            {
                "space_id": "dm-space-id",
                "webex_room_id": "dm-room-id",
                "message_id": "dm-message-id",
                "text": "neo-coder hello",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
                "is_direct": True,
            }
        )
    )

    assert sse.conversations[0]["metadata"]["webex_is_direct"] is True
    user_turn, _assistant_turn = sse.messages
    assert user_turn["metadata"]["webex_is_direct"] is True


def test_threaded_stream_dispatcher_does_not_tag_message_turns_on_denied_agent() -> None:
    """No message-turn rows are recorded when the agent access is denied."""

    class DenyingSseClient(FakeSseClient):
        def stream_chat(self, **kwargs: Any):
            self.calls.append(kwargs)
            raise AgentAccessDeniedError("incident-agent")
            yield  # pragma: no cover - unreachable, keeps this a generator

    api = FakeWebexApi()
    sse = DenyingSseClient(events=[])
    dispatcher = WebexThreadedStreamDispatcher(webex_api=api, sse_client=sse)

    asyncio.run(
        dispatcher(
            {
                "space_id": "space-id",
                "webex_room_id": "room-id",
                "message_id": "trigger-message-id",
                "text": "neo-coder hello",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert sse.messages == []


def test_threaded_stream_dispatcher_reuses_root_parent_for_thread_replies() -> None:
    api = FakeWebexApi()
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
                "webex_room_id": "room-public-id",
                "message_id": "reply-message-public-id",
                "thread_parent_id": "root-message-public-id",
                "text": "neo-coder show my jira profile",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert api.created[0] == {
        "room_id": "room-public-id",
        "parent_id": "root-message-public-id",
        "markdown": (
            "Working on it...\n\n"
            "_Agent: incident-agent_ • **Mention @CAIPE to continue**"
            f"{_BOT_REPLY_MARKER}"
        ),
    }
    assert sse.conversations[0]["idempotency_key"] == (
        "webex:6f91b070-531a-11f1-926d-6fd3c20dfdc4:root-message-public-id"
    )
    assert sse.calls[0]["client_context"] == {
        "source": "webex",
        "surface": "webex",
        "webex_space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
        "webex_message_id": "reply-message-public-id",
        "webex_thread_parent_id": "root-message-public-id",
        # Phase 1 channel-derived team binding (spec FR-016/FR-017):
        "channel_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
        "surface_kind": "channel",
        "thread_ts": "root-message-public-id",
    }


def test_threaded_stream_dispatcher_pins_new_thread_to_first_responding_agent() -> None:
    """The first agent to respond in a thread claims ownership.

    Ownership is persisted to conversation metadata so a later change to
    the space's agent route does not redirect this thread — mirroring
    Slack's thread-owner pinning.
    """
    api = FakeWebexApi()
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
        thread_owner_cache=ThreadOwnerCache(),
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "space-id",
                "webex_room_id": "room-public-id",
                "message_id": "reply-message-id",
                "thread_parent_id": "root-message-id",
                "text": "neo-coder show my jira profile",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert sse.calls[0]["agent_id"] == "incident-agent"
    assert sse.metadata_updates == [
        {
            "conversation_id": "server-conversation-id",
            "metadata": {"thread_owner_agent_id": "incident-agent"},
            "bearer_token": "obo-access-token",
        }
    ]


def test_threaded_stream_dispatcher_pins_root_message_to_its_agent() -> None:
    """A root (non-reply) message also claims ownership for its thread."""
    api = FakeWebexApi()
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
        thread_owner_cache=ThreadOwnerCache(),
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "space-id",
                "webex_room_id": "room-public-id",
                "message_id": "root-message-id",
                "text": "neo-coder hello",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert sse.metadata_updates == [
        {
            "conversation_id": "server-conversation-id",
            "metadata": {"thread_owner_agent_id": "incident-agent"},
            "bearer_token": "obo-access-token",
        }
    ]


def test_threaded_stream_dispatcher_overrides_reconfigured_space_route_for_existing_thread() -> None:
    """A follow-up in an already-owned thread stays with the original agent.

    Simulates an admin changing the space's agent route between the first
    and second message in the same Webex thread: the runtime gate resolves
    the new route (``agent_id="new-agent"``), but the conversation already
    carries a persisted ``thread_owner_agent_id`` from the first reply, so
    the dispatcher must override back to the original owner *before* the
    placeholder is created — the owner should be shown from the very first
    message, with no create-then-correct flash.
    """
    api = FakeWebexApi()
    sse = FakeSseClient(
        events=[SSEEvent(SSEEventType.RUN_FINISHED)],
        conversation_metadata={"thread_owner_agent_id": "original-agent"},
    )
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
        thread_owner_cache=ThreadOwnerCache(),
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "space-id",
                "webex_room_id": "room-public-id",
                "message_id": "reply-message-id",
                "thread_parent_id": "root-message-id",
                "text": "neo-coder follow up",
                "agent_id": "new-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert sse.calls[0]["agent_id"] == "original-agent"
    # Placeholder reply was created with the owner's agent from the start —
    # never shows the requested/reconfigured agent, so nothing needs correcting.
    assert len(api.created) == 1
    assert api.created[0]["markdown"].startswith(
        "Working on it...\n\n_Agent: original-agent_"
    )
    assert api.updated[-1]["markdown"].startswith("Done.\n\n_Agent: original-agent_")
    # Ownership was already persisted — no redundant metadata write.
    assert sse.metadata_updates == []


def test_threaded_stream_dispatcher_posts_fresh_error_when_conversation_setup_fails() -> None:
    """A failure while resolving ownership/conversation setup still notifies the user.

    Because ownership is now resolved before the placeholder is created, a
    failure in that earlier step (e.g. conversation creation) means no
    placeholder exists yet. The dispatcher must post a fresh error message
    instead of trying to edit a message_id that was never created.
    """

    class FailingConversationSseClient(FakeSseClient):
        def create_conversation(self, **kwargs: Any) -> dict[str, Any]:
            raise AgentAccessDeniedError("incident-agent")

    api = FakeWebexApi()
    sse = FailingConversationSseClient(events=[])
    dispatcher = WebexThreadedStreamDispatcher(webex_api=api, sse_client=sse)

    asyncio.run(
        dispatcher(
            {
                "space_id": "space-id",
                "webex_room_id": "room-id",
                "message_id": "trigger-message-id",
                "text": "neo-coder hello",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    # No placeholder was ever created, so the error is posted as a fresh
    # message rather than an update to a nonexistent message_id.
    assert api.updated == []
    assert len(api.created) == 1
    assert api.created[0]["room_id"] == "room-id"
    assert api.created[0]["parent_id"] == "trigger-message-id"
    assert "don't have permission" in api.created[0]["markdown"]


def test_threaded_stream_dispatcher_uses_in_memory_owner_cache_before_server_metadata() -> None:
    """The in-memory cache resolves ownership on the hot path.

    A second reply in the same thread is pinned to the agent recorded by
    the first reply's in-memory claim, even though the fake SSE client's
    conversation metadata never reflects a persisted owner (it is only
    updated in a real deployment after a successful PATCH).
    """
    api = FakeWebexApi()
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    cache = ThreadOwnerCache()
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
        thread_owner_cache=cache,
    )

    first_payload = {
        "space_id": "space-id",
        "webex_room_id": "room-public-id",
        "message_id": "reply-1",
        "thread_parent_id": "root-message-id",
        "text": "neo-coder first",
        "agent_id": "agent-a",
        "obo_token": "obo-access-token",
    }
    second_payload = {**first_payload, "message_id": "reply-2", "agent_id": "agent-b"}

    asyncio.run(dispatcher(first_payload))
    asyncio.run(dispatcher(second_payload))

    assert sse.calls[0]["agent_id"] == "agent-a"
    assert sse.calls[1]["agent_id"] == "agent-a"


def test_threaded_stream_dispatcher_includes_bounded_thread_context_in_agent_prompt() -> None:
    api = FakeWebexApi(
        messages_by_id={
            "root-message-public-id": {
                "id": "root-message-public-id",
                "text": "original incident details",
                "personEmail": "alice@example.com",
            }
        },
        thread_messages=[
            {
                "id": "newer-reply-public-id",
                "parentId": "root-message-public-id",
                "text": "second follow-up",
                "personEmail": "carol@example.com",
            },
            {
                "id": "older-reply-public-id",
                "parentId": "root-message-public-id",
                "text": "first follow-up",
                "personEmail": "bob@example.com",
            },
            {
                "id": "bot-reply-public-id",
                "parentId": "root-message-public-id",
                "markdown": (
                    "prior bot answer\n\n"
                    "_Agent: incident-agent_ • **Mention @CAIPE to continue**"
                    f"{_BOT_REPLY_MARKER}"
                ),
                "personEmail": "bot@example.com",
            },
        ],
    )
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
                "webex_room_id": "room-public-id",
                "message_id": "current-reply-public-id",
                "thread_parent_id": "root-message-public-id",
                "text": "what changed?",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert api.get_calls == ["root-message-public-id"]
    assert api.list_calls == [
        {
            "room_id": "room-public-id",
            "parent_id": "root-message-public-id",
            "before_message_id": "current-reply-public-id",
            "max_messages": 9,
        }
    ]
    assert sse.calls[0]["message"] == (
        "Webex thread context (oldest to newest, excluding the current request):\n"
        "- alice@example.com: original incident details\n"
        "- bob@example.com: first follow-up\n"
        "- carol@example.com: second follow-up\n\n"
        "Current Webex request:\n"
        "what changed?"
    )
    assert "prior bot answer" not in sse.calls[0]["message"]


def test_thread_context_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBEX_THREAD_CONTEXT_ENABLED", "false")
    api = FakeWebexApi(
        messages_by_id={
            "root-message-public-id": {
                "id": "root-message-public-id",
                "text": "original incident details",
            }
        }
    )
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
                "webex_room_id": "room-public-id",
                "message_id": "current-reply-public-id",
                "thread_parent_id": "root-message-public-id",
                "text": "use only this message",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert api.get_calls == []
    assert api.list_calls == []
    assert sse.calls[0]["message"] == "use only this message"


def test_thread_context_fetch_failure_falls_back_to_current_message() -> None:
    api = FailingThreadContextWebexApi()
    sse = FakeSseClient(events=[SSEEvent(SSEEventType.RUN_FINISHED)])
    dispatcher = WebexThreadedStreamDispatcher(
        webex_api=api,
        sse_client=sse,
    )

    asyncio.run(
        dispatcher(
            {
                "space_id": "6f91b070-531a-11f1-926d-6fd3c20dfdc4",
                "webex_room_id": "room-public-id",
                "message_id": "current-reply-public-id",
                "thread_parent_id": "root-message-public-id",
                "text": "continue without history",
                "agent_id": "incident-agent",
                "obo_token": "obo-access-token",
            }
        )
    )

    assert sse.calls[0]["message"] == "continue without history"


def test_bot_reply_recognized_after_app_name_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_NAME", "OldName")
    reply_markdown = _agent_reply_markdown("incident-agent", "prior bot answer")

    monkeypatch.setenv("APP_NAME", "NewName")

    message = {"markdown": reply_markdown, "personEmail": "bot@example.com"}
    assert _is_webex_bot_reply(message) is True
    assert _format_thread_context([message]) == ""


def test_bot_reply_recognized_via_legacy_app_name_pattern_pre_upgrade(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replies the bot posted before the marker was introduced only contain
    the old ``Mention @{app_name} to continue`` pattern — those must still be
    recognized as bot replies during the transition to marker-based
    detection, or they'll be mistaken for user messages in thread context."""
    monkeypatch.setenv("APP_NAME", "CAIPE")
    legacy_markdown = (
        "prior bot answer\n\n_Agent: incident-agent_ • **Mention @CAIPE to continue**"
    )
    assert _BOT_REPLY_MARKER not in legacy_markdown

    message = {"markdown": legacy_markdown, "personEmail": "bot@example.com"}
    assert _is_webex_bot_reply(message) is True
    assert _format_thread_context([message]) == ""

"""Tests for the in-process Webex dispatcher.

The dispatcher decides loopguard / not-thread-reply / no-mapping /
forward verdicts for inbound Webex events.
"""

from __future__ import annotations

from typing import Mapping

import pytest

from autonomous_agents.services.webex_inbound import (
    FollowUpPayload,
    Verdict,
    dispatch_message_event,
)
from autonomous_agents.services.webex_threads import WebexThreadEntry


def _make_message(
    *,
    msg_id: str = "msg-reply-1",
    person_id: str = "PERSON-USER",
    parent_id: str | None = "msg-task-1",
    text: str = "please retry the rollout",
    person_email: str | None = "ops@example.com",
) -> dict:
    body: dict = {
        "id": msg_id,
        "personId": person_id,
        "text": text,
    }
    if parent_id is not None:
        body["parentId"] = parent_id
    if person_email is not None:
        body["personEmail"] = person_email
    return body


def _fetch(messages: Mapping[str, dict]):
    async def _impl(message_id: str) -> dict:
        return messages[message_id]

    return _impl


def _lookup(rows: Mapping[str, WebexThreadEntry | None]):
    async def _impl(parent_id: str) -> WebexThreadEntry | None:
        return rows.get(parent_id)

    return _impl


class TestDispatcherVerdicts:
    """``dispatch_message_event`` produces drop / forward verdicts."""

    @pytest.mark.asyncio
    async def test_drops_event_authored_by_bot_via_event_personid(self):
        """Event ``personId == bot`` short-circuits without calling fetch_message."""
        fetch_called = False

        async def fetch(_id: str):  # pragma: no cover - asserted not called
            nonlocal fetch_called
            fetch_called = True
            return {}

        async def lookup(_pid: str) -> WebexThreadEntry | None:
            return None

        event = {"data": {"id": "msg-1", "personId": "BOT"}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=fetch,
            lookup_thread=lookup,
        )

        assert result.verdict is Verdict.DROP_LOOPGUARD
        assert fetch_called is False, "loopguard pre-check must avoid fetch_message"

    @pytest.mark.asyncio
    async def test_drops_event_authored_by_bot_via_fetched_message(self):
        """Loopguard via the fetched message's personId."""
        msg = _make_message(person_id="BOT")
        event = {"data": {"id": msg["id"]}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=_fetch({msg["id"]: msg}),
            lookup_thread=_lookup({}),
        )

        assert result.verdict is Verdict.DROP_LOOPGUARD

    @pytest.mark.asyncio
    async def test_drops_top_level_message_with_no_parent(self):
        """Messages without ``parentId`` are not thread replies."""
        msg = _make_message(parent_id=None)
        event = {"data": {"id": msg["id"], "personId": msg["personId"]}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=_fetch({msg["id"]: msg}),
            lookup_thread=_lookup({}),
        )

        assert result.verdict is Verdict.DROP_NOT_THREAD_REPLY

    @pytest.mark.asyncio
    async def test_drops_when_parent_not_in_thread_map(self):
        """A reply to a parent we never recorded yields ``DROP_NO_MAPPING``."""
        msg = _make_message(parent_id="msg-someone-else")
        event = {"data": {"id": msg["id"], "personId": msg["personId"]}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=_fetch({msg["id"]: msg}),
            lookup_thread=_lookup({}),
        )

        assert result.verdict is Verdict.DROP_NO_MAPPING

    @pytest.mark.asyncio
    async def test_drops_when_message_text_is_empty(self):
        """Empty message text is not actionable."""
        msg = _make_message(text="")
        event = {"data": {"id": msg["id"], "personId": msg["personId"]}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=_fetch({msg["id"]: msg}),
            lookup_thread=_lookup(
                {
                    "msg-task-1": WebexThreadEntry(
                        message_id="msg-task-1", task_id="T", run_id="R"
                    )
                }
            ),
        )

        assert result.verdict is Verdict.DROP_NOT_THREAD_REPLY

    @pytest.mark.asyncio
    async def test_forwards_legitimate_followup(self):
        """A real thread reply is forwarded with the original task / run ids."""
        msg = _make_message(text="please retry")
        event = {"data": {"id": msg["id"], "personId": msg["personId"]}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=_fetch({msg["id"]: msg}),
            lookup_thread=_lookup(
                {
                    "msg-task-1": WebexThreadEntry(
                        message_id="msg-task-1",
                        task_id="task-abc",
                        run_id="run-xyz",
                    )
                }
            ),
        )

        assert result.verdict is Verdict.FORWARD
        assert result.payload == FollowUpPayload(
            task_id="task-abc",
            parent_run_id="run-xyz",
            user_text="please retry",
            user_ref="ops@example.com",
            transport="webex",
        )

    @pytest.mark.asyncio
    async def test_forward_strips_whitespace_and_optional_user_ref_omitted(self):
        """Forward payloads strip whitespace and omit user_ref when missing."""
        msg = _make_message(text="   help   ", person_email=None)
        event = {"data": {"id": msg["id"], "personId": msg["personId"]}}

        result = await dispatch_message_event(
            event,
            bot_person_id="BOT",
            fetch_message=_fetch({msg["id"]: msg}),
            lookup_thread=_lookup(
                {
                    "msg-task-1": WebexThreadEntry(
                        message_id="msg-task-1", task_id="T", run_id="R"
                    )
                }
            ),
        )

        assert result.verdict is Verdict.FORWARD
        assert result.payload is not None
        assert result.payload.user_text == "help"
        assert result.payload.user_ref is None

    @pytest.mark.asyncio
    async def test_drops_event_with_no_data_id(self):
        """Events lacking ``data.id`` are dropped defensively."""
        result = await dispatch_message_event(
            {"data": {}},
            bot_person_id="BOT",
            fetch_message=_fetch({}),
            lookup_thread=_lookup({}),
        )
        assert result.verdict is Verdict.DROP_NOT_THREAD_REPLY

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Threaded Webex responses for denials and Dynamic Agent streaming."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from typing import Any, Protocol

import httpx

from .a2a_client import (
    AgentAccessDeniedError,
    SSEEventType,
    WebexSSEClient,
    space_message_to_conversation_id,
)
from .app import WebexMessageResult
from .utils.chat_envelope import augment_webex_client_context
from .utils.thread_ownership import ThreadOwnerCache, get_default_thread_owner_cache
from .utils.user_messages import FRIENDLY_REASON_MESSAGES, GENERIC_REQUEST_DENIED_MESSAGE
from .utils.webex_runtime_policy import should_post_denial_notice

logger = logging.getLogger("caipe.webex_bot.webex_responder")

WEBEX_API_BASE_URL = "https://webexapis.com/v1"
# Avoid spamming duplicate 1:1 linking cards when the user retries before completing SSO.
# The OAuth state cookie set by the UI BFF expires after 10 minutes. Keep the resend
# guard shorter so we never point users at an expired card.
_LINKING_CARD_COOLDOWN_SECONDS = 9 * 60
_recent_linking_cards_sent: dict[str, float] = {}


class WebexApiProtocol(Protocol):
    def create_message(
        self,
        *,
        markdown: str,
        room_id: str | None = None,
        parent_id: str | None = None,
        person_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str: ...

    def update_message(self, *, message_id: str, room_id: str, markdown: str) -> None: ...

    def get_message(self, *, message_id: str) -> dict[str, Any] | None: ...

    def list_messages(
        self,
        *,
        room_id: str,
        parent_id: str | None = None,
        before_message_id: str | None = None,
        max_messages: int = 10,
    ) -> list[dict[str, Any]]: ...


class WebexRestApi:
    """Minimal Webex messages API client."""

    def __init__(
        self,
        *,
        access_token: str | None = None,
        base_url: str = WEBEX_API_BASE_URL,
        http_client: httpx.Client | None = None,
    ) -> None:
        token = access_token or os.environ.get("WEBEX_INTEGRATION_BOT_ACCESS_TOKEN", "")
        if not token.strip():
            raise ValueError("WEBEX_INTEGRATION_BOT_ACCESS_TOKEN is required for Webex replies")
        self._token = token.strip()
        self._base_url = base_url.rstrip("/")
        self._http_client = http_client

    def create_message(
        self,
        *,
        markdown: str,
        room_id: str | None = None,
        parent_id: str | None = None,
        person_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        payload: dict[str, Any] = {"markdown": markdown}
        if room_id:
            payload["roomId"] = room_id
        if person_id:
            payload["toPersonId"] = person_id
        if parent_id:
            payload["parentId"] = parent_id
        if attachments:
            payload["attachments"] = attachments
        data = self._request("POST", "/messages", json=payload)
        message_id = data.get("id")
        return str(message_id) if message_id else ""

    def update_message(self, *, message_id: str, room_id: str, markdown: str) -> None:
        self._request("PUT", f"/messages/{message_id}", json={"roomId": room_id, "markdown": markdown})

    def get_message(self, *, message_id: str) -> dict[str, Any] | None:
        data = self._request("GET", f"/messages/{message_id}")
        return data if data else None

    def list_messages(
        self,
        *,
        room_id: str,
        parent_id: str | None = None,
        before_message_id: str | None = None,
        max_messages: int = 10,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"roomId": room_id, "max": max(1, max_messages)}
        if parent_id:
            params["parentId"] = parent_id
        if before_message_id:
            params["beforeMessage"] = before_message_id
        data = self._request("GET", "/messages", params=params)
        items = data.get("items")
        return items if isinstance(items, list) else []

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        client = self._http_client
        owns_client = client is None
        if owns_client:
            client = httpx.Client(timeout=30)
        assert client is not None
        try:
            response = client.request(
                method,
                f"{self._base_url}{path}",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "caipe-webex-bot/0.5.0",
                },
                json=json,
                params=params,
            )
            response.raise_for_status()
            if not response.content:
                return {}
            return response.json()
        finally:
            if owns_client:
                client.close()


class WebexResponder:
    """Reply to the original Webex message thread."""

    def __init__(self, *, webex_api: WebexApiProtocol | None = None) -> None:
        self._webex_api = webex_api or WebexRestApi()

    async def reply_to_result(self, event: dict[str, Any], result: WebexMessageResult) -> None:
        """Send a threaded denial/error reply for non-ignored non-dispatched results."""

        if result.ignored or result.dispatched:
            return
        room_id, parent_id = _thread_refs(event)
        if not room_id or not parent_id:
            logger.warning("Cannot send Webex reply without room_id and parent_id")
            return
        if result.reason_code == "WEBEX_USER_NOT_LINKED":
            if result.linking_url:
                await self._reply_with_private_linking_card(
                    event, room_id=room_id, parent_id=parent_id, result=result
                )
                return
            # Linking URL minting failed (e.g. misconfigured base URL in
            # production, which must be HTTPS) — no DM to send. Fall back to
            # a threaded text reply so explicit invocations are never met
            # with silence, mirroring Slack's unlinked_fallback admin-contact
            # copy.
            if not should_post_denial_notice(
                silence_env=False,
                explicit_invocation=result.explicit_invocation,
            ):
                logger.info(
                    "Suppressing Webex denial reply reason=%s explicit_invocation=%s",
                    result.reason_code,
                    result.explicit_invocation,
                )
                return
            await self._reply_to_thread(
                room_id=room_id,
                parent_id=parent_id,
                markdown=(
                    "Your Webex account could not be linked because the bot is "
                    "not configured to mint linking URLs. Please contact your admin."
                ),
            )
            return

        if not should_post_denial_notice(
            silence_env=False,
            explicit_invocation=result.explicit_invocation,
        ):
            logger.info(
                "Suppressing Webex denial reply reason=%s explicit_invocation=%s",
                result.reason_code,
                result.explicit_invocation,
            )
            return

        markdown = _markdown_for_result(result)
        if not markdown:
            return
        await asyncio.to_thread(
            self._webex_api.create_message,
            room_id=room_id,
            parent_id=parent_id,
            markdown=markdown,
        )

    async def _reply_with_private_linking_card(
        self,
        event: dict[str, Any],
        *,
        room_id: str,
        parent_id: str,
        result: WebexMessageResult,
    ) -> None:
        person_id = _person_ref(event)
        app_name = _app_name()
        if not person_id:
            logger.warning("Cannot send Webex 1:1 linking card without person_id")
            await self._reply_to_thread(
                room_id=room_id,
                parent_id=parent_id,
                markdown=(
                    f"I could not identify your Webex user for private linking. Open {app_name} "
                    "and try account linking, then retry your request."
                ),
            )
            return

        now = time.time()
        last_sent = _recent_linking_cards_sent.get(person_id)
        if (
            last_sent is not None and now - last_sent < _LINKING_CARD_COOLDOWN_SECONDS
        ) or await self._recent_linking_card_exists(room_id=room_id, app_name=app_name, now=now):
            await self._reply_to_thread(
                room_id=room_id,
                parent_id=parent_id,
                markdown=(
                    f"Your Webex account still needs to be linked to {app_name}. "
                    "Open your **1:1 chat with me** and tap **Link with SSO** on the card I sent earlier "
                    "(links expire after 10 minutes). After linking, retry here — no need to wait for a new card."
                ),
            )
            return

        try:
            await asyncio.to_thread(
                self._webex_api.create_message,
                person_id=person_id,
                markdown=f"Link your {app_name} account to Webex to continue.",
                attachments=[_linking_card(app_name, result.linking_url)],
            )
            _recent_linking_cards_sent[person_id] = now
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not send Webex 1:1 linking card (type=%s)", type(exc).__name__)
            await self._reply_to_thread(
                room_id=room_id,
                parent_id=parent_id,
                markdown=(
                    f"I could not send you a 1:1 Webex linking message. Open {app_name} and "
                    "try account linking, then retry your request."
                ),
            )
            return

        await self._reply_to_thread(
            room_id=room_id,
            parent_id=parent_id,
            markdown=(
                f"I sent you a 1:1 Webex message to link your {app_name} account. "
                "Complete linking there, then retry your request."
            ),
        )

    async def _recent_linking_card_exists(self, *, room_id: str, app_name: str, now: float) -> bool:
        # assisted-by Codex Codex-sonnet-4-6
        # Webex WDM can replay messages across reconnects or across duplicate
        # bot instances. The in-memory person cache is still fast, but checking
        # the 1:1 room history prevents another card after a local restart.
        try:
            messages = await asyncio.to_thread(
                self._webex_api.list_messages,
                room_id=room_id,
                max_messages=20,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Could not inspect Webex room for recent linking cards (type=%s)", type(exc).__name__)
            return False

        for message in messages:
            if not _looks_like_linking_message(message, app_name=app_name):
                continue
            created_at = _message_created_at(message)
            if created_at is not None and now - created_at <= _LINKING_CARD_COOLDOWN_SECONDS:
                return True
        return False

    async def _reply_to_thread(self, *, room_id: str, parent_id: str, markdown: str) -> None:
        await asyncio.to_thread(
            self._webex_api.create_message,
            room_id=room_id,
            parent_id=parent_id,
            markdown=markdown,
        )


class WebexThreadedStreamDispatcher:
    """Dispatch allowed messages to Dynamic Agents and stream results into a Webex thread."""

    def __init__(
        self,
        *,
        webex_api: WebexApiProtocol | None = None,
        sse_client: WebexSSEClient | None = None,
        update_every_chars: int = 240,
        thread_owner_cache: ThreadOwnerCache | None = None,
    ) -> None:
        self._webex_api = webex_api or WebexRestApi()
        self._sse_client = sse_client or WebexSSEClient(
            os.environ.get("CAIPE_API_URL", "http://caipe-ui:3000")
        )
        self._update_every_chars = max(1, update_every_chars)
        self._thread_owner_cache = thread_owner_cache or get_default_thread_owner_cache()

    async def __call__(self, payload: dict[str, Any]) -> None:
        await asyncio.to_thread(self._dispatch_sync, payload)

    def _dispatch_sync(self, payload: dict[str, Any]) -> None:
        room_id = str(payload.get("webex_room_id") or "")
        message_id = str(payload.get("message_id") or "")
        thread_parent_id = str(payload.get("thread_parent_id") or "")
        parent_id = thread_parent_id or message_id
        space_id = str(payload.get("space_id") or "")
        agent_id = str(payload.get("agent_id") or "")
        text = str(payload.get("text") or "")
        obo_token = str(payload.get("obo_token") or "")
        is_direct = bool(payload.get("is_direct") or False)
        if not all((room_id, message_id, parent_id, space_id, agent_id, text, obo_token)):
            raise ValueError("Webex threaded stream dispatch payload is missing required fields")

        t0 = time.monotonic()
        reply_id: str | None = None
        accumulated = ""
        last_sent_len = 0

        try:
            agent_message = _message_with_thread_context(
                self._webex_api,
                room_id=room_id,
                parent_id=parent_id,
                message_id=message_id,
                text=text,
            )
            conversation = self._sse_client.create_conversation(
                title=text[:50].strip() or "Webex Thread",
                agent_id=agent_id,
                idempotency_key=f"webex:{space_id}:{parent_id}",
                metadata={
                    "surface": "webex",
                    "webex_space_id": space_id,
                    "webex_message_id": parent_id,
                    "webex_room_id": room_id,
                    "webex_is_direct": is_direct,
                },
                bearer_token=obo_token,
            )
            conversation_id = str(
                conversation.get("conversation_id")
                or space_message_to_conversation_id(space_id, parent_id)
            )

            # Thread ownership: once an agent has responded in this thread,
            # keep routing follow-ups to it even if the space's agent route
            # changes later — mirrors Slack's thread-owner pinning. Only
            # replies (never the root message) look up an existing owner;
            # thread_parent_id is populated exclusively on true replies.
            # Resolved before the placeholder message is created so the
            # first thing users see already shows the pinned/owner agent,
            # instead of flashing the reconfigured route and self-correcting.
            conv_metadata = conversation.get("metadata") or {}
            thread_key = f"{space_id}:{parent_id}"
            if thread_parent_id:
                owner_id = self._thread_owner_cache.get(thread_key) or conv_metadata.get(
                    "thread_owner_agent_id"
                )
                if owner_id and owner_id != agent_id:
                    logger.info(
                        "Webex thread space=%s parent=%s owned by agent=%s, "
                        "overriding requested agent=%s",
                        space_id,
                        parent_id,
                        owner_id,
                        agent_id,
                    )
                    agent_id = owner_id

            reply_id = self._webex_api.create_message(
                room_id=room_id,
                parent_id=parent_id,
                markdown=_agent_reply_markdown(agent_id, "Working on it..."),
            )

            self._thread_owner_cache.set(thread_key, agent_id)
            if not conv_metadata.get("thread_owner_agent_id"):
                try:
                    self._sse_client.update_conversation_metadata(
                        conversation_id,
                        {"thread_owner_agent_id": agent_id},
                        bearer_token=obo_token,
                    )
                except Exception:  # noqa: BLE001 - metadata persistence is best-effort
                    logger.warning("Failed to persist Webex thread owner metadata")

            client_context = {
                "source": "webex",
                "surface": "webex",
                "webex_space_id": space_id,
                "webex_message_id": message_id,
                **({"webex_thread_parent_id": parent_id} if thread_parent_id else {}),
            }
            # Phase 1: propagate originating space context so RAG/PDP can
            # derive team_id from channel_id (spec FR-016/FR-017). 1:1
            # rooms are signalled by absence of a channel_team_mappings row
            # downstream (FR-018), so we always emit surface_kind="channel"
            # here; the receiving server treats unmapped channel_ids as
            # DM-like for personal-team-union evaluation.
            client_context = augment_webex_client_context(
                client_context,
                space_id=space_id,
                thread_parent_id=parent_id if thread_parent_id else None,
                surface_kind="channel",
            )
            for event in self._sse_client.stream_chat(
                message=agent_message,
                conversation_id=conversation_id,
                agent_id=agent_id,
                bearer_token=obo_token,
                client_context=client_context,
            ):
                if event.type == SSEEventType.TEXT_MESSAGE_CONTENT and event.delta:
                    accumulated += event.delta
                    if len(accumulated) - last_sent_len >= self._update_every_chars:
                        self._webex_api.update_message(
                            message_id=reply_id,
                            room_id=room_id,
                            markdown=_agent_reply_markdown(agent_id, accumulated),
                        )
                        last_sent_len = len(accumulated)
                elif event.type == SSEEventType.RUN_ERROR:
                    message = event.message or "The agent run failed."
                    self._webex_api.update_message(
                        message_id=reply_id,
                        room_id=room_id,
                        markdown=_agent_reply_markdown(agent_id, message),
                    )
                    return
        except AgentAccessDeniedError as exc:
            logger.info(
                "Agent access denied for Webex thread space=%s agent=%s",
                space_id,
                exc.agent_id,
            )
            self._post_or_update_reply(
                reply_id=reply_id,
                room_id=room_id,
                parent_id=parent_id,
                markdown=_agent_reply_markdown(
                    agent_id,
                    (
                        f"You don't have permission to use agent `{exc.agent_id}`. "
                        f"Ask an admin to grant you access in {_app_name()}."
                    ),
                ),
            )
            return
        except Exception as exc:
            logger.warning("Webex threaded stream dispatch failed (type=%s)", type(exc).__name__)
            self._post_or_update_reply(
                reply_id=reply_id,
                room_id=room_id,
                parent_id=parent_id,
                markdown=_agent_reply_markdown(
                    agent_id,
                    "I could not complete the request. Please try again.",
                ),
            )
            return

        final_markdown = accumulated.strip() or "Done."
        self._webex_api.update_message(
            message_id=reply_id,
            room_id=room_id,
            markdown=_agent_reply_markdown(agent_id, final_markdown),
        )

        # Persist per-turn message rows for stats/linking — only reached on a
        # genuine successful response (denied/error dispatches return above).
        self._record_message_turns(
            conversation_id=conversation_id,
            space_id=space_id,
            room_id=room_id,
            parent_id=parent_id,
            message_id=message_id,
            agent_id=agent_id,
            is_direct=is_direct,
            response_time_ms=int((time.monotonic() - t0) * 1000),
            bearer_token=obo_token,
        )

    def _post_or_update_reply(
        self, *, reply_id: str | None, room_id: str, parent_id: str, markdown: str
    ) -> None:
        """Surface an error, editing the placeholder if it exists or posting fresh otherwise.

        ``reply_id`` is ``None`` when the failure happened while resolving
        thread ownership/conversation setup, before the placeholder message
        was created.
        """
        if reply_id:
            self._webex_api.update_message(message_id=reply_id, room_id=room_id, markdown=markdown)
        else:
            self._webex_api.create_message(room_id=room_id, parent_id=parent_id, markdown=markdown)

    def _record_message_turns(
        self,
        *,
        conversation_id: str,
        space_id: str,
        room_id: str,
        parent_id: str,
        message_id: str,
        agent_id: str,
        is_direct: bool = False,
        response_time_ms: int | None = None,
        bearer_token: str | None = None,
    ) -> None:
        """Persist per-turn message rows (metadata-only) for a Webex exchange.

        Mirrors Slack's ``_record_message_turns``: Webex turn content lives in
        Webex / the LangGraph checkpointer, so we do NOT duplicate it here. We
        write two content-less ``messages`` rows — one ``user`` turn and one
        ``assistant`` turn — carrying just the metadata admin stats need to
        count Webex messages the same way as web and Slack (source, agent,
        latency).
        """
        link_meta: dict[str, object] = {
            "source": "webex",
            "agent_id": agent_id,
            "webex_space_id": space_id,
            "webex_room_id": room_id,
            "webex_thread_parent_id": parent_id,
            "webex_message_id": message_id,
            "webex_is_direct": is_direct,
        }
        base_id = f"webex-{conversation_id}-{message_id}"

        try:
            self._sse_client.add_message(
                conversation_id=conversation_id,
                message_id=f"{base_id}-user",
                role="user",
                metadata={**link_meta, "turn_id": f"{message_id}-user"},
                bearer_token=bearer_token,
            )
            self._sse_client.add_message(
                conversation_id=conversation_id,
                message_id=f"{base_id}-assistant",
                role="assistant",
                metadata={
                    **link_meta,
                    "turn_id": f"{message_id}-assistant",
                    "is_final": True,
                    **({"latency_ms": response_time_ms} if response_time_ms is not None else {}),
                },
                bearer_token=bearer_token,
            )
        except Exception:  # noqa: BLE001 - best-effort telemetry; never break the Webex reply.
            logger.warning("Failed to record Webex message turns for conversation=%s", conversation_id)


def _thread_refs(event: dict[str, Any]) -> tuple[str | None, str | None]:
    data = event.get("data") if isinstance(event.get("data"), dict) else event
    room_id = data.get("webexRoomId") or data.get("publicRoomId")
    parent_id = data.get("id") or data.get("messageId")
    return (
        str(room_id).strip() if isinstance(room_id, str) and room_id.strip() else None,
        str(parent_id).strip() if isinstance(parent_id, str) and parent_id.strip() else None,
    )


def _person_ref(event: dict[str, Any]) -> str | None:
    data = event.get("data") if isinstance(event.get("data"), dict) else event
    person_id = data.get("personId") or data.get("person_id") or event.get("personId")
    return str(person_id).strip() if isinstance(person_id, str) and person_id.strip() else None


def _markdown_for_result(result: WebexMessageResult) -> str | None:
    parts: list[str] = []
    if result.deny_message:
        parts.append(result.deny_message)
    elif result.reason_code:
        parts.append(FRIENDLY_REASON_MESSAGES.get(result.reason_code, GENERIC_REQUEST_DENIED_MESSAGE))
    if result.linking_url:
        parts.append(f"Link your account: {result.linking_url}")
    return "\n\n".join(parts) if parts else None


def _linking_card(app_name: str, linking_url: str | None) -> dict[str, Any]:
    return {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "type": "AdaptiveCard",
            "version": "1.3",
            "body": [
                {
                    "type": "TextBlock",
                    "text": f"Link {app_name} to Webex",
                    "weight": "Bolder",
                    "size": "Medium",
                    "wrap": True,
                },
                {
                    "type": "TextBlock",
                    "text": f"Verify your identity to interface with {app_name} agents.",
                    "wrap": True,
                },
                {
                    "type": "TextBlock",
                    "text": "This link expires in 10 minutes.",
                    "isSubtle": True,
                    "wrap": True,
                },
            ],
            "actions": [
                {
                    "type": "Action.OpenUrl",
                    "title": "Link with SSO",
                    "url": linking_url or "",
                }
            ],
        },
    }


def _message_created_at(message: dict[str, Any]) -> float | None:
    raw = message.get("created") or message.get("createdAt") or message.get("created_at")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return datetime.fromisoformat(raw.strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _looks_like_linking_message(message: dict[str, Any], *, app_name: str) -> bool:
    expected_title = f"Link {app_name} to Webex"
    markdown = str(message.get("markdown") or message.get("text") or "")
    if expected_title in markdown or f"Link your {app_name} account to Webex" in markdown:
        return True

    attachments = message.get("attachments")
    if not isinstance(attachments, list):
        return False
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        content = attachment.get("content")
        if not isinstance(content, dict):
            continue
        if _card_contains_text(content.get("body"), expected_title):
            return True
        if _card_contains_text(content.get("actions"), "Link with SSO"):
            return True
    return False


def _card_contains_text(value: object, expected: str) -> bool:
    if isinstance(value, str):
        return expected in value
    if isinstance(value, dict):
        return any(_card_contains_text(child, expected) for child in value.values())
    if isinstance(value, list):
        return any(_card_contains_text(child, expected) for child in value)
    return False


def _app_name() -> str:
    return os.environ.get("APP_NAME", "CAIPE").strip() or "CAIPE"


# Stable marker identifying bot-authored replies, independent of APP_NAME so
# renaming the deployment does not orphan the recognition of older replies
# already posted to a Webex thread.
_BOT_REPLY_MARKER = "​<!-- caipe-agent-reply -->"


def _agent_reply_markdown(agent_id: str, body: str) -> str:
    content = body.strip() or "Done."
    app_name = _app_name()
    return (
        f"{content}\n\n"
        f"_Agent: {agent_id}_ • **Mention @{app_name} to continue**"
        f"{_BOT_REPLY_MARKER}"
    )


def _message_with_thread_context(
    webex_api: WebexApiProtocol,
    *,
    room_id: str,
    parent_id: str,
    message_id: str,
    text: str,
) -> str:
    if os.environ.get("WEBEX_THREAD_CONTEXT_ENABLED", "true").strip().lower() in {
        "false",
        "0",
        "no",
        "off",
    }:
        return text

    try:
        context_messages = _load_thread_context_messages(
            webex_api,
            room_id=room_id,
            parent_id=parent_id,
            message_id=message_id,
            max_messages=_thread_context_max_messages(),
        )
    except Exception as exc:  # noqa: BLE001 - context is optional; dispatch should continue.
        logger.warning("Unable to load Webex thread context (type=%s)", type(exc).__name__)
        return text

    formatted_context = _format_thread_context(context_messages)
    if not formatted_context:
        return text
    return (
        "Webex thread context (oldest to newest, excluding the current request):\n"
        f"{formatted_context}\n\n"
        "Current Webex request:\n"
        f"{text}"
    )


def _load_thread_context_messages(
    webex_api: WebexApiProtocol,
    *,
    room_id: str,
    parent_id: str,
    message_id: str,
    max_messages: int,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    remaining = max_messages
    if parent_id != message_id:
        root = webex_api.get_message(message_id=parent_id)
        if root:
            messages.append(root)
            remaining -= 1

    if remaining > 0:
        replies = webex_api.list_messages(
            room_id=room_id,
            parent_id=parent_id,
            before_message_id=message_id,
            max_messages=remaining,
        )
        messages.extend(reversed(replies))
    return [message for message in messages if message.get("id") != message_id]


def _format_thread_context(messages: list[dict[str, Any]]) -> str:
    max_chars = _thread_context_max_chars()
    lines: list[str] = []
    used_chars = 0
    for message in messages:
        if _is_webex_bot_reply(message):
            continue
        text = _message_text(message)
        if not text:
            continue
        author = _message_author(message)
        line = f"- {author}: {text}"
        if used_chars + len(line) > max_chars:
            remaining = max_chars - used_chars
            if remaining <= 0:
                break
            line = line[:remaining].rstrip()
        lines.append(line)
        used_chars += len(line)
        if used_chars >= max_chars:
            break
    return "\n".join(lines)


def _message_text(message: dict[str, Any]) -> str:
    raw = message.get("text") or message.get("markdown") or ""
    return " ".join(str(raw).split())


def _is_webex_bot_reply(message: dict[str, Any]) -> bool:
    raw = str(message.get("markdown") or message.get("text") or "")
    if _BOT_REPLY_MARKER in raw:
        return True
    # Pre-upgrade replies lack the marker entirely — fall back to the old
    # APP_NAME-dependent pattern so they're still recognized during the
    # transition to marker-based detection.
    return f"Mention @{_app_name()} to continue" in raw


def _message_author(message: dict[str, Any]) -> str:
    for key in ("personEmail", "personDisplayName", "personId"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "unknown"


def _thread_context_max_messages() -> int:
    try:
        return max(1, int(os.environ.get("WEBEX_THREAD_CONTEXT_MAX_MESSAGES", "10")))
    except ValueError:
        return 10


def _thread_context_max_chars() -> int:
    try:
        return max(200, int(os.environ.get("WEBEX_THREAD_CONTEXT_MAX_CHARS", "4000")))
    except ValueError:
        return 4000

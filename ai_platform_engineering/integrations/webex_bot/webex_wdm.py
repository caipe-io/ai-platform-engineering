# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Webex WDM/Mercury websocket transport for bot message ingestion."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import threading
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Mapping

from .utils.webex_command_dispatcher import WebexCommandDispatcher
from .utils.webex_direct_users import webex_dm_access_mode
from .utils.webex_ids import canonicalize_webex_space_id, public_webex_room_id_from_uuid
from .utils.webex_bot_catalog import configured_webex_bots
from .app import handle_webex_message
from .webex_responder import (
    WebexResponder,
    WebexRestApi,
    WebexThreadedStreamDispatcher,
)
from .webex_websocket import WebexWebSocketRuntime

logger = logging.getLogger("caipe.webex_bot.webex_wdm")

WEBEX_API_BASE_URL = "https://webexapis.com/v1"
WEBEX_WDM_DEVICES_URL = "https://wdm-a.wbx2.com/wdm/api/v1/devices"
# Mercury rejects stale or throttled registrations with these HTTP statuses during
# the WebSocket upgrade; delete and re-register the WDM device before retrying.
WDM_HANDSHAKE_REFRESH_STATUSES = frozenset({401, 403, 404, 429})
MAX_WDM_HANDSHAKE_REFRESH_ATTEMPTS = 3
@dataclass(frozen=True)
class WebexBotListenerConfig:
    id: str
    name: str
    token_env: str
    access_token: str


def configured_webex_bot_listeners(
    env: Mapping[str, str] | None = None,
) -> list[WebexBotListenerConfig]:
    """Resolve configured bot identities without exposing token values."""

    source = os.environ if env is None else env
    listeners: list[WebexBotListenerConfig] = []
    for bot in configured_webex_bots(source):
        token = source.get(bot.token_env, "").strip()
        if not token:
            logger.warning(
                "Webex bot listener disabled id=%s: %s is not configured",
                bot.id,
                bot.token_env,
            )
            continue
        listeners.append(WebexBotListenerConfig(bot.id, bot.name, bot.token_env, token))
    return listeners


def websocket_handshake_status(exc: BaseException) -> int | None:
    """Return the HTTP status code when a WebSocket handshake fails."""

    try:
        from websockets.exceptions import InvalidStatus
    except ImportError:  # pragma: no cover - older websockets
        from websockets import InvalidStatus  # type: ignore[attr-defined,no-redef]

    if not isinstance(exc, InvalidStatus):
        return None
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    return int(status_code) if status_code is not None else None


def should_refresh_wdm_device_on_handshake(status_code: int | None) -> bool:
    """Return True when Mercury indicates the cached WDM registration is unusable."""

    return status_code in WDM_HANDSHAKE_REFRESH_STATUSES


def websocket_connect_header_kwargs(headers: dict[str, str]) -> dict[str, Any]:
    """Build version-compatible auth header kwargs for websockets.connect()."""

    import websockets

    connect = websockets.connect
    try:
        params = inspect.signature(connect).parameters
    except (TypeError, ValueError):
        return {"extra_headers": headers}
    if "additional_headers" in params:
        return {"additional_headers": headers}
    if "extra_headers" in params:
        return {"extra_headers": headers}
    return {"extra_headers": headers}


def base64_encode_webex_id(raw_id: str | None, resource_type: str) -> str | None:
    """Encode a WDM raw resource id into Webex public API id format."""

    if not raw_id:
        return None
    if resource_type == "ROOM":
        return public_webex_room_id_from_uuid(raw_id)
    import base64

    payload = f"ciscospark://us/{resource_type}/{raw_id}".encode("utf-8")
    return base64.b64encode(payload).decode("ascii").rstrip("=")


def webex_event_from_wdm_activity(
    activity: dict[str, Any],
    *,
    message_detail: dict[str, Any],
    bot_person_id: str | None,
    bot_id: str | None = None,
    bot_name: str | None = None,
) -> dict[str, Any]:
    """Build the existing Webex gate payload from a WDM activity and message detail."""

    raw_message_id = _raw_message_id(activity)
    raw_room_id = _raw_room_id(activity)
    person_id = message_detail.get("personId")
    public_room_id = str(message_detail.get("roomId") or base64_encode_webex_id(raw_room_id, "ROOM"))
    canonical_space_id = canonicalize_webex_space_id(public_room_id or str(raw_room_id or ""))
    mentioned_people = message_detail.get("mentionedPeople") or []
    normalized_mentions = (
        {str(value).strip() for value in mentioned_people}
        if isinstance(mentioned_people, list)
        else set()
    )

    data = {
        "id": message_detail.get("id") or base64_encode_webex_id(raw_message_id, "MESSAGE"),
        "parentId": message_detail.get("parentId"),
        "roomId": canonical_space_id,
        "webexRoomId": public_room_id,
        "personId": person_id,
        "personEmail": message_detail.get("personEmail"),
        "roomType": message_detail.get("roomType"),
        "text": message_detail.get("text") or message_detail.get("markdown") or "",
        "mentionedPeople": mentioned_people,
        "botMentioned": bool(
            bot_person_id
            and (bot_person_id in normalized_mentions or "all" in normalized_mentions)
        ),
        "isSelf": bool(bot_person_id and person_id == bot_person_id),
    }
    if bot_id:
        data["botId"] = bot_id
    if bot_name:
        data["botName"] = bot_name
    return {
        "event": "message",
        "data": data,
    }


class WebexWdmRuntime:
    """Maintain a Webex WDM websocket connection and dispatch message events."""

    def __init__(
        self,
        *,
        access_token: str,
        runtime: WebexWebSocketRuntime | None = None,
        responder: WebexResponder | None = None,
        device_name: str = "CAIPE-Webex-Bot",
        bot_id: str,
        bot_name: str = "Webex bot",
        require_bot_mention: bool = False,
    ) -> None:
        self._access_token = access_token
        webex_api = WebexRestApi(access_token=access_token)
        dispatcher = WebexThreadedStreamDispatcher(webex_api=webex_api)
        command_handler = (
            WebexCommandDispatcher(webex_api=webex_api)
            if webex_dm_access_mode(bot_id) == "all_users"
            else None
        )
        self._runtime = runtime or WebexWebSocketRuntime(
            message_handler=lambda event, **kwargs: handle_webex_message(
                event,
                dispatcher=dispatcher,
                command_handler=command_handler,
                **kwargs,
            )
        )
        self._responder = responder or WebexResponder(webex_api=webex_api)
        self._device_name = device_name
        self._bot_id = bot_id
        self._bot_name = bot_name
        self._require_bot_mention = require_bot_mention
        self._bot_email: str | None = None
        self._bot_person_id: str | None = None
        # Self-link of the WDM device we are currently registered as, so we
        # can reuse it across reconnects instead of leaking a new device.
        self._device_url: str | None = None
        # Bounded de-duplication of recently handled message ids. Webex can
        # redeliver the same activity (e.g. across registered devices or on
        # reconnect); without this guard the bot processes and replies to the
        # same message more than once.
        self._seen_message_ids: deque[str] = deque()
        self._seen_message_id_set: set[str] = set()
        self._seen_message_limit = 512
        self._handshake_refresh_attempts = 0

    def _rest_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
        }

    async def run_forever(self) -> None:
        """Connect to Webex WDM and reconnect with capped exponential backoff."""

        import aiohttp
        import websockets

        headers = self._rest_headers()
        connect_kwargs = websocket_connect_header_kwargs(headers)
        retry_delay = 1
        async with aiohttp.ClientSession(headers=headers) as session:
            await self._load_bot_identity(session)
            while True:
                try:
                    websocket_url = await self._get_websocket_url(session)
                    if not websocket_url:
                        logger.error("Webex WDM did not return a websocket URL")
                        return
                    logger.info("Connecting to Webex WDM websocket")
                    async with websockets.connect(
                        websocket_url,
                        ping_interval=20,
                        open_timeout=30,
                        **connect_kwargs,
                    ) as websocket:
                        retry_delay = 1
                        self._handshake_refresh_attempts = 0
                        await websocket.send(
                            json.dumps(
                                {
                                    "id": str(uuid.uuid4()),
                                    "type": "authorization",
                                    "data": {"token": f"Bearer {self._access_token}"},
                                }
                            )
                        )
                        logger.info("Webex WDM websocket listener is live")
                        async for message in websocket:
                            await self._handle_websocket_message(session, message)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - reconnect on transport failures
                    retry_delay = await self._handle_connection_failure(
                        session,
                        exc,
                        retry_delay,
                    )

    async def _load_bot_identity(self, session: Any) -> None:
        async with session.get(f"{WEBEX_API_BASE_URL}/people/me") as response:
            if response.status != 200:
                logger.warning("Unable to load Webex bot identity status=%s", response.status)
                return
            payload = await response.json()
            self._bot_email = (payload.get("emails") or [None])[0]
            self._bot_person_id = payload.get("id")
            logger.info(
                "Loaded Webex bot identity display=%s id_present=%s",
                payload.get("displayName"),
                bool(self._bot_person_id),
            )

    async def _handle_connection_failure(
        self,
        session: Any,
        exc: BaseException,
        retry_delay: int,
    ) -> int:
        """Log a reconnectable transport failure and optionally refresh WDM state."""

        status_code = websocket_handshake_status(exc)
        if status_code is not None:
            logger.warning(
                "Webex WDM websocket handshake failed status=%s; retrying in %ss",
                status_code,
                retry_delay,
            )
            if (
                should_refresh_wdm_device_on_handshake(status_code)
                and self._handshake_refresh_attempts < MAX_WDM_HANDSHAKE_REFRESH_ATTEMPTS
            ):
                self._handshake_refresh_attempts += 1
                await self._refresh_wdm_device(session)
                if status_code == 429:
                    retry_delay = max(retry_delay, 5)
            elif (
                should_refresh_wdm_device_on_handshake(status_code)
                and self._handshake_refresh_attempts >= MAX_WDM_HANDSHAKE_REFRESH_ATTEMPTS
            ):
                logger.error(
                    "Webex WDM device refresh limit reached after %s attempt(s); "
                    "continuing backoff without deleting devices",
                    MAX_WDM_HANDSHAKE_REFRESH_ATTEMPTS,
                )
        else:
            logger.warning(
                "Webex WDM websocket connection lost (type=%s); retrying in %ss",
                type(exc).__name__,
                retry_delay,
            )
            # The server closed the socket post-handshake (ConnectionClosedOK for a
            # graceful 1000/1001 close, ConnectionClosedError for anything else) — the
            # cached webSocketUrl may have expired either way.  Force a fresh device
            # registration so the next connect gets a valid URL instead of looping on
            # a stale one.
            from websockets.exceptions import ConnectionClosed  # noqa: PLC0415

            if (
                isinstance(exc, ConnectionClosed)
                and self._handshake_refresh_attempts < MAX_WDM_HANDSHAKE_REFRESH_ATTEMPTS
            ):
                self._handshake_refresh_attempts += 1
                await self._refresh_wdm_device(session)

        await asyncio.sleep(retry_delay)
        return min(retry_delay * 2, 60)

    async def _refresh_wdm_device(self, session: Any) -> None:
        """Delete cached WDM registrations so the next connect registers fresh."""

        device_urls: set[str] = set()
        if self._device_url:
            device_urls.add(self._device_url)
            self._device_url = None
        for device in await self._list_own_devices(session):
            url = device.get("url")
            if url:
                device_urls.add(str(url))
        for device_url in device_urls:
            await self._delete_device(session, device_url)
        logger.info(
            "Refreshed Webex WDM device registration after failed Mercury handshake "
            "(attempt %s/%s)",
            self._handshake_refresh_attempts,
            MAX_WDM_HANDSHAKE_REFRESH_ATTEMPTS,
        )

    async def _get_websocket_url(self, session: Any) -> str | None:
        # Reuse an existing WDM registration instead of creating a brand-new
        # device on every reconnect. Webex fans every message out to ALL
        # registered devices, so leaking a device per reconnect makes the bot
        # receive (and reply to) the same message multiple times. We keep a
        # single device for this bot and prune any extras we previously leaked.
        existing = await self._list_own_devices(session)
        if existing:
            existing.sort(key=lambda d: str(d.get("modificationTime") or ""), reverse=True)
            primary = existing[0]
            for stale in existing[1:]:
                await self._delete_device(session, stale.get("url"))
            url = primary.get("webSocketUrl")
            if url:
                self._device_url = primary.get("url")
                logger.info(
                    "Reusing existing Webex WDM device (pruned %d stale device(s))",
                    max(0, len(existing) - 1),
                )
                return url
        return await self._register_device(session)

    async def _list_own_devices(self, session: Any) -> list[dict[str, Any]]:
        async with session.get(WEBEX_WDM_DEVICES_URL) as response:
            if response.status != 200:
                logger.warning("Webex WDM device listing returned status=%s", response.status)
                return []
            payload = await response.json()
        devices = payload.get("devices") or []
        return [
            device
            for device in devices
            if device.get("name") == self._device_name and device.get("webSocketUrl")
        ]

    async def _register_device(self, session: Any) -> str | None:
        device_data = {
            "name": self._device_name,
            "deviceName": self._device_name,
            "deviceType": "DESKTOP",
            "model": "caipe-webex-bot",
            "localizedModel": "caipe-webex-bot",
            "systemName": "linux",
            "systemVersion": "1.0.0",
        }
        async with session.post(WEBEX_WDM_DEVICES_URL, json=device_data) as response:
            if response.status in (200, 201):
                payload = await response.json()
                self._device_url = payload.get("url")
                return payload.get("webSocketUrl")
            logger.warning("Webex WDM device registration returned status=%s", response.status)
            return None

    async def _delete_device(self, session: Any, device_url: str | None) -> None:
        if not device_url:
            return
        try:
            async with session.delete(device_url) as response:
                if response.status not in (200, 202, 204):
                    logger.warning("Webex WDM device delete returned status=%s", response.status)
        except Exception as exc:  # noqa: BLE001 - device cleanup is best-effort
            logger.warning("Webex WDM device delete failed (type=%s)", type(exc).__name__)

    async def _handle_websocket_message(self, session: Any, message: str | bytes) -> None:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            logger.warning("Ignoring malformed Webex WDM websocket frame")
            return

        activity = payload.get("data", {}).get("activity", {})
        if activity.get("verb") != "post":
            return

        actor_email = activity.get("actor", {}).get("emailAddress")
        if actor_email and self._bot_email and actor_email == self._bot_email:
            return

        message_id = base64_encode_webex_id(_raw_message_id(activity), "MESSAGE")
        if not message_id:
            logger.warning("Ignoring Webex WDM activity without message id")
            return

        if self._already_handled(message_id):
            logger.debug("Ignoring duplicate Webex WDM activity message_id=%s", message_id)
            return

        message_detail = await self._fetch_message_detail(session, message_id)
        if message_detail is None:
            return
        if self._require_bot_mention and not message_targets_bot(
            message_detail, self._bot_person_id
        ):
            logger.debug("Ignoring group message not addressed to bot id=%s", self._bot_id)
            return

        event = webex_event_from_wdm_activity(
            activity,
            message_detail=message_detail,
            bot_person_id=self._bot_person_id,
            bot_id=self._bot_id,
            bot_name=self._bot_name,
        )
        result = await self._runtime.handle_payload(event)
        await self._responder.reply_to_result(event, result)
        logger.info(
            "Webex WDM event processed bot_id=%s allowed=%s dispatched=%s ignored=%s reason=%s",
            self._bot_id,
            result.allowed,
            result.dispatched,
            result.ignored,
            result.reason_code,
        )

    def _already_handled(self, message_id: str) -> bool:
        """Return True if this message id was handled recently (and record it)."""

        if message_id in self._seen_message_id_set:
            return True
        self._seen_message_ids.append(message_id)
        self._seen_message_id_set.add(message_id)
        while len(self._seen_message_ids) > self._seen_message_limit:
            oldest = self._seen_message_ids.popleft()
            self._seen_message_id_set.discard(oldest)
        return False

    async def _fetch_message_detail(self, session: Any, message_id: str) -> dict[str, Any] | None:
        async with session.get(f"{WEBEX_API_BASE_URL}/messages/{message_id}") as response:
            if response.status != 200:
                logger.warning("Unable to fetch Webex message detail status=%s", response.status)
                return None
            return await response.json()


def message_targets_bot(
    message_detail: Mapping[str, Any], bot_person_id: str | None
) -> bool:
    """Require an explicit bot mention in shared rooms when listeners are multiplexed."""

    if str(message_detail.get("roomType") or "").strip().lower() == "direct":
        return True
    mentions = message_detail.get("mentionedPeople")
    if not bot_person_id or not isinstance(mentions, list):
        return False
    normalized = {str(value).strip() for value in mentions}
    return bot_person_id in normalized or "all" in normalized


def start_webex_wdm_listener(
    access_token: str,
    *,
    bot_id: str,
    bot_name: str = "Webex bot",
    require_bot_mention: bool = False,
) -> threading.Thread | None:
    """Start the Webex WDM listener in a daemon thread when a bot token is configured."""

    token = access_token.strip()
    if not token:
        logger.info("Webex bot token is empty for id=%s; WDM listener disabled", bot_id)
        return None

    runtime = WebexWdmRuntime(
        access_token=token,
        bot_id=bot_id,
        bot_name=bot_name,
        device_name=f"CAIPE-Webex-Bot-{bot_id}",
        require_bot_mention=require_bot_mention,
    )
    thread = threading.Thread(target=lambda: asyncio.run(runtime.run_forever()), daemon=True)
    thread.start()
    return thread


def start_webex_wdm_listeners(
    env: Mapping[str, str] | None = None,
) -> list[threading.Thread]:
    """Start one isolated WDM listener per configured bot identity."""

    listeners = configured_webex_bot_listeners(env)
    multiplexed = len(listeners) > 1
    threads: list[threading.Thread] = []
    for listener in listeners:
        thread = start_webex_wdm_listener(
            listener.access_token,
            bot_id=listener.id,
            bot_name=listener.name,
            require_bot_mention=multiplexed,
        )
        if thread is not None:
            threads.append(thread)
            logger.info("Webex WDM listener started id=%s name=%s", listener.id, listener.name)
    return threads


def _raw_message_id(activity: dict[str, Any]) -> str | None:
    raw = activity.get("object", {}).get("id") or activity.get("id")
    return str(raw) if raw else None


def _raw_room_id(activity: dict[str, Any]) -> str | None:
    raw = activity.get("target", {}).get("id")
    return str(raw) if raw else None

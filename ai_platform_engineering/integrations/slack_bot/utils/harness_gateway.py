"""Optional bot transport for detached runs and cursor-based AG-UI replay."""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any
from urllib.parse import quote

import httpx


class NativeConversation(Exception):
    """The BFF owns a legacy or application stream; no Engine run was admitted."""


_CURSOR = re.compile(r"^[0-9]+\.[0-9]+$")
_RETRYABLE = {502, 503, 504}
_TERMINAL = {"RUN_FINISHED", "RUN_ERROR"}
_MAX_RETRIES = 5


def _cursor(value: str) -> tuple[int, int]:
    if not _CURSOR.fullmatch(value):
        raise RuntimeError("Harness Gateway returned an invalid replay cursor")
    sequence, part = value.split(".")
    return int(sequence), int(part)


def _request_id(payload: dict[str, Any], source: str) -> str:
    context = payload.get("client_context") or {}
    if not isinstance(context, dict):
        raise ValueError("client_context must be an object")
    delivery = context.get("delivery_id") or context.get("webex_message_id")
    if not delivery:
        return str(uuid.uuid4())
    return hashlib.sha256(json.dumps([
        source, payload["agent_id"], payload["conversation_id"], delivery,
    ]).encode()).hexdigest()


def _frames(response: httpx.Response) -> Iterator[tuple[str, str]]:
    event_id = ""
    data: list[str] = []
    size = 0
    for line in response.iter_lines():
        if not line:
            if data:
                yield event_id, "\n".join(data)
            event_id, data, size = "", [], 0
        elif line.startswith("id:"):
            event_id = line[3:].strip()
        elif line.startswith("data:"):
            value = line[5:].removeprefix(" ")
            size += len(value)
            if size > 8 * 1024 * 1024:
                raise RuntimeError("Harness Gateway event exceeds the size limit")
            data.append(value)
    # An incomplete final frame is replayed after the previous committed cursor.


def stream_gateway(
    client: httpx.Client,
    base_url: str,
    payload: dict[str, Any],
    headers: Callable[[], dict[str, str]],
) -> Iterator[str]:
    """Admit once, then reconnect only the subscriber with the same caller identity.

    The idempotency key is fixed before admission retries. Never fall back after
    an ambiguous failure, and never cancel provider execution on subscriber exit.
    No credentials or delivery cursors are persisted by this transport.
    """
    body = {**payload, "client_request_id": _request_id(payload, headers().get("X-Client-Source", ""))}
    for attempt in range(_MAX_RETRIES + 1):
        try:
            response = client.post(
                f"{base_url}/api/harness-engine/runs", json=body,
                headers={**headers(), "Accept": "application/json"},
            )
            if response.status_code in {409, 501}:
                envelope = response.json()
                if isinstance(envelope, dict) and envelope.get("code") in {"HARNESS_RUNTIME_MISMATCH", "APP_STREAM_REQUIRED"}:
                    raise NativeConversation
                if response.status_code == 409:
                    # Redelivery may rebuild newer thread context. Find the
                    # original run instead of changing its admitted input.
                    lookup = client.post(
                        f"{base_url}/api/harness-engine/run-requests/lookup",
                        json={key: body[key] for key in ("agent_id", "conversation_id", "client_request_id")},
                        headers={**headers(), "Accept": "application/json"},
                    )
                    if lookup.status_code in _RETRYABLE:
                        response = lookup
                    else:
                        lookup.raise_for_status()
                        known = lookup.json()
                        data = known.get("data") if isinstance(known, dict) and known.get("success") else None
                        if isinstance(data, dict) and isinstance(data.get("run_id"), str) and data["run_id"]:
                            run_id = data["run_id"]
                            break
            if response.status_code not in _RETRYABLE:
                response.raise_for_status()
                run = response.json()
                data = run.get("data") if isinstance(run, dict) and run.get("success") else None
                run_id = data.get("run_id") if isinstance(data, dict) else None
                if not isinstance(run_id, str) or not run_id:
                    raise RuntimeError("Harness Gateway did not confirm run admission")
                break
        except httpx.TransportError:
            # Admission may have succeeded; retain the key and use the bounded
            # retry/backoff below rather than dispatching another transport.
            pass
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Harness Gateway admission failed (HTTP {exc.response.status_code})") from None
        if attempt == _MAX_RETRIES:
            raise RuntimeError("Harness Gateway admission could not be confirmed; do not resubmit automatically")
        time.sleep(min(0.25 * 2**attempt, 4))

    after = "0"
    failures = 0
    while failures <= _MAX_RETRIES:
        try:
            with client.stream(
                "GET", f"{base_url}/api/harness-engine/runs/{quote(run_id, safe='')}/events/stream",
                params={"protocol": "agui", "after": after}, headers=headers(),
            ) as response:
                if response.status_code not in _RETRYABLE:
                    response.raise_for_status()
                    for event_id, data in _frames(response):
                        position = _cursor(event_id)
                        if after != "0" and position <= _cursor(after):
                            continue
                        event = json.loads(data)
                        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                            raise RuntimeError("Harness Gateway returned an invalid AG-UI event")
                        yield data
                        after = event_id
                        failures = 0
                        if event["type"] in _TERMINAL:
                            return
        except httpx.TransportError:
            # Keep the last complete cursor. The shared retry budget/backoff
            # below also handles interrupted and empty subscription responses.
            pass
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Harness Gateway replay denied (HTTP {exc.response.status_code})") from None
        failures += 1
        if failures > _MAX_RETRIES:
            raise RuntimeError("Harness Gateway subscription interrupted; the server-owned run may still be active")
        time.sleep(min(0.25 * 2 ** (failures - 1), 4))

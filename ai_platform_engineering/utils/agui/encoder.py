# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
AG-UI SSE encoder.

Provides utilities for serialising AG-UI event models to Server-Sent Events
(SSE) wire format.

SSE wire format (per W3C)::

    event: TEXT_MESSAGE_CONTENT
    data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}

    (blank line terminates the event frame)

Usage::

    from ai_platform_engineering.utils.agui.encoder import format_sse_event
    from ai_platform_engineering.utils.agui.event_emitter import emit_text_content

    event = emit_text_content(message_id="msg-1", delta="Hello ")
    sse_frame = format_sse_event(event)
    # yields: "event: TEXT_MESSAGE_CONTENT\\ndata: {...}\\n\\n"
"""

from __future__ import annotations

import json
from typing import AsyncIterator, Iterator

from .event_types import BaseAGUIEvent


# ---------------------------------------------------------------------------
# Core serialisation helper
# ---------------------------------------------------------------------------


def _event_to_dict(event: BaseAGUIEvent) -> dict:
    """Serialise a Pydantic AG-UI event model to a plain dict.

    Field aliases (camelCase) are used in the output so the wire format
    matches the AG-UI specification (e.g. ``messageId``, not ``message_id``).
    """
    return event.model_dump(by_alias=True, exclude_none=True)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def format_sse_event(event: BaseAGUIEvent) -> str:
    """Serialise an AG-UI event to a complete SSE frame string.

    The returned string includes the ``event:`` type line, the ``data:``
    payload line (JSON), and the mandatory trailing blank line.

    Parameters
    ----------
    event:
        Any AG-UI event model (must be a subclass of ``BaseAGUIEvent``).

    Returns
    -------
    str
        An SSE frame ready to be written to a streaming HTTP response, e.g.::

            "event: TEXT_MESSAGE_CONTENT\\ndata: {...}\\n\\n"
    """
    payload = json.dumps(_event_to_dict(event), ensure_ascii=False)
    event_type = event.type.value

    # SSE data values containing newlines must be split into multiple
    # ``data:`` lines (W3C SSE spec §9.2.6).
    if "\n" in payload:
        data_lines = "\n".join(f"data: {line}" for line in payload.split("\n"))
    else:
        data_lines = f"data: {payload}"

    return f"event: {event_type}\n{data_lines}\n\n"


def encode_events(
    events: Iterator[BaseAGUIEvent],
) -> Iterator[str]:
    """Yield SSE-formatted strings from a synchronous iterator of events.

    Parameters
    ----------
    events:
        Synchronous iterator that yields AG-UI event models.

    Yields
    ------
    str
        SSE frame strings suitable for writing to a streaming response.
    """
    for event in events:
        yield format_sse_event(event)


async def encode_events_async(
    events: AsyncIterator[BaseAGUIEvent],
) -> AsyncIterator[str]:
    """Yield SSE-formatted strings from an async iterator of events.

    Parameters
    ----------
    events:
        Async iterator that yields AG-UI event models.

    Yields
    ------
    str
        SSE frame strings suitable for writing to a streaming response.
    """
    async for event in events:
        yield format_sse_event(event)

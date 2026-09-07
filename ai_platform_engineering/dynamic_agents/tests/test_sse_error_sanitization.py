# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by claude code claude-sonnet-4-6

"""Tests that SSE error events don't expose internal exception details."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from dynamic_agents.services.stream_encoders import get_encoder


async def _collect_sse_events(async_gen):
    events = []
    async for chunk in async_gen:
        events.append(chunk)
    return events


class TestSSEErrorSanitization:
    """Verify _generate_sse_events and _generate_resume_sse_events don't leak str(e)."""

    @pytest.mark.asyncio
    async def test_stream_error_does_not_expose_exception_message(self):
        from dynamic_agents.routes.chat import _generate_sse_events

        secret_message = "SECRET_TOKEN_abc123_should_not_appear"

        async def _failing_stream(*args, **kwargs):
            raise RuntimeError(secret_message)
            yield  # pragma: no cover — unreachable; makes this an async generator

        mock_runtime = AsyncMock()
        mock_runtime.stream = _failing_stream

        mock_cache = MagicMock()
        mock_cache.get_or_create = AsyncMock(return_value=mock_runtime)

        agent_config = MagicMock()
        agent_config.name = "test-agent"
        user = MagicMock()
        user.email = "user@example.com"

        with patch("dynamic_agents.routes.chat.get_runtime_cache", return_value=mock_cache):
            events = await _collect_sse_events(
                _generate_sse_events(agent_config, [], "hello", "sess-1", user, get_encoder("custom"))
            )

        error_events = [e for e in events if "event: error" in e]
        assert len(error_events) == 1
        error_data = json.loads(error_events[0].split("data: ", 1)[1].strip())
        assert secret_message not in error_data.get("error", "")
        assert error_data.get("error")  # a generic, non-empty message replaces the raw exception

    @pytest.mark.asyncio
    async def test_resume_stream_error_does_not_expose_exception_message(self):
        from dynamic_agents.routes.chat import _generate_resume_sse_events

        secret_message = "SECRET_API_KEY_xyz789_should_not_appear"

        async def _failing_resume(*args, **kwargs):
            raise RuntimeError(secret_message)
            yield  # pragma: no cover — unreachable; makes this an async generator

        mock_runtime = AsyncMock()
        mock_runtime.resume = _failing_resume

        mock_cache = MagicMock()
        mock_cache.get_or_create = AsyncMock(return_value=mock_runtime)

        agent_config = MagicMock()
        agent_config.name = "test-agent"
        user = MagicMock()
        user.email = "user@example.com"

        with patch("dynamic_agents.routes.chat.get_runtime_cache", return_value=mock_cache):
            events = await _collect_sse_events(
                _generate_resume_sse_events(agent_config, [], "sess-1", user, "{}", get_encoder("custom"))
            )

        error_events = [e for e in events if "event: error" in e]
        assert len(error_events) == 1
        error_data = json.loads(error_events[0].split("data: ", 1)[1].strip())
        assert secret_message not in error_data.get("error", "")
        assert error_data.get("error")  # a generic, non-empty message replaces the raw exception

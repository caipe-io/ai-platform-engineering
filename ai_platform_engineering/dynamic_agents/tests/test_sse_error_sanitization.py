# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by claude code claude-sonnet-4-6

"""SSE error events never expose internal exception details."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from dynamic_agents.routes import chat
from dynamic_agents.services.stream_encoders import get_encoder


@pytest.mark.parametrize("resume_data", [None, "{}"])
@pytest.mark.parametrize("protocol", ["custom", "agui"])
async def test_stream_and_resume_errors_do_not_expose_internal_messages(monkeypatch, resume_data, protocol):
    secret_message = "SECRET_TOKEN_example_should_not_appear"

    async def failing_stream(turn, encoder):
        assert turn.resume_data == resume_data
        raise RuntimeError(secret_message)
        yield  # pragma: no cover -- async generator contract

    service = SimpleNamespace(stream=failing_stream)
    monkeypatch.setattr(chat, "AgentExecutionService", lambda _mongo: service)
    agent_config = MagicMock(name="test-agent")
    user = SimpleNamespace(email="caller@example.com")
    frames = [frame async for frame in chat._generate_sse_events(
        agent_config=agent_config, message=None if resume_data else "hello", session_id="example-session",
        user=user, encoder=get_encoder(protocol), resume_data=resume_data,
    )]
    assert len(frames) == 1
    data = json.loads(frames[0].split("data: ", 1)[1].strip())
    error = data["error"] if protocol == "custom" else data["message"]
    assert error == chat.GENERIC_AGENT_ERROR
    assert secret_message not in error

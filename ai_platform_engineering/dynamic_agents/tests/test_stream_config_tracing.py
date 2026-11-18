"""Langfuse trace attributes carried by the stream run config."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from dynamic_agents.services.agent_runtime import AgentRuntime


class _StubTracing:
    def create_config(self, context_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": context_id}}

    def get_trace_id(self) -> str | None:
        return None


def _runtime() -> AgentRuntime:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime.tracing = _StubTracing()
    runtime.config = SimpleNamespace(id="agent-1", name="example-agent")
    return runtime


def test_stream_config_sets_langfuse_user_id() -> None:
    config = _runtime()._build_stream_config("conv-1", "test-user@example.com", None)

    assert config["metadata"]["langfuse_user_id"] == "test-user@example.com"
    assert config["metadata"]["user_id"] == "test-user@example.com"


@pytest.mark.parametrize(
    ("session_id", "expected"),
    [
        ("conv-1", "conv-1"),
        ("workflow-run-7-step-2", "workflow-run-7"),
    ],
)
def test_stream_config_sets_langfuse_session_id(session_id: str, expected: str) -> None:
    config = _runtime()._build_stream_config(session_id, "test-user@example.com", None)

    assert config["metadata"]["langfuse_session_id"] == expected

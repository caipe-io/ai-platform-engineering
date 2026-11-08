"""A2A participants retain transport safety, remote context and terminal proof."""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

pytest.importorskip("dynamic_agents")
from a2a.client.errors import A2AClientError
from a2a.types import (
    Artifact,
    Message,
    Part,
    Role,
    StreamResponse,
    Task,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)

from harness_engine import a2a_runtime
from harness_engine.adapters.a2a import RemoteA2AAdapter
from harness_engine.adapters.base import ExecutionUnconfirmedError
from harness_engine.models import AgentBlueprint, ExecutionIdentity, RunContext, SessionBinding, TurnOutcome


def context(**turn: Any) -> RunContext:
    return RunContext(
        blueprint=AgentBlueprint(id="a2a-remote-example", name="Remote example", harness={
            "id": "a2a_remote", "profile_id": "registry", "options": {"registry_id": "remote-example"},
        }, prompt={"system": "Do not send this prompt to the remote service"}),
        binding=SessionBinding(binding_id="binding-example", owner_subject="test-owner", agent_id="a2a-remote-example",
            agent_version=1, conversation_id="chat-example", harness_id="a2a_remote", profile_id="registry", checkpoint_strategy="remote_managed"),
        prompt={"system": "Do not send this prompt to the remote service"},
        turn={"run_id": "run-example", "message": "Assigned task", **turn},
        identity=ExecutionIdentity(subject="test-owner", bearer="caller-token"),
    )


def task(state: int, text: str = "answer") -> Task:
    return Task(id="task-example", context_id="context-example", status=TaskStatus(state=state),
                artifacts=[Artifact(artifact_id="answer", parts=[Part(text=text)])])


@pytest.fixture
def setup(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, ...]:
    registry = SimpleNamespace(initialize=AsyncMock(), mongo=SimpleNamespace(
        get_remote_agents_by_ids=Mock(return_value=[{"_id": "remote-example", "endpoint": "https://example.test/agent", "timeout_seconds": 10, "streaming": True}]),
        settings=SimpleNamespace(remote_a2a_max_output_bytes=4096, remote_a2a_max_response_bytes=8192,
            credential_api_url="https://credentials.example.test", credential_service_audience="example", remote_a2a_allowed_http_origins=[]),
    ))
    runtime = a2a_runtime.A2ARuntime(registry)
    client = SimpleNamespace(send_message=Mock(), get_task=AsyncMock(), cancel_task=AsyncMock())
    calls = []
    @asynccontextmanager
    async def open_client(**kwargs: Any) -> AsyncIterator[Any]:
        calls.append(kwargs)
        yield client
    monkeypatch.setattr(a2a_runtime, "remote_agent_client", open_client)
    permission = AsyncMock()
    monkeypatch.setattr(a2a_runtime, "require_agent_use_permission", permission)
    def responses(*items: Any) -> None:
        async def stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
            for item in items:
                if isinstance(item, Exception):
                    raise item
                yield item
        client.send_message.side_effect = stream
    return runtime, client, responses, registry, permission, calls


async def test_artifact_replacements_stream_without_duplicate_final_text(setup: Any) -> None:
    runtime, client, responses, _, permission, calls = setup
    responses(
        StreamResponse(task=task(TaskState.TASK_STATE_WORKING, "old")),
        StreamResponse(artifact_update=TaskArtifactUpdateEvent(task_id="task-example", context_id="context-example",
            artifact=Artifact(artifact_id="answer", parts=[Part(text="replacement")]), append=False)),
        StreamResponse(status_update=TaskStatusUpdateEvent(task_id="task-example", context_id="context-example",
            status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED))),
    )
    events = [event async for event in runtime.execute(context())]
    assert [e.data["text"] for e in events if getattr(e, "event_type", "") == "content.delta"] == ["replacement"]
    assert events[-1].status == "completed"
    assert any(getattr(e, "event_type", "") == "session.updated" and e.data["provider_session_id"] == "context-example" for e in events)
    assert calls[0]["caller_token"] == "caller-token"
    permission.assert_awaited_once_with("a2a-remote-example", delegated_user_sub="test-owner")
    assert client.send_message.call_args.args[0].message.parts[0].text == "Assigned task"


async def test_polling_completes_accepted_nonterminal_tasks_without_resending(setup: Any) -> None:
    runtime, client, responses, *_ = setup
    responses(StreamResponse(task=task(TaskState.TASK_STATE_WORKING, "partial")))
    client.get_task.return_value = task(TaskState.TASK_STATE_COMPLETED, "finished")
    events = [e async for e in runtime.execute(context())]
    assert events[-1].result["content"] == "finished"
    assert client.send_message.call_count == 1
    assert client.get_task.call_args.args[0].id == "task-example"


async def test_eof_without_remote_task_is_unconfirmed_not_completed(setup: Any) -> None:
    runtime, _, responses, *_ = setup
    responses()
    with pytest.raises(ExecutionUnconfirmedError):
        _ = [e async for e in runtime.execute(context())]


async def test_caller_revocation_prevents_discovery_or_execution(setup: Any) -> None:
    runtime, client, _, registry, permission, calls = setup
    permission.side_effect = PermissionError("revoked")
    with pytest.raises(PermissionError):
        _ = [e async for e in runtime.execute(context())]
    registry.initialize.assert_not_awaited()
    assert not calls
    client.send_message.assert_not_called()


async def test_disabled_registry_prevents_discovery(setup: Any) -> None:
    runtime, client, _, registry, *_ = setup
    registry.mongo.get_remote_agents_by_ids.return_value = []
    with pytest.raises(PermissionError):
        _ = [e async for e in runtime.execute(context())]
    client.send_message.assert_not_called()


async def test_remote_input_pauses_and_resume_uses_saved_task_and_context(setup: Any) -> None:
    runtime, client, responses, *_ = setup
    responses(StreamResponse(task=task(TaskState.TASK_STATE_INPUT_REQUIRED, "Need details")))
    events = [e async for e in runtime.execute(context())]
    pause = events[-1]
    assert isinstance(pause, TurnOutcome) and pause.status == "paused"
    resumed = context(command="resume", resume_data={"values": {"message": "Details"}})
    resumed.binding.pending_interrupt = pause.interrupt
    resumed.binding.provider_session_id = "context-example"
    responses(StreamResponse(task=task(TaskState.TASK_STATE_COMPLETED)))
    assert [e async for e in runtime.execute(resumed)][-1].status == "completed"
    sent = client.send_message.call_args.args[0].message
    assert sent.task_id == "task-example" and sent.context_id == "context-example"
    assert sent.parts[0].text == "Details"


async def test_stop_waits_for_confirmed_remote_cancellation(setup: Any) -> None:
    runtime, client, responses, *_ = setup
    responses(StreamResponse(task=task(TaskState.TASK_STATE_WORKING)))
    client.cancel_task.return_value = task(TaskState.TASK_STATE_CANCELED)
    events = []
    async for event in runtime.execute(context()):
        events.append(event)
        if getattr(event, "event_type", "") == "session.updated":
            assert await runtime.cancel_run("run-example")
    assert events[-1].status == "cancelled"
    client.cancel_task.assert_awaited_once()


async def test_context_change_never_merges_other_remote_session(setup: Any) -> None:
    runtime, _, responses, *_ = setup
    responses(StreamResponse(task=task(TaskState.TASK_STATE_COMPLETED)))
    ctx = context()
    ctx.binding.provider_session_id = "different-context"
    with pytest.raises(ExecutionUnconfirmedError):
        _ = [e async for e in runtime.execute(ctx)]


def test_blueprint_cannot_supply_endpoint_or_impersonate_another_registry_entry() -> None:
    adapter = RemoteA2AAdapter(None, runtime=SimpleNamespace())
    blueprint = context().blueprint
    assert not adapter.evaluate(blueprint).issues
    blueprint.harness.options["endpoint"] = "https://untrusted.example.test"
    assert adapter.evaluate(blueprint).issues
    blueprint.harness.options = {"registry_id": "remote-other"}
    assert adapter.evaluate(blueprint).issues


async def test_message_only_agent_reuses_remote_context_on_follow_up(setup: Any) -> None:
    runtime, client, responses, *_ = setup
    responses(StreamResponse(message=Message(message_id="reply", context_id="context-example", role=Role.ROLE_AGENT, parts=[Part(text="first")])) )
    events = [e async for e in runtime.execute(context())]
    assert events[-1].status == "completed"
    follow_up = context(message="Follow-up")
    follow_up.binding.provider_session_id = "context-example"
    responses(StreamResponse(message=Message(message_id="reply-2", context_id="context-example", role=Role.ROLE_AGENT, parts=[Part(text="second")])) )
    assert [e async for e in runtime.execute(follow_up)][-1].result["content"] == "second"
    sent = client.send_message.call_args.args[0].message
    assert sent.context_id == "context-example" and not sent.task_id


async def test_unsupported_remote_cancel_drains_to_completion(setup: Any) -> None:
    runtime, client, responses, *_ = setup
    responses(StreamResponse(task=task(TaskState.TASK_STATE_WORKING)))
    client.cancel_task.side_effect = A2AClientError("Cancellation is unsupported")
    client.get_task.return_value = task(TaskState.TASK_STATE_COMPLETED)
    events = []
    async for event in runtime.execute(context()):
        events.append(event)
        if getattr(event, "event_type", "") == "session.updated":
            await runtime.cancel_run("run-example")
    assert events[-1].status == "cancelled"
    client.get_task.assert_awaited_once()

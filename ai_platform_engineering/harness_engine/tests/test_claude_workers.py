from __future__ import annotations

import asyncio
import json
import traceback
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx2 as httpx
import pytest
from claude_agent_sdk import (
    AssistantMessage,
    InMemorySessionStore,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from pydantic import SecretStr

from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.claude_tools import ClaudeToolBroker
from harness_engine.claude_worker import create_worker_app
from harness_engine.config import Settings
from harness_engine.main import create_app
from harness_engine.models import (
    AgentBlueprint,
    ExecutionIdentity,
    RenderedPrompt,
    RunContext,
    SessionBinding,
    TurnInput,
)
from harness_engine.repository import InMemoryRunRepository, ReplayGapError
from tests.conftest import auth_headers, blueprint


def result(session_id: str = "session-example") -> ResultMessage:
    return ResultMessage(
        subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id=session_id
    )


def context() -> RunContext:
    draft = blueprint(harness_id="claude_agent_sdk", profile_id="safe", options={})
    draft["tools"] = {"bindings": [{"tool_id": "example.lookup"}], "approval_policy": "never"}
    agent = AgentBlueprint.model_validate(draft)
    return RunContext(
        blueprint=agent,
        binding=SessionBinding(
            binding_id="binding-example",
            owner_subject="test-user",
            agent_id=agent.id,
            agent_version=1,
            conversation_id="conversation-example",
            harness_id="claude_agent_sdk",
            profile_id="safe",
            checkpoint_strategy="adapter_store",
        ),
        prompt=RenderedPrompt(system="Use the selected tool"),
        turn=TurnInput(run_id="run-example", message="look up example"),
        identity=ExecutionIdentity(subject="test-user", bearer="caller-test-token"),
    )


async def test_sdk_mcp_tools_preserve_identity_allowlist_and_tool_events(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []
    exposed = []

    def broker(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer caller-test-token"
        body = json.loads(request.content)
        calls.append(body)
        if body["operation"] == "list":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {"tools": [{"tool_id": "example.lookup", "input_schema": {"type": "object"}}]},
                },
            )
        return httpx.Response(
            200, json={"success": True, "data": {"content": [{"type": "text", "text": "example result"}]}}
        )

    def sdk_server(**kwargs: Any) -> dict[str, Any]:
        exposed.extend(kwargs["tools"])
        return {"type": "sdk", "name": "caipe", "instance": object()}

    monkeypatch.setattr("harness_engine.claude_tools.create_sdk_mcp_server", sdk_server)

    async def query(**kwargs: Any) -> AsyncIterator[Any]:
        options = kwargs["options"]
        assert options.tools == []
        assert options.allowed_tools == ["mcp__caipe__tool_0"]
        assert options.setting_sources == []
        prompts = [message async for message in kwargs["prompt"]]
        assert prompts[0]["message"]["content"] == "look up example"
        yield SystemMessage(subtype="init", data={"session_id": "session-example"})
        yield AssistantMessage(
            content=[ToolUseBlock(id="call-example", name="mcp__caipe__tool_0", input={"value": "example"})],
            model="example",
        )
        output = await exposed[0].handler({"value": "example"})
        yield UserMessage(content=[ToolResultBlock(tool_use_id="call-example", content=output["content"])])
        yield AssistantMessage(content=[TextBlock(text="done")], model="example")
        yield result()

    configured = settings.model_copy(update={"claude_tool_broker_url": "http://broker.example.test"})
    adapter = ClaudeSDKAdapter(
        configured, query_fn=query, tool_broker=ClaudeToolBroker(configured, httpx.MockTransport(broker))
    )
    events = [event async for event in adapter.execute(context())]
    assert [event.event_type for event in events[:-1]] == [
        "session.updated",
        "tool.started",
        "tool.completed",
        "content.delta",
    ]
    assert events[-1].status == "completed"
    assert calls == [
        {"operation": "list"},
        {"operation": "call", "tool_id": "example.lookup", "arguments": {"value": "example"}},
    ]
    assert "caller-test-token" not in "".join(event.model_dump_json() for event in events)


async def test_broker_rejects_an_expanded_allowlist_before_inference(settings: Settings) -> None:
    async def response(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"success": True, "data": {"tools": [{"tool_id": "example.other"}]}})

    broker = ClaudeToolBroker(
        settings.model_copy(update={"claude_tool_broker_url": "http://broker.example.test"}),
        httpx.MockTransport(response),
    )
    with pytest.raises(ValueError, match="different allowlist"):
        async with broker.bind(context()):
            pytest.fail("Expanded tool policy was accepted")


def configured_worker(settings: Settings) -> Settings:
    return settings.model_copy(
        update={
            "claude_worker_profiles_json": SecretStr(
                json.dumps(
                    {
                        "remote": {
                            "url": "http://worker.example.test",
                            "token": "test-worker-secret",
                            "profile_id": "safe",
                            "tools_enabled": True,
                        }
                    }
                )
            )
        }
    )


class SplitWorkerTransport(httpx.AsyncBaseTransport):
    """Dispatch on one replica and inspect/cancel through another."""

    def __init__(self, producer: Any, replica: Any) -> None:
        self.producer = httpx.ASGITransport(app=producer)
        self.replica = httpx.ASGITransport(app=replica)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        target = self.producer if request.method == "POST" else self.replica
        return await target.handle_async_request(request)


@asynccontextmanager
async def pair(
    settings: Settings, query: Any, *, options: dict[str, Any] | None = None
) -> AsyncIterator[tuple[httpx.AsyncClient, InMemoryRunRepository, Any]]:
    worker_repo = InMemoryRunRepository()
    local = ClaudeSDKAdapter(settings, query_fn=query, transcript_store=InMemorySessionStore())
    worker = create_worker_app(
        settings=settings.model_copy(update={"internal_token": "test-worker-secret"}),
        repository=worker_repo,
        adapter=local,
    )
    replica = create_worker_app(
        settings=settings.model_copy(update={"internal_token": "test-worker-secret"}),
        repository=worker_repo,
        adapter=ClaudeSDKAdapter(settings, query_fn=query, transcript_store=InMemorySessionStore()),
    )
    remote = RemoteClaudeSDKAdapter(configured_worker(settings), SplitWorkerTransport(worker, replica))
    parent_repo = InMemoryRunRepository()
    parent = create_app(settings=settings, repository=parent_repo, adapters=[remote])
    async with (
        worker.router.lifespan_context(worker),
        replica.router.lifespan_context(replica),
        parent.router.lifespan_context(parent),
    ):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=parent), base_url="http://engine.example.test", headers=auth_headers()
        ) as client:
            saved = await client.put(
                "/api/v1/agents/agent-example",
                json={
                    "blueprint": blueprint(
                        harness_id="claude_agent_sdk_remote", profile_id="remote", options=options or {}
                    )
                },
            )
            assert saved.status_code == 200, saved.text
            yield client, parent_repo, worker


async def terminal(client: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    for _ in range(400):
        page = (await client.get(f"/api/v1/runs/{run_id}/events")).json()["data"]
        if page["run"]["status"] in {"completed", "cancelled", "failed"}:
            return page
        await asyncio.sleep(0.01)
    pytest.fail("Execution did not drain")


async def test_remote_worker_preserves_session_and_idempotent_admission(settings: Settings) -> None:
    resumed = []

    async def query(**kwargs: Any) -> AsyncIterator[Any]:
        resumed.append(kwargs["options"].resume)
        yield SystemMessage(subtype="init", data={"session_id": "session-example"})
        yield AssistantMessage(content=[TextBlock(text="remote answer")], model="example")
        yield result()

    async with pair(settings, query) as (client, repo, _):
        body = {
            "agent_id": "agent-example",
            "conversation_id": "conversation-example",
            "message": "one",
            "client_request_id": "request-example",
        }
        first = await client.post("/api/v1/runs", json=body)
        assert first.status_code == 202
        run_id = first.json()["data"]["run_id"]
        done = await terminal(client, run_id)
        assert done["run"]["status"] == "completed"
        retry = await client.post("/api/v1/runs", json=body)
        assert retry.json()["data"]["run_id"] == run_id
        second = await client.post("/api/v1/runs", json={**body, "message": "two", "client_request_id": "request-next"})
        second_page = await terminal(client, second.json()["data"]["run_id"])
        assert second_page["run"]["status"] == "completed"
        assert resumed == [None, "session-example"]
        assert [event["sequence"] for event in done["events"]] == list(range(1, len(done["events"]) + 1))
        assert "test-worker-secret" not in json.dumps(done)
        denied = await client.get(f"/api/v1/runs/{run_id}", headers=auth_headers("other-user"))
        assert denied.status_code == 404


async def test_remote_cancellation_drains_before_releasing_the_parent(settings: Settings) -> None:
    entered = asyncio.Event()
    closed = asyncio.Event()

    async def query(**_: Any) -> AsyncIterator[Any]:
        try:
            entered.set()
            yield SystemMessage(subtype="init", data={"session_id": "session-example"})
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0.1)
            closed.set()

    async with pair(settings, query) as (client, repo, _):
        started = (
            await client.post(
                "/api/v1/runs",
                json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "wait"},
            )
        ).json()["data"]
        await asyncio.wait_for(entered.wait(), 2)
        await client.delete(f"/api/v1/runs/{started['run_id']}")
        page = await terminal(client, started["run_id"])
        assert page["run"]["status"] == "cancelled"
        assert closed.is_set()
        binding = await repo.get_session(started["binding_id"])
        assert binding.active_run is None


@pytest.mark.parametrize("admission_conflict", [False, True])
async def test_unconfirmed_worker_keeps_the_session_reserved(settings: Settings, admission_conflict: bool) -> None:
    def unavailable(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            if admission_conflict:
                return httpx.Response(409, json={"detail": "Existing producer has different input"})
            run_id = json.loads(request.content)["turn"]["run_id"]
            return httpx.Response(202, json={"success": True, "data": {"run": {"run_id": run_id}}})
        raise httpx.ConnectError("worker unavailable", request=request)

    remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.MockTransport(unavailable))
    repo = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repo, adapters=[remote])
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://engine.example.test", headers=auth_headers()
        ) as client:
            await client.put(
                "/api/v1/agents/agent-example",
                json={"blueprint": blueprint(harness_id="claude_agent_sdk_remote", profile_id="remote", options={})},
            )
            started = (
                await client.post(
                    "/api/v1/runs",
                    json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "one"},
                )
            ).json()["data"]
            page = await terminal(client, started["run_id"])
            assert page["run"]["status"] == "failed"
            assert page["events"][-1]["data"]["code"] == "execution_unconfirmed"
            binding = await repo.get_session(started["binding_id"])
            assert binding.active_run.run_id == started["run_id"]
            blocked = await client.post(
                "/api/v1/runs",
                json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "two"},
            )
            assert blocked.status_code == 409


@pytest.mark.parametrize("owner", ["other-user", ""])
async def test_worker_rejects_unowned_context(settings: Settings, owner: str) -> None:
    worker = create_worker_app(settings=settings, repository=InMemoryRunRepository())
    ctx = context()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=worker), base_url="http://worker.example.test"
    ) as client:
        response = await client.post(
            "/api/v1/worker/runs", headers=auth_headers(owner), json=ctx.model_dump(mode="json")
        )
        assert response.status_code in {400, 401}


async def test_sdk_partial_tokens_are_not_duplicated_by_the_completed_message(settings: Settings) -> None:
    async def query(**_: Any) -> AsyncIterator[Any]:
        for index, text in enumerate(["hel", "lo"]):
            yield StreamEvent(
                uuid=f"event-{index}",
                session_id="session-example",
                event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}},
            )
        yield AssistantMessage(content=[TextBlock(text="hello")], model="example")
        yield result()

    ctx = context()
    ctx.blueprint.tools.bindings = []
    events = [event async for event in ClaudeSDKAdapter(settings, query_fn=query).execute(ctx)]
    assert [event.data["text"] for event in events[:-1] if event.event_type == "content.delta"] == ["hel", "lo"]
    assert events[-1].result == {"content": "hello"}


async def test_sdk_rejects_an_unselected_builtin_tool(settings: Settings) -> None:
    async def query(**_: Any) -> AsyncIterator[Any]:
        yield AssistantMessage(
            content=[ToolUseBlock(id="call-example", name="Bash", input={"command": "example"})], model="example"
        )

    ctx = context()
    ctx.blueprint.tools.bindings = []
    with pytest.raises(PermissionError, match="outside its allowlist"):
        _ = [event async for event in ClaudeSDKAdapter(settings, query_fn=query).execute(ctx)]


def test_remote_catalog_and_settings_never_expose_worker_credentials(settings: Settings) -> None:
    configured = configured_worker(settings)
    adapter = RemoteClaudeSDKAdapter(configured)
    assert adapter.descriptor.execution_mode == "remote_worker"
    assert "test-worker-secret" not in repr(configured)
    assert "test-worker-secret" not in adapter.descriptor.model_dump_json()
    assert "worker.example.test" not in adapter.descriptor.model_dump_json()


def test_worker_requires_durable_storage_by_default(settings: Settings) -> None:
    with pytest.raises(ValueError, match="MongoDB persistence"):
        create_worker_app(settings=settings)


def test_invalid_worker_configuration_does_not_log_its_credentials(settings: Settings) -> None:
    configured = settings.model_copy(
        update={
            "claude_worker_profiles_json": SecretStr(
                json.dumps(
                    {
                        "primary": {"url": "invalid", "token": "private-example-token", "profile_id": "safe"},
                    }
                )
            )
        }
    )
    with pytest.raises(ValueError) as error:
        configured.claude_worker_profiles()
    assert "private-example-token" not in "".join(traceback.format_exception(error.value))


async def test_cancelled_sdk_tool_drains_the_dispatched_call_without_retry(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = asyncio.Event()
    finish = asyncio.Event()
    exposed: list[Any] = []
    count = 0

    async def respond(request: httpx.Request) -> httpx.Response:
        nonlocal count
        if json.loads(request.content)["operation"] == "list":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "tools": [
                            {"tool_id": "example.lookup", "input_schema": {"type": "object"}},
                        ]
                    },
                },
            )
        count += 1
        entered.set()
        await finish.wait()
        return httpx.Response(200, json={"success": True, "data": {"content": []}})

    def sdk_server(**kwargs: Any) -> dict[str, Any]:
        exposed.extend(kwargs["tools"])
        return {}

    monkeypatch.setattr("harness_engine.claude_tools.create_sdk_mcp_server", sdk_server)
    broker = ClaudeToolBroker(
        settings.model_copy(update={"claude_tool_broker_url": "http://broker.example.test"}),
        httpx.MockTransport(respond),
    )

    async def invoke() -> None:
        async with broker.bind(context()):
            await exposed[0].handler({})

    task = asyncio.create_task(invoke())
    await entered.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    assert count == 1
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert count == 1


async def test_broker_exposes_duplicate_bindings_only_once(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    exposed: list[Any] = []
    ctx = context()
    ctx.blueprint.tools.bindings.append(ctx.blueprint.tools.bindings[0])
    schema = {"tool_id": "example.lookup", "input_schema": {"type": "object"}}
    transport = httpx.MockTransport(
        lambda _: httpx.Response(200, json={"success": True, "data": {"tools": [schema, schema]}})
    )

    def sdk_server(**kwargs: Any) -> dict[str, Any]:
        exposed.extend(kwargs["tools"])
        return {}

    monkeypatch.setattr("harness_engine.claude_tools.create_sdk_mcp_server", sdk_server)
    broker = ClaudeToolBroker(
        settings.model_copy(update={"claude_tool_broker_url": "http://broker.example.test"}), transport
    )
    async with broker.bind(ctx) as (_, names):
        assert names == {"mcp__caipe__tool_0": "example.lookup"}
        assert len(exposed) == 1


async def test_worker_validation_denial_releases_parent_without_dispatch(settings: Settings) -> None:
    dispatched = False

    async def query(**_: Any) -> AsyncIterator[Any]:
        nonlocal dispatched
        dispatched = True
        yield result()

    async with pair(settings, query, options={"permission_mode": "plan"}) as (client, repo, _):
        for message in ["first", "second"]:
            response = await client.post(
                "/api/v1/runs",
                json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": message},
            )
            assert response.status_code == 202
            run = response.json()["data"]
            page = await terminal(client, run["run_id"])
            assert page["run"]["status"] == "failed"
            assert page["events"][-1]["data"]["code"] == "provider_error"
            assert (await repo.get_session(run["binding_id"])).active_run is None
        assert not dispatched


async def test_worker_stop_and_drain_do_not_require_replay_history(settings: Settings) -> None:
    class ExpiredReplayRepository(InMemoryRunRepository):
        async def list_events(self, run_id: str, after: int = 0) -> list[Any]:
            raise ReplayGapError("Expired event prefix")

    entered = asyncio.Event()

    async def query(**_: Any) -> AsyncIterator[Any]:
        entered.set()
        yield SystemMessage(subtype="init", data={"session_id": "session-example"})
        await asyncio.Event().wait()

    repo = ExpiredReplayRepository()
    worker = create_worker_app(settings=settings, repository=repo, adapter=ClaudeSDKAdapter(settings, query_fn=query))
    ctx = context()
    ctx.blueprint.tools.bindings = []
    async with worker.router.lifespan_context(worker):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=worker), base_url="http://worker.example.test", headers=auth_headers()
        ) as client:
            assert (await client.post("/api/v1/worker/runs", json=ctx.model_dump(mode="json"))).status_code == 202
            await asyncio.wait_for(entered.wait(), 2)
            path = f"/api/v1/worker/runs/{ctx.turn.run_id}"
            assert (await client.get(path)).status_code == 409
            stopped = await client.delete(path)
            assert stopped.status_code == 200
            for _ in range(50):
                state = (await client.get(path + "/state")).json()["data"]
                if state["drained"]:
                    break
                await asyncio.sleep(0.01)
            assert state["drained"]
            assert state["run"]["status"] == "cancelled"
            assert (await client.get(path + "/state", headers=auth_headers("other-user"))).status_code == 404


@pytest.mark.parametrize("drain_poll", [1, 3])
async def test_parent_cleanup_polls_state_without_requiring_events(settings: Settings, drain_poll: int) -> None:
    paths: list[str] = []
    polls = 0

    def worker(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        paths.append(request.url.path)
        if request.method == "POST":
            run_id = json.loads(request.content)["turn"]["run_id"]
            return httpx.Response(202, json={"success": True, "data": {"run": {"run_id": run_id}}})
        if request.method == "DELETE":
            return httpx.Response(200, json={"success": True, "data": {"drained": False}})
        if request.url.path.endswith("/state"):
            polls += 1
            return httpx.Response(200, json={"success": True, "data": {"drained": polls >= drain_poll}})
        return httpx.Response(409, json={"detail": "Expired event prefix"})

    remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.MockTransport(worker))
    repo = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repo, adapters=[remote])
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://engine.example.test", headers=auth_headers()
        ) as client:
            await client.put(
                "/api/v1/agents/agent-example",
                json={"blueprint": blueprint(harness_id="claude_agent_sdk_remote", profile_id="remote", options={})},
            )
            run = (
                await client.post(
                    "/api/v1/runs",
                    json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "one"},
                )
            ).json()["data"]
            page = await terminal(client, run["run_id"])
            assert page["events"][-1]["data"]["code"] == "provider_error"
            assert (await repo.get_session(run["binding_id"])).active_run is None
            assert paths[-1].endswith("/state")


async def test_remote_completion_consumes_the_committed_event_tail(settings: Settings) -> None:
    cursors: list[int] = []
    run_id = ""

    def worker(request: httpx.Request) -> httpx.Response:
        nonlocal run_id
        if request.method == "POST":
            run_id = json.loads(request.content)["turn"]["run_id"]
            return httpx.Response(202, json={"success": True, "data": {"run": {"run_id": run_id}}})
        cursor = int(request.url.params.get("after", "0"))
        cursors.append(cursor)
        # Completion can commit between the event-prefix read and metadata read.
        events = (
            [{"run_id": run_id, "sequence": 1, "event_type": "content.delta", "data": {"text": "first"}}]
            if cursor == 0
            else [
                {"run_id": run_id, "sequence": 2, "event_type": "content.delta", "data": {"text": " second"}},
                {"run_id": run_id, "sequence": 3, "event_type": "run.completed", "data": {}},
            ]
        )
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": {
                    "run": {"run_id": run_id, "status": "completed", "last_sequence": 3},
                    "events": events,
                    "drained": True,
                },
            },
        )

    remote = RemoteClaudeSDKAdapter(configured_worker(settings), httpx.MockTransport(worker))
    repo = InMemoryRunRepository()
    app = create_app(settings=settings, repository=repo, adapters=[remote])
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://engine.example.test", headers=auth_headers()
        ) as client:
            await client.put(
                "/api/v1/agents/agent-example",
                json={"blueprint": blueprint(harness_id="claude_agent_sdk_remote", profile_id="remote", options={})},
            )
            run = (
                await client.post(
                    "/api/v1/runs",
                    json={"agent_id": "agent-example", "conversation_id": "conversation-example", "message": "one"},
                )
            ).json()["data"]
            page = await terminal(client, run["run_id"])
            assert page["run"]["status"] == "completed"
            assert [e["data"]["text"] for e in page["events"] if e["event_type"] == "content.delta"] == [
                "first",
                " second",
            ]
            assert cursors == [0, 1]

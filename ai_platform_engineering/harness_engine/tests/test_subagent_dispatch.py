"""Delegation must preserve provider runtime, identity and child event boundaries."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from importlib.util import find_spec
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx2 as httpx
import pytest
from pydantic import SecretStr

from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.claude_worker import create_worker_app
from harness_engine.config import Settings
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import (
    AgentBlueprint,
    CanonicalEventDraft,
    ExecutionIdentity,
    HarnessProfile,
    RenderedPrompt,
    RunContext,
    SessionBinding,
    TurnInput,
)
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import InMemoryRunRepository
from harness_engine.sessions import CAIPEAgentSessionManager, DeterministicProviderSessionManager
from tests.conftest import FakeHarnessAdapter, blueprint

if find_spec("dynamic_agents") is not None:
    from dynamic_agents.models import SubAgentRef
    from langchain_core.messages import HumanMessage
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.graph import END, START, MessagesState, StateGraph

    from harness_engine.subagent_dispatch import HarnessSubagentDispatcher

pytestmark = pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")


class ChildAdapter(FakeHarnessAdapter):
    def __init__(self, runtime: str = "claude_code_cli_acp", delay: float = 0) -> None:
        super().__init__(delay=delay)
        self.runtime = runtime
        self._session_manager = DeterministicProviderSessionManager(runtime, prefix="child-", checkpoint_strategy="remote_managed")
        self.finished = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def cancel_run(self, run_id: str) -> bool:
        self.cancelled.set()
        await self.finished.wait()
        return True

    @property
    def descriptor(self) -> Any:
        return super().descriptor.model_copy(update={"id": self.runtime, "profiles": [HarnessProfile(
            id="primary", harness_id=self.runtime, display_name="Child policy",
        )]})

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft]:
        self.calls.append(context)
        try:
            yield CanonicalEventDraft(event_type="tool.started", data={"tool_call_id": "lookup", "tool_name": "lookup", "args": {"value": "example"}})
            if self.delay:
                try:
                    await asyncio.wait_for(self.cancelled.wait(), self.delay)
                    raise asyncio.CancelledError
                except TimeoutError:
                    pass
            yield CanonicalEventDraft(event_type="tool.completed", data={"tool_call_id": "lookup", "result": "found"})
            yield CanonicalEventDraft(event_type="content.delta", data={"text": "Child report"})
        finally:
            self.finished.set()


def parent(subject: str = "caller-a") -> RunContext:
    draft = blueprint()
    draft.update(id="agent-parent", delegation={"agents": ["agent-child"]})
    bp = AgentBlueprint.model_validate(draft)
    return RunContext(blueprint=bp, binding=SessionBinding(
        binding_id="binding-" + subject, owner_subject=subject, agent_id=bp.id,
        agent_version=1, conversation_id="conversation-" + subject,
        harness_id="dynamic_agents", profile_id="existing", checkpoint_strategy="langgraph",
    ), prompt=RenderedPrompt(system="Parent policy"), turn=TurnInput(run_id="run-" + subject, message="Delegate"),
        identity=ExecutionIdentity(subject=subject, bearer="transient-" + subject))


async def setup(monkeypatch: pytest.MonkeyPatch, runtime: str = "claude_code_cli_acp", delay: float = 0) -> tuple[Any, ChildAdapter]:
    async def authorize(*args: Any, **kwargs: Any) -> None:
        return None
    monkeypatch.setattr("harness_engine.subagent_dispatch.require_agent_use_permission", authorize)
    repo = InMemoryRunRepository()
    adapter = ChildAdapter(runtime, delay)
    registry = HarnessRegistry([adapter])
    coordinator = RunCoordinator(repo, registry, CAIPEAgentSessionManager(repo, registry, b"example-secret"), DefaultPromptCompiler())
    bp = blueprint(harness_id=runtime)
    bp.update(id="agent-child", prompt={"system": "Child policy"})
    await repo.save_agent(AgentBlueprint.model_validate(bp), "child-config", "test", None)
    mongo = SimpleNamespace(get_agent=lambda _: SimpleNamespace(enabled=True, execution_harness_id=runtime))
    return HarnessSubagentDispatcher(coordinator, repo, mongo), adapter


async def graph_for(dispatcher: Any) -> Any:
    spec = await dispatcher.build(SubAgentRef(agent_id="agent-child", name="child", description="Specialist"))
    graph = StateGraph(MessagesState)
    graph.add_node("child", spec["runnable"])
    graph.add_edge(START, "child")
    graph.add_edge("child", END)
    return graph.compile(checkpointer=MemorySaver())


@pytest.mark.parametrize("runtime", ["claude_code_cli_acp", "claude_code_acp", "claude_agent_sdk_remote", "claude_agent_sdk", "agentcore"])
async def test_saved_runtime_and_child_policy_are_preserved(monkeypatch: pytest.MonkeyPatch, runtime: str) -> None:
    dispatcher, adapter = await setup(monkeypatch, runtime)
    with dispatcher.scope(parent()):
        graph = await graph_for(dispatcher)
        chunks = [chunk async for chunk in graph.astream({"messages": [HumanMessage(content="Read only lookup")]},
            {"configurable": {"thread_id": "example-parent"}}, stream_mode=["custom", "updates"], subgraphs=True)]
    assert len(adapter.calls) == 1
    call = adapter.calls[0]
    assert call.blueprint.harness.id == runtime
    assert call.binding.profile_id == "primary"
    assert call.binding.conversation_id.startswith("subagent-")
    assert call.binding.conversation_id != parent().binding.conversation_id
    assert call.prompt.system == "Child policy"
    assert call.identity.bearer.get_secret_value() == "transient-caller-a"
    assert call.turn.message == "Read only lookup"
    assert any(chunk[1] == "custom" and chunk[2].get("event_type") == "tool.started" for chunk in chunks)
    assert "transient-caller-a" not in repr(chunks)
    snapshots = [snapshot async for snapshot in graph.aget_state_history({"configurable": {"thread_id": "example-parent"}})]
    assert "transient-caller-a" not in repr(snapshots)
    assert all(run.agent_version == 1 for run in dispatcher.repository._runs.values())


async def test_cached_child_graph_uses_each_invocations_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, adapter = await setup(monkeypatch, delay=.02)
    with dispatcher.scope(parent()):
        graph = await graph_for(dispatcher)
    async def invoke(subject: str) -> Any:
        with dispatcher.scope(parent(subject)):
            return await graph.ainvoke({"messages": [HumanMessage(content="lookup")]}, {"configurable": {"thread_id": subject}})
    await asyncio.gather(invoke("caller-a"), invoke("caller-b"))
    assert {call.identity.bearer.get_secret_value() for call in adapter.calls} == {"transient-caller-a", "transient-caller-b"}
    assert len({call.binding.provider_session_id for call in adapter.calls}) == 2
    assert len({call.binding.conversation_id for call in adapter.calls}) == 2


async def test_revocation_prevents_cached_graph_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, adapter = await setup(monkeypatch)
    with dispatcher.scope(parent()):
        graph = await graph_for(dispatcher)
        async def denied(*args: Any, **kwargs: Any) -> None:
            raise PermissionError("Revoked")
        monkeypatch.setattr("harness_engine.subagent_dispatch.require_agent_use_permission", denied)
        with pytest.raises(PermissionError, match="Revoked"):
            await graph.ainvoke({"messages": [HumanMessage(content="lookup")]}, {"configurable": {"thread_id": "revoked"}})
    assert not adapter.calls


async def test_cancellation_reaches_child_and_drains_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, adapter = await setup(monkeypatch, delay=60)
    with dispatcher.scope(parent()):
        graph = await graph_for(dispatcher)
        task = asyncio.create_task(graph.ainvoke({"messages": [HumanMessage(content="lookup")]}, {"configurable": {"thread_id": "cancel"}}))
        async with asyncio.timeout(3):
            while not adapter.calls:
                await asyncio.sleep(.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    await asyncio.wait_for(adapter.finished.wait(), 3)
    assert all(run.cancellation_requested for run in dispatcher.repository._runs.values())


async def test_unpublished_and_disabled_children_never_fall_back_to_a_model(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, adapter = await setup(monkeypatch)
    with dispatcher.scope(parent()):
        graph = await graph_for(dispatcher)
        dispatcher.repository._agents.clear()
        result = await graph.ainvoke({"messages": [HumanMessage(content="lookup")]}, {"configurable": {"thread_id": "unpublished"}})
        assert "ERROR:" in result["messages"][-1].text
        dispatcher.mongo.get_agent = lambda _: SimpleNamespace(enabled=False, execution_harness_id="claude_code_cli_acp")
        with pytest.raises(PermissionError):
            await dispatcher.build(SubAgentRef(agent_id="agent-child", name="child", description="Child"))
    assert not adapter.calls


async def test_child_uses_real_remote_acp_transport_and_subprocess(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, _ = await setup(monkeypatch)
    runtime = "claude_code_cli_acp"
    executable = Path(settings.claude_sdk_profiles()["safe"].cwd).parent / "claude"
    fixture = Path(__file__).parent / "fixtures" / "claude_cli.py"
    executable.write_text(f"#!{sys.executable}\n" + fixture.read_text().replace("from __future__ import annotations\n", "").replace('Path("cli-policy.json").write_text', 'policy["system_prompt"] = Path(args[args.index("--append-system-prompt-file") + 1]).read_text()\n    Path("cli-policy.json").write_text'))
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", str(executable.parent) + os.pathsep + os.environ["PATH"])
    worker_config = settings.model_copy(update={
        "claude_cli_isolation": "disabled",  # Deterministic local CLI fixture; kernel isolation has separate Linux coverage.
        "claude_acp_command": [sys.executable, str(Path(__file__).parents[1] / "src/harness_engine/claude_cli_acp.py")],
        "claude_acp_runtime": runtime,
    })
    worker = create_worker_app(settings=worker_config, repository=InMemoryRunRepository())
    config = settings.model_copy(update={"claude_worker_profiles_json": SecretStr(json.dumps({"remote": {
        "url": "http://worker.example.test", "token": settings.internal_token, "profile_id": "safe", "runtime": runtime,
    }}))})
    remote = RemoteClaudeSDKAdapter(config, httpx.ASGITransport(app=worker), claude_cli_acp=True)
    registry = HarnessRegistry([remote])
    dispatcher.coordinator = RunCoordinator(dispatcher.repository, registry,
        CAIPEAgentSessionManager(dispatcher.repository, registry, b"example-secret"), DefaultPromptCompiler())
    bp = blueprint(harness_id=runtime, profile_id="remote")
    bp.update(id="agent-child", prompt={"system": "Child workspace policy"})
    await dispatcher.repository.save_agent(AgentBlueprint.model_validate(bp), "remote-config", "test", None)
    async with worker.router.lifespan_context(worker):
        with dispatcher.scope(parent()):
            graph = await graph_for(dispatcher)
            config = {"configurable": {"thread_id": "remote-acp"}}
            chunks = [chunk async for chunk in graph.astream({"messages": [HumanMessage(content="lookup")]}, config,
                stream_mode=["custom", "updates"], subgraphs=True)]
            result = (await graph.aget_state(config)).values
    assert any(chunk[1] == "custom" and chunk[2].get("event_type") == "tool.started" for chunk in chunks)
    assert any(chunk[1] == "custom" and chunk[2].get("event_type") == "tool.completed" for chunk in chunks)
    assert result["messages"][-1].text == "CLI answer"
    run = next(iter(dispatcher.repository._runs.values()))
    assert run.harness_id == runtime and run.profile_id == "remote" and run.agent_version == 2
    assert run.provider_session_id is not None
    assert run.status.value == "completed"
    policy_files = list(Path(settings.claude_sdk_profiles()["safe"].cwd).glob("*/cli-policy.json"))
    assert len(policy_files) == 1
    policy = policy_files[0].read_text()
    assert "Child workspace policy" in policy
    assert "transient-caller-a" not in policy


async def test_stop_during_admission_still_cancels_the_admitted_child(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, adapter = await setup(monkeypatch, delay=60)
    admitted, receipt = asyncio.Event(), asyncio.Event()
    start = dispatcher.coordinator.start_run
    async def delayed(*args: Any, **kwargs: Any) -> Any:
        run = await start(*args, **kwargs)
        admitted.set()
        await receipt.wait()
        return run
    monkeypatch.setattr(dispatcher.coordinator, "start_run", delayed)
    with dispatcher.scope(parent()):
        graph = await graph_for(dispatcher)
        task = asyncio.create_task(graph.ainvoke({"messages": [HumanMessage(content="lookup")]}, {"configurable": {"thread_id": "admission-cancel"}}))
        await asyncio.wait_for(admitted.wait(), 3)
        task.cancel()
        await asyncio.sleep(.01)
        receipt.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with asyncio.timeout(3):
        while any(run.status.value not in {"cancelled", "failed", "completed"} for run in dispatcher.repository._runs.values()):
            await asyncio.sleep(.01)
    assert all(run.cancellation_requested for run in dispatcher.repository._runs.values())


async def test_deadline_requests_child_cancellation_without_model_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    dispatcher, adapter = await setup(monkeypatch, delay=60)
    with dispatcher.scope(parent()):
        original = dispatcher.build
        async def bounded(ref: SubAgentRef) -> dict[str, Any]:
            return await original(ref.model_copy(update={"timeout_seconds": 1}))
        monkeypatch.setattr(dispatcher, "build", bounded)
        graph = await graph_for(dispatcher)
        result = await graph.ainvoke({"messages": [HumanMessage(content="lookup")]}, {"configurable": {"thread_id": "deadline"}})
    assert "do not automatically retry" in result["messages"][-1].text
    assert len(adapter.calls) == 1
    await asyncio.wait_for(adapter.finished.wait(), 3)

"""Run compiled Deep Agents children through their published Harness runtime."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from dynamic_agents.auth.authz import require_agent_use_permission
from dynamic_agents.models import SubAgentRef
from dynamic_agents.services.subagent_dispatch import subagent_factory
from langchain_core.messages import AIMessage
from langgraph.config import get_config, get_stream_writer
from langgraph.graph import END, START, MessagesState, StateGraph

from harness_engine.coordinator import RunCoordinator
from harness_engine.models import TERMINAL_RUN_STATUSES, CreateRunRequest, RunContext, RunStatus
from harness_engine.repository import RunRepository

_parent: ContextVar[RunContext | None] = ContextVar("harness_delegation_parent", default=None)
logger = logging.getLogger(__name__)
SUPPORTED_CHILD_HARNESSES = frozenset({
    "claude_agent_sdk", "claude_agent_sdk_remote", "claude_code_acp", "claude_code_cli_acp", "agentcore",
})


class HarnessSubagentDispatcher:
    def __init__(self, coordinator: RunCoordinator, repository: RunRepository, mongo: Any) -> None:
        self.coordinator, self.repository, self.mongo = coordinator, repository, mongo

    @contextmanager
    def scope(self, context: RunContext) -> Iterator[None]:
        parent_token = _parent.set(context)
        factory_token = subagent_factory.set(self.build)
        try:
            yield
        finally:
            subagent_factory.reset(factory_token)
            _parent.reset(parent_token)

    async def _authorize(self, ref: SubAgentRef) -> tuple[RunContext, str]:
        parent = _parent.get()
        if parent is None or parent.identity is None or parent.identity.subject != parent.binding.owner_subject:
            raise PermissionError("Subagent execution requires its admitted parent identity")
        if ref.agent_id not in parent.blueprint.delegation.agents:
            raise PermissionError("Subagent is not selected by the published parent")
        await require_agent_use_permission(ref.agent_id, delegated_user_sub=parent.identity.subject)
        child = await asyncio.to_thread(self.mongo.get_agent_execution, ref.agent_id)
        if child is None or child.get("enabled") is False or child.get("execution_harness_id") not in SUPPORTED_CHILD_HARNESSES:
            raise PermissionError("Subagent runtime is unavailable")
        return parent, child["execution_harness_id"]

    async def build(self, ref: SubAgentRef) -> dict[str, Any]:
        await self._authorize(ref)

        async def delegate(state: MessagesState) -> dict[str, list[AIMessage]]:
            # Cached graphs retain only the reference. Identity is resolved anew
            # for every invocation, never captured in closures or checkpoints.
            parent, expected_harness = await self._authorize(ref)
            namespace = get_config().get("configurable", {}).get("checkpoint_ns")
            if not namespace:
                raise ValueError("Subagent invocation requires a checkpoint namespace")
            key = hashlib.sha256(
                f"{parent.binding.binding_id}\0{parent.turn.run_id}\0{ref.agent_id}\0{namespace}".encode()
            ).hexdigest()
            request = CreateRunRequest(
                agent_id=ref.agent_id, conversation_id=f"subagent-{key}", client_request_id=f"child-{key}",
                message=state["messages"][-1].text,
            )
            writer, run, admission, cursor, content = get_stream_writer(), None, None, 0, []
            output_size = 0

            async def stop() -> None:
                nonlocal run
                # Drain admission even if Stop/deadline arrives after the DB
                # committed it but before its receipt reached this graph node.
                if run is None and admission is not None:
                    run = await asyncio.shield(admission)
                if run is not None:
                    await self.coordinator.cancel(run.run_id)
            try:
                async with asyncio.timeout(ref.timeout_seconds):
                    # Admission pins the published child version and creates an
                    # isolated provider session, using the existing ACP adapter.
                    prior = await self.repository.find_run_request(
                        parent.identity.subject, request.agent_id, request.conversation_id, request.client_request_id,
                    )
                    version = await self.repository.get_agent_version(request.agent_id, prior.agent_version if prior else None)
                    if version is None or version.blueprint.harness.id != expected_harness:
                        raise ValueError("Publish a supported Harness child before delegation")
                    request.agent_version = version.version
                    admission = asyncio.create_task(self.coordinator.start_run(
                        request, parent.identity.subject, parent.turn.traceparent, parent.identity,
                        parent_run_id=parent.turn.run_id,
                    ))
                    run = await asyncio.shield(admission)
                    writer({"type": "harness_subagent", "event_type": "subagent.started", "data": {
                        "child_run_id": run.run_id, "agent_id": ref.agent_id, "agent_version": run.agent_version,
                        "harness_id": run.harness_id, "parent_run_id": parent.turn.run_id,
                    }})
                    while True:
                        for event in await self.repository.wait_for_events(run.run_id, cursor, 1):
                            cursor = event.sequence
                            if event.event_type == "content.delta":
                                content.append(event.data["text"])
                                output_size += len(event.data["text"])
                                if output_size > 1_000_000:
                                    raise ValueError("Subagent report exceeds the output limit")
                                writer({"type": "remote_agent_output", "result": event.data["text"]})
                            elif event.event_type in {"tool.started", "tool.completed"}:
                                writer({"type": "harness_subagent", "event_type": event.event_type,
                                        "data": {**event.data, "tool_call_id": f"{run.run_id}:{event.data['tool_call_id']}"}})
                        current = await self.repository.get_run(run.run_id)
                        if current is None:
                            raise RuntimeError("Subagent journal is unavailable")
                        if current.status in TERMINAL_RUN_STATUSES and cursor >= current.last_sequence:
                            if current.status != RunStatus.COMPLETED:
                                return {"messages": [AIMessage(content=f"ERROR: Subagent {run.run_id} is {current.status.value}; do not automatically retry.")]}
                            return {"messages": [AIMessage(content="".join(content))]}
            except asyncio.CancelledError:
                await asyncio.shield(stop())
                raise
            except Exception as exc:
                logger.warning("Subagent execution did not complete (%s), child run %s", type(exc).__name__, run.run_id if run else "not admitted")
                await stop()
                # A timeout or transport failure cannot prove a remote command
                # stopped. Keep the worker's reservation and avoid model retries.
                return {"messages": [AIMessage(content=f"ERROR: Subagent {run.run_id if run else ref.agent_id} could not complete; do not automatically retry.")]}

        graph = StateGraph(MessagesState)
        graph.add_node("delegate", delegate)
        graph.add_edge(START, "delegate")
        graph.add_edge("delegate", END)
        return {"name": ref.agent_id, "description": ref.description, "runnable": graph.compile(name=ref.agent_id)}

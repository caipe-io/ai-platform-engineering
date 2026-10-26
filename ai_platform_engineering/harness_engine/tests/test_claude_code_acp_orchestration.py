"""The real Engine owns ACP turns, checkpoints and visible terminal history."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from harness_engine.adapters import claude_code_acp
from harness_engine.adapters.claude_code_acp import ClaudeCodeACPAdapter
from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.coding.admission import CodingAdmissionError
from harness_engine.coding.inputs import SubmitCodingInput
from harness_engine.coding.sandbox import SandboxClient
from harness_engine.coding.state_protocol import STATE_EXCLUDED_PATHS, NativeStateExport
from harness_engine.coding.workspace import CanonicalWorkspace
from harness_engine.config import Settings
from harness_engine.coordinator import RunCoordinator
from harness_engine.history import MongoRunHistoryProjector
from harness_engine.models import CreateRunRequest, RunStatus
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import MongoRunRepository
from harness_engine.sessions import CAIPEAgentSessionManager
from tests.test_coding_acp_client import HarnessPeer

pytest_plugins = ["tests.coding_fixtures"]


class FakeSandbox:
    def __init__(self, profile, *, interaction=None, fail_terminal=False):
        self.base = "https://sandbox.example.test"
        self.profile = profile
        self.interaction, self.fail_terminal = interaction, fail_terminal
        self.peers = []
        self.captures = []
        self.restores = []
        self.deletions = []
        self.allocation = None

    async def profiles(self):
        return [self.profile.model_copy(update={"capabilities": {"mcp": True, "skills": True, "attachments": True}})]

    async def provision(self, agent_id, binding_id, profile):
        self.allocation = SimpleNamespace()
        from harness_engine.coding.sandbox import SandboxAllocation

        self.allocation = SandboxAllocation(
            id="sandbox-primary",
            uid="uid-primary",
            namespace="example",
            conversation_id=SandboxClient.conversation_reference(agent_id, binding_id),
            profile_id=profile.id,
            revision=profile.revision,
            cwd="/workspace",
            state="ready",
        )
        return self.allocation

    async def restore(self, allocation, profile):
        return allocation

    async def lookup(self, *args):
        return self.allocation

    async def delete(self, allocation, profile):
        assert allocation.uid == "uid-primary" and profile.revision == "r1"
        self.deletions.append(allocation.id)

    async def prepare(self, allocation, files):
        assert all(path.startswith(".claude/skills/") for path in files)

    async def workspace_files(self, allocation):
        return {
            "files": ["result.txt"] if any(peer.task is not None and peer.task.done() for peer in self.peers) else [],
            "truncated": False,
        }

    async def _request(self, method, path, body=None):
        raw = b"Acknowledged artifact"
        return {
            "path": "result.txt",
            "encoding": "base64",
            "content": base64.b64encode(raw).decode(),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    @asynccontextmanager
    async def execution(self, *args):
        yield

    @asynccontextmanager
    async def acp(self, allocation):
        peer = HarnessPeer(interaction=self.interaction)
        self.peers.append(peer)
        try:
            yield peer
        finally:
            await peer.close()

    @asynccontextmanager
    async def export_state(self, allocation, profile, *, checkpoint_id, provider_session_id):
        assert all(peer.closed for peer in self.peers)
        raw = ("state-" + str(len(self.captures))).encode()
        header = {
            "type": "header",
            "checkpoint_id": checkpoint_id,
            "format": "caipe.native-state.v1",
            "archive": "pax-tar",
            "profile_id": profile.id,
            "profile_revision": profile.revision,
            "harness": "claude-code",
            "provider_session_id": provider_session_id,
            "cwd": allocation.cwd,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "runtime_versions": {"claude-code": "qualified"},
            "excluded_paths": STATE_EXCLUDED_PATHS,
        }
        self.captures.append(checkpoint_id)

        async def frames():
            yield {"type": "chunk", "data": base64.b64encode(raw).decode()}
            yield {
                **header,
                "type": "complete",
                "members": 1,
                "expanded_bytes": len(raw),
                "sha256": "0" * 64 if self.fail_terminal and len(self.captures) > 1 else header["sha256"],
            }

        yield NativeStateExport(header, frames())

    async def restore_state(self, allocation, profile, *, header, complete, chunks, restore_id):
        restored = b"".join([chunk async for chunk in chunks()])
        assert hashlib.sha256(restored).hexdigest() == header["sha256"]
        self.restores.append(header["checkpoint_id"])


class Credentials:
    def __init__(self, settings, fence):
        self.settings, self.fence = settings, fence

    async def token(self, **kwargs):
        await self.fence.require(**kwargs)
        return "owner-bearer"


@asynccontextmanager
async def harness(coding_scope, monkeypatch, *, interaction=None, fail_terminal=False):
    db, context, profile, _ = coding_scope
    db.harness_runs.delete_many({})
    db.harness_sessions.delete_many({})
    settings = Settings(
        internal_token="test-internal-token-value",
        storage_backend="mongodb",
        mongodb_uri=os.environ["HARNESS_ENGINE_TEST_MONGODB_URI"],
        mongodb_database=db.name,
        claude_code_profiles_json=json.dumps({"primary": {"sandbox_profile_id": "primary", "revision": "r1"}}),
        coding_sandbox_service_url="https://sandbox.example.test",
        coding_platform_url="https://caipe.example.test",
        coding_resources_url="https://resources.example.test",
        coding_tools_public_url="https://broker.example.test",
        coding_obo_token_url="https://identity.example.test/token",
        coding_obo_client_id="example",
        coding_obo_client_secret="example-secret",
    )
    repository = MongoRunRepository(settings.mongodb_uri, db.name, 86400)
    await repository.initialize()
    await repository.save_agent(context.blueprint, "fingerprint", "catalog", None)
    sandbox = FakeSandbox(profile, interaction=interaction, fail_terminal=fail_terminal)
    monkeypatch.setattr(claude_code_acp, "AuthorizedRunCredentials", Credentials)

    @asynccontextmanager
    async def resources(*args):
        async def start(driver):
            pass

        async def close():
            pass

        yield SimpleNamespace(
            system_prompt="Help",
            files={},
            mcp_servers=[],
            start=start,
            close=close,
            unsettled=False,
            execution_policy={
                "model_retry": {"max_retries": 2},
                "model_call_limit": {"run_limit": 10},
                "context_management": "provider_native",
            },
        )

    monkeypatch.setattr(claude_code_acp, "platform_resources", resources)
    adapter = ClaudeCodeACPAdapter(settings, repository=repository, sandbox_factory=lambda *args, **kwargs: sandbox)
    registry = HarnessRegistry([adapter])
    sessions = CAIPEAgentSessionManager(repository, registry, b"test-session-key")
    history = MongoRunHistoryProjector(repository)
    await history.initialize()
    coordinator = RunCoordinator(repository, registry, sessions, DefaultPromptCompiler(), history_projector=history)
    try:
        yield repository, coordinator, adapter, sandbox, context
    finally:
        await coordinator.shutdown()
        await repository.close()


async def wait_for(repository, run_id, statuses):
    async with asyncio.timeout(10):
        while True:
            run = await repository.get_run(run_id)
            if run.status in statuses:
                return run
            await asyncio.sleep(0.01)


def request(context, key="turn-primary"):
    return CreateRunRequest(
        agent_id=context.binding.agent_id,
        conversation_id=context.binding.conversation_id,
        visible_conversation_id=context.binding.conversation_id,
        message="Hello",
        client_request_id=key,
        expected_harness_id="claude_code_acp",
    )


async def test_detached_provider_acknowledges_checkpoint_and_server_history_once(coding_scope, monkeypatch):
    async with harness(coding_scope, monkeypatch) as (repository, coordinator, _, sandbox, context):
        run = await coordinator.start_run(request(context), context.binding.owner_subject)
        # No subscriber is needed to drive the provider or its history writer.
        run = await wait_for(repository, run.run_id, {RunStatus.COMPLETED, RunStatus.FAILED})
        assert run.status == RunStatus.COMPLETED
        async with asyncio.timeout(3):
            while not coding_scope[0].messages.find_one({"message_id": "message-" + run.run_id, "content": "Result"}):
                await asyncio.sleep(0.01)
        assert coding_scope[0].messages.count_documents({"conversation_id": context.binding.conversation_id}) == 2
        assert len(sandbox.captures) == 2  # Initial empty state, then stopped-turn state.
        assert sum(message.get("method") == "session/prompt" for peer in sandbox.peers for message in peer.sent) == 1
        files = await CanonicalWorkspace(coding_scope[0]).list(run.owner_subject, run.agent_id, run.conversation_id)
        assert files["files"] == ["/result.txt"] and files["snapshot"] == "acknowledged"
        same = await coordinator.start_run(request(context), context.binding.owner_subject)
        assert same.run_id == run.run_id
        assert sum(message.get("method") == "session/prompt" for peer in sandbox.peers for message in peer.sent) == 1


async def test_later_turn_restores_exact_canonical_native_state_before_prompt(coding_scope, monkeypatch):
    async with harness(coding_scope, monkeypatch) as (repository, coordinator, _, sandbox, context):
        first = await coordinator.start_run(request(context), context.binding.owner_subject)
        first = await wait_for(repository, first.run_id, {RunStatus.COMPLETED, RunStatus.FAILED})
        assert first.status == RunStatus.COMPLETED
        async with asyncio.timeout(3):
            while first.run_id in coordinator._tasks:
                await asyncio.sleep(0.01)
        previous = sandbox.captures[-1]
        second = await coordinator.start_run(request(context, "turn-secondary"), context.binding.owner_subject)
        second = await wait_for(repository, second.run_id, {RunStatus.COMPLETED, RunStatus.FAILED})
        assert second.status == RunStatus.COMPLETED
        assert sandbox.restores == [previous]
        assert sum(message.get("method") == "session/new" for peer in sandbox.peers for message in peer.sent) == 1
        assert sum(message.get("method") == "session/prompt" for peer in sandbox.peers for message in peer.sent) == 2


async def test_failed_terminal_capture_cannot_publish_completed(coding_scope, monkeypatch):
    async with harness(coding_scope, monkeypatch, fail_terminal=True) as (repository, coordinator, _, sandbox, context):
        run = await coordinator.start_run(request(context), context.binding.owner_subject)
        run = await wait_for(repository, run.run_id, {RunStatus.COMPLETED, RunStatus.FAILED})
        assert run.status == RunStatus.FAILED
        assert (
            coding_scope[0].harness_sessions.find_one()["_provider_state_head"]["checkpoint_id"] == sandbox.captures[0]
        )
        assert not coding_scope[0].harness_events.find_one({"run_id": run.run_id, "event_type": "run.completed"})


async def test_permission_resume_answers_original_prompt_and_cancel_never_approves(coding_scope, monkeypatch):
    async with harness(coding_scope, monkeypatch, interaction="permission") as (
        repository,
        coordinator,
        adapter,
        sandbox,
        context,
    ):
        run = await coordinator.start_run(request(context), context.binding.owner_subject)
        paused = await wait_for(repository, run.run_id, {RunStatus.AWAITING_INPUT, RunStatus.FAILED})
        assert paused.status == RunStatus.AWAITING_INPUT and paused.pending_interrupt_id
        decision = SubmitCodingInput(
            client_request_id="decision-primary",
            decision={
                "type": "form_input",
                "interrupt_id": paused.pending_interrupt_id,
                "values": {"option_id": "allow-once"},
            },
        )
        await adapter.submit_input(run.run_id, run.owner_subject, decision)
        done = await wait_for(repository, run.run_id, {RunStatus.COMPLETED, RunStatus.FAILED})
        assert done.status == RunStatus.COMPLETED
        assert sum(message.get("method") == "session/prompt" for peer in sandbox.peers for message in peer.sent) == 1
        async with asyncio.timeout(3):
            while run.run_id in coordinator._tasks:
                await asyncio.sleep(0.01)
        second = await coordinator.start_run(request(context, "turn-secondary"), context.binding.owner_subject)
        paused = await wait_for(repository, second.run_id, {RunStatus.AWAITING_INPUT, RunStatus.FAILED})
        assert paused.status == RunStatus.AWAITING_INPUT
        await coordinator.cancel(second.run_id)
        done = await wait_for(repository, second.run_id, {RunStatus.CANCELLED, RunStatus.FAILED})
        assert done.status == RunStatus.CANCELLED
        reply = [
            message.get("result")
            for peer in sandbox.peers[-1:]
            for message in peer.sent
            if message.get("id") == "permission-1"
        ]
        assert reply == [{"outcome": {"outcome": "cancelled"}}]


async def test_permanent_delete_cleans_owned_cache_and_canonical_native_bytes_after_stop(coding_scope, monkeypatch):
    async with harness(coding_scope, monkeypatch) as (repository, coordinator, _, sandbox, context):
        run = await coordinator.start_run(request(context), context.binding.owner_subject)
        run = await wait_for(repository, run.run_id, {RunStatus.COMPLETED, RunStatus.FAILED})
        assert run.status == RunStatus.COMPLETED
        async with asyncio.timeout(3):
            while run.run_id in coordinator._tasks:
                await asyncio.sleep(0.01)
        db = coding_scope[0]
        assert db["harness_provider_state.files"].count_documents({}) == 2
        db.harness_deleted_contexts.insert_one({"_id": run.conversation_id})
        await coordinator.delete_session(run.owner_subject, run.agent_id, run.conversation_id)
        assert sandbox.deletions == ["sandbox-primary"]
        assert db["harness_provider_state.files"].count_documents({}) == 0
        assert db["harness_workspace_artifacts.files"].count_documents({}) == 0
        assert db.harness_provider_checkpoints.count_documents({}) == 0
        assert db.harness_sessions.count_documents({}) == 0


async def test_replica_with_changed_operator_policy_cannot_authorize_active_callbacks(coding_scope, monkeypatch):
    async with harness(coding_scope, monkeypatch, interaction="permission") as (
        repository,
        coordinator,
        adapter,
        _,
        context,
    ):
        run = await coordinator.start_run(request(context), context.binding.owner_subject)
        paused = await wait_for(repository, run.run_id, {RunStatus.AWAITING_INPUT, RunStatus.FAILED})
        assert paused.status == RunStatus.AWAITING_INPUT
        changed_settings = adapter.settings.model_copy(
            update={
                "claude_code_profiles_json": json.dumps(
                    {"primary": {"sandbox_profile_id": "primary", "revision": "r1", "model": "changed-approved-model"}}
                )
            }
        )
        changed = ClaudeCodeACPAdapter(changed_settings, repository=repository)
        with pytest.raises(CodingAdmissionError, match="operator policy changed"):
            await changed.context(run.run_id, run.owner_subject)
        await coordinator.cancel(run.run_id)

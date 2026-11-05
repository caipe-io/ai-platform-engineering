from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import httpx2 as httpx
import pytest
from pydantic import SecretStr
from pymongo import MongoClient

from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.claude_worker import create_worker_app
from harness_engine.config import Settings
from harness_engine.models import AgentBlueprint
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import MongoRunRepository
from harness_engine.sessions import AgentSessionNotRunnableError, CAIPEAgentSessionManager
from tests.conftest import auth_headers, blueprint
from tests.test_claude_sandbox import configured_parent, connection
from tests.test_claude_workers import context


@pytest.fixture
async def mongo_repository() -> AsyncIterator[MongoRunRepository]:
    uri = os.getenv("HARNESS_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set HARNESS_TEST_MONGODB_URI to an isolated local MongoDB")
    if urlsplit(uri).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Sandbox integration tests require an isolated local MongoDB")
    name = f"acp_sandbox_test_{uuid4().hex}"
    repository = MongoRunRepository(uri, name, 3600)
    await repository.initialize()
    try:
        yield repository
    finally:
        await repository.close()
        with MongoClient(uri, serverSelectionTimeoutMS=2000) as client:
            client.drop_database(name)


async def saved_agent(repository: MongoRunRepository, registry: HarnessRegistry) -> AgentBlueprint:
    draft = AgentBlueprint.model_validate(blueprint(harness_id="claude_code_acp", profile_id="primary"))
    validation = registry.validate(draft, owner_subject="test-user")
    assert validation.valid
    await repository.save_agent(draft, validation.config_fingerprint, registry.catalog_revision, None)
    return draft


async def test_real_mongo_retains_sandbox_identity_across_replicas_and_rejects_repoint(
    mongo_repository: MongoRunRepository, settings: Settings, tmp_path: Path,
) -> None:
    adapter = RemoteClaudeSDKAdapter(configured_parent(settings, tmp_path), claude_acp=True)
    registry = HarnessRegistry([adapter])
    draft = await saved_agent(mongo_repository, registry)
    first = CAIPEAgentSessionManager(mongo_repository, registry, b"shared-session-key")
    second = CAIPEAgentSessionManager(mongo_repository, registry, b"shared-session-key")
    original, _ = await first.resolve("test-user", draft.id, "conversation-example")
    loaded, _ = await second.resolve("test-user", draft.id, "conversation-example")
    # BSON timestamps are millisecond-precision; executable identity is exact.
    assert loaded.model_dump(exclude={"created_at", "updated_at"}) == original.model_dump(exclude={"created_at", "updated_at"})
    assert loaded.execution_target and loaded.sandbox.instance_id == "sandbox-example"
    adapter._profiles["primary"].sandbox.policy_revision = "changed-policy"
    with pytest.raises(AgentSessionNotRunnableError):
        await second.resolve("test-user", draft.id, "conversation-example")
    assert (await mongo_repository.get_session(original.binding_id)).sandbox.policy_revision == "revision-example"


async def test_real_mongo_competing_profile_revisions_cannot_dispatch_under_winning_binding(
    mongo_repository: MongoRunRepository, settings: Settings, tmp_path: Path,
) -> None:
    first_settings = configured_parent(settings, tmp_path)
    changed = json.loads(first_settings.claude_worker_profiles_json.get_secret_value())
    changed["primary"]["url"] = "https://replacement-worker.example.test"
    second_settings = first_settings.model_copy(update={"claude_worker_profiles_json": SecretStr(json.dumps(changed))})
    barrier = asyncio.Barrier(2)
    managers = []
    targets = set()
    for config in [first_settings, second_settings]:
        adapter = RemoteClaudeSDKAdapter(config, claude_acp=True)
        original = adapter.session_manager

        class ConcurrentOpen:
            harness_id = "claude_code_acp"

            def __init__(self, delegate: Any) -> None:
                self.delegate = delegate

            async def open(self, context: Any) -> Any:
                await barrier.wait()
                return await self.delegate.open(context)

        adapter.session_manager = ConcurrentOpen(original)
        registry = HarnessRegistry([adapter])
        if not managers:
            await saved_agent(mongo_repository, registry)
        targets.add(adapter.binding_target("primary"))
        managers.append(CAIPEAgentSessionManager(mongo_repository, registry, b"shared-session-key"))
    outcomes = await asyncio.gather(
        *(manager.resolve("test-user", "agent-example", "conversation-example") for manager in managers),
        return_exceptions=True,
    )
    assert sum(isinstance(value, AgentSessionNotRunnableError) for value in outcomes) == 1
    winner = next(value[0] for value in outcomes if isinstance(value, tuple))
    assert winner.execution_target in targets
    persisted = await mongo_repository.get_session(winner.binding_id)
    assert persisted.execution_target == winner.execution_target


async def test_real_mongo_worker_relay_fingerprint_survives_restart_and_rejects_alias_change(
    mongo_repository: MongoRunRepository, settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_connection(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("A changed relay must be rejected before opening the sandbox connection")

    monkeypatch.setattr("harness_engine.claude_sandbox.connect", unexpected_connection)
    remote = connection("wss://portal.example.test/api/acp/connections/primary/stdio", tmp_path)
    profiles = {"safe": {"model": "claude-example", "sandbox": {
        **remote.model_dump(mode="json", exclude={"token"}), "token": remote.token.get_secret_value(),
    }}}
    configured = settings.model_copy(update={"claude_sdk_profiles_json": json.dumps(profiles)})
    ctx = context()
    ctx.blueprint.tools.bindings = []
    ctx.binding.sandbox = remote.public()
    metadata = {"caipe.io/harness": {"context": ctx.model_dump(mode="json")}}
    headers = {**auth_headers(), "ACP-Protocol-Version": "1"}
    setup = {"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": {"cwd": "/workspace", "mcpServers": [], "_meta": metadata}}
    database_name = mongo_repository._db.name
    worker = create_worker_app(settings=configured, repository=mongo_repository)
    async with worker.router.lifespan_context(worker):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker), base_url="https://worker.example.test") as client:
            assert (await client.post("/acp", headers=headers, json=setup)).status_code == 200
            persisted = await mongo_repository.get_session(ctx.binding.binding_id)
    assert persisted.worker_execution_target
    profiles["safe"]["sandbox"]["url"] = "wss://portal.example.test/api/acp/connections/replacement/stdio"
    changed = configured.model_copy(update={"claude_sdk_profiles_json": json.dumps(profiles)})
    replacement_repository = MongoRunRepository(os.environ["HARNESS_TEST_MONGODB_URI"], database_name, 3600)
    replacement = create_worker_app(settings=changed, repository=replacement_repository)
    setup["method"] = "session/resume"
    setup["params"]["sessionId"] = ctx.binding.binding_id
    prompt = {"jsonrpc": "2.0", "id": ctx.turn.run_id, "method": "session/prompt", "params": {
        "sessionId": ctx.binding.binding_id, "prompt": [{"type": "text", "text": ctx.turn.message}], "_meta": metadata,
    }}
    async with replacement.router.lifespan_context(replacement):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=replacement), base_url="https://worker.example.test") as client:
            assert (await client.post("/acp", headers=headers, json=setup)).status_code == 409
            assert (await client.post("/acp", headers=headers, json=prompt)).status_code == 409
            assert (await replacement_repository.get_session(ctx.binding.binding_id)).worker_execution_target == persisted.worker_execution_target
            assert await replacement_repository.get_run(ctx.turn.run_id) is None

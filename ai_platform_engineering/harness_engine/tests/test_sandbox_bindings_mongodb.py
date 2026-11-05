from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from pydantic import SecretStr
from pymongo import MongoClient

from harness_engine.adapters.claude_remote import RemoteClaudeSDKAdapter
from harness_engine.config import Settings
from harness_engine.models import AgentBlueprint
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import MongoRunRepository
from harness_engine.sessions import AgentSessionNotRunnableError, CAIPEAgentSessionManager
from tests.conftest import blueprint
from tests.test_claude_sandbox import configured_parent


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

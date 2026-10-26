"""Real MongoDB exercises fencing, GridFS integrity and scoped human decisions."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from pymongo import MongoClient

from harness_engine.coding.sandbox import SandboxAllocation, SandboxProfile
from harness_engine.coding.state_protocol import STATE_CONTRACT
from harness_engine.models import AgentBlueprint, RenderedPrompt, RunContext, SessionBinding, TurnInput


@pytest.fixture
def coding_scope():
    uri = os.environ.get("HARNESS_ENGINE_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set HARNESS_ENGINE_TEST_MONGODB_URI for standalone coding-provider tests")
    client = MongoClient(
        uri,
        tz_aware=True,
        serverSelectionTimeoutMS=2000,
    )
    client.admin.command("ping")
    name = "test_coding_" + uuid4().hex
    db = client[name]
    blueprint = AgentBlueprint(
        id="agent-example",
        name="Example",
        harness={"id": "claude_code_acp", "profile_id": "primary"},
        prompt={"system": "Help"},
    )
    binding = SessionBinding(
        binding_id="binding-example",
        owner_subject="user-primary",
        agent_id=blueprint.id,
        agent_version=1,
        conversation_id="conversation-example",
        harness_id="claude_code_acp",
        profile_id="primary",
        checkpoint_strategy="adapter_store",
    )
    context = RunContext(
        blueprint=blueprint,
        binding=binding,
        prompt=RenderedPrompt(system="Help"),
        turn=TurnInput(run_id="run-example", message="Hello", visible_conversation_id=binding.conversation_id),
        producer_token="producer-primary",
    )
    db.harness_sessions.insert_one(
        {
            **binding.model_dump(mode="python"),
            "_active_run_id": context.turn.run_id,
            "_producer_id": context.producer_token,
            "_lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
        }
    )
    db.harness_runs.insert_one(
        {
            "run_id": context.turn.run_id,
            "binding_id": binding.binding_id,
            "owner_subject": binding.owner_subject,
            "agent_id": binding.agent_id,
            "agent_version": 1,
            "conversation_id": binding.conversation_id,
            "harness_id": binding.harness_id,
            "profile_id": binding.profile_id,
            "status": "running",
            "last_sequence": 1,
            "_producer_id": context.producer_token,
            "_producer_expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
            "cancellation_requested": False,
        }
    )
    db.conversations.insert_one(
        {
            "_id": binding.conversation_id,
            "owner_id": "user@example.test",
            "participants": [{"type": "agent", "id": binding.agent_id}],
        }
    )
    db.users.insert_one({"email": "user@example.test", "keycloak_sub": binding.owner_subject})
    db.dynamic_agents.insert_one({"_id": binding.agent_id, "enabled": True})
    db.harness_gateway_bindings.insert_one(
        {
            "owner_subject": binding.owner_subject,
            "agent_id": binding.agent_id,
            "conversation_id": binding.conversation_id,
            "harness_id": binding.harness_id,
        }
    )
    profile = SandboxProfile(
        id="primary", name="Primary", revision="r1", harness="claude-code", state_contract=STATE_CONTRACT
    )
    allocation = SandboxAllocation(
        id="sandbox-primary",
        uid="uid-primary",
        namespace="example",
        conversation_id="opaque-reference",
        profile_id="primary",
        revision="r1",
        cwd="/workspace",
        state="ready",
    )
    try:
        yield db, context, profile, allocation
    finally:
        client.drop_database(name)
        client.close()

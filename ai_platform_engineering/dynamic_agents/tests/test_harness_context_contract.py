from __future__ import annotations

import importlib.util
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from pymongo import MongoClient

from dynamic_agents.services import harness_context


@pytest.fixture(params=["runtime", "engine"])
def resolver(request):
    if request.param == "runtime":
        return harness_context.resolve_canonical_conversation
    source = Path(__file__).resolve().parents[2] / "harness_engine/src/harness_engine/canonical_context.py"
    if not source.exists():
        pytest.skip("The independent Engine source is unavailable in this component-only image")
    spec = importlib.util.spec_from_file_location("engine_canonical_context_contract", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.resolve_canonical_conversation


@pytest.fixture
def context_db():
    uri = os.environ.get("HARNESS_ENGINE_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("Set HARNESS_ENGINE_TEST_MONGODB_URI for canonical context contracts")
    client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000)
    database = client["harness_context_test_" + uuid4().hex]
    database.conversations.insert_one({"_id": "visible-example", "owner_id": "owner@example.test",
                                      "owner_subject": "owner-example", "participants": [{"type": "agent", "id": "agent-example"}]})
    try:
        yield database
    finally:
        client.drop_database(database.name)
        client.close()


def resolve(resolver, database, runtime="visible-example"):
    return resolver(database, owner_subject="owner-example", agent_id="agent-example", conversation_id=runtime, visible_conversation_id="visible-example")


def test_authoritative_subject_cannot_be_replaced_by_participant_or_legacy_email(resolver, context_db):
    context_db.conversations.update_one({}, {"$set": {"owner_subject": "another-owner"}})
    context_db.users.insert_one({"email": "owner@example.test", "keycloak_sub": "owner-example"})
    with pytest.raises(ValueError, match="owner"):
        resolve(resolver, context_db)


@pytest.mark.parametrize("subject_field", ["keycloak_sub", "metadata.keycloak_sub"])
def test_legacy_email_requires_canonical_user_to_subject_mapping(resolver, context_db, subject_field):
    context_db.conversations.update_one({}, {"$unset": {"owner_subject": ""}})
    with pytest.raises(ValueError, match="owner"):
        resolve(resolver, context_db)
    context_db.users.update_one({"email": "owner@example.test"}, {"$set": {subject_field: "owner-example"}}, upsert=True)
    assert resolve(resolver, context_db)["_id"] == "visible-example"


def test_local_owner_identity_and_missing_journal_only_context(resolver, context_db):
    context_db.conversations.update_one({}, {"$unset": {"owner_subject": ""}, "$set": {"owner_id": "owner-example"}})
    assert resolve(resolver, context_db)["_id"] == "visible-example"
    assert resolver(context_db, owner_subject="owner-example", agent_id="agent-example", conversation_id="api-context-example") is None


def test_only_stored_runtime_pointer_admits_an_alias(resolver, context_db):
    with pytest.raises(ValueError, match="mapping"):
        resolve(resolver, context_db, "runtime-example")
    context_db.conversations.update_one({}, {"$set": {"source": "autonomous", "execution_context_id": "runtime-example"}})
    assert resolve(resolver, context_db, "runtime-example")["_id"] == "visible-example"
    with pytest.raises(ValueError, match="pointer"):
        resolve(resolver, context_db, "runtime-other")


def test_legacy_autonomous_alias_requires_owned_task_and_latest_run(resolver, context_db):
    context_db.conversations.update_one({}, {"$set": {"source": "autonomous", "task_id": "task-example"}})
    context_db.autonomous_tasks.insert_one({"_id": "task-example", "owner_sub": "owner-example", "owner_id": "owner@example.test"})
    now = datetime.now(timezone.utc)
    context_db.autonomous_runs.insert_one({"task_id": "task-example", "owner_id": "owner@example.test", "execution_context_id": "runtime-example", "conversation_id": "visible-example", "started_at": now})
    assert resolve(resolver, context_db, "runtime-example")["_id"] == "visible-example"
    context_db.autonomous_runs.insert_one({"task_id": "task-example", "owner_id": "owner@example.test", "execution_context_id": "runtime-new", "conversation_id": "visible-example", "started_at": now + timedelta(seconds=1)})
    with pytest.raises(ValueError, match="mapping"):
        resolve(resolver, context_db, "runtime-example")
    context_db.autonomous_tasks.update_one({}, {"$set": {"owner_sub": "another-owner"}})
    with pytest.raises(ValueError, match="mapping"):
        resolve(resolver, context_db, "runtime-new")

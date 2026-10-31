"""Legacy and Engine producers must share the same native checkpoint fence."""

from __future__ import annotations

import asyncio
import threading
from importlib import import_module
from importlib.util import find_spec
from typing import Any

import mongomock
import pytest

from harness_engine.models import ExecutionIdentity
from harness_engine.repository import RunAdmissionError
from harness_engine.resume import validate_resume_response


@pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")
@pytest.mark.asyncio
async def test_native_checkpoint_has_one_producer_and_releases_after_cancellation() -> None:
    DynamicAgentConfig = import_module("dynamic_agents.models").DynamicAgentConfig
    leases = import_module("dynamic_agents.services.execution_lease")
    reserve_native_thread = leases.reserve_native_thread
    NativeThreadBusyError = leases.NativeThreadBusyError
    db = mongomock.MongoClient().example
    config = DynamicAgentConfig(
        _id="example-agent",
        name="Example",
        owner_id="user@example.test",
        system_prompt="Help",
        model={"id": "example-model", "provider": "example"},
    )
    entered = asyncio.Event()

    async def produce() -> None:
        async with reserve_native_thread(db, config, "native-thread", "first-run"):
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(produce())
    await entered.wait()
    with pytest.raises(NativeThreadBusyError):
        async with reserve_native_thread(db, config, "native-thread", "second-run"):
            pytest.fail("A competing producer entered the native thread")
    task.cancel()
    results = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert task.cancelled()
    async with reserve_native_thread(db, config, "native-thread", "third-run"):
        assert db.execution_thread_leases.count_documents({"active_run": "third-run"}) == 1
    assert db.execution_thread_leases.count_documents({"active_run": {"$ne": None}}) == 0


def test_approval_edits_cannot_replace_the_saved_tool_or_add_a_batched_decision() -> None:
    pending = {
        "interrupt_type": "tool_approval",
        "tool_approvals": [{"tool_name": "example_tool", "allowed_decisions": ["approve", "edit"]}],
    }
    validate_resume_response(pending, {"type": "tool_approval", "decision": "approve"})
    with pytest.raises(RunAdmissionError):
        validate_resume_response(
            pending, {"type": "tool_approval", "decision": "edit", "tool_name": "other_tool", "edited_args": {}}
        )
    with pytest.raises(RunAdmissionError):
        validate_resume_response(
            pending, {"type": "tool_approval", "decisions": [{"decision": "approve"}, {"decision": "approve"}]}
        )


def test_transient_execution_identity_cannot_be_serialized_or_logged_by_repr() -> None:
    identity = ExecutionIdentity(
        subject="test-user", bearer="example-transient-secret", user_context={"access_token": "other-transient-secret"}
    )
    assert "transient-secret" not in identity.model_dump_json()
    assert "transient-secret" not in repr(identity)


@pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")
@pytest.mark.asyncio
async def test_handoff_fences_previous_owner_and_failed_reconciliation_restores_it() -> None:
    models = import_module("dynamic_agents.models")
    leases = import_module("dynamic_agents.services.execution_lease")
    config = models.DynamicAgentConfig(_id="example-agent", name="Example", owner_id="user@example.test", system_prompt="Help", model={"id": "example-model", "provider": "example"})
    db = mongomock.MongoClient().example
    async with leases.reserve_native_thread(db, config, "example-thread", "legacy-run"):
        pass
    async def fail_inspection() -> None:
        raise ValueError("Checkpoint inspection failed")

    with pytest.raises(ValueError):
        async with leases.reserve_native_thread(db, config, "example-thread", "failed-handoff", owner="harness_engine", adopt=True, handoff_to="harness_engine"):
            await fail_inspection()
    async with leases.reserve_native_thread(db, config, "example-thread", "legacy-retry"):
        pass
    async with leases.reserve_native_thread(db, config, "example-thread", "adopt", owner="harness_engine", adopt=True, handoff_to="harness_engine"):
        pass
    with pytest.raises(leases.NativeThreadBusyError):
        async with leases.reserve_native_thread(db, config, "example-thread", "late-legacy-run"):
            pytest.fail("The previous execution owner was not fenced")
    async with leases.reserve_native_thread(db, config, "example-thread", "rollback", owner="harness_engine", handoff_to="dynamic_agents"):
        pass
    async with leases.reserve_native_thread(db, config, "example-thread", "legacy-after-rollback"):
        pass


@pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")
@pytest.mark.asyncio
async def test_cancelled_claim_cannot_leave_a_late_native_reservation(monkeypatch: pytest.MonkeyPatch) -> None:
    models = import_module("dynamic_agents.models")
    leases = import_module("dynamic_agents.services.execution_lease")
    config = models.DynamicAgentConfig(_id="example-agent", name="Example", owner_id="user@example.test", system_prompt="Help", model={"id": "example-model", "provider": "example"})
    db = mongomock.MongoClient().example
    started, release = threading.Event(), threading.Event()
    original = db.execution_thread_leases.find_one_and_update
    def delayed(*args: Any, **kwargs: Any) -> Any:
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(db.execution_thread_leases, "find_one_and_update", delayed)
    async def produce() -> None:
        async with leases.reserve_native_thread(db, config, "example-thread", "cancelled-run"):
            pytest.fail("A cancelled claim entered execution")
    task = asyncio.create_task(produce())
    assert await asyncio.to_thread(started.wait, 5)
    task.cancel()
    release.set()
    results = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert task.cancelled()
    assert db.execution_thread_leases.count_documents({"active_run": {"$ne": None}}) == 0


@pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")
def test_native_publication_uses_configuration_reader_defaults_for_null_fields() -> None:
    runtime = import_module("harness_engine.deep_agents_runtime").DeepAgentsRuntime
    normalized = runtime.normalize_options({"runtime": {
        "name": "Example", "system_prompt": "Help", "model": {"id": "example-model", "provider": "example"},
        "interrupt_on": None, "features": None,
    }})
    assert isinstance(normalized["runtime"]["interrupt_on"], dict)


@pytest.mark.parametrize("occurrence", [True, False, 1.5, "1"])
def test_rewind_requires_a_positive_integer_occurrence(occurrence: Any) -> None:
    models = import_module("harness_engine.models")
    with pytest.raises(ValueError, match="Rewind requires"):
        models.CreateRunRequest(agent_id="example", conversation_id="example", command="rewind", turn_id="example",
                                rewind_data={"message_content": "example", "content_occurrence": occurrence})


@pytest.mark.parametrize("override", [
    {"backend": {"type": "store"}}, {"model": {"provider": "example"}},
    {"system_prompt": "replace"}, {"skills": ["example"]}, {"subagents": []},
])
def test_public_run_rejects_trust_boundary_overrides(override: dict[str, Any]) -> None:
    models = import_module("harness_engine.models")
    with pytest.raises(ValueError, match="override|reasoning"):
        models.CreateRunRequest(agent_id="example", conversation_id="example", message="example", config_override=override)


@pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")
@pytest.mark.asyncio
async def test_release_drains_repeated_cancellation_and_retries_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    models = import_module("dynamic_agents.models")
    leases = import_module("dynamic_agents.services.execution_lease")
    errors = import_module("pymongo.errors")
    config = models.DynamicAgentConfig(_id="example", name="Example", owner_id="user@example.test", system_prompt="Help", model={"id": "example", "provider": "example"})
    db = mongomock.MongoClient().example
    entered, releasing, finish = asyncio.Event(), threading.Event(), threading.Event()
    original = db.execution_thread_leases.update_one
    attempts = 0
    def delayed(*args: Any, **kwargs: Any) -> Any:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise errors.AutoReconnect("temporary storage failure")
        releasing.set()
        assert finish.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(db.execution_thread_leases, "update_one", delayed)
    async def produce() -> None:
        async with leases.reserve_native_thread(db, config, "example", "example-run"):
            entered.set()
            await asyncio.Event().wait()
    task = asyncio.create_task(produce())
    await entered.wait()
    task.cancel()
    assert await asyncio.to_thread(releasing.wait, 5)
    task.cancel()
    task.cancel()
    finish.set()
    results = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert attempts == 2
    assert db.execution_thread_leases.count_documents({"active_run": {"$ne": None}}) == 0


@pytest.mark.skipif(find_spec("dynamic_agents") is None, reason="Requires the deep-agents extra")
@pytest.mark.asyncio
@pytest.mark.parametrize("owner,conversation", [("other-user", "example-thread"), ("test-user", "other-thread")])
async def test_attachment_reader_rejects_another_owner_or_conversation(owner: str, conversation: str) -> None:
    runtime_class = import_module("harness_engine.deep_agents_runtime").DeepAgentsRuntime
    models = import_module("harness_engine.models")
    namespaces = import_module("types")
    dates = import_module("datetime")
    runtime = object.__new__(runtime_class)
    db = mongomock.MongoClient(tz_aware=True).example
    runtime.mongo = namespaces.SimpleNamespace(_db=db)
    db.harness_attachment_blobs.insert_one({
        "_id": "example-blob", "owner_subject": "test-user", "agent_id": "example-agent", "conversation_id": "example-thread",
        "expires_at": models.utc_now() + dates.timedelta(hours=1), "file": {"data": "ZXhhbXBsZQ==", "mime_type": "text/plain"},
    })
    context = namespaces.SimpleNamespace(identity=namespaces.SimpleNamespace(subject=owner),
        turn=namespaces.SimpleNamespace(attachments=[namespaces.SimpleNamespace(id="example-blob")]),
        binding=namespaces.SimpleNamespace(conversation_id=conversation))
    with pytest.raises(PermissionError, match="unavailable"):
        await runtime._load_attachments(context, "example-agent")
    context.identity.subject = "test-user"
    context.binding.conversation_id = "example-thread"
    assert len(await runtime._load_attachments(context, "example-agent")) == 1

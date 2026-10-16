"""Opaque checkpoint publication and restoration against disposable MongoDB."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from pymongo.errors import NetworkTimeout

from dynamic_agents.models import AgentExecutionConfig
from dynamic_agents.services.harness_checkpoints import (
    CHECKPOINT_BUCKET,
    MAX_CHUNK_BYTES,
    RETAINED_CHECKPOINTS,
    CheckpointError,
    CheckpointFenceError,
    CheckpointIdentity,
    CheckpointStore,
)
from dynamic_agents.services.native_run_repository import NativeRunRepository
from dynamic_agents.services.native_state_protocol import STATE_CONTRACT
from dynamic_agents.services.session_bindings import (
    SessionBindingError,
    adopt_sandbox_checkpoint_profile,
    get_sandbox_binding,
    reset_sandbox_binding,
    resolve_native_binding,
    save_sandbox_binding,
)
from dynamic_agents.services.session_runs import current_native_session_lease, native_session_run
from tests.test_native_acp_mongodb import native_database as native_database


@pytest.fixture
def checkpoint_state(native_database):
    state = native_database
    state.agent = state.agent.model_copy(update={"execution": AgentExecutionConfig(kind="sandbox", profile_id="qualified")})
    resolve_native_binding(state.mongo, state.agent, state.session_id)
    state.allocation = {"id": "example", "uid": "original-uid", "namespace": "example", "conversation_id": state.session_id,
        "profile_id": "qualified", "revision": "revision-1", "cwd": "/workspace", "state": "Ready", "resource_version": "1"}
    state.identity = CheckpointIdentity(agent_id=state.agent.id, session_id=state.session_id,
        owner_subject="fixture-owner", profile_id="qualified", profile_revision="revision-1", harness="claude-code",
        provider_session_id="provider-native-session", connection_version="a" * 64)
    save_sandbox_binding(state.mongo, state.agent.id, state.session_id, {
        "owner_subject": state.identity.owner_subject, "connection_version": state.identity.connection_version,
        "provider_session_id": state.identity.provider_session_id,
        "profile": {"id": "qualified", "name": "Qualified runtime", "revision": "revision-1", "harness": "claude-code"},
        "allocation": state.allocation,
    })
    state.store = CheckpointStore(state.mongo)
    state.run_id = str(uuid4())
    state.base = {"cwd": "/workspace", "source_allocation_uid": "original-uid", "run_id": state.run_id,
        "journal_cursor": 7, "runtime_versions": {"adapter": "1.0.0", "harness": "2.0.0"}}
    return state


def _bind_run(state, lease_id):
    state.db["native_acp_execution_runs"].update_one({"run_id": state.run_id}, {"$set": {
        "agent_id": state.agent.id, "session_id": state.session_id, "owner_subject": state.identity.owner_subject,
        "lease_id": lease_id, "last_sequence": 7, "active": True,
    }}, upsert=True)


async def _writer(state, lease_id, *, base=None):
    _bind_run(state, lease_id)
    return await state.store.open_writer(state.identity, checkpoint_id=str(uuid4()), lease_id=lease_id,
        base_metadata=base or state.base)


def _completion(content):
    return {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content), "members": 3, "expanded_bytes": len(content)}


async def _save(state, lease_id, content=b"opaque\x00native\xffstate"):
    writer = await _writer(state, lease_id)
    await writer.write(content)
    return await writer.commit(_completion(content))


async def test_stream_roundtrip_survives_release_and_fresh_store(checkpoint_state):
    state = checkpoint_state
    content = b"native\x00binary\xff" * 12_000
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        assert current_native_session_lease.get() == lease
        writer = await _writer(state, lease)
        assert state.store.manifests.find_one({"_id": writer.checkpoint_id})["status"] == "uploading"
        assert await state.store.latest(state.identity) is None
        for offset in range(0, len(content), MAX_CHUNK_BYTES):
            await writer.write(content[offset:offset + MAX_CHUNK_BYTES])
        manifest = await writer.commit(_completion(content))
    assert current_native_session_lease.get() is None
    row = state.mongo.get_session_runs_collection().find_one({"session_id": state.session_id})
    assert "lease_id" not in row and row["checkpoint_head"]["checkpoint_id"] == manifest.checkpoint_id
    restarted = CheckpointStore(state.mongo)
    assert await restarted.latest(state.identity) == manifest
    assert b"".join([chunk async for chunk in restarted.download(state.identity, manifest)]) == content


async def test_failed_hash_preserves_prior_snapshot_and_removes_upload(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        prior = await _save(state, lease)
        writer = await _writer(state, lease)
        await writer.write(b"changed")
        with pytest.raises(CheckpointError, match="streamed bytes"):
            await writer.commit(_completion(b"wrong"))
        assert await state.store.latest(state.identity) == prior
        assert state.store.manifests.find_one({"_id": writer.checkpoint_id}) is None
        assert state.db[f"{CHECKPOINT_BUCKET}.files"].count_documents({}) == 1


async def test_stale_worker_cannot_publish_after_new_admission(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as first:
        prior = await _save(state, first)
        writer = await _writer(state, first)
        await writer.write(b"late data")
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as second:
        assert second != first
        _bind_run(state, second)
        with pytest.raises(CheckpointFenceError):
            await writer.commit(_completion(b"late data"))
        assert await state.store.latest(state.identity) == prior


async def test_same_lease_new_writer_fences_previous_generation(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        old = await _writer(state, lease)
        await old.write(b"old")
        current = await _writer(state, lease)
        await current.write(b"current")
        with pytest.raises(CheckpointFenceError):
            await old.commit(_completion(b"old"))
        saved = await current.commit(_completion(b"current"))
        assert await state.store.latest(state.identity) == saved


async def test_cleanup_fences_open_upload_and_purges_all_snapshots(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        await _save(state, lease)
        writer = await _writer(state, lease)
        partial = b"partial" * 9000
        await writer.write(partial)
        result = await state.store.cleanup(state.agent.id, state.session_id, state.identity.owner_subject, lease)
        assert result == {"checkpoints_deleted": 2}
        with pytest.raises(CheckpointFenceError):
            await writer.commit(_completion(partial))
        assert await state.store.latest(state.identity) is None
        assert state.store.manifests.count_documents({}) == 0
        assert state.db[f"{CHECKPOINT_BUCKET}.files"].count_documents({}) == 0
        assert state.db[f"{CHECKPOINT_BUCKET}.chunks"].count_documents({}) == 0


async def test_completed_capture_rejects_cancel_but_interrupted_retains_context(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        prior = await _save(state, lease)
        state.mongo.get_session_runs_collection().update_one({"lease_id": lease}, {"$set": {"cancel_requested": True}})
        with pytest.raises(CheckpointFenceError):
            await _writer(state, lease)
        writer = await _writer(state, lease, base={**state.base, "capture_status": "interrupted"})
        await writer.write(b"partial conversation")
        saved = await writer.commit(_completion(b"partial conversation"))
        assert saved.metadata.capture_status == "interrupted" and saved.checkpoint_id != prior.checkpoint_id


@pytest.mark.parametrize("field,value", [("owner_subject", "another-owner"), ("profile_revision", "revision-2"),
    ("provider_session_id", "another-session"), ("agent_id", "another-agent"), ("connection_version", "b" * 64)])
async def test_wrong_identity_cannot_read_or_save(checkpoint_state, field, value):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        await _save(state, lease)
        with pytest.raises(CheckpointFenceError):
            await state.store.latest(state.identity.model_copy(update={field: value}))
        with pytest.raises(CheckpointFenceError):
            await state.store.open_writer(state.identity.model_copy(update={field: value}), checkpoint_id=str(uuid4()),
                lease_id=lease, base_metadata=state.base)


async def test_run_cursor_and_source_allocation_are_bound(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        for updates in ({"journal_cursor": 8}, {"run_id": "unrelated-run"}, {"source_allocation_uid": "another-uid"},
                        {"cwd": "/another-workspace"}):
            with pytest.raises(CheckpointFenceError):
                await _writer(state, lease, base={**state.base, **updates})
        assert state.store.manifests.count_documents({}) == 0


async def test_owned_history_is_bounded_and_other_sessions_survive(checkpoint_state):
    state = checkpoint_state
    state.db[f"{CHECKPOINT_BUCKET}.files"].insert_one({"_id": "unrelated", "length": 0, "chunkSize": 1})
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        for index in range(RETAINED_CHECKPOINTS + 3):
            last = await _save(state, lease, f"snapshot-{index}".encode())
        assert state.store.manifests.count_documents({"status": "ready"}) == RETAINED_CHECKPOINTS
        assert await state.store.latest(state.identity) == last
        await state.store.cleanup(state.agent.id, state.session_id, state.identity.owner_subject, lease)
    assert state.db[f"{CHECKPOINT_BUCKET}.files"].find_one({"_id": "unrelated"})


async def _restore(state, saved, allocation, lease):
    intent = await state.store.begin_restore(state.identity, checkpoint_id=saved.checkpoint_id, lease_id=lease)
    await state.store.record_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id, restore_id=intent["restore_id"],
        allocation=allocation, lease_id=lease)
    return await state.store.replace_allocation(state.identity, checkpoint_id=saved.checkpoint_id, restore_id=intent["restore_id"],
        allocation=allocation, lease_id=lease)


async def test_restore_rebind_is_controlled_and_latest_survives_allocation_change(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        saved = await _save(state, lease)
        replacement = {**state.allocation, "uid": "replacement-uid", "resource_version": "2"}
        forged = {**get_sandbox_binding(state.mongo, state.agent.id, state.session_id), "allocation": replacement}
        with pytest.raises(SessionBindingError, match="environment changed"):
            save_sandbox_binding(state.mongo, state.agent.id, state.session_id, forged)
        result = await _restore(state, saved, replacement, lease)
        assert result["allocation"] == replacement
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == result
        save_sandbox_binding(state.mongo, state.agent.id, state.session_id, result)
        assert await state.store.latest(state.identity) == saved
        assert b"".join([chunk async for chunk in state.store.download(state.identity, saved)])


async def test_expired_restore_and_wrong_profile_cannot_replace_allocation(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        saved = await _save(state, lease)
        replacement = {**state.allocation, "uid": "replacement-uid", "profile_id": "unqualified"}
        with pytest.raises(CheckpointFenceError):
            await _restore(state, saved, replacement, lease)
        state.mongo.get_session_runs_collection().update_one({"lease_id": lease}, {"$set": {
            "lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        with pytest.raises(CheckpointFenceError):
            await _restore(state, saved, {**state.allocation, "uid": "replacement-uid"}, lease)


async def test_corrupt_gridfs_payload_is_detected_on_download(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        saved = await _save(state, lease)
        state.db[f"{CHECKPOINT_BUCKET}.chunks"].update_one({}, {"$set": {"data": b"corrupted bytes"}})
        with pytest.raises(CheckpointError):
            _ = [chunk async for chunk in state.store.download(state.identity, saved)]


async def test_permanent_deleted_fence_rejects_delayed_save(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        writer = await _writer(state, lease)
        await writer.write(b"private retained state")
        state.db["native_acp_deleted_sessions"].insert_one({"_id": state.session_id})
        with pytest.raises(CheckpointFenceError):
            await writer.commit(_completion(b"private retained state"))
        assert state.store.manifests.count_documents({}) == 0


@pytest.mark.parametrize("already_qualified", [False, True])
async def test_legacy_adoption_is_fenced_until_checkpoint_commit(checkpoint_state, already_qualified):
    state = checkpoint_state
    saved = get_sandbox_binding(state.mongo, state.agent.id, state.session_id)
    profile = {**saved["profile"], "state_contract": STATE_CONTRACT}
    if already_qualified:
        state.mongo.get_session_bindings_collection().update_one({"session_id": state.session_id},
            {"$set": {"sandbox.profile": profile}})
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        adopted = adopt_sandbox_checkpoint_profile(state.mongo, state.agent.id, state.session_id, profile, lease)
        assert adopted["checkpoint_phase"] == "adopting"
        save_sandbox_binding(state.mongo, state.agent.id, state.session_id, adopted)
        forged = {**adopted, "checkpoint_phase": "active"}
        save_sandbox_binding(state.mongo, state.agent.id, state.session_id, forged)
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id)["checkpoint_phase"] == "adopting"
        await _save(state, lease)
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id)["checkpoint_phase"] == "active"
        with pytest.raises(SessionBindingError):
            adopt_sandbox_checkpoint_profile(state.mongo, state.agent.id, state.session_id, profile, lease)


async def test_adoption_rejects_profile_drift_or_wrong_lease(checkpoint_state):
    state = checkpoint_state
    profile = {**get_sandbox_binding(state.mongo, state.agent.id, state.session_id)["profile"], "state_contract": STATE_CONTRACT}
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        with pytest.raises(SessionBindingError):
            adopt_sandbox_checkpoint_profile(state.mongo, state.agent.id, state.session_id,
                {**profile, "revision": "another-revision"}, lease)
        with pytest.raises(SessionBindingError):
            adopt_sandbox_checkpoint_profile(state.mongo, state.agent.id, state.session_id, profile, "another-lease")
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id).get("checkpoint_phase") is None


async def test_abandoned_uploads_are_collected_by_new_owner(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as first:
        abandoned = await _writer(state, first)
        await abandoned.write(b"x" * MAX_CHUNK_BYTES)
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as second:
        current = await _save(state, second)
        assert state.store.manifests.find_one({"_id": abandoned.checkpoint_id}) is None
        assert state.store.manifests.count_documents({}) == 1
        assert await state.store.latest(state.identity) == current


async def test_chunk_and_completion_bounds_fail_before_publication(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        writer = await _writer(state, lease)
        with pytest.raises(CheckpointError):
            await writer.write(b"x" * (MAX_CHUNK_BYTES + 1))
        await writer.write(b"valid")
        with pytest.raises(CheckpointError):
            await writer.commit({**_completion(b"valid"), "members": 20_001})
        assert await state.store.latest(state.identity) is None


async def test_clear_immediately_after_atomic_rebind_does_not_need_binding_save(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        saved = await _save(state, lease)
        replacement = {**state.allocation, "uid": "replacement-uid"}
        await _restore(state, saved, replacement, lease)
        # Provider deletion uses this effective UID. Cleanup then restores raw
        # original coordinates for the final immutable binding CAS reset.
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id)["allocation"]["uid"] == "replacement-uid"
        await state.store.cleanup(state.agent.id, state.session_id, state.identity.owner_subject, lease)
        original = get_sandbox_binding(state.mongo, state.agent.id, state.session_id)
        assert original["allocation"]["uid"] == "original-uid"
        reset_sandbox_binding(state.mongo, state.agent.id, state.session_id, original)
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) is None


async def test_late_orphans_are_swept_without_session_reuse_and_ids_retire(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        writer = await _writer(state, lease)
        await writer.write(b"partial state")
        await state.store.cleanup(state.agent.id, state.session_id, state.identity.owner_subject, lease)
        # A command sent before the clear fence can finish afterward. Only
        # its owned deletion coordinate is retained, never its manifest.
        state.db[f"{CHECKPOINT_BUCKET}.chunks"].insert_one({"files_id": writer.stream._id, "n": 0, "data": b"late chunk"})
        assert await state.store.sweep_orphans() == 1
        assert state.store.cleanup_records.count_documents({}) == 1
        state.store.cleanup_records.update_many({}, {"$set": {"retire_after": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        await state.store.sweep_orphans()
        assert state.store.cleanup_records.count_documents({}) == 0
        assert state.store.manifests.count_documents({}) == 0
        await writer.abort()


async def test_restore_intent_survives_worker_loss_without_exposing_pending_uid(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as first:
        saved = await _save(state, first)
        intent = await state.store.begin_restore(state.identity, checkpoint_id=saved.checkpoint_id, lease_id=first)
        assert intent["allocation"] is None
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as second:
        recovered = await state.store.begin_restore(state.identity, checkpoint_id=saved.checkpoint_id, lease_id=second)
        assert recovered["restore_id"] == intent["restore_id"]
        replacement = {**state.allocation, "uid": "replacement-uid"}
        await state.store.record_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
            restore_id=intent["restore_id"], allocation=replacement, lease_id=second)
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id)["allocation"]["uid"] == "original-uid"
        with pytest.raises(CheckpointFenceError):
            await state.store.replace_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
                restore_id=intent["restore_id"], allocation=replacement, lease_id=first)
        with pytest.raises(CheckpointFenceError):
            await _writer(state, second)
        result = await state.store.replace_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
            restore_id=intent["restore_id"], allocation={**replacement, "resource_version": "after-restore"}, lease_id=second)
        assert result["allocation"]["uid"] == "replacement-uid" and result["checkpoint_phase"] == "active"
        assert await state.store.restore_intent(state.identity) is None


async def test_restore_requires_recorded_destination_and_rejects_another_uid(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        saved = await _save(state, lease)
        intent = await state.store.begin_restore(state.identity, checkpoint_id=saved.checkpoint_id, lease_id=lease)
        replacement = {**state.allocation, "uid": "replacement-uid"}
        with pytest.raises(CheckpointFenceError):
            await state.store.replace_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
                restore_id=intent["restore_id"], allocation=replacement, lease_id=lease)
        await state.store.record_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
            restore_id=intent["restore_id"], allocation=replacement, lease_id=lease)
        with pytest.raises(CheckpointFenceError):
            await state.store.record_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
                restore_id=intent["restore_id"], allocation={**replacement, "uid": "unrelated-uid"}, lease_id=lease)
        assert (await state.store.restore_intent(state.identity))["allocation"]["uid"] == "replacement-uid"
        await state.store.cleanup(state.agent.id, state.session_id, state.identity.owner_subject, lease)
        assert await state.store.restore_intent(state.identity) is None


async def test_idle_checkpoint_authority_preserves_normal_run_finishing(checkpoint_state):
    state = checkpoint_state
    repository = NativeRunRepository(state.mongo)
    await repository.initialize()
    run, _ = await repository.create(owner_subject=state.identity.owner_subject, agent_id=state.agent.id,
        session_id=state.session_id, turn_id="finishing-turn", fingerprint="fixture", protocol="custom")
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        await repository.bind_lease(run.run_id, lease)
        writer = await state.store.open_writer(state.identity, checkpoint_id=str(uuid4()), lease_id=lease,
            base_metadata={**state.base, "run_id": run.run_id, "journal_cursor": 0})
        await writer.write(b"native checkpoint")
        await writer.commit(_completion(b"native checkpoint"))
        await repository.prepare_finish(run.run_id)
    observed = await repository.get(run.run_id, owner_subject=state.identity.owner_subject)
    assert observed.status == "running" and observed.finishing is True
    assert (await repository.finish(run.run_id, "completed")).status == "completed"


async def test_global_sweep_reaps_crashed_upload_intent_without_session_reuse(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        writer = await _writer(state, lease)
        await writer.write(b"x" * MAX_CHUNK_BYTES)
    state.store.manifests.update_one({"_id": writer.checkpoint_id}, {"$set": {
        "created_at": datetime.now(timezone.utc) - timedelta(minutes=2)}})
    assert await state.store.sweep_orphans() >= 1
    assert state.store.manifests.count_documents({}) == 0
    assert state.db[f"{CHECKPOINT_BUCKET}.chunks"].count_documents({}) == 0
    await writer.abort()


async def test_permanent_fence_allows_only_owned_lease_pending_cleanup(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        saved = await _save(state, lease)
        intent = await state.store.begin_restore(state.identity, checkpoint_id=saved.checkpoint_id, lease_id=lease)
        state.db["native_acp_deleted_sessions"].insert_one({"_id": state.session_id})
        with pytest.raises(CheckpointFenceError):
            await state.store.restore_intent(state.identity)
        with pytest.raises(CheckpointFenceError):
            await state.store.restore_intent_for_cleanup(state.identity, "unowned-lease")
        assert (await state.store.restore_intent_for_cleanup(state.identity, lease))["restore_id"] == intent["restore_id"]
        await state.store.cleanup(state.agent.id, state.session_id, state.identity.owner_subject, lease)
        assert state.store.manifests.count_documents({}) == 0


async def test_lost_head_commit_ack_never_deletes_published_payload(checkpoint_state, monkeypatch):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        writer = await _writer(state, lease)
        await writer.write(b"completed native state")
        original = state.store.runs.update_one

        def lost_ack(query, update, *args, **kwargs):
            result = original(query, update, *args, **kwargs)
            if "checkpoint_head" in update.get("$set", {}):
                raise NetworkTimeout("simulated lost write acknowledgement")
            return result

        monkeypatch.setattr(state.store.runs, "update_one", lost_ack)
        with pytest.raises(CheckpointError):
            await writer.commit(_completion(b"completed native state"))
        await writer.abort()
        recovered = await state.store.latest(state.identity)
        assert recovered.checkpoint_id == writer.checkpoint_id
        assert b"".join([chunk async for chunk in state.store.download(state.identity, recovered)]) == b"completed native state"


async def test_unapplied_uncertain_publication_is_reconciled_without_harming_prior_head(checkpoint_state, monkeypatch):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as lease:
        prior = await _save(state, lease)
        writer = await _writer(state, lease)
        await writer.write(b"unpublished native state")
        original = state.store.runs.update_one

        def lost_write(query, update, *args, **kwargs):
            if "checkpoint_head" in update.get("$set", {}):
                raise NetworkTimeout("simulated uncertain write")
            return original(query, update, *args, **kwargs)

        monkeypatch.setattr(state.store.runs, "update_one", lost_write)
        with pytest.raises(CheckpointError):
            await writer.commit(_completion(b"unpublished native state"))
        assert await state.store.latest(state.identity) == prior
    expired = datetime.now(timezone.utc) - timedelta(minutes=2)
    state.store.manifests.update_one({"_id": writer.checkpoint_id}, {"$set": {"created_at": expired, "publication_started_at": expired}})
    await state.store.sweep_orphans()
    assert state.store.manifests.find_one({"_id": writer.checkpoint_id}) is None
    assert await state.store.latest(state.identity) == prior


async def test_lost_pending_destination_can_be_restaged_without_accepting_old_receipt(checkpoint_state):
    state = checkpoint_state
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as first:
        saved = await _save(state, first)
        intent = await state.store.begin_restore(state.identity, checkpoint_id=saved.checkpoint_id, lease_id=first)
        missing = {**state.allocation, "uid": "missing-cache"}
        await state.store.record_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
            restore_id=intent["restore_id"], allocation=missing, lease_id=first)
    async with native_session_run(state.mongo, state.agent.id, state.session_id) as second:
        current = {**state.allocation, "uid": "replacement-cache"}
        restaged = await state.store.restage_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
            restore_id=intent["restore_id"], expected_allocation=missing, new_allocation=current, lease_id=second)
        assert restaged["restore_id"] == intent["restore_id"]
        assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id)["allocation"]["uid"] == "original-uid"
        with pytest.raises(CheckpointFenceError):
            await state.store.replace_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
                restore_id=intent["restore_id"], allocation=missing, lease_id=second)
        with pytest.raises(CheckpointFenceError):
            await state.store.restage_restore_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
                restore_id=intent["restore_id"], expected_allocation=missing, new_allocation=current, lease_id=second)
        replaced = await state.store.replace_allocation(state.identity, checkpoint_id=saved.checkpoint_id,
            restore_id=intent["restore_id"], allocation=current, lease_id=second)
        assert replaced["allocation"]["uid"] == "replacement-cache"

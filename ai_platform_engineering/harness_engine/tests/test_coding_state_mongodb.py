"""Real MongoDB exercises fencing, GridFS integrity and scoped human decisions."""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from harness_engine.coding.acp_client import HarnessPendingInput, InputRequired
from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.attachments import CodingAttachments, UploadAttachment
from harness_engine.coding.inputs import CodingInputs, SubmitCodingInput
from harness_engine.coding.state import ProviderStateError, ProviderStateStore
from harness_engine.coding.state_protocol import STATE_EXCLUDED_PATHS, NativeStateExport

pytest_plugins = ["tests.coding_fixtures"]


def exported(profile, allocation, raw=b"opaque-native-state", *, complete_sha=None, before_chunk=None):
    checkpoint = str(uuid4())
    sha = hashlib.sha256(raw).hexdigest()
    header = {
        "type": "header",
        "checkpoint_id": checkpoint,
        "format": "caipe.native-state.v1",
        "archive": "pax-tar",
        "profile_id": profile.id,
        "profile_revision": profile.revision,
        "harness": "claude-code",
        "provider_session_id": "provider-primary",
        "cwd": allocation.cwd,
        "sha256": sha,
        "bytes": len(raw),
        "runtime_versions": {"claude-code": "qualified"},
        "excluded_paths": STATE_EXCLUDED_PATHS,
    }

    async def frames():
        yield {"type": "chunk", "data": base64.b64encode(raw).decode()}
        if before_chunk:
            before_chunk()
        yield {**header, "type": "complete", "members": 1, "expanded_bytes": len(raw), "sha256": complete_sha or sha}

    return NativeStateExport(header, frames())


async def test_native_bytes_publish_only_to_live_engine_session_head(coding_scope):
    db, context, profile, allocation = coding_scope
    store = ProviderStateStore(RunFence(db, context), connection="https://sandbox.example.test", profile=profile)
    pending = await store.pin_new(allocation, "provider-primary")
    head = await store.capture(pending, allocation, exported(profile, allocation), outcome="completed")
    manifest = await store.manifest(head)
    assert b"".join([chunk async for chunk in store.chunks(manifest)]) == b"opaque-native-state"
    assert db.harness_sessions.find_one()["_provider_state_head"] == head
    assert db.harness_runs.count_documents({}) == 1
    assert db.harness_events.count_documents({}) == 0  # Only the existing coordinator writes the journal.
    db.harness_sessions.update_one({}, {"$unset": {"_active_run_id": "", "_producer_id": "", "_lease_expires_at": ""}})
    assert db.harness_sessions.find_one()["_provider_state_head"] == head


async def test_stale_capture_cannot_replace_the_previous_head(coding_scope):
    db, context, profile, allocation = coding_scope
    store = ProviderStateStore(RunFence(db, context), connection="https://sandbox.example.test", profile=profile)
    pending = await store.pin_new(allocation, "provider-primary")
    head = await store.capture(pending, allocation, exported(profile, allocation), outcome="completed")

    def lose_owner():
        db.harness_sessions.update_one({}, {"$set": {"_producer_id": "producer-secondary"}})

    with pytest.raises(CodingAdmissionError):
        await store.capture(
            head, allocation, exported(profile, allocation, b"later", before_chunk=lose_owner), outcome="completed"
        )
    assert db.harness_sessions.find_one()["_provider_state_head"] == head
    assert db.harness_provider_checkpoints.count_documents({}) == 1


async def test_incomplete_archive_never_becomes_durable_completion(coding_scope):
    db, context, profile, allocation = coding_scope
    store = ProviderStateStore(RunFence(db, context), connection="https://sandbox.example.test", profile=profile)
    pending = await store.pin_new(allocation, "provider-primary")
    with pytest.raises(ValueError):
        await store.capture(
            pending, allocation, exported(profile, allocation, complete_sha="0" * 64), outcome="completed"
        )
    assert db.harness_sessions.find_one()["_provider_state_head"] == pending
    assert db.harness_provider_checkpoints.count_documents({}) == 0


async def test_changed_profile_or_missing_manifest_never_starts_empty_session(coding_scope):
    db, context, profile, allocation = coding_scope
    store = ProviderStateStore(RunFence(db, context), connection="https://sandbox.example.test", profile=profile)
    head = await store.pin_new(allocation, "provider-primary")
    with pytest.raises(ProviderStateError, match="not been acknowledged"):
        await store.manifest(head)
    other = ProviderStateStore(RunFence(db, context), connection="https://other.example.test", profile=profile)
    with pytest.raises(ProviderStateError, match="connection"):
        await other.head()


async def test_canonical_attachment_is_opaque_scoped_and_integrity_checked(coding_scope):
    db, context, _, _ = coding_scope
    attachments = CodingAttachments(db)
    request = UploadAttachment(
        agent_id=context.binding.agent_id,
        conversation_id=context.binding.conversation_id,
        expected_harness_id="claude_code_acp",
        name="example.txt",
        media_type="text/plain",
        data=base64.b64encode(b"Private example").decode(),
    )
    reference = await attachments.upload(context.binding.owner_subject, request)
    assert await attachments.upload(context.binding.owner_subject, request) == reference
    resolved = await attachments.resolve(RunFence(db, context), [reference])
    assert base64.b64decode(resolved[0].data) == b"Private example"
    changed = reference.model_copy(update={"sha256": "0" * 64})
    with pytest.raises(CodingAdmissionError):
        await attachments.resolve(RunFence(db, context), [changed])
    db.harness_gateway_bindings.update_one({}, {"$set": {"owner_subject": "user-secondary"}})
    with pytest.raises(CodingAdmissionError):
        await attachments.upload(context.binding.owner_subject, request)


async def test_pending_answer_is_idempotent_bound_and_never_changes_run_owner(coding_scope):
    db, context, _, _ = coding_scope
    inputs = CodingInputs(RunFence(db, context))
    pending = HarnessPendingInput(
        interrupt_id="input-primary",
        session_id="provider-primary",
        method="session/request_permission",
        request={"options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}]},
        event=InputRequired(
            interrupt_id="input-primary", interrupt_type="form_input", prompt="Review", fields=[], agent="Example"
        ),
    )
    await inputs.persist(pending)
    db.harness_runs.update_one({}, {"$set": {"status": "awaiting_input", "pending_interrupt_id": "input-primary"}})
    decision = {"type": "form_input", "interrupt_id": "input-primary", "values": {"option_id": "allow"}}
    request = SubmitCodingInput(client_request_id="decision-primary", decision=decision)
    run, cursor = await inputs.submit(request)
    assert run.run_id == context.turn.run_id and cursor == 1
    assert (await inputs.submit(request))[1] == cursor
    assert await inputs.wait(pending) == {"outcome": {"outcome": "selected", "optionId": "allow"}}
    assert db.harness_runs.count_documents({}) == 1
    with pytest.raises(CodingAdmissionError, match="different input"):
        await inputs.submit(request.model_copy(update={"decision": {**decision, "values": {"option_id": "reject"}}}))


@pytest.mark.parametrize(
    "change",
    [
        {"owner_subject": "user-secondary"},
        {"owner_id": "other@example.test"},
        {"participants": [{"type": "agent", "id": "agent-secondary"}]},
        {"deleted_at": datetime.now(timezone.utc)},
    ],
)
async def test_upload_does_not_trust_retained_route_after_canonical_changes(coding_scope, change):
    db, context, _, _ = coding_scope
    db.conversations.update_one({}, {"$set": change})
    with pytest.raises(CodingAdmissionError):
        await CodingAttachments(db).upload(
            context.binding.owner_subject,
            UploadAttachment(
                agent_id=context.binding.agent_id,
                conversation_id=context.binding.conversation_id,
                expected_harness_id="claude_code_acp",
                name="example.txt",
                media_type="text/plain",
                data="ZXhhbXBsZQ==",
            ),
        )
    assert db["harness_attachments.files"].count_documents({}) == 0


async def test_upload_rechecks_canonical_identity_after_gridfs_io(coding_scope, monkeypatch):
    db, context, _, _ = coding_scope
    store = CodingAttachments(db)
    original = store.bucket.upload_from_stream_with_id

    def write_then_delete(*args, **kwargs):
        result = original(*args, **kwargs)
        db.conversations.update_one({}, {"$set": {"deleted_at": datetime.now(timezone.utc)}})
        return result

    monkeypatch.setattr(store.bucket, "upload_from_stream_with_id", write_then_delete)
    with pytest.raises(CodingAdmissionError):
        await store.upload(
            context.binding.owner_subject,
            UploadAttachment(
                agent_id=context.binding.agent_id,
                conversation_id=context.binding.conversation_id,
                expected_harness_id="claude_code_acp",
                name="example.txt",
                media_type="text/plain",
                data="ZXhhbXBsZQ==",
            ),
        )
    assert db["harness_attachments.files"].count_documents({}) == 0


async def test_optional_attachment_hash_uses_canonical_digest(coding_scope):
    db, context, _, _ = coding_scope
    store = CodingAttachments(db)
    ref = await store.upload(
        context.binding.owner_subject,
        UploadAttachment(
            agent_id=context.binding.agent_id,
            conversation_id=context.binding.conversation_id,
            expected_harness_id="claude_code_acp",
            name="example.txt",
            media_type="text/plain",
            data="ZXhhbXBsZQ==",
        ),
    )
    files = await store.resolve(RunFence(db, context), [ref.model_copy(update={"sha256": None})])
    assert base64.b64decode(files[0].data) == b"example"


async def test_operator_profile_changes_cannot_reuse_canonical_native_head(coding_scope):
    db, context, profile, allocation = coding_scope
    initial = ProviderStateStore(
        RunFence(db, context),
        connection="https://sandbox.example.test",
        profile=profile,
        operator_profile={
            "model": "approved-primary",
            "permission_mode": "default",
            "git": {"repositories": ["example/primary"]},
        },
    )
    await initial.pin_new(allocation, "provider-primary")
    changed = ProviderStateStore(
        RunFence(db, context),
        connection="https://sandbox.example.test",
        profile=profile,
        operator_profile={
            "model": "approved-secondary",
            "permission_mode": "default",
            "git": {"repositories": ["example/*"]},
        },
    )
    with pytest.raises(ProviderStateError, match="pinned profile changed"):
        await changed.head()

"""Opaque native-state streaming, identity and acknowledgement boundaries."""

from __future__ import annotations

import base64
import hashlib
import json
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from dynamic_agents.services.native_state_protocol import (
    MAX_STATE_CHUNK,
    MAX_STATE_LINE,
    STATE_ARCHIVE,
    STATE_CONTRACT,
    STATE_EXCLUDED_PATHS,
    STATE_FORMAT,
    NativeStateExport,
    NativeStateProtocolError,
    state_frames,
    state_line,
    validate_state_header,
)
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxError, SandboxProfile
from tests.test_sandbox_client import PROFILE, _allocation, _client


def descriptors(raw: bytes = b"opaque native HOME and session bytes") -> tuple[dict, dict]:
    header = {"type": "header", "format": STATE_FORMAT, "archive": STATE_ARCHIVE, "checkpoint_id": str(uuid4()),
        "profile_id": PROFILE["id"], "profile_revision": PROFILE["revision"], "harness": "claude-code",
        "provider_session_id": "native-session", "cwd": "/workspace", "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw), "excluded_paths": STATE_EXCLUDED_PATHS, "runtime_versions": {"adapter": "1.0", "sdk": "2.0"}}
    return header, {**header, "type": "complete", "members": 3, "expanded_bytes": len(raw)}


def archive(raw: bytes, header: dict, complete: dict) -> bytes:
    return b"\n" + state_line(header) + state_line({"type": "chunk", "data": base64.b64encode(raw).decode()}) + state_line(complete)


async def _bytes(*values):
    for value in values:
        yield value


async def _decode(raw: bytes) -> tuple[bytes, NativeStateExport]:
    frames = state_frames(_bytes(*(raw[pos:pos + 7] for pos in range(0, len(raw), 7))))
    header = validate_state_header(await anext(frames), {})
    exported = NativeStateExport(header, frames)
    content = b"".join([chunk async for chunk in exported.chunks()])
    return content, exported


async def test_fragmented_stream_blank_keepalives_and_complete_integrity():
    raw = b"opaque\x00archive\xffbytes"
    header, complete = descriptors(raw)
    content, exported = await _decode(archive(raw, header, complete))
    assert content == raw and exported.complete == complete


@pytest.mark.parametrize("mutation", ["digest", "size", "incomplete", "trailing", "wrong-profile", "exclusions", "versions"])
async def test_incomplete_changed_and_unqualified_archives_fail_closed(mutation):
    raw = b"opaque"
    header, complete = descriptors(raw)
    if mutation == "digest":
        header["sha256"] = complete["sha256"] = "0" * 64
    if mutation == "size":
        header["bytes"] = complete["bytes"] = len(raw) + 1
    if mutation == "wrong-profile":
        complete["profile_revision"] = "changed"
    if mutation == "exclusions":
        header["excluded_paths"] = [".claude"]
    if mutation == "versions":
        header["runtime_versions"] = {}
    value = archive(raw, header, complete)
    if mutation == "incomplete":
        value = value[:value.rfind(b'{"type":"complete"')]
    if mutation == "trailing":
        value += state_line({"type": "chunk", "data": "eA=="})
    with pytest.raises(NativeStateProtocolError):
        await _decode(value)


@pytest.mark.parametrize("raw", [b"x" * (MAX_STATE_LINE + 1), b"[]\n", b"{\xff}\n", b'{}'])
async def test_frame_decoding_is_bounded_before_json_or_utf8(raw):
    with pytest.raises(NativeStateProtocolError):
        _ = [frame async for frame in state_frames(_bytes(raw))]


async def test_oversized_decoded_chunk_rejected():
    raw = b"x" * (MAX_STATE_CHUNK + 1)
    header, complete = descriptors(raw)
    with pytest.raises(NativeStateProtocolError):
        await _decode(archive(raw, header, complete))


@pytest.mark.parametrize("changes", [{"harness": "codex"}, {"state_contract": None}, {"state_contract": {**STATE_CONTRACT, "max_bytes": 1}},
    {"state_contract": {**STATE_CONTRACT, "excluded_paths": [".claude"]}}])
def test_only_qualified_claude_profiles_admitted(changes):
    with pytest.raises(ValidationError):
        SandboxProfile.model_validate({**PROFILE, **changes})


async def test_export_retries_only_quiescence_conflict_and_streams_exact_bound_archive(monkeypatch):
    raw = b"opaque native archive"
    header, complete = descriptors(raw)
    requests = []

    def handle(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(409)
        assert json.loads(request.content) == {"conversation_id": _allocation()["conversation_id"], "uid": "example-uid",
            "checkpoint_id": header["checkpoint_id"], "provider_session_id": "native-session"}
        return httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content=archive(raw, header, complete))

    client = _client(monkeypatch, handle)
    async with client.export_state(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE),
            checkpoint_id=header["checkpoint_id"], provider_session_id="native-session") as exported:
        assert b"".join([chunk async for chunk in exported.chunks()]) == raw
    assert len(requests) == 2
    assert all(request.url.path.endswith("/state/export") for request in requests)


@pytest.mark.parametrize("status", [302, 401, 403, 404, 503])
async def test_export_auth_failures_and_redirects_do_not_expose_or_fallback(monkeypatch, status):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(status, text="private diagnostic", headers={"Location": "https://evil.example.test"})

    client = _client(monkeypatch, handle)
    with pytest.raises(SandboxError) as failure:
        async with client.export_state(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE),
                checkpoint_id=str(uuid4()), provider_session_id="native-session"):
            pytest.fail("Invalid export was admitted")
    assert "private diagnostic" not in str(failure.value) and len(requests) == 1


async def test_lost_restore_ack_queries_exact_receipt_without_reupload_or_agent_rpc(monkeypatch):
    raw = b"native snapshot"
    header, complete = descriptors(raw)
    restore_id = str(uuid4())
    requests = []

    def handle(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer example-bearer"
        assert "cookie" not in request.headers
        if request.method == "POST":
            frames = [json.loads(line) for line in request.content.splitlines()]
            assert frames[0] == {**header, "conversation_id": _allocation()["conversation_id"], "uid": "example-uid", "restore_id": restore_id}
            assert frames[-1]["sha256"] == header["sha256"]
            raise httpx.ReadError("private lost acknowledgement")
        assert request.url.params["restore_id"] == restore_id
        assert request.url.params["sha256"] == header["sha256"]
        return httpx.Response(200, json={**complete, "restore_id": restore_id, "status": "restored"})

    client = _client(monkeypatch, handle)
    result = await client.restore_state(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE),
        header=header, complete=complete, chunks=lambda: _bytes(raw), restore_id=restore_id)
    assert result["status"] == "restored" and [r.method for r in requests] == ["POST", "GET"]


async def test_uncertain_restore_retries_same_id_but_new_hydration_uses_new_id(monkeypatch):
    raw = b"native snapshot"
    header, complete = descriptors(raw)
    ids = []

    def handle(request):
        if request.method == "GET":
            return httpx.Response(404)
        frames = [json.loads(line) for line in request.content.splitlines()]
        ids.append(frames[0]["restore_id"])
        if len(ids) == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={**complete, "restore_id": ids[-1], "status": "restored"})

    client = _client(monkeypatch, handle)
    first_id, second_id = str(uuid4()), str(uuid4())
    for restore_id in (first_id, second_id):
        await client.restore_state(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE),
            header=header, complete=complete, chunks=lambda: _bytes(raw), restore_id=restore_id)
    assert ids == [first_id, first_id, second_id]


@pytest.mark.parametrize("receipt_change", [{"sha256": "0" * 64}, {"restore_id": str(uuid4())}, {"provider_session_id": "other"}, {"runtime_versions": {"sdk": "other"}}, {"profile_id": "other"}, {"archive": "other"}, {"harness": "other"}, {"cwd": "/other"}])
async def test_restore_requires_exact_verified_receipt(monkeypatch, receipt_change):
    raw = b"native snapshot"
    header, complete = descriptors(raw)
    restore_id = str(uuid4())
    client = _client(monkeypatch, lambda request: httpx.Response(200, json={**complete, "restore_id": restore_id, "status": "restored", **receipt_change}))
    with pytest.raises(SandboxError, match="receipt"):
        await client.restore_state(SandboxAllocation.model_validate(_allocation()), SandboxProfile.model_validate(PROFILE),
            header=header, complete=complete, chunks=lambda: _bytes(raw), restore_id=restore_id)

"""Sandbox artifacts use canonical GridFS with explicit bounds and privacy checks."""

from __future__ import annotations

import base64
import hashlib
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import pytest
from deepagents.backends.utils import create_file_data

from dynamic_agents.models import AgentExecutionConfig
from dynamic_agents.services import harness_workspace
from dynamic_agents.services.builtin_tools import create_format_file_tool
from dynamic_agents.services.harness_workspace import HarnessWorkspaceBridge
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxClient, SandboxError
from tests.test_native_acp_mongodb import native_database as native_database


class WorkspacePeer:
    def __init__(self, files: dict[str, str | bytes] | None = None, *, truncated: bool = False) -> None:
        self.files = files or {}
        self.truncated = truncated
        self.requests: list[tuple[str, str, dict | None]] = []
        self.denied: set[str] = set()

    async def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        self.requests.append((method, path, body))
        if method == "PUT":
            self.files[body["path"]] = body["content"]
            return {"path": body["path"], "bytes": len(body["content"].encode())}
        if "/files?" in path:
            return {"files": list(self.files), "truncated": self.truncated}
        relative = parse_qs(urlsplit(path).query)["path"][0]
        if relative in self.denied:
            raise SandboxError("The sandbox artifact is not a regular file")
        if parse_qs(urlsplit(path).query).get("encoding") == ["base64"]:
            raw = self.files[relative]
            data = raw.encode() if isinstance(raw, str) else raw
            return {"path": relative, "content": base64.b64encode(data).decode(), "encoding": "base64",
                    "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        return {"path": relative, "content": self.files[relative]}


def bridge(state: SimpleNamespace, peer: WorkspacePeer) -> HarnessWorkspaceBridge:
    agent = state.agent.model_copy(update={"backend": None, "execution": AgentExecutionConfig(kind="sandbox", profile_id="primary")}, deep=True)
    allocation = SandboxAllocation(id="primary", uid="original-uid", namespace="primary",
        conversation_id=SandboxClient.conversation_reference(agent.id, state.session_id), profile_id="primary", revision="v1", cwd="/workspace", state="Ready")
    return HarnessWorkspaceBridge(state.mongo, agent, state.session_id, peer, allocation)


@pytest.fixture(autouse=True)
def public_context(monkeypatch: pytest.MonkeyPatch, native_database: SimpleNamespace) -> AsyncMock:
    privacy = AsyncMock(return_value=(native_database.agent.id, native_database.session_id, "filesystem"))
    monkeypatch.setattr(harness_workspace, "require_harness_workspace", privacy)
    return privacy


async def test_workflow_inputs_snapshot_is_scoped_and_seeded_in_one_managed_map(native_database: SimpleNamespace, public_context: AsyncMock) -> None:
    peer = WorkspacePeer()
    value = bridge(native_database, peer)
    value.store.put(value.namespace, "/workflow/input.txt", create_file_data("Example workflow input"))
    value.store.put(value.namespace, "/skills/primary/SKILL.md", create_file_data("Managed instructions"))
    value.store.put(value.namespace, "/.env", create_file_data("private"))
    value.store.put(("other-agent", "other-conversation", "filesystem"), "/foreign.txt", create_file_data("foreign"))
    assert await value.seed_inputs() == {"inputs/workflow/input.txt": "Example workflow input"}
    assert public_context.await_count == 2
    assert peer.requests == []  # The runtime merges this map with instructions in one prepare call.


async def test_revoked_workspace_after_snapshot_blocks_input_delivery(native_database: SimpleNamespace, public_context: AsyncMock) -> None:
    peer = WorkspacePeer()
    value = bridge(native_database, peer)
    value.store.put(value.namespace, "/input.txt", create_file_data("Example"))
    public_context.side_effect = [public_context.return_value, SandboxError("workspace admission was revoked")]
    with pytest.raises(SandboxError, match="workspace admission"):
        await value.seed_inputs()
    assert peer.requests == []


async def test_large_native_input_is_rejected_before_reading_its_gridfs_payload(native_database: SimpleNamespace, public_context: AsyncMock, monkeypatch: pytest.MonkeyPatch) -> None:
    value = bridge(native_database, WorkspacePeer())
    value.namespace = ("example-workflow", "example-run", "filesystem")
    public_context.return_value = value.namespace
    value.store.put(value.namespace, "/oversized.txt", create_file_data("x" * (harness_workspace.MAX_STORED_INPUT_BYTES + 1)))
    original = value.store.get
    calls: list[str] = []

    def get(namespace: tuple, key: str) -> Any:
        calls.append(key)
        return original(namespace, key)

    monkeypatch.setattr(value.store, "get", get)
    with pytest.raises(SandboxError, match="supported size"):
        await value.seed_inputs()
    assert calls == []


async def test_completed_export_retains_unrelated_files_and_excludes_managed_private_and_nonregular_paths(native_database: SimpleNamespace) -> None:
    peer = WorkspacePeer({"report.txt": "Completed report", "AGENTS.md": "instructions", "inputs/input.txt": "input", "../outside.txt": "outside", ".env": "private", "link.txt": "symlink", "binary.txt": "\x00"})
    peer.denied.add("link.txt")
    value = bridge(native_database, peer)
    value.store.put(value.namespace, "/keep.txt", create_file_data("Retain this file"))
    warnings = await value.publish()
    assert value.store.get(value.namespace, "/report.txt").value["content"] == "Completed report"
    assert value.store.get(value.namespace, "/keep.txt").value["content"] == "Retain this file"
    assert value.store.get(value.namespace, "/binary.txt").value["encoding"] == "base64"
    for path in ("/AGENTS.md", "/inputs/input.txt", "/outside.txt", "/.env", "/link.txt"):
        assert value.store.get(value.namespace, path) is None
    assert warnings
    assert not any("../outside.txt" in request[1] or "path=.env" in request[1] for request in peer.requests)


async def test_export_limits_and_truncated_listing_are_visible(native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    peer = WorkspacePeer({"first.txt": "1234", "second.txt": "5678", "third.txt": "abcd"}, truncated=True)
    value = bridge(native_database, peer)
    monkeypatch.setattr(harness_workspace, "MAX_EXPORT_BYTES", 7)
    warnings = await value.publish()
    assert any("truncated" in message for message in warnings)
    assert any("byte limit" in message for message in warnings)
    assert value.store.get(value.namespace, "/first.txt") is not None
    assert value.store.get(value.namespace, "/second.txt") is None
    assert value.store.get(value.namespace, "/third.txt") is None


@pytest.mark.parametrize("relative", ["reports/source.json", "workspace/source.json"])
async def test_actual_formatter_imports_exact_path_then_copies_only_new_output_to_sandbox(native_database: SimpleNamespace, relative: str) -> None:
    content = json.dumps({"values": list(range(500))}, separators=(",", ":"))
    peer = WorkspacePeer({relative: content})
    value = bridge(native_database, peer)
    arguments = {"file_path": f"/workspace/{relative}"}
    await value.before_tool("format_file", arguments)
    assert arguments == {"file_path": f"/{relative}"}
    tool = create_format_file_tool(value.store, lambda: value.namespace)
    result = await tool.ainvoke(arguments)
    await value.after_tool("format_file", arguments, result)
    assert "Created formatted file" in result
    assert f"{relative}_formatted.json" in peer.files
    assert json.loads(peer.files[f"{relative}_formatted.json"]) == json.loads(content)
    assert value.store.get(value.namespace, f"/{relative}_formatted.json") is not None


async def test_formatter_noop_never_uploads_a_stale_prior_derived_artifact(native_database: SimpleNamespace) -> None:
    peer = WorkspacePeer({"source.txt": "Short content"})
    value = bridge(native_database, peer)
    value.store.put(value.namespace, "/source.txt_formatted", create_file_data("Stale output"))
    arguments = {"file_path": "/workspace/source.txt"}
    await value.before_tool("format_file", arguments)
    tool = create_format_file_tool(value.store, lambda: value.namespace)
    result = await tool.ainvoke(arguments)
    await value.after_tool("format_file", arguments, result)
    assert not any(method == "PUT" for method, _path, _body in peer.requests)


async def test_after_format_snapshot_rechecks_workspace_admission_before_remote_write(native_database: SimpleNamespace, public_context: AsyncMock) -> None:
    peer = WorkspacePeer({"source.txt": "Example"})
    value = bridge(native_database, peer)
    arguments = {"file_path": "/workspace/source.txt"}
    await value.before_tool("format_file", arguments)
    value.store.put(value.namespace, "/source.txt_formatted", create_file_data("New formatted output"))
    public_context.side_effect = [public_context.return_value, SandboxError("workspace admission was revoked")]
    with pytest.raises(SandboxError, match="workspace admission"):
        await value.after_tool("format_file", arguments, "ignored")
    assert not any(method == "PUT" for method, _path, _body in peer.requests)
    assert value.warnings


@pytest.mark.parametrize("path", ["../outside", "a/../outside", "/workspace/../outside", "/workspace/.ssh/key", "credentials/key", "/workspace/AGENTS.md"])
async def test_formatter_rejects_traversal_credentials_and_managed_files_before_portal_read(native_database: SimpleNamespace, path: str) -> None:
    peer = WorkspacePeer()
    value = bridge(native_database, peer)
    with pytest.raises(SandboxError):
        await value.before_tool("format_file", {"file_path": path})
    assert peer.requests == []



def test_allocation_and_namespace_must_match_the_admitted_conversation(native_database: SimpleNamespace) -> None:
    peer = WorkspacePeer()
    value = bridge(native_database, peer)
    with pytest.raises(SandboxError, match="admitted agent conversation"):
        HarnessWorkspaceBridge(native_database.mongo, value.agent, value.session_id, peer, value.allocation.model_copy(update={"conversation_id": "another-conversation"}))


async def test_binary_export_and_next_workflow_input_preserve_exact_bytes(native_database: SimpleNamespace) -> None:
    raw = b"PK\x03\x04\x00\xff\xfe\x80\x01" * 47
    peer = WorkspacePeer({"output/archive.zip": raw})
    value = bridge(native_database, peer)
    assert await value.publish() == []
    stored = value.store.get(value.namespace, "/output/archive.zip").value
    assert stored["encoding"] == "base64"
    assert base64.b64decode(stored["content"], validate=True) == raw
    assert await value.seed_inputs() == {"inputs/output/archive.zip": {
        "encoding": "base64", "content": base64.b64encode(raw).decode(),
    }}


async def test_binary_export_rejects_inconsistent_hash_before_gridfs_write(native_database: SimpleNamespace) -> None:
    peer = WorkspacePeer({"output.bin": b"\xff\x00"})
    original = peer._request

    async def corrupt(method: str, path: str, body: dict | None = None) -> dict:
        result = await original(method, path, body)
        if result.get("encoding") == "base64":
            result["sha256"] = "0" * 64
        return result

    peer._request = corrupt
    value = bridge(native_database, peer)
    assert await value.publish()
    assert value.store.get(value.namespace, "/output.bin") is None


async def test_oversized_required_binary_workflow_input_fails_before_provider_write(native_database: SimpleNamespace, public_context: AsyncMock) -> None:
    value = bridge(native_database, WorkspacePeer())
    value.namespace = ("example-workflow", "example-run", "filesystem")
    public_context.return_value = value.namespace
    value.store.put(value.namespace, "/output.bin", {"content": base64.b64encode(b"x" * (harness_workspace.MAX_INPUT_FILE_BYTES + 1)).decode(), "encoding": "base64"})
    with pytest.raises(SandboxError, match="supported size"):
        await value.seed_inputs()


async def test_generated_binary_above_input_copy_limit_does_not_block_next_conversation_turn(native_database: SimpleNamespace) -> None:
    raw = b"\xff\x00" * (150 * 1024)
    value = bridge(native_database, WorkspacePeer({"large.zip": raw}))
    assert await value.publish() == []
    assert await value.seed_inputs() == {}
    assert any("input-copy budget" in warning for warning in value.warnings)
    assert base64.b64decode(value.store.get(value.namespace, "/large.zip").value["content"]) == raw


async def test_large_optional_stored_record_is_not_read_and_does_not_block_continuation(native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    value = bridge(native_database, WorkspacePeer())
    value.store.put(value.namespace, "/large.txt", create_file_data("x" * harness_workspace.MAX_STORED_INPUT_BYTES))
    monkeypatch.setattr(value, "_stored_value", lambda _identifier: pytest.fail("Oversized optional records must not be read"))
    assert await value.seed_inputs() == {}
    assert any("input-copy budget" in warning for warning in value.warnings)


async def test_optional_scan_limit_is_visible_without_blocking_continuation(native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    value = bridge(native_database, WorkspacePeer())
    for index in range(3):
        value.store.put(value.namespace, f"/file-{index}.txt", create_file_data("example"))
    monkeypatch.setattr(harness_workspace, "MAX_SCANNED_INPUT_FILES", 2)
    assert len(await value.seed_inputs()) == 2
    assert any("scan reached its file limit" in warning for warning in value.warnings)

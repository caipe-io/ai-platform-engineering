"""Git admission, capability isolation and actual pack ancestry verification."""

from __future__ import annotations

import hashlib
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from harness_engine.coding import git_http
from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.config import GitPolicy
from harness_engine.coding.git_http import GitBroker, git_environment, parse_receive_pack
from harness_engine.coding.resources import PlatformResourceBroker
from harness_engine.config import Settings
from harness_engine.models import ToolBinding

pytest_plugins = ["tests.coding_fixtures"]


def policy(**values) -> GitPolicy:
    return GitPolicy(
        repositories=["example/*"],
        read_tool_ids=["server-primary.read"],
        write_tool_ids=["server-primary.write"],
        audit_service_url="https://audit.example.test",
        **values,
    )


def receive(old: str, new: str, ref: str, pack: bytes = b"PACK") -> bytes:
    command = f"{old} {new} {ref}\0report-status side-band-64k\n".encode()
    return f"{len(command) + 4:04x}".encode() + command + b"0000" + pack


def broker_for(scope, *, push=True):
    db, context, _, _ = scope
    context = context.model_copy(
        update={
            "blueprint": context.blueprint.model_copy(
                update={
                    "tools": context.blueprint.tools.model_copy(
                        update={
                            "bindings": [
                                ToolBinding(tool_id="server-primary.read"),
                                ToolBinding(tool_id="server-primary.write"),
                            ]
                        }
                    )
                }
            )
        }
    )
    db.dynamic_agents.update_one({}, {"$set": {"allowed_tools": {"server-primary": ["read", "write"]}}})
    db.mcp_servers.insert_one({"_id": "server-primary", "enabled": True})
    db.harness_runs.update_one({}, {"$set": {"_coding_capability_hash": hashlib.sha256(b"r" * 43).hexdigest()}})
    credentials = SimpleNamespace(
        token=AsyncMock(return_value="owner-bearer"),
        authorize_resource=AsyncMock(return_value="owner-bearer"),
        settings=SimpleNamespace(coding_platform_url="https://caipe.example.test"),
    )
    broker = GitBroker(policy(), RunFence(db, context), credentials)
    broker._provider_token = AsyncMock(return_value="provider-secret")
    broker._github = AsyncMock(
        return_value={
            "full_name": "example/repository",
            "permissions": {"pull": True, "push": push},
            "default_branch": "main",
        }
    )
    broker._audit = AsyncMock()
    return broker


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"zzzz",
        b"0001",
        b"0000PACK",
        receive("g" * 40, "a" * 40, "refs/heads/agent/test"),
        receive("a" * 40, "b" * 40, "refs/tags/test"),
    ],
)
def test_invalid_git_reference_frames_never_reach_write_admission(body):
    with pytest.raises(CodingAdmissionError):
        parse_receive_pack(body)


def test_receive_pack_preserves_exact_old_new_and_branch():
    commands, pack = parse_receive_pack(receive("a" * 40, "b" * 40, "refs/heads/agent/test", b"PACKbytes"))
    assert commands == [("a" * 40, "b" * 40, "refs/heads/agent/test")]
    assert pack == b"PACKbytes"


async def test_repository_capability_never_exposes_user_credentials_or_crosses_repository(coding_scope):
    broker = broker_for(coding_scope)
    value = await broker.mint("example/repository", "r" * 43)
    assert set(value) == {"username", "capability"} and value["username"] == "caipe"
    assert "provider-secret" not in str(value)
    await broker.validate_capability("example/repository", value["capability"], write=True)
    with pytest.raises(CodingAdmissionError):
        await broker.validate_capability("example/other", value["capability"], write=False)
    broker.fence.db.dynamic_agents.update_one({}, {"$set": {"allowed_tools": {}}})
    with pytest.raises(CodingAdmissionError, match="selected Git tools"):
        await broker.authorize_repository("example/repository", write=True)


async def test_read_permission_cannot_be_upgraded_by_asking_for_write(coding_scope):
    broker = broker_for(coding_scope, push=False)
    value = await broker.mint("example/repository", "r" * 43)
    await broker.validate_capability("example/repository", value["capability"], write=False)
    with pytest.raises(CodingAdmissionError):
        await broker.validate_capability("example/repository", value["capability"], write=True)


async def test_operator_destination_policy_precedes_credential_retrieval(coding_scope):
    broker = broker_for(coding_scope)
    with pytest.raises(CodingAdmissionError, match="operator Git policy"):
        await broker.authorize_repository("other/repository", write=False)
    broker._provider_token.assert_not_awaited()


def test_git_helper_is_bound_to_broker_host_and_contains_only_run_capability():
    env = git_environment("https://broker.example.test", "run-example", "opaque-run-capability")
    assert env["CAIPE_GIT_HOST"] == "broker.example.test"
    assert env["GIT_CONFIG_VALUE_0"] == "https://github.com/"
    assert "NoRedirect" in env["GIT_CONFIG_VALUE_1"]
    assert 'fields.get("host")' in env["GIT_CONFIG_VALUE_1"]
    assert "provider-secret" not in str(env)


async def test_default_and_protected_branch_policy_reject_before_pack_processing(coding_scope):
    broker = broker_for(coding_scope)
    broker.policy = policy(ref_prefixes=["refs/heads/"])
    with pytest.raises(CodingAdmissionError, match="default branch"):
        await broker.validate_write(
            "example/repository",
            receive("a" * 40, "b" * 40, "refs/heads/main"),
            "provider-secret",
            {"default_branch": "main"},
        )
    broker._github = AsyncMock(return_value={"protected": True})
    with pytest.raises(CodingAdmissionError, match="protected branches"):
        await broker.validate_write(
            "example/repository",
            receive("a" * 40, "b" * 40, "refs/heads/agent/test"),
            "provider-secret",
            {"default_branch": "main"},
        )


def git(directory: Path, *args: str, input: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=directory, input=input, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    ).stdout


async def test_real_git_pack_accepts_fast_forward_and_rejects_force_push(coding_scope, tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    git(source, "init", "-b", "main")
    git(source, "config", "user.name", "Example")
    git(source, "config", "user.email", "user@example.test")
    (source / "example.txt").write_text("base\n")
    git(source, "add", "example.txt")
    git(source, "commit", "-m", "initial")
    old = git(source, "rev-parse", "HEAD").decode().strip()
    remote = tmp_path / "remote.git"
    git(tmp_path, "clone", "--bare", str(source), str(remote))
    (source / "example.txt").write_text("base\nnext\n")
    git(source, "commit", "-am", "next")
    new = git(source, "rev-parse", "HEAD").decode().strip()
    pack = git(source, "pack-objects", "--revs", "--stdout", input=(new + "\n^" + old + "\n").encode())
    broker = broker_for(coding_scope)
    broker._github = AsyncMock(side_effect=[None, []])
    original = broker._run_git

    async def local_git(directory, *args, token, data=None):
        if args[0] == "fetch":
            args = ("-c", "protocol.file.allow=always", *args[:3], str(remote), *args[4:])
        return await original(directory, *args, token=token, data=data)

    monkeypatch.setattr(broker, "_run_git", local_git)
    refs = await broker.validate_write(
        "example/repository",
        receive(old, new, "refs/heads/agent/test", pack),
        "provider-secret",
        {"default_branch": "main"},
    )
    assert refs == ["refs/heads/agent/test"]
    # Reversing this relationship is a force push even though both objects are valid.
    broker._github = AsyncMock(side_effect=[None, []])
    with pytest.raises(CodingAdmissionError, match="Force pushes"):
        await broker.validate_write(
            "example/repository",
            receive(new, old, "refs/heads/agent/test", pack),
            "provider-secret",
            {"default_branch": "main"},
        )


async def test_accepted_git_write_is_dispatched_once_and_reconciled_by_refs(coding_scope, monkeypatch):
    broker = broker_for(coding_scope)
    value = await broker.mint("example/repository", "r" * 43)
    broker.validate_write = AsyncMock(return_value=["refs/heads/agent/test"])
    broker.authorize_repository = AsyncMock(return_value=("provider-secret", {"default_branch": "main"}))
    broker._requires_review = AsyncMock(return_value=False)
    broker._write_matches = AsyncMock(return_value=False)
    sent = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        @asynccontextmanager
        async def stream(self, method, url, **kwargs):
            sent.append((method, url, kwargs))
            yield httpx.Response(
                200, content=b"accepted", headers={"Content-Type": "application/x-git-receive-pack-result"}
            )

    monkeypatch.setattr(git_http.httpx, "AsyncClient", Client)
    body = receive("0" * 40, "b" * 40, "refs/heads/agent/test", b"PACK")
    params = {
        "method": "POST",
        "operation": "git-receive-pack",
        "service": None,
        "body": body,
        "content_type": "application/x-git-receive-pack-request",
    }
    async with broker.proxy("example/repository", value["capability"], **params) as response:
        assert set(coding_scope[0].harness_runs.find_one()["_coding_git_dispatches"].values()) == {"executing"}
        assert len(sent) == 1
        assert sent[0][1] == "https://github.com/example/repository.git/git-receive-pack"
        # A second replica must never resend an already accepted pack.
        with pytest.raises(CodingAdmissionError, match="uncertain outcome"):
            async with broker.proxy("example/repository", value["capability"], **params):
                pass
        assert len(sent) == 1
        assert await response.aread() == b"accepted"
        response.extensions["caipe_complete"] = True
    assert coding_scope[0].harness_tool_requests.find_one()["git_phase"] == "completed"
    assert set(coding_scope[0].harness_runs.find_one()["_coding_git_dispatches"].values()) == {"completed"}
    broker._write_matches = AsyncMock(return_value=True)
    async with broker.proxy("example/repository", value["capability"], **params) as response:
        report = await response.aread()
        assert b"unpack ok" in report and b"ok refs/heads/agent/test" in report
        assert b"\x01" in report  # Retain the negotiated side-band report framing.
    assert len(sent) == 1
    coding_scope[0].harness_runs.update_one({}, {"$set": {"cancellation_requested": True}})
    with pytest.raises(CodingAdmissionError):
        async with broker.proxy("example/repository", value["capability"], **params):
            pass
    assert len(sent) == 1


async def test_close_between_git_validation_and_dispatch_revokes_all_capabilities(coding_scope, monkeypatch):
    broker = broker_for(coding_scope)
    value = await broker.mint("example/repository", "r" * 43)
    resources = PlatformResourceBroker(
        Settings(
            storage_backend="memory",
            coding_resources_url="https://resources.example.test",
            coding_tools_public_url="https://broker.example.test",
        ),
        broker.fence,
        broker.credentials,
    )
    broker.authorize_repository = AsyncMock(return_value=("provider-secret", {}))

    async def close_before_dispatch(*args, **kwargs):
        await resources.close()

    broker._audit = AsyncMock(side_effect=close_before_dispatch)
    network = AsyncMock(side_effect=AssertionError("Revoked Git operation reached the network"))
    monkeypatch.setattr(git_http.httpx, "AsyncClient", network)
    with pytest.raises(CodingAdmissionError, match="revoked"):
        async with broker.proxy(
            "example/repository",
            value["capability"],
            method="GET",
            operation="info/refs",
            service="git-upload-pack",
            body=b"",
            content_type="",
        ):
            pytest.fail("A callback admitted before close must not start IO after close")
    network.assert_not_called()
    run = coding_scope[0].harness_runs.find_one()
    assert run["_coding_resources_closed"] is True
    assert "_coding_capability_hash" not in run and "_coding_git_capabilities" not in run
    assert not run.get("_coding_git_dispatches")
    assert resources.unsettled is False
    with pytest.raises(CodingAdmissionError):
        await broker.validate_capability("example/repository", value["capability"], write=False)

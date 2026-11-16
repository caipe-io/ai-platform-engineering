from __future__ import annotations

import socket
import stat
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from harness_engine import claude_isolation, claude_worker
from harness_engine.claude_isolation import check_isolation, isolated_command
from harness_engine.config import Settings
from harness_engine.repository import InMemoryRunRepository


@pytest.mark.parametrize("mode", [0o700, 0o2700])
def test_private_workspace_accepts_owner_only_setgid_directory(tmp_path: Path, mode: int) -> None:
    workspace = tmp_path.resolve() / "session"
    workspace.mkdir(mode=0o700)
    workspace.chmod(mode)
    claude_isolation.private_workspace(workspace)
    assert stat.S_IMODE(workspace.stat().st_mode) == mode
    assert (workspace / ".tmp").is_dir()
    assert (workspace / ".claude").is_dir()


@pytest.mark.parametrize("mode", [0o750, 0o770, 0o755, 0o2750, 0o2770, 0o1700, 0o4700])
def test_private_workspace_still_rejects_other_permissions(tmp_path: Path, mode: int) -> None:
    workspace = tmp_path.resolve() / "session"
    workspace.mkdir(mode=0o700)
    workspace.chmod(mode)
    with pytest.raises(ValueError, match="mode 0700"):
        claude_isolation.private_workspace(workspace)


async def test_isolation_default_and_exact_launch_policy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().claude_cli_isolation == "landlock"
    workspace = tmp_path.resolve() / "session"
    workspace.mkdir(mode=0o700)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("192.0.2.10", 3128))])
    env = {"HTTPS_PROXY": "http://proxy.example.test:3128", "NO_PROXY": "*"}
    command = await isolated_command(["python", "adapter.py"], workspace, env, 8010)
    assert command == [claude_isolation.LAUNCHER, "--workspace", str(workspace), "--connect-port", "8010",
                       "--connect-port", "3128", "--", "python", "adapter.py"]
    assert env["HOME"] == str(workspace)
    assert env["TMPDIR"] == str(workspace / ".tmp")
    assert env["HTTPS_PROXY"] == env["http_proxy"] == "http://192.0.2.10:3128"
    assert env["NO_PROXY"] == env["no_proxy"] == "127.0.0.1,::1,localhost"


@pytest.mark.parametrize("env", [{}, {"HTTPS_PROXY": "http://user:secret@proxy.example.test"},
                                  {"HTTPS_PROXY": "https://proxy.example.test"},
                                  {"HTTP_PROXY": "http://one.example.test", "HTTPS_PROXY": "http://two.example.test"}])
async def test_isolation_rejects_missing_or_ambiguous_proxy(tmp_path: Path, env: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="proxy") as error:
        await isolated_command(["claude"], tmp_path.resolve(), env, 8010)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("name", [".tmp", ".claude"])
async def test_isolation_rejects_symlinked_private_directories(tmp_path: Path, name: str) -> None:
    workspace, other = tmp_path.resolve() / "session", tmp_path.resolve() / "other"
    workspace.mkdir(mode=0o700)
    other.mkdir(mode=0o700)
    (workspace / name).symlink_to(other, target_is_directory=True)
    with pytest.raises(ValueError, match="symlinks"):
        await isolated_command(["claude"], workspace, {}, 8010)


async def test_preflight_fails_closed_if_binary_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claude_isolation.asyncio, "create_subprocess_exec", AsyncMock(side_effect=FileNotFoundError))
    with pytest.raises(RuntimeError, match="unavailable"):
        await check_isolation()


async def test_preflight_fails_closed_if_enforcement_denied(monkeypatch: pytest.MonkeyPatch) -> None:
    process = AsyncMock()
    process.returncode = 125
    process.communicate.return_value = (b"", b"Claude isolation refused: Linux Landlock ABI 6 or newer is required")
    monkeypatch.setattr(claude_isolation.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    with pytest.raises(RuntimeError, match="Landlock ABI 6"):
        await check_isolation()


async def test_worker_does_not_become_ready_without_enforcement(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    check = AsyncMock(side_effect=RuntimeError("enforcement unavailable"))
    monkeypatch.setattr(claude_worker, "check_isolation", check)
    repository = InMemoryRunRepository()
    app = claude_worker.create_worker_app(
        settings=settings.model_copy(update={"claude_acp_runtime": "claude_code_cli_acp"}), repository=repository,
    )
    with pytest.raises(RuntimeError, match="enforcement unavailable"):
        async with app.router.lifespan_context(app):
            pytest.fail("worker became ready without isolation")
    check.assert_awaited_once()

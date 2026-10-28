"""Verify traffic gating, readiness and recovery without replacing real services."""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("compose_safe_upgrade", ROOT / "deploy/compose-safe-upgrade.py")
assert spec and spec.loader
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


@pytest.fixture
def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[argparse.Namespace, list[list[str]]]:
    args = argparse.Namespace(
        gate_file=str(tmp_path / "maintenance/active"),
        public_url="https://example.test/",
        ready_url=["http://127.0.0.1:3000/api/health"],
        compose_file=["compose.yaml"],
        env_file=".env",
        profile=["example"],
        service=["example-ui"],
        proxy_container="example-proxy",
        timeout=1, resume=False,
    )
    commands: list[list[str]] = []
    monkeypatch.setattr(upgrade, "run", lambda command: commands.append(command))
    monkeypatch.setattr(upgrade, "probe", Mock(return_value=(503, "1", "old-worker")))
    monkeypatch.setattr(upgrade, "wait_ready", Mock())
    monkeypatch.setattr(upgrade, "wait_reloaded", Mock())
    return args, commands


def test_reopens_only_after_readiness_and_observed_reload(setup: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    args, commands = setup
    events: list[str] = []
    gate = Path(args.gate_file)

    def ready(urls: list[str], timeout: int) -> None:
        assert gate.exists()
        assert "--wait" in commands[-1]
        events.append("ready")

    def reloaded(url: str, worker: str, timeout: int) -> None:
        assert gate.exists()
        assert commands[-1][-2:] == ["-s", "reload"]
        assert events == ["ready"]
        events.append("reloaded")

    monkeypatch.setattr(upgrade, "wait_ready", ready)
    monkeypatch.setattr(upgrade, "wait_reloaded", reloaded)
    upgrade.upgrade(args)
    assert events == ["ready", "reloaded"]
    assert not gate.exists()
    assert commands[0][-2:] == ["config", "--quiet"]


def test_wrong_proxy_or_missing_mount_prevents_replacement(setup: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    args, commands = setup
    monkeypatch.setattr(upgrade, "probe", Mock(return_value=(200, None, None)))
    with pytest.raises(upgrade.UpgradeError, match="did not confirm"):
        upgrade.upgrade(args)
    assert not Path(args.gate_file).exists()
    assert not any("up" in command for command in commands)


@pytest.mark.parametrize("failure", ["replace", "ready", "reload", "observe"])
def test_failures_after_mutation_retain_maintenance(setup: tuple, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    args, commands = setup

    def fail(*args: object) -> None:
        raise upgrade.UpgradeError("example failure")

    if failure == "ready":
        monkeypatch.setattr(upgrade, "wait_ready", fail)
    elif failure == "observe":
        monkeypatch.setattr(upgrade, "wait_reloaded", fail)
    else:
        def run(command: list[str]) -> None:
            commands.append(command)
            if (failure == "replace" and "up" in command) or (failure == "reload" and command[-2:] == ["-s", "reload"]):
                fail()
        monkeypatch.setattr(upgrade, "run", run)
    with pytest.raises(upgrade.UpgradeError):
        upgrade.upgrade(args)
    assert Path(args.gate_file).exists()


def test_existing_gate_requires_explicit_resume(setup: tuple) -> None:
    args, commands = setup
    gate = Path(args.gate_file)
    gate.parent.mkdir()
    gate.touch()
    with pytest.raises(upgrade.UpgradeError, match="already active"):
        upgrade.upgrade(args)
    assert gate.exists()
    assert not commands
    args.resume = True
    upgrade.upgrade(args)
    assert not gate.exists()


def test_requires_a_readiness_url_for_each_service(setup: tuple) -> None:
    args, commands = setup
    args.service.append("example-api")
    with pytest.raises(upgrade.UpgradeError, match="every replaced service"):
        upgrade.upgrade(args)
    assert not commands


@pytest.mark.parametrize("url", ["https://user:secret@example.test/", "https://example.test/?token=secret", "file:///etc/passwd"])
def test_rejects_unsafe_probe_urls(url: str) -> None:
    with pytest.raises(upgrade.UpgradeError):
        upgrade.validate_url(url, loopback=False)


def test_direct_probes_cannot_target_the_gated_public_proxy() -> None:
    with pytest.raises(upgrade.UpgradeError, match="loopback"):
        upgrade.validate_url("https://example.test/api/health", loopback=True)


def test_readiness_checks_all_services(monkeypatch: pytest.MonkeyPatch) -> None:
    probe = Mock(side_effect=[(200, None, None), (503, None, None)])
    monkeypatch.setattr(upgrade, "probe", probe)
    with pytest.raises(upgrade.UpgradeError, match="timed out"):
        upgrade.wait_ready(["http://127.0.0.1:3000/", "http://127.0.0.1:3001/"], 0)
    assert probe.call_count == 2


def test_reload_requires_a_new_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(upgrade, "probe", Mock(return_value=(503, "1", "old-worker")))
    with pytest.raises(upgrade.UpgradeError, match="observable"):
        upgrade.wait_reloaded("https://example.test/", "old-worker", 0)
    monkeypatch.setattr(upgrade, "probe", Mock(return_value=(503, "1", "new-worker")))
    upgrade.wait_reloaded("https://example.test/", "old-worker", 0)

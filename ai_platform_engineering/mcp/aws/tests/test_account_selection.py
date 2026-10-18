import asyncio
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Optional
from unittest.mock import AsyncMock, Mock

import pytest


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    spec = importlib.util.spec_from_file_location("aws_account_server", Path(__file__).parents[1] / "server.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("AWS_ACCOUNT_LIST", "primary:000000000001,secondary:000000000002")
    module._aws_cli_semaphore = asyncio.Semaphore(1)
    module._kubectl_semaphore = asyncio.Semaphore(1)
    return module


def test_discovery_does_not_write_config(server: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "_setup_aws_profiles", Mock(side_effect=AssertionError("unexpected write")))
    assert server.list_aws_accounts() == {"accounts": [
        {"name": "primary", "id": "000000000001"},
        {"name": "secondary", "id": "000000000002"},
    ]}
    assert server._get_configured_profiles() == ["primary", "secondary"]


def test_parse_accounts_preserves_bare_ids(server: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ACCOUNT_LIST", " , primary : 000000000001 , 000000000002,")
    assert server._parse_aws_accounts() == [
        {"name": "primary", "id": "000000000001"},
        {"name": "000000000002", "id": "000000000002"},
    ]


@pytest.mark.parametrize("profile,account", [(None, None), ("", ""), ("unknown", None), (None, "unknown"), ("primary", "secondary")])
@pytest.mark.asyncio
async def test_invalid_selectors_never_execute(server: ModuleType, monkeypatch: pytest.MonkeyPatch, profile: Optional[str], account: Optional[str]) -> None:
    spawn = AsyncMock(side_effect=AssertionError("must not invoke AWS"))
    run = Mock(side_effect=AssertionError("must not invoke kubectl"))
    monkeypatch.setattr(server.asyncio, "create_subprocess_shell", spawn)
    monkeypatch.setattr(server, "_run_kubectl", run)
    assert "❌" in await server.aws_cli_execute("sts get-caller-identity", profile=profile, account=account)
    assert "❌" in await server.eks_kubectl_execute("example", "get pods", profile=profile, account=account)
    spawn.assert_not_called()
    run.assert_not_called()


@pytest.mark.parametrize("profile,account", [("primary", None), (None, "primary"), (" primary ", "primary")])
def test_profile_and_legacy_alias(server: ModuleType, profile: Optional[str], account: Optional[str]) -> None:
    assert server._resolve_account_profile(profile, account) == ("primary", None)


def test_default_credential_chain_without_account_list(server: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AWS_ACCOUNT_LIST")
    assert server.list_aws_accounts() == {"accounts": []}
    assert server._resolve_account_profile(None, None) == (None, None)


@pytest.mark.asyncio
async def test_eks_legacy_alias_reaches_executor(server: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    run = Mock(return_value="ok")
    monkeypatch.setattr(server, "_run_kubectl", run)
    assert await server.eks_kubectl_execute("example", "get pods", account="secondary") == "ok"
    run.assert_called_once_with("example", "get pods", "secondary", None)


@pytest.mark.asyncio
async def test_aws_legacy_alias_reaches_cli(server: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    process = Mock(returncode=0)
    process.communicate = AsyncMock(return_value=(b"{}", b""))
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(server.asyncio, "create_subprocess_shell", spawn)
    assert await server.aws_cli_execute("sts get-caller-identity", account="primary") == "{}"
    assert "--profile primary" in spawn.call_args.args[0]

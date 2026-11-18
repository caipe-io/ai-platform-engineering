"""aws_cli_execute applies jq_filter to a mocked AWS CLI response."""

import asyncio
import importlib.util
import shutil
from pathlib import Path
from types import ModuleType

import pytest


SERVER_PATH = Path(__file__).parents[1] / "server.py"

pytestmark = pytest.mark.skipif(shutil.which("jq") is None, reason="jq is not installed")


def _load_server() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mcp_aws_server_jq", SERVER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_aws = fake_bin / "aws"
    fake_aws.write_text(
        "#!/bin/sh\n"
        "echo '{\"UserId\":\"EXAMPLE\",\"Account\":\"123456789012\","
        "\"Arn\":\"arn:aws:iam::123456789012:user/test-user\"}'\n",
        encoding="utf-8",
    )
    fake_aws.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake_bin}:{Path(shutil.which('jq') or '').parent}")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.delenv("AWS_ACCOUNT_LIST", raising=False)
    module = _load_server()
    # main() normally creates this before serving requests.
    module._aws_cli_semaphore = asyncio.Semaphore(1)
    return module


def test_jq_filter_selects_field_from_cli_output(server: ModuleType) -> None:
    result = asyncio.run(
        server.aws_cli_execute(command="sts get-caller-identity", profile="", jq_filter=".Account")
    )

    assert result.strip() == '"123456789012"'


def test_invalid_jq_filter_reports_raw_output(server: ModuleType) -> None:
    result = asyncio.run(
        server.aws_cli_execute(command="sts get-caller-identity", profile="", jq_filter=".[")
    )

    assert result.startswith("⚠️ jq filter failed")
    assert "123456789012" in result

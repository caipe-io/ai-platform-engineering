import asyncio
import sys
import tempfile
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

@pytest.mark.parametrize("command", [
    "ec2 describe-instances | cat", "ec2 describe-instances|cat", "ec2 describe-instances && whoami",
    "ec2 describe-instances; whoami", "ec2 describe-instances > output", 'ec2 describe-instances --query "unterminated',
    "ec2 describe-instances --profile unknown", "ec2 describe-instances --profile=unknown",
])
def test_reject_shell_operators_and_embedded_account_override(server: Any, command: str) -> None:
    assert server._validate_aws_command(command)[0] is False


def test_quoted_jmespath_pipe_is_one_argument(server: Any) -> None:
    query = "Reservations[].Instances[].{Name:Tags[?Key=='Name']|[0].Value}"
    command = f'ec2 describe-instances --query "{query}"'
    assert server._validate_aws_command(command) == (True, "")
    assert server._parse_aws_command(command) == ["ec2", "describe-instances", "--query", query]
    assert server._validate_aws_command("ec2 terminate-instances")[0] is False


@pytest.mark.asyncio
async def test_exec_argv_and_full_input_jq_before_truncation(server: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple] = []
    raw = b'{"items": ["example", "another"]}'
    query = "Items[?Key=='Name']|[0]"
    def process(*args: str, **kwargs: Any) -> Mock:
        calls.append(args)
        if args[0] == "aws":
            kwargs["stdout"].write(raw)
        else:
            assert args == ("jq", ".items | length")
            assert kwargs["stdin"].read() == raw
            kwargs["stdout"].write(b"2")
        return Mock(returncode=0, wait=AsyncMock(return_value=0))
    monkeypatch.setattr(server, "MAX_OUTPUT_SIZE", 3)
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", AsyncMock(side_effect=process))
    monkeypatch.setattr(server.asyncio, "create_subprocess_shell", AsyncMock(side_effect=AssertionError("no shell")))
    result = await server.aws_cli_execute(f'ec2 describe-instances --query "{query}"', profile="primary", jq_filter=".items | length")
    assert result == "2"
    assert calls[0][:3] == ("aws", "--profile", "primary")
    assert query in calls[0]
    assert calls[0][-2:] == ("--output", "json")


@pytest.mark.parametrize("flag", ["--region eu-west-1", "--region=eu-west-1"])
@pytest.mark.asyncio
async def test_explicit_region_is_not_duplicated(server: Any, monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    spawn = AsyncMock(return_value=Mock(returncode=0, wait=AsyncMock(return_value=0)))
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", spawn)
    await server.aws_cli_execute(f"eks list-clusters {flag}", profile="primary")
    assert sum(arg.startswith("--region") for arg in spawn.call_args.args) == 1


@pytest.mark.parametrize("exit_code,stream", [(0, "stdout"), (1, "stderr")])
@pytest.mark.asyncio
async def test_real_child_output_is_bounded(server: Any, monkeypatch: pytest.MonkeyPatch, exit_code: int, stream: str) -> None:
    spawn = asyncio.create_subprocess_exec
    async def child(*args: str, **kwargs: Any) -> asyncio.subprocess.Process:
        return await spawn(sys.executable, "-c", f"import sys; sys.{stream}.write('x' * 200000); sys.exit({exit_code})", **kwargs)
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", child)
    monkeypatch.setattr(server, "MAX_OUTPUT_SIZE", 16)
    result = await server.aws_cli_execute("sts get-caller-identity", profile="primary")
    assert "xxxxxxxxxxxxxxxx\n\n... [Truncated. Total: 200000 bytes]" in result
    assert len(result) < 120


@pytest.mark.asyncio
async def test_timeout_kills_and_reaps_real_child(server: Any) -> None:
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(60)")
    with pytest.raises(TimeoutError):
        await server._wait_for_process(process, 0.01)
    assert process.returncode is not None


@pytest.mark.asyncio
async def test_cancellation_kills_and_reaps_real_child(server: Any) -> None:
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(60)")
    task = asyncio.create_task(server._wait_for_process(process, 30))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.returncode is not None


@pytest.mark.parametrize("failure", [FileNotFoundError, TimeoutError])
@pytest.mark.asyncio
async def test_jq_failure_returns_bounded_raw_capture(server: Any, monkeypatch: pytest.MonkeyPatch, failure: type[Exception]) -> None:
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", AsyncMock(side_effect=failure))
    monkeypatch.setattr(server, "MAX_OUTPUT_SIZE", 4)
    with tempfile.TemporaryFile() as data:
        data.write(b"0123456789")
        result = await server._apply_jq(data, ".items")
    assert "filtering failed" in result
    assert result.endswith("0123\n\n... [Truncated. Total: 10 bytes]")

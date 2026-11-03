import asyncio
import os
import runpy
import signal
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
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
async def test_exec_argv_and_full_input_jq_before_truncation(server: Any, monkeypatch: pytest.MonkeyPatch, completed_process: Callable[..., Mock]) -> None:
    calls: list[tuple] = []
    raw = b'{"items": ["example", "another"]}'
    query = "Items[?Key=='Name']|[0]"
    def process(*args: str, **kwargs: Any) -> Mock:
        calls.append(args)
        assert kwargs["stdout"] == asyncio.subprocess.PIPE
        assert kwargs["stderr"] == asyncio.subprocess.PIPE
        if args[0] == "aws":
            return completed_process(stdout=raw)
        else:
            assert args == ("jq", ".items | length")
            assert kwargs["stdin"].read() == raw
            return completed_process(stdout=b"2")
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
async def test_explicit_region_is_not_duplicated(server: Any, monkeypatch: pytest.MonkeyPatch, flag: str, completed_process: Callable[..., Mock]) -> None:
    spawn = AsyncMock(return_value=completed_process())
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
    result = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(result[0], asyncio.CancelledError)
    assert process.returncode is not None


@pytest.mark.parametrize("failure", [FileNotFoundError, TimeoutError])
@pytest.mark.asyncio
async def test_jq_failure_returns_bounded_raw_capture(server: Any, monkeypatch: pytest.MonkeyPatch, failure: type[Exception]) -> None:
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", AsyncMock(side_effect=failure))
    monkeypatch.setattr(server, "MAX_OUTPUT_SIZE", 4)
    with tempfile.TemporaryFile() as data:
        data.write(b"0123456789")
        result = await server._apply_jq(data, ".items")
    assert "processing failed" in result
    assert result.endswith("0123\n\n... [Truncated. Total: 10 bytes]")


@pytest.mark.parametrize("configured", ["-100", "0"])
def test_nonpositive_output_limit_never_reads_unbounded(server: Any, monkeypatch: pytest.MonkeyPatch, configured: str) -> None:
    monkeypatch.setenv("AWS_CLI_MAX_OUTPUT_SIZE", configured)
    namespace = runpy.run_path(server.__file__)
    assert namespace["MAX_OUTPUT_SIZE"] == 0
    with tempfile.TemporaryFile() as data:
        data.write(b"example")
        assert namespace["_read_captured_output"](data) == "\n\n... [Truncated. Total: 7 bytes]"


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
@pytest.mark.asyncio
async def test_capture_limit_kills_reaps_and_bounds_disk(server: Any, monkeypatch: pytest.MonkeyPatch, stream: str) -> None:
    monkeypatch.setattr(server, "MAX_CAPTURE_SIZE", 1024)
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", f"import sys,time; sys.{stream}.write('x'*1000000); sys.{stream}.flush(); time.sleep(60)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        with pytest.raises(server.CaptureLimitExceeded, match=f"{stream} exceeded AWS_CLI_MAX_CAPTURE_SIZE \\(1024 bytes\\)"):
            await asyncio.wait_for(server._wait_for_process(process, 5, stdout, stderr), timeout=10)
        assert stdout.seek(0, 2) <= 1024
        assert stderr.seek(0, 2) <= 1024
    assert process.returncode is not None


@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.asyncio
async def test_pipe_capture_cleanup_on_timeout_and_cancellation(server: Any, cancel: bool) -> None:
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import sys,time; sys.stdout.write('example'); sys.stdout.flush(); time.sleep(60)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        task = asyncio.create_task(server._wait_for_process(process, 30 if cancel else 0.05, stdout, stderr))
        if cancel:
            await asyncio.sleep(0)
            task.cancel()
        result = await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=10)
    assert isinstance(result[0], asyncio.CancelledError if cancel else TimeoutError)
    assert process.returncode is not None


@pytest.mark.asyncio
async def test_aws_capture_limit_is_an_explicit_failure(server: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    spawn = asyncio.create_subprocess_exec
    processes = []
    async def child(*args: str, **kwargs: Any) -> asyncio.subprocess.Process:
        process = await spawn(sys.executable, "-c", "import sys; sys.stdout.write('x'*1000000)", **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", child)
    monkeypatch.setattr(server, "MAX_CAPTURE_SIZE", 1024)
    result = await server.aws_cli_execute("sts get-caller-identity", profile="primary")
    assert result == "❌ stdout exceeded AWS_CLI_MAX_CAPTURE_SIZE (1024 bytes)."
    assert processes[0].returncode is not None


@pytest.mark.asyncio
async def test_jq_capture_limit_never_returns_partial_json(server: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    spawn = asyncio.create_subprocess_exec
    async def child(*args: str, **kwargs: Any) -> asyncio.subprocess.Process:
        return await spawn(sys.executable, "-c", "import sys; sys.stdout.write('['+'1,'*1000000+']')", **kwargs)
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", child)
    monkeypatch.setattr(server, "MAX_CAPTURE_SIZE", 1024)
    with tempfile.TemporaryFile() as data:
        data.write(b"{}")
        result = await server._apply_jq(data, ".")
    assert result == "❌ jq stdout exceeded AWS_CLI_MAX_CAPTURE_SIZE (1024 bytes)."


@pytest.mark.asyncio
async def test_jq_stderr_is_preserved_and_bounded(server: Any, monkeypatch: pytest.MonkeyPatch, completed_process: Callable[..., Mock], caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(server, "MAX_OUTPUT_SIZE", 12)
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", AsyncMock(return_value=completed_process(stderr=b"syntax error: details", returncode=3)))
    with tempfile.TemporaryFile() as data:
        data.write(b'{"items":[]}')
        result = await server._apply_jq(data, "invalid")
    assert "syntax error\n\n... [Truncated. Total: 21 bytes]" in result
    assert "syntax error" in caplog.text
    assert result.endswith('{"items":[]}')


@pytest.mark.asyncio
async def test_jq_os_error_message_is_preserved(server: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", AsyncMock(side_effect=OSError("example spawn failure")))
    with tempfile.TemporaryFile() as data:
        data.write(b"{}")
        result = await server._apply_jq(data, ".")
    assert "example spawn failure" in result
    assert "example spawn failure" in caplog.text


@pytest.mark.asyncio
async def test_jq_timeout_wiring_reaps_real_child(server: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    spawn = asyncio.create_subprocess_exec
    processes = []
    async def child(*args: str, **kwargs: Any) -> asyncio.subprocess.Process:
        process = await spawn(sys.executable, "-c", "import time; time.sleep(60)", **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", child)
    monkeypatch.setattr(server, "JQ_TIMEOUT", 0.05)
    try:
        with tempfile.TemporaryFile() as data:
            data.write(b"{}")
            result = await asyncio.wait_for(server._apply_jq(data, "."), timeout=5)
        assert "processing failed" in result
        assert result.endswith("{}")
        assert processes[0].returncode is not None
    finally:
        for process in processes:
            if process.returncode is None:
                process.kill()
                await process.communicate()


@pytest.mark.skipif(os.name != "posix", reason="POSIX session and process-group behavior")
@pytest.mark.parametrize("escaped", [False, True])
@pytest.mark.asyncio
async def test_descendant_pipe_cannot_hold_cleanup_open(
    server: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture, escaped: bool,
) -> None:
    pid_file = tmp_path / "descendant.pid"
    code = (
        "import subprocess,sys,time; "
        f"p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session={escaped}); "
        "open(sys.argv[1],'w').write(str(p.pid)); time.sleep(60)"
    )
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", code, str(pid_file), start_new_session=True,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    monkeypatch.setattr(server, "PROCESS_CLEANUP_TIMEOUT", 0.05)
    try:
        async def ready() -> None:
            while not pid_file.exists() or not pid_file.read_text():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(ready(), timeout=5)
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(server._wait_for_process(process, 0.05, stdout, stderr, process_group=True), timeout=2)
        assert process.returncode is not None
        assert ("pipe cleanup exceeded" in caplog.text) is escaped
    finally:
        if process.returncode is None:
            os.killpg(process.pid, signal.SIGKILL)
        if escaped and pid_file.exists() and pid_file.read_text():
            try:
                os.killpg(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        await asyncio.wait_for(process.communicate(), timeout=2)

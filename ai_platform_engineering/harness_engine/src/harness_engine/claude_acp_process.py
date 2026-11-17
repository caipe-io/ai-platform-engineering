"""Keep the ACP agent and its provider subprocesses inside one drained boundary."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path

from acp import connect_to_agent
from acp.core import ClientSideConnection

from harness_engine.adapters.base import ExecutionUnconfirmedError

logger = logging.getLogger(__name__)


def signal_group(process_id: int, sig: int) -> bool:
    try:
        os.killpg(process_id, sig)
        return True
    except ProcessLookupError:
        return False


@asynccontextmanager
async def managed_acp_process(
    client: object,
    command: list[str],
    *,
    env: Mapping[str, str],
    cwd: Path,
    run_id: str,
) -> AsyncIterator[ClientSideConnection]:
    if os.name != "posix":
        raise ValueError("Claude ACP workers require a POSIX process boundary")
    process = await asyncio.create_subprocess_exec(
        *command,
        env=dict(env),
        cwd=cwd,
        start_new_session=True,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    connection = connect_to_agent(client, process.stdin, process.stdout)
    try:
        yield connection
    finally:
        try:
            await asyncio.wait_for(connection.close(), timeout=2)
        except (TimeoutError, ConnectionError) as error:
            logger.warning(
                "ACP connection teardown required process termination",
                extra={
                    "run_id": run_id,
                    "process_id": process.pid,
                    "error_type": type(error).__name__,
                },
            )
        # A child can outlive the stdio agent. Signal the entire dedicated group,
        # even when the direct process has already exited. Container init reaps
        # adopted children so an idle worker does not accumulate zombies.
        drained = False
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if not signal_group(process.pid, sig):
                drained = True
                break
            for _ in range(40):
                await asyncio.sleep(0.025)
                if not signal_group(process.pid, 0):
                    drained = True
                    break
            if drained:
                break
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except TimeoutError:
            raise ExecutionUnconfirmedError(
                "ACP provider process did not exit; retain the session reservation"
            ) from None
        if not drained:
            raise ExecutionUnconfirmedError("ACP provider processes did not drain; retain the session reservation")

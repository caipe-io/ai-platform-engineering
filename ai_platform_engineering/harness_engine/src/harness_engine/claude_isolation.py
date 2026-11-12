"""Operator-controlled launch policy; no user policy or credentials in argv."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
import stat
from pathlib import Path
from urllib.parse import urlsplit

LAUNCHER = "/usr/local/bin/caipe-claude-sandbox"


async def check_isolation() -> None:
    """Exercise both enforcement mechanisms before the worker becomes ready."""
    try:
        process = await asyncio.create_subprocess_exec(
            LAUNCHER, "--check", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
    except OSError:
        raise RuntimeError("Claude CLI isolation launcher is unavailable") from None
    try:
        _, error = await asyncio.wait_for(process.communicate(), 10)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise RuntimeError("Claude CLI isolation preflight timed out") from None
    if process.returncode:
        # The native launcher emits fixed diagnostic text, never environment or argv.
        raise RuntimeError(f"Claude CLI isolation preflight failed: {error.decode(errors='replace').strip()}")


def private_workspace(workspace: Path) -> None:
    """Reject aliases before the trusted worker creates files in a workspace."""
    if not workspace.is_absolute() or workspace.resolve() != workspace:
        raise ValueError("Claude CLI isolation requires a canonical absolute workspace")
    info = workspace.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Claude CLI isolation requires a worker-owned workspace with mode 0700")
    for name in (".tmp", ".claude"):
        child = workspace / name
        child.mkdir(mode=0o700, exist_ok=True)
        if child.is_symlink() or child.resolve() != child:
            raise ValueError("Claude CLI private directories must not be symlinks")


async def isolated_command(
    command: list[str], workspace: Path, env: dict[str, str], broker_port: int,
) -> list[str]:
    private_workspace(workspace)
    # Child processes cannot use UDP/Unix sockets for DNS. Resolve the fixed
    # operator proxy outside the sandbox; all destination DNS stays at the proxy.
    proxies = {env[key] for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy") if env.get(key)}
    if len(proxies) != 1:
        raise ValueError("Claude CLI isolation requires one explicit HTTP egress proxy")
    parsed = urlsplit(proxies.pop())
    if (parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
        raise ValueError("Claude CLI isolation requires an HTTP proxy without embedded credentials")
    port = parsed.port or 80
    addresses = await asyncio.to_thread(socket.getaddrinfo, parsed.hostname, port, type=socket.SOCK_STREAM)
    address = ipaddress.ip_address(addresses[0][4][0])
    host = f"[{address}]" if address.version == 6 else str(address)
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        env[key] = f"http://{host}:{port}"
    for key in ("NO_PROXY", "no_proxy"):
        env[key] = "127.0.0.1,::1,localhost"
    env.update(HOME=str(workspace), TMPDIR=str(workspace / ".tmp"), TMP=str(workspace / ".tmp"),
               TEMP=str(workspace / ".tmp"))
    return [LAUNCHER, "--workspace", str(workspace), "--connect-port", str(broker_port),
            "--connect-port", str(port), "--", *command]

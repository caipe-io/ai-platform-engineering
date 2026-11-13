#!/usr/bin/env python3
"""Gate proxy traffic while replacing Compose services; retain the gate on failure."""

from __future__ import annotations

import argparse
import fcntl
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class UpgradeError(RuntimeError):
    """The upgrade could not safely reopen traffic."""


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise UpgradeError(f"{command[0]} command failed (exit {result.returncode}); inspect service logs")


def probe(url: str) -> tuple[int, str | None, str | None]:
    try:
        response = urllib.request.urlopen(url, timeout=3)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers.get("X-CAIPE-Maintenance"), response.headers.get("X-CAIPE-Generation")


def validate_url(url: str, *, loopback: bool) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise UpgradeError("Probe URLs must be HTTP(S) without credentials, query or fragment")
    if loopback and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise UpgradeError("Readiness probes must target direct loopback ports, not the gated public proxy")


def wait_ready(urls: list[str], timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while True:
        ready = True
        for url in urls:
            try:
                status, maintenance, _ = probe(url)
                if status != 200 or maintenance is not None:
                    ready = False
            except (urllib.error.URLError, TimeoutError, OSError):
                ready = False
        if ready:
            return
        if time.monotonic() >= deadline:
            raise UpgradeError("Direct service readiness checks timed out")
        time.sleep(1)


def wait_reloaded(url: str, generation: str, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            status, marker, observed_generation = probe(url)
            if status == 503 and marker == "1" and observed_generation == generation:
                return
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        if time.monotonic() >= deadline:
            raise UpgradeError("Proxy reload did not become observable; maintenance retained")
        time.sleep(1)


def upgrade(args: argparse.Namespace) -> None:
    validate_url(args.public_url, loopback=False)
    for url in args.ready_url:
        validate_url(url, loopback=True)
    if len(set(args.ready_url)) < len(set(args.service)):
        raise UpgradeError("Supply a distinct direct readiness URL for every replaced service")
    gate = Path(args.gate_file).resolve()
    gate.parent.mkdir(parents=True, exist_ok=True)
    compose = ["docker", "compose"]
    for path in args.compose_file:
        compose += ["-f", path]
    if args.env_file:
        compose += ["--env-file", args.env_file]
    for profile in args.profile:
        compose += ["--profile", profile]
    proxy = ["docker", "exec", args.proxy_container, "nginx"] if args.proxy_container else ["nginx"]

    # A separate lock survives gate deletion and excludes simultaneous upgraders.
    with gate.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise UpgradeError("Another upgrade holds the maintenance lock") from error
        if gate.exists() and not args.resume:
            raise UpgradeError("Maintenance is already active; review its owner before using --resume")
        run(compose + ["config", "--quiet"])
        run(proxy + ["-t"])
        created_gate = not gate.exists()
        if created_gate:
            gate.touch(exist_ok=False)
        replacing = False
        try:
            # Refuse mutation unless the real public proxy observes the mounted flag.
            status, marker, generation = probe(args.public_url)
            if status != 503 or marker != "1" or not generation:
                raise UpgradeError("Public proxy did not confirm maintenance; no containers replaced")
            replacing = True
            run(compose + ["up", "-d", "--no-deps", "--wait", "--wait-timeout", str(args.timeout), *args.service])
            wait_ready(args.ready_url, args.timeout)
            # An exact generation marker distinguishes the new configuration
            # from every old worker, even when nginx has several worker PIDs.
            generation = uuid.uuid4().hex
            staging = gate.parent / f"generation.{generation}.tmp"
            staging.write_text(f'set $caipe_upgrade_generation "{generation}";\n')
            staging.replace(gate.parent / "generation.conf")
            # Reload only after readiness, refreshing Docker upstream DNS as well.
            run(proxy + ["-t"])
            run(proxy + ["-s", "reload"])
            wait_reloaded(args.public_url, generation, args.timeout)
            gate.unlink()
            print("Services are ready; maintenance cleared.")
        except (UpgradeError, OSError, urllib.error.URLError):
            if not replacing and created_gate:
                gate.unlink(missing_ok=True)
            else:
                print("Upgrade incomplete; maintenance remains active. Restore prior image pins and rerun with --resume.")
            raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate-file", required=True, help="Host flag path mounted into the proxy")
    parser.add_argument("--public-url", required=True, help="Public HTTPS endpoint used to verify the gate")
    parser.add_argument("--ready-url", action="append", required=True, help="Direct loopback health URL; repeat for every replaced app")
    parser.add_argument("--compose-file", action="append", default=[])
    parser.add_argument("--env-file")
    parser.add_argument("--profile", action="append", default=[])
    parser.add_argument("--service", action="append", required=True)
    parser.add_argument("--proxy-container", help="Omit when nginx runs on the host")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--resume", action="store_true", help="Continue an explicitly reviewed existing maintenance window")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        upgrade(args)
    except (UpgradeError, OSError, urllib.error.URLError) as error:
        parser.exit(1, f"Upgrade stopped: {error}\n")


if __name__ == "__main__":
    main()

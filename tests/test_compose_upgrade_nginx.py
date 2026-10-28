"""Opt-in isolated nginx integration test; never connects to a deployment."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(os.environ.get("RUN_COMPOSE_NGINX_TEST") != "1", reason="Requires the isolated Docker nginx lane")


def docker(*args: str) -> str:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, check=False, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr[-1000:])
    return result.stdout.strip()


def response(url: str) -> tuple[int, dict[str, str]]:
    try:
        result = urllib.request.urlopen(url, timeout=2)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        return result.status, dict(result.headers)


def await_response(url: str, expected: int, different_worker: str | None = None) -> dict[str, str]:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            status, headers = response(url)
            if status == expected and (different_worker is None or headers.get("X-CAIPE-Worker") not in {None, different_worker}):
                return headers
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"Isolated proxy did not return expected status {expected}")


def test_nginx_gates_startup_and_observes_reloaded_workers(tmp_path: Path) -> None:
    suffix = uuid.uuid4().hex[:12]
    network, frontend, backend = (f"example-{kind}-{suffix}" for kind in ("network", "proxy", "backend"))
    gate_dir = tmp_path / "maintenance"
    gate_dir.mkdir()
    # Keep the shipped server's gate and named error handler unchanged; only
    # adapt TLS/listeners and upstream names for the isolated test network.
    config = (ROOT / "deploy/caipe-oss-nginx.conf").read_text()
    config = config[config.index("server {", config.index("server {") + 1):]
    config = re.sub(r"listen 443 ssl http2;", "listen 8080;", config)
    config = re.sub(r"^\s*ssl_(?:certificate|certificate_key|protocols) .*;\n", "", config, flags=re.MULTILINE)
    config = re.sub(r"http://(?:caipe-ui:3000|keycloak:7080|openfga:3000|agentgateway:15000)", f"http://{backend}:80", config)
    config_file = tmp_path / "nginx.conf"
    config_file.write_text(config)
    created_network = False
    try:
        docker("network", "create", network)
        created_network = True
        docker("run", "-d", "--name", backend, "--network", network, "nginx:1.27-alpine")
        docker("run", "-d", "--name", frontend, "--network", network,
               "-p", "127.0.0.1::8080", "-v", f"{config_file}:/etc/nginx/conf.d/default.conf:ro",
               "-v", f"{gate_dir}:/run/caipe-maintenance:ro", "nginx:1.27-alpine")
        address = docker("port", frontend, "8080/tcp")
        url = f"http://{address}/"
        await_response(url, 200)
        gate = gate_dir / "active"
        gate.touch()
        headers = await_response(url, 503)
        assert headers["Retry-After"] == "15"
        assert headers["X-CAIPE-Maintenance"] == "1"
        old_worker = headers["X-CAIPE-Worker"]
        # Even an unavailable upstream cannot leak a connection-failure 502
        # through the maintenance gate while containers are replaced.
        docker("stop", backend)
        assert response(url)[0] == 503
        docker("start", backend)
        docker("exec", frontend, "nginx", "-t")
        docker("exec", frontend, "nginx", "-s", "reload")
        headers = await_response(url, 503, different_worker=old_worker)
        assert headers["X-CAIPE-Maintenance"] == "1"
        gate.unlink()
        headers = await_response(url, 200)
        assert "X-CAIPE-Maintenance" not in headers
    finally:
        subprocess.run(["docker", "rm", "-f", frontend, backend], capture_output=True, check=False, timeout=30)
        if created_network:
            subprocess.run(["docker", "network", "rm", network], capture_output=True, check=False, timeout=30)

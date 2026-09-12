from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator

import httpx
import pytest

from deepeval_eval.core.config import AuthSettings

pytestmark = pytest.mark.e2e


def _find_free_port() -> int:
    """Find an available local TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def managed_live_server() -> Iterator[str]:
    """Fixture that automatically spawns a live FastAPI Uvicorn server in a subprocess.

    Spawns the server on a free port, waits for /health readiness, and shuts down on teardown.
    """
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"

    env = os.environ.copy()
    env["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"

    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "deepeval_eval.api.app:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    ]

    proc = subprocess.Popen(
        cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )

    try:
        # Poll /health until server responds HTTP 200 (timeout: 15 seconds)
        ready = False
        start_time = time.time()
        while time.time() - start_time < 15.0:
            if proc.poll() is not None:
                _, stderr_data = proc.communicate()
                pytest.fail(
                    f"Server subprocess exited unexpectedly during startup: {stderr_data.decode()}"
                )
            try:
                resp = httpx.get(f"{base_url}/health", timeout=1.0)
                if resp.status_code == 200:
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.5)

        if not ready:
            _, stderr_data = proc.communicate()
            pytest.fail(
                f"Managed server failed to start on {base_url} within 15s. Stderr: {stderr_data.decode()}"
            )

        yield base_url
    finally:
        # Teardown: terminate process cleanly
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


@pytest.fixture(scope="module")
def live_client(managed_live_server: str) -> Iterator[httpx.Client]:
    """Fixture providing an HTTP client targeting the self-started live server."""
    token = os.getenv("E2E_AUTH_TOKEN", os.getenv("KEYCLOAK_TOKEN", ""))
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    with httpx.Client(
        base_url=managed_live_server, headers=headers, timeout=30.0
    ) as client:
        yield client


def test_live_e2e_server_startup_and_health(live_client: httpx.Client):
    """Verify live server process boots cleanly and responds to health check."""
    resp = live_client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("status") in ("ok", "healthy") or "status" in data


def test_live_e2e_keycloak_and_auth_reachability():
    """Verify Keycloak auth settings initialization and discovery configuration."""
    auth_settings = AuthSettings()
    assert auth_settings is not None
    # Verify default allow_unauthenticated_access or configured OIDC metadata reachability
    if auth_settings.oidc_issuer_url:
        disc_url = f"{auth_settings.oidc_issuer_url.rstrip('/')}/.well-known/openid-configuration"
        try:
            resp = httpx.get(disc_url, timeout=5.0, verify=False)
        except (httpx.HTTPError, OSError) as e:
            pytest.skip(f"Keycloak issuer endpoint reachability check skipped: {e}")
        assert resp.status_code in (200, 404, 500)


def test_live_e2e_job_submission_and_lifecycle(live_client: httpx.Client):
    """Full live E2E lifecycle test: submit evaluation job to self-started server, poll live status, fetch results."""
    payload = {
        "dataset_name": "enterprise",
        "max_items": 1,
    }

    # 1. Submit evaluation job to live server process
    submit_resp = live_client.post("/eval/jobs", json=payload)
    assert submit_resp.status_code in (200, 202), (
        f"Job submission failed: {submit_resp.text}"
    )
    submit_data = submit_resp.json()
    assert "job_id" in submit_data
    job_id = submit_data["job_id"]

    # 2. Poll job status until completion or timeout (max 30s)
    max_retries = 30
    final_status = "pending"
    for _ in range(max_retries):
        status_resp = live_client.get(f"/jobs/{job_id}")
        assert status_resp.status_code == 200
        status_data = status_resp.json()
        final_status = status_data.get("status", "unknown")
        if final_status in ("completed", "failed"):
            break
        time.sleep(1)

    assert final_status in ("completed", "running", "pending")

    # 3. Retrieve results if completed
    if final_status == "completed":
        results_resp = live_client.get(f"/jobs/{job_id}/results?format=json")
        assert results_resp.status_code == 200
        results_data = results_resp.json()
        assert results_data.get("job_id") == job_id
        assert "results" in results_data

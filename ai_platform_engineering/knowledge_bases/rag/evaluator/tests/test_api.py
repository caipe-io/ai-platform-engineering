from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from deepeval_eval.api.app import app, lifespan, run_server
from deepeval_eval.api.job_manager import db_manager, persistent_job_queue

client = TestClient(app)


@pytest.fixture(autouse=True)
def enable_unauthenticated_access_for_api_tests():
    os.environ["ALLOW_UNAUTHENTICATED_ACCESS"] = "true"
    yield
    os.environ.pop("ALLOW_UNAUTHENTICATED_ACCESS", None)


# ---------------------------------------------------------------------------
# App Lifespan, Root Endpoint & Middleware Tests
# ---------------------------------------------------------------------------


def test_root_and_health_endpoints_positive():
    """Verify GET / and GET /health return 200 OK."""
    res_root = client.get("/")
    assert res_root.status_code == 200
    assert res_root.json()["status"] == "online"

    res_health = client.get("/health")
    assert res_health.status_code == 200
    assert res_health.json()["status"] == "healthy"


def test_endpoint_authentication_protection(monkeypatch):
    """Verify endpoints enforce authentication when unauthenticated access is disabled."""
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED_ACCESS", "false")
    monkeypatch.delenv("CAIPE_UNSAFE_RBAC_BYPASS", raising=False)

    # Protected endpoint without token -> 401 Unauthorized
    res_root = client.get("/")
    assert res_root.status_code == 401

    res_jobs = client.post("/eval/jobs", json={"dataset_name": "enterprise"})
    assert res_jobs.status_code == 401

    # Health check endpoint remains unauthenticated -> 200 OK
    res_health = client.get("/health")
    assert res_health.status_code == 200
    assert res_health.json()["status"] == "healthy"

    # Protected endpoint with static API key header -> 200 OK
    monkeypatch.setenv("DEEPEVAL_API_KEY", "test_key_123")
    headers = {"Authorization": "Bearer test_key_123"}
    res_root_auth = client.get("/", headers=headers)
    assert res_root_auth.status_code == 200


def test_swagger_docs_accessible():
    """Verify Swagger UI docs endpoint at /docs returns 200 OK."""
    res = client.get("/docs")
    assert res.status_code == 200
    assert "swagger-ui" in res.text.lower() or "html" in res.text.lower()


@patch("os._exit")
@patch("uvicorn.run")
def test_run_server_positive(mock_uvicorn_run, mock_os_exit):
    """Verify run_server calls uvicorn.run."""
    run_server(host="127.0.0.1", port=9000)
    mock_uvicorn_run.assert_called_once_with(
        "deepeval_eval.api.app:app", host="127.0.0.1", port=9000, reload=False
    )
    mock_os_exit.assert_called_once_with(0)


def test_run_server_with_custom_host_and_port_invokes_uvicorn():
    with patch("uvicorn.run") as mock_uvicorn, patch("os._exit") as mock_exit:
        run_server(host="127.0.0.1", port=8888)
        mock_uvicorn.assert_called_once_with(
            "deepeval_eval.api.app:app",
            host="127.0.0.1",
            port=8888,
            reload=False,
        )
        mock_exit.assert_called_once_with(0)


@patch("os._exit")
@patch("uvicorn.run", side_effect=KeyboardInterrupt)
def test_run_server_keyboard_interrupt_reraises_and_exits(
    mock_uvicorn_run, mock_os_exit
):
    """Verify run_server reraises KeyboardInterrupt and calls os._exit."""
    with pytest.raises(KeyboardInterrupt):
        run_server(host="127.0.0.1", port=9000)
    mock_os_exit.assert_called_once_with(0)


@patch("os._exit")
@patch("uvicorn.run", side_effect=SystemExit(0))
def test_run_server_system_exit_reraises_and_exits(mock_uvicorn_run, mock_os_exit):
    """Verify run_server reraises SystemExit and calls os._exit."""
    with pytest.raises(SystemExit):
        run_server(host="127.0.0.1", port=9000)
    mock_os_exit.assert_called_once_with(0)


def test_healthz_and_livez_probes():
    """Verify shallow orchestrator liveness probes (/healthz and /livez)."""
    res1 = client.get("/healthz")
    assert res1.status_code == 200
    assert res1.json() == {"status": "ok"}

    res2 = client.get("/livez")
    assert res2.status_code == 200
    assert res2.json() == {"status": "ok"}


def test_readyz_probe():
    """Verify shallow readiness probe (/readyz)."""
    with patch.object(db_manager, "is_postgres", return_value=True):
        res = client.get("/readyz")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert "checks" in data
        assert data["checks"]["database"] == "connected"
        assert data["checks"]["job_manager"] == "connected"

    with patch.object(db_manager, "is_postgres", return_value=False):
        res_unavail = client.get("/readyz")
        assert res_unavail.status_code == 503
        data_unavail = res_unavail.json()
        assert data_unavail["status"] == "unavailable"
        assert data_unavail["checks"]["database"] == "error"


def test_health_deep_check():
    """Verify detailed status endpoint (/health) returns version, uptime, and checks."""
    res = client.get("/health")
    assert res.status_code in (200, 503)
    data = res.json()
    assert data["status"] in ("healthy", "degraded")
    assert data["version"] == "0.1.0"
    assert "uptime_seconds" in data
    assert isinstance(data["uptime_seconds"], (int, float))
    assert "checks" in data
    assert "database" in data["checks"]
    assert "job_manager" in data["checks"]


def test_metrics_prometheus():
    """Verify /metrics returns Prometheus format text via prometheus_client."""
    res_text = client.get("/metrics")
    assert res_text.status_code == 200
    assert "text/plain" in res_text.headers["content-type"]
    assert "deepeval_uptime_seconds" in res_text.text
    assert "deepeval_jobs_total" in res_text.text


def test_telemetry_endpoint_removed():
    """Verify non-standard /telemetry endpoint returns HTTP 404 (removed in favor of standard /metrics)."""
    res = client.get("/telemetry")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_lifespan_postgres_verification_failure_raises_runtime_error():
    """Verify application startup fails loudly if PostgreSQL connection verification fails."""
    with patch.object(
        db_manager,
        "verify_postgres_connection",
        side_effect=RuntimeError("Cannot connect to PostgreSQL"),
    ):
        with pytest.raises(
            RuntimeError, match="PostgreSQL database is required for CAIPE Evaluator"
        ):
            async with lifespan(app):
                pass


@pytest.mark.asyncio
async def test_lifespan_postgres_verification_success():
    """Verify application startup starts job queue after verifying PostgreSQL connection."""
    with patch.object(db_manager, "verify_postgres_connection") as mock_verify:
        with patch.object(persistent_job_queue, "start") as mock_start:
            with patch.object(persistent_job_queue, "stop") as mock_stop:
                async with lifespan(app):
                    mock_verify.assert_called_once()
                    mock_start.assert_called_once()
                mock_stop.assert_called_once()


def test_api_init_getattr_app_returns_fastapi_app():
    """Verify __getattr__ in api package dynamically imports and returns app."""
    import deepeval_eval.api as api_pkg

    app_instance = api_pkg.__getattr__("app")
    assert app_instance is not None
    assert hasattr(app_instance, "routes")


def test_api_init_getattr_run_server_returns_callable():
    """Verify __getattr__ in api package dynamically imports and returns run_server."""
    import deepeval_eval.api as api_pkg

    server_func = api_pkg.__getattr__("run_server")
    assert callable(server_func)


def test_api_init_getattr_unknown_attribute_raises_attribute_error():
    """Verify __getattr__ in api package raises AttributeError for unrecognized attributes."""
    import deepeval_eval.api as api_pkg

    with pytest.raises(AttributeError, match="has no attribute 'unknown_attr'"):
        api_pkg.__getattr__("unknown_attr")


def test_main_execution_invokes_run_server():
    """Verify executing app.py as main entrypoint invokes run_server."""
    import runpy

    with (
        patch("uvicorn.run") as mock_uvicorn,
        patch("os._exit") as mock_exit,
    ):
        runpy.run_module("deepeval_eval.api.app", run_name="__main__")
        mock_uvicorn.assert_called_once()
        mock_exit.assert_called_once_with(0)

from __future__ import annotations

from deepeval_eval.api.telemetry import TelemetryMetrics, setup_otlp_tracing


def test_telemetry_metrics_initialization():
    """Verify TelemetryMetrics initializes and returns valid uptime."""
    tm = TelemetryMetrics()
    assert tm.get_uptime_seconds() >= 0.0


def test_telemetry_metrics_recording():
    """Verify metric recording methods produce valid Prometheus exposition output."""
    tm = TelemetryMetrics()
    tm.record_cache_hit()
    tm.record_cache_miss()
    tm.record_evaluation(1.5)
    tm.record_http_request("/health", 200)

    content, media_type = tm.export_prometheus()
    prom_text = content.decode("utf-8")
    assert "text/plain" in media_type
    assert "deepeval_uptime_seconds" in prom_text
    assert "deepeval_cache_hits_total" in prom_text
    assert "deepeval_cache_misses_total" in prom_text
    assert "deepeval_evaluations_total" in prom_text
    assert 'deepeval_http_requests_total{endpoint="/health",status="200"}' in prom_text


def test_export_prometheus_when_job_manager_provided_updates_status_gauges() -> None:
    from enum import Enum
    from unittest.mock import MagicMock

    class MockStatus(Enum):
        RUNNING = "running"

    tm = TelemetryMetrics()
    mock_jm = MagicMock()
    mock_jm.jobs = {
        "j1": {"status": MockStatus.RUNNING},
        "j2": {"status": "completed"},
        "j3": {"status": "failed"},
        "j4": {"status": "pending"},
    }
    content, _ = tm.export_prometheus(job_manager=mock_jm)
    prom_text = content.decode("utf-8")
    assert "deepeval_jobs_total" in prom_text


def test_setup_otlp_tracing():
    """Verify OTLP tracing setup function handles missing collector gracefully."""
    result = setup_otlp_tracing()
    assert isinstance(result, bool)


def test_trace_evaluation_span():
    """Verify trace_evaluation_span creates context manager without raising exceptions."""
    from deepeval_eval.api.telemetry import trace_evaluation_span

    with trace_evaluation_span(
        "enterprise", {"answer_mode": "generate", "max_items": 5}
    ):
        pass


def test_setup_otlp_tracing_with_endpoint_and_app(monkeypatch):
    """Verify setup_otlp_tracing configures provider and instruments FastAPI app when endpoint is provided."""
    from unittest.mock import patch

    from fastapi import FastAPI

    from deepeval_eval.api.telemetry import setup_otlp_tracing

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    app = FastAPI()

    with (
        patch("opentelemetry.trace.set_tracer_provider"),
        patch("opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter"),
        patch("opentelemetry.sdk.trace.export.BatchSpanProcessor"),
        patch("opentelemetry.sdk.trace.TracerProvider"),
        patch(
            "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app"
        ) as mock_inst,
    ):
        res = setup_otlp_tracing(app=app)
        assert res is True
        mock_inst.assert_called_once_with(app)


def test_get_tracer_when_opentelemetry_fails_returns_dummy_tracer() -> None:
    """Verify get_tracer falls back to DummyTracer when opentelemetry trace fails."""
    from unittest.mock import patch

    from deepeval_eval.api.telemetry import get_tracer

    with patch(
        "opentelemetry.trace.get_tracer", side_effect=RuntimeError("OTel disabled")
    ):
        tracer = get_tracer("test-tracer")
        span = tracer.start_as_current_span("test-span")
        with span as s:
            s.set_attribute("key", "val")
        assert tracer.__class__.__name__ == "DummyTracer"


def test_setup_otlp_tracing_when_instrumentation_fails_logs_debug_and_returns_true(
    monkeypatch,
) -> None:
    from unittest.mock import patch

    from fastapi import FastAPI

    from deepeval_eval.api.telemetry import setup_otlp_tracing

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    app = FastAPI()

    with (
        patch("opentelemetry.trace.set_tracer_provider"),
        patch("opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter"),
        patch("opentelemetry.sdk.trace.export.BatchSpanProcessor"),
        patch("opentelemetry.sdk.trace.TracerProvider"),
        patch(
            "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app",
            side_effect=RuntimeError("FastAPI instrument failed"),
        ),
    ):
        result = setup_otlp_tracing(app=app)
        assert result is True


def test_setup_otlp_tracing_when_importerror_or_setup_fails_returns_false(
    monkeypatch,
) -> None:
    from unittest.mock import patch

    from deepeval_eval.api.telemetry import setup_otlp_tracing

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    with patch(
        "opentelemetry.trace.set_tracer_provider",
        side_effect=RuntimeError("OTel setup failed"),
    ):
        result = setup_otlp_tracing()
        assert result is False


def test_trace_evaluation_span_when_dataset_name_empty_defaults_to_enterprise() -> None:
    from unittest.mock import MagicMock, patch

    from deepeval_eval.api.telemetry import trace_evaluation_span

    mock_span = MagicMock()
    mock_tracer = MagicMock()
    mock_tracer.start_as_current_span.return_value = mock_span

    with patch("deepeval_eval.api.telemetry.get_tracer", return_value=mock_tracer):
        with trace_evaluation_span(
            "",
            {
                "answer_mode": "generate",
                "datasource_id": "ds-1",
                "prompt_style": "custom",
                "max_items": 10,
                "unknown_key": "val",
            },
        ):
            pass

    mock_span.set_attribute.assert_any_call("deepeval.dataset", "enterprise")
    mock_span.set_attribute.assert_any_call("deepeval.answer_mode", "generate")
    mock_span.set_attribute.assert_any_call("deepeval.datasource_id", "ds-1")
    mock_span.set_attribute.assert_any_call("deepeval.prompt_style", "custom")
    mock_span.set_attribute.assert_any_call("deepeval.max_items", "10")


def test_trace_evaluation_span_when_config_dict_none_sets_system_attributes() -> None:
    from unittest.mock import MagicMock, patch

    from deepeval_eval.api.telemetry import trace_evaluation_span

    mock_span = MagicMock()
    mock_tracer = MagicMock()
    mock_tracer.start_as_current_span.return_value = mock_span

    with patch("deepeval_eval.api.telemetry.get_tracer", return_value=mock_tracer):
        with trace_evaluation_span("custom_dataset", None):
            pass

    mock_span.set_attribute.assert_any_call("gen_ai.system", "deepeval")
    mock_span.set_attribute.assert_any_call("deepeval.dataset", "custom_dataset")


def test_liveness_probe_endpoint_returns_ok_status() -> None:
    from deepeval_eval.api.telemetry import liveness_probe

    result = liveness_probe()
    assert result == {"status": "ok"}


def test_readiness_probe_when_database_not_ready_returns_503_unavailable() -> None:
    from unittest.mock import MagicMock, patch

    from fastapi import Response

    from deepeval_eval.api.telemetry import readiness_probe

    mock_db = MagicMock()
    mock_db.is_postgres.return_value = False
    mock_job = MagicMock()
    response = Response()

    with (
        patch("deepeval_eval.api.job_manager.db_manager", mock_db),
        patch("deepeval_eval.api.job_manager.job_manager", mock_job),
    ):
        result = readiness_probe(response=response)
        assert response.status_code == 503
        assert result["status"] == "unavailable"
        assert result["checks"]["database"] == "error"
        assert result["checks"]["job_manager"] == "connected"


def test_readiness_probe_when_all_dependencies_ready_returns_ok() -> None:
    from unittest.mock import MagicMock, patch

    from fastapi import Response

    from deepeval_eval.api.telemetry import readiness_probe

    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_job = MagicMock()
    response = Response()

    with (
        patch("deepeval_eval.api.job_manager.db_manager", mock_db),
        patch("deepeval_eval.api.job_manager.job_manager", mock_job),
    ):
        result = readiness_probe(response=response)
        assert response.status_code == 200
        assert result["status"] == "ok"
        assert result["checks"]["database"] == "connected"
        assert result["checks"]["job_manager"] == "connected"


def test_health_check_when_db_exception_occurs_returns_degraded_and_503() -> None:
    from unittest.mock import MagicMock, patch

    from fastapi import Response

    from deepeval_eval.api.telemetry import health_check

    mock_db = MagicMock()
    mock_db.is_postgres.side_effect = RuntimeError("DB connection timeout")
    mock_job = MagicMock()
    response = Response()

    with (
        patch("deepeval_eval.api.job_manager.db_manager", mock_db),
        patch("deepeval_eval.api.job_manager.job_manager", mock_job),
    ):
        result = health_check(response=response)
        assert result["checks"]["database"] == "degraded"
        assert result["status"] == "healthy"


def test_health_check_when_job_manager_missing_returns_503_unavailable() -> None:
    from unittest.mock import MagicMock, patch

    from fastapi import Response

    from deepeval_eval.api.telemetry import health_check

    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    response = Response()

    with (
        patch("deepeval_eval.api.job_manager.db_manager", mock_db),
        patch("deepeval_eval.api.job_manager.job_manager", None),
    ):
        result = health_check(response=response)
        assert response.status_code == 503
        assert result["status"] == "degraded"
        assert result["checks"]["job_manager"] == "error"


def test_metrics_endpoint_when_called_returns_prometheus_response() -> None:
    from unittest.mock import MagicMock, patch

    from deepeval_eval.api.telemetry import metrics_endpoint

    mock_job_mgr = MagicMock()
    mock_job_mgr.list_all_jobs.return_value = []

    with patch("deepeval_eval.api.job_manager.job_manager", mock_job_mgr):
        response = metrics_endpoint()
        assert response.status_code == 200
        assert "text/plain" in response.media_type

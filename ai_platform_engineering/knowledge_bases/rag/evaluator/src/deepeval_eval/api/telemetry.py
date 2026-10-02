from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

from fastapi import APIRouter, Response, status
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

logger = logging.getLogger(__name__)

# Standard Prometheus Collector Registry for DeepEval Evaluation Service
REGISTRY = CollectorRegistry()

START_TIME = time.time()

# Prometheus Metrics Definition
UPTIME_GAUGE = Gauge(
    "deepeval_uptime_seconds",
    "Total seconds the API service has been running.",
    registry=REGISTRY,
)

JOBS_GAUGE = Gauge(
    "deepeval_jobs_total",
    "Total evaluation jobs by status.",
    ["status"],
    registry=REGISTRY,
)

CACHE_HITS_COUNTER = Counter(
    "deepeval_cache_hits_total",
    "Total evaluation cache hits.",
    registry=REGISTRY,
)

CACHE_MISSES_COUNTER = Counter(
    "deepeval_cache_misses_total",
    "Total evaluation cache misses.",
    registry=REGISTRY,
)

EVALUATIONS_COUNTER = Counter(
    "deepeval_evaluations_total",
    "Total evaluations completed.",
    registry=REGISTRY,
)

EVALUATION_DURATION_HISTOGRAM = Histogram(
    "deepeval_evaluation_duration_seconds",
    "Duration in seconds spent running evaluations.",
    registry=REGISTRY,
)

HTTP_REQUESTS_COUNTER = Counter(
    "deepeval_http_requests_total",
    "Total HTTP requests handled by endpoint and status code.",
    ["endpoint", "status"],
    registry=REGISTRY,
)


class TelemetryMetrics:
    """Thread-safe telemetry metrics manager leveraging prometheus_client and OTel standards."""

    def record_cache_hit(self) -> None:
        CACHE_HITS_COUNTER.inc()

    def record_cache_miss(self) -> None:
        CACHE_MISSES_COUNTER.inc()

    def record_evaluation(self, duration: float) -> None:
        EVALUATIONS_COUNTER.inc()
        EVALUATION_DURATION_HISTOGRAM.observe(duration)

    def record_http_request(self, endpoint: str, status_code: int) -> None:
        HTTP_REQUESTS_COUNTER.labels(endpoint=endpoint, status=str(status_code)).inc()

    def get_uptime_seconds(self) -> float:
        return time.time() - START_TIME

    def update_job_status_counts(self, job_manager: Any = None) -> None:
        """Update job status gauge counts from job manager state."""
        counts = {"pending": 0, "running": 0, "completed": 0, "failed": 0}
        if job_manager and hasattr(job_manager, "jobs"):
            with getattr(job_manager, "_lock", threading.Lock()):
                for job in job_manager.jobs.values():
                    status_val = job.get("status")
                    status_str = (
                        status_val.value
                        if hasattr(status_val, "value")
                        else str(status_val)
                    )
                    counts[status_str] = counts.get(status_str, 0) + 1

        for status_name, count in counts.items():
            JOBS_GAUGE.labels(status=status_name).set(count)

    def export_prometheus(self, job_manager: Any = None) -> tuple[bytes, str]:
        """Generate Prometheus exposition format payload for GET /metrics."""
        UPTIME_GAUGE.set(self.get_uptime_seconds())
        self.update_job_status_counts(job_manager)
        return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


def setup_otlp_tracing(app: Any = None) -> bool:
    """Set up OpenTelemetry tracer provider and OTLP exporter if configured via environment variables."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    enable_otel = os.environ.get("ENABLE_OTEL_TRACING", "").lower() in (
        "true",
        "1",
        "yes",
    )
    if not endpoint and not enable_otel:
        logger.debug(
            "OpenTelemetry OTLP setup skipped: OTEL_EXPORTER_OTLP_ENDPOINT or ENABLE_OTEL_TRACING not set"
        )
        return False

    endpoint = endpoint or "http://localhost:4317"
    service_name = os.environ.get("OTEL_SERVICE_NAME", "deepeval-evaluator")

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create({"service.name": service_name})
        provider = TracerProvider(resource=resource)
        processor = BatchSpanProcessor(
            OTLPSpanExporter(endpoint=endpoint, insecure=True)
        )
        provider.add_span_processor(processor)
        trace.set_tracer_provider(provider)

        if app:
            try:
                from opentelemetry.instrumentation.fastapi import (
                    FastAPIInstrumentor,
                )

                FastAPIInstrumentor.instrument_app(app)
            except Exception as inst_err:
                logger.debug(f"FastAPI OTel auto-instrumentation deferred: {inst_err}")

        logger.info(
            f"OpenTelemetry initialized for '{service_name}' sending OTLP to {endpoint}"
        )
        return True
    except Exception as e:
        logger.debug(f"OpenTelemetry OTLP setup skipped/deferred: {e}")
        return False


# Global telemetry metrics instance
telemetry_metrics = TelemetryMetrics()


def get_tracer(name: str = "deepeval-evaluator") -> Any:
    """Get an OpenTelemetry Tracer instance with graceful fallback."""
    try:
        from opentelemetry import trace

        return trace.get_tracer(name)
    except Exception:

        class DummySpan:
            def set_attribute(self, key: str, value: Any) -> None:
                # No-op fallback when OpenTelemetry trace is not installed or enabled
                pass

            def __enter__(self) -> DummySpan:
                return self

            def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
                # No-op context manager exit for DummySpan fallback
                pass

        class DummyTracer:
            def start_as_current_span(self, name: str, **kwargs: Any) -> DummySpan:
                return DummySpan()

        return DummyTracer()


def trace_evaluation_span(
    dataset_name: str, config_dict: dict[str, Any] | None = None
) -> Any:
    """OpenTelemetry context manager for tracing DeepEval dataset evaluations."""
    tracer = get_tracer("deepeval-evaluator")
    span = tracer.start_as_current_span("deepeval.evaluate_dataset")
    if hasattr(span, "set_attribute"):
        span.set_attribute("gen_ai.system", "deepeval")
        span.set_attribute("deepeval.dataset", dataset_name or "enterprise")
        if config_dict:
            for k in ("answer_mode", "datasource_id", "prompt_style", "max_items"):
                if config_dict.get(k) is not None:
                    span.set_attribute(f"deepeval.{k}", str(config_dict[k]))
    return span


# ---------------------------------------------------------------------------
# FastAPI Health & Telemetry Router
# ---------------------------------------------------------------------------

telemetry_router = APIRouter(tags=["Health & Telemetry"])


@telemetry_router.get(
    "/healthz",
    summary="Internal Liveness Probe (Kubernetes/Orchestrators)",
)
@telemetry_router.get(
    "/livez",
    summary="Internal Liveness Probe",
)
def liveness_probe() -> dict[str, str]:
    """Fast, shallow liveness check to verify process availability without hitting DB/cache."""
    return {"status": "ok"}


@telemetry_router.get(
    "/readyz",
    summary="Internal Readiness Probe",
)
def readiness_probe(response: Response) -> dict[str, Any]:
    """Shallow readiness check verifying process and database readiness."""
    from deepeval_eval.api.job_manager import db_manager, job_manager

    db_ready = db_manager.is_postgres()
    checks = {
        "database": "connected" if db_ready else "error",
        "job_manager": "connected" if job_manager else "error",
    }
    is_ready = all(v == "connected" for v in checks.values())
    if not is_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "checks": checks}
    return {"status": "ok", "checks": checks}


@telemetry_router.get(
    "/health",
    summary="Public Uptime & Detailed Status Endpoint",
)
def health_check(response: Response) -> dict[str, Any]:
    """Deep health check returning rich diagnostic details per component."""
    from deepeval_eval.api.job_manager import db_manager, job_manager

    job_mgr_ok = job_manager is not None
    db_status = "not_configured"
    try:
        if db_manager.is_postgres():
            db_status = "connected"
    except Exception as db_err:
        logger.debug(f"Health check DB probe error: {db_err}")
        db_status = "degraded"

    checks = {
        "job_manager": "connected" if job_mgr_ok else "error",
        "database": db_status,
    }

    is_healthy = job_mgr_ok and db_status != "error"
    overall_status = "healthy" if is_healthy else "degraded"

    if not is_healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {
        "status": overall_status,
        "version": "0.1.0",
        "uptime_seconds": round(telemetry_metrics.get_uptime_seconds(), 2),
        "checks": checks,
    }


@telemetry_router.get(
    "/metrics",
    summary="Prometheus / OpenTelemetry Metrics Endpoint",
)
def metrics_endpoint() -> Response:
    """Return operational metrics in standard Prometheus Exposition format for Prometheus/Mimir scrapers."""
    from deepeval_eval.api.job_manager import job_manager

    content, media_type = telemetry_metrics.export_prometheus(job_manager)
    return Response(content=content, media_type=media_type)

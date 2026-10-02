from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    Request,
    Response,
)

from deepeval_eval.api.auth import (
    UserContext,
    get_current_user,
)
from deepeval_eval.api.evaluation_jobs import (
    router as evaluation_jobs_router,
)
from deepeval_eval.api.evaluation_results import (
    router as evaluation_results_router,
)
from deepeval_eval.api.job_manager import (
    db_manager,
    persistent_job_queue,
)
from deepeval_eval.api.metric_sets import router as metric_sets_router
from deepeval_eval.api.metrics import router as metrics_router
from deepeval_eval.api.prompt_styles import router as prompt_styles_router
from deepeval_eval.api.question_sets import router as question_sets_router
from deepeval_eval.api.telemetry import (
    setup_otlp_tracing,
    telemetry_metrics,
    telemetry_router,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

API_V1_PREFIX = "/api/v1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Strictly verify PostgreSQL connectivity on startup; fail loudly if unreachable
    try:
        db_manager.verify_postgres_connection()
        logger.info(
            "PostgreSQL database connection verified and schema initialized successfully."
        )
    except Exception as exc:
        logger.exception(
            f"Fatal startup error: PostgreSQL database is unreachable or unconfigured: {exc}"
        )
        raise RuntimeError(
            f"PostgreSQL database is required for CAIPE Evaluator service, but failed to connect: {exc}"
        ) from exc

    persistent_job_queue.start()
    try:
        yield
    finally:
        persistent_job_queue.stop()


# ---------------------------------------------------------------------------
# FastAPI Application Definition
# ---------------------------------------------------------------------------

app = FastAPI(
    title="CAIPE DeepEval REST API Evaluation Service",
    description=(
        "REST API service to trigger evaluation pipelines, submit datasets, "
        "manage async evaluation jobs, poll execution results, query PostgreSQL "
        "evaluation runs, and leverage 24-hour evaluation caching."
    ),
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# Initialize CAIPE OpenTelemetry tracing exporter if configured via environment
setup_otlp_tracing(app)


@app.middleware("http")
async def telemetry_middleware(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    endpoint = request.url.path
    telemetry_metrics.record_http_request(endpoint, response.status_code)
    return response


@app.get("/", summary="Root Endpoint", include_in_schema=False)
def root_endpoint(
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    return {
        "service": "CAIPE DeepEval REST API Evaluation Service",
        "version": "0.1.0",
        "status": "online",
        "docs_url": "/docs",
        "redoc_url": "/redoc",
    }


# Mount Routers
app.include_router(telemetry_router)
app.include_router(question_sets_router, prefix=API_V1_PREFIX)
app.include_router(prompt_styles_router, prefix=API_V1_PREFIX)
app.include_router(metrics_router, prefix=API_V1_PREFIX)
app.include_router(metric_sets_router, prefix=API_V1_PREFIX)
app.include_router(evaluation_jobs_router)
app.include_router(evaluation_results_router)


def run_server(host: str = "0.0.0.0", port: int = 8000) -> None:
    """CLI launcher for starting the Uvicorn ASGI server."""
    import uvicorn

    try:
        uvicorn.run("deepeval_eval.api.app:app", host=host, port=port, reload=False)
    except (KeyboardInterrupt, SystemExit):
        logger.info("KeyboardInterrupt received, exiting server process cleanly...")
        raise
    finally:
        # Force immediate process termination to prevent non-daemon worker threads
        # from third-party libraries (deepeval/langchain) hanging during python _shutdown
        os._exit(0)


if __name__ == "__main__":
    run_server()

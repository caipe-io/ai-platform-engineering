"""Dynamic Agents FastAPI Application."""

import asyncio
import os
from contextlib import asynccontextmanager

import dotenv

dotenv.load_dotenv()  # Ensure .env is in os.environ before any boto3/httpx clients are created

from dynamic_agents.log_config import setup_logging

# Setup logging before other imports that trigger cnoe-agent-utils
logger = setup_logging()


def fatal_exit(message: str) -> None:
    """Log a critical error and forcefully terminate the process.

    Uses os._exit(1) to bypass exception handlers and ensure immediate termination,
    which is necessary when running under uvicorn with reload mode.
    """
    logger.critical(message)
    os._exit(1)


# ruff: noqa: E402
# Imports must be after logging setup to ensure our format is used
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from dynamic_agents.config import get_settings
from dynamic_agents.metrics import PrometheusHTTPMiddleware
from dynamic_agents.routes import (
    agents,
    assistant,
    builtin_tools,
    chat,
    conversations,
    files,
    health,
    mcp_servers,
    memories,
    middleware,
    projects,
)
from dynamic_agents.services.mongo import get_mongo_service, reset_mongo_service
from dynamic_agents.services.runtime_cache import RuntimeCapacityError, RuntimeInitError, get_runtime_cache


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    settings = get_settings()
    logger.info("Starting Dynamic Agents service...")

    from dynamic_agents.services.mcp_client import warn_if_agent_gateway_missing_hmac

    warn_if_agent_gateway_missing_hmac()

    # Eagerly initialise tracing + scrubber so the OTel processor
    # is registered before any span fires (FastAPI middleware,
    # MongoDB ping, etc.). The per-AgentRuntime install is kept as
    # a defence-in-depth idempotent fallback in case the lifespan
    # hook is bypassed (e.g. some unit-test setups instantiate
    # AgentRuntime without going through main:app).
    # Vendored scrubber lives under
    # ``dynamic_agents.services.skill_scrubber`` — see the file
    # header for the source-of-truth location.
    try:
        from cnoe_agent_utils.tracing import TracingManager

        from dynamic_agents.services.skill_scrubber import install_skill_content_scrubber

        TracingManager()
        install_skill_content_scrubber()
    except Exception as exc:  # noqa: BLE001 — tracing is best-effort
        logger.warning("Eager tracing/scrubber init failed: %s", exc)

    # MongoDB connection with retry logic
    max_retries = 5
    base_delay = 2  # seconds

    mongo = None
    for attempt in range(max_retries):
        mongo = get_mongo_service()
        if mongo._client is not None:
            logger.info(f"Connected to MongoDB: {settings.mongodb_database}")
            break

        if attempt < max_retries - 1:
            delay = base_delay * (2**attempt)  # 2, 4, 8, 16, 32 seconds
            logger.warning(f"MongoDB connection failed, retrying in {delay}s (attempt {attempt + 1}/{max_retries})...")
            await asyncio.sleep(delay)
            # Reset singleton to allow fresh connection attempt
            reset_mongo_service()
    else:
        # All retries exhausted - crash the service
        fatal_exit(f"Failed to connect to MongoDB after {max_retries} attempts. Service cannot start without MongoDB.")

    # Start runtime cache background sweep
    cache = get_runtime_cache()
    cache.set_mongo_service(mongo)
    cache.start()

    # Ensure GridFS TTL index for automatic file expiry
    if mongo._db is not None:
        from dynamic_agents.services.gridfs_store import MongoDBGridFSStore

        store = MongoDBGridFSStore(db=mongo._db, bucket_name=settings.gridfs_bucket_name)
        store.ensure_ttl_index()
        logger.info("GridFS TTL index ensured (per-document expireAt)")
        memory_store = MongoDBGridFSStore(
            db=mongo._db,
            bucket_name=settings.memory_gridfs_bucket_name,
            ttl_seconds=0,
        )
        try:
            memory_store.ensure_identity_index()
            logger.info("Memory GridFS namespace/key identity index ensured")
        except Exception as exc:  # noqa: BLE001 - report legacy duplicates without hiding startup
            logger.error("Could not ensure memory identity index: %s", exc)
            raise

    yield

    # Cleanup on shutdown
    logger.info("Shutting down Dynamic Agents service...")

    # Stop sweep and clear agent runtime cache
    await cache.stop()

    # Disconnect MongoDB
    mongo.disconnect()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="Dynamic Agents Service",
        description="Create, configure, and run ephemeral AI agents dynamically",
        version="0.1.0",
        lifespan=lifespan,
    )

    # Add CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Prometheus HTTP metrics middleware (from main). Mounted BEFORE the
    # JWT auth middleware so failed-auth and CORS-preflight requests are
    # still observable.
    # When METRICS_PORT is set to a port other than the main API port,
    # /metrics is served by a separate standalone server (see below) instead
    # of on the main port — e.g. to keep the main port on strict mTLS while
    # leaving the metrics port permissive for scrapers that don't support
    # mTLS client certs.
    serve_metrics_on_main_port = settings.metrics_port in (0, settings.port)
    app.add_middleware(PrometheusHTTPMiddleware, serve_metrics=serve_metrics_on_main_port)

    # Spec 102 Phase 8 / T103: validate incoming Bearer JWTs against
    # Keycloak and bind current_user_token so the MCP httpx factory can
    # forward the user identity to agentgateway. Mounted AFTER CORS so
    # CORS preflights are not auth-gated.
    from dynamic_agents.auth.jwt_middleware import JwtAuthMiddleware

    app.add_middleware(JwtAuthMiddleware)

    # Mount routes
    app.include_router(health.router)
    app.include_router(builtin_tools.router, prefix="/api/v1")
    app.include_router(mcp_servers.router, prefix="/api/v1")
    app.include_router(agents.router, prefix="/api/v1")
    app.include_router(chat.router, prefix="/api/v1")
    app.include_router(conversations.router, prefix="/api/v1")
    app.include_router(files.router, prefix="/api/v1")
    app.include_router(memories.router, prefix="/api/v1")
    app.include_router(projects.router, prefix="/api/v1")
    app.include_router(assistant.router, prefix="/api/v1")
    app.include_router(middleware.router, prefix="/api/v1")

    @app.exception_handler(RuntimeInitError)
    async def runtime_init_error_handler(request: Request, exc: RuntimeInitError):
        """Return a 503 with a descriptive message when runtime initialization fails."""
        return JSONResponse(
            status_code=503,
            content={
                "detail": str(exc),
                "agent_id": exc.agent_id,
                "error_type": type(exc.cause).__name__,
            },
        )

    @app.exception_handler(RuntimeCapacityError)
    async def runtime_capacity_error_handler(request: Request, exc: RuntimeCapacityError):
        """Return a 503 when the runtime cache is at capacity."""
        return JSONResponse(
            status_code=503,
            content={
                "error": "agent_busy",
                "message": "This agent is at capacity right now. Please try again in a moment.",
                "retry_after_seconds": 5,
            },
            headers={"Retry-After": "5"},
        )

    @app.get("/")
    async def root():
        """Root endpoint."""
        return {
            "service": "dynamic-agents",
            "version": "0.1.0",
            "docs": "/docs",
        }

    # Spec 102 Phase 11.2 — expose Prometheus metrics so the RBAC PDP
    # cache hit/miss + decision counters set in
    # ai_platform_engineering.utils.auth.metrics are scrapeable. The
    # endpoint is intentionally NOT auth-gated (standard /metrics
    # convention; restrict via NetworkPolicy in production).
    # Skipped when METRICS_PORT moves /metrics to a dedicated port (see
    # serve_metrics_on_main_port above and run_metrics_server below).
    if serve_metrics_on_main_port:
        try:
            from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
            from starlette.responses import Response

            @app.get("/metrics", include_in_schema=False)
            async def metrics() -> Response:
                return Response(
                    content=generate_latest(),
                    media_type=CONTENT_TYPE_LATEST,
                )
        except ImportError:
            logger.warning(
                "prometheus_client not installed; /metrics endpoint disabled"
            )

    return app


# Application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()

    # Serve /metrics on its own port when METRICS_PORT differs from the main
    # API port (see serve_metrics_on_main_port in create_app). Uses
    # prometheus_client's own WSGI server, started in a background thread,
    # against the same default collector registry the app's metrics use.
    if settings.metrics_port and settings.metrics_port != settings.port:
        from prometheus_client import start_http_server

        start_http_server(settings.metrics_port, addr=settings.host)
        logger.info("Metrics server listening on %s:%s/metrics", settings.host, settings.metrics_port)

    uvicorn.run(
        "dynamic_agents.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )

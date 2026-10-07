"""Autonomous Agents FastAPI Application."""

import asyncio
from contextlib import asynccontextmanager

from autonomous_agents.log_config import setup_logging

logger = setup_logging()

# ruff: noqa: E402
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from autonomous_agents.config import get_settings
from autonomous_agents.error_handlers import webhook_secret_encryption_error_handler
from autonomous_agents.routes import health, tasks, webex, webhooks
from autonomous_agents.routes.webex import set_bot_person_id, set_webex_client
from autonomous_agents.services.chat_history import NoopChatHistoryPublisher
from autonomous_agents.services.mongo import (
    MongoChatHistoryPublisherAdapter,
    MongoRunStoreAdapter,
    MongoTaskStoreAdapter,
    MongoWebexThreadMapAdapter,
    get_mongo_service,
    reset_mongo_service,
)
from autonomous_agents.services.scheduler import (
    get_scheduler,
    register_scheduler_tasks,
)
from autonomous_agents.services.secret_encryption import WebhookSecretEncryptionError
from autonomous_agents.services.task_lifecycle import set_task_store
from autonomous_agents.services.task_runner import (
    set_chat_history_publisher,
    set_run_store,
    set_webex_thread_map,
)
from autonomous_agents.services.webex_inbound import (
    WebexClient,
    ensure_webhook_registered,
)
from autonomous_agents.services.webhook_adapters import load_adapters
from autonomous_agents.services.webhook_runtime import register_webhook_tasks


def fatal_exit(message: str, exit_code: int = 1) -> None:
    """Logs a critical error and terminate the process with exit_code.

    Uses SystemExit so that pytest/reload loops can catch
    it without killing their whole harness, while uvicorn main:app
    still terminates normally.
    """
    logger.critical(message)
    raise SystemExit(exit_code)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    settings = get_settings()
    logger.info("Starting Autonomous Agents service...")

    # Load webhook provider adapters (pointed at by WEBHOOK_PROVIDERS_FILE).
    try:
        load_adapters(settings.webhook_providers_file)
    except (FileNotFoundError, ValueError) as exc:
        fatal_exit(f"Failed to load webhook_providers.yaml: {exc}")

    # Ensure required MongoDB config is present before connecting
    if not settings.mongodb_uri or not settings.mongodb_database:
        fatal_exit(
            "MONGODB_URI and MONGODB_DATABASE must both be set. "
            f"(MONGODB_URI={'set' if settings.mongodb_uri else 'UNSET'}, "
            f"MONGODB_DATABASE={'set' if settings.mongodb_database else 'UNSET'}). "
            "Configure them in your .env / environment before restarting."
        )

    mongo = get_mongo_service()
    max_attempts = settings.mongodb_connect_max_attempts
    delay = settings.mongodb_connect_retry_delay_seconds
    connected = False
    for attempt in range(1, max_attempts + 1):
        connected = await mongo.connect()
        if connected:
            break
        if attempt < max_attempts:
            logger.warning(
                "MongoDB connect attempt %d/%d failed; retrying in %.1fs",
                attempt,
                max_attempts,
                delay,
            )
            # Clear partial state and rebuild the singleton so the next
            # attempt gets a fresh client rather than reusing a broken
            # one.
            reset_mongo_service()
            mongo = get_mongo_service()
            await asyncio.sleep(delay)

    if not connected:
        fatal_exit(
            f"Failed to connect to MongoDB after {max_attempts} attempt(s). "
            "See prior error logs for the underlying driver exception. "
            "Verify MONGODB_URI, network reachability, and credentials, "
            "then restart."
        )

    task_store = MongoTaskStoreAdapter(mongo)
    run_store = MongoRunStoreAdapter(mongo)
    logger.info(
        "TaskStore + RunStore: MongoDB (db=%s, tasks=%s, runs=%s)",
        settings.mongodb_database,
        settings.mongodb_tasks_collection,
        settings.mongodb_collection,
    )
    if settings.chat_history_publish_enabled:
        chat_publisher = MongoChatHistoryPublisherAdapter(mongo)
        logger.info(
            "ChatHistoryPublisher: MongoDB (db=%s, owner=%s)",
            settings.chat_history_database or settings.mongodb_database,
            settings.chat_history_owner_email,
        )
    else:
        # Chat-history publishing stays opt-in even with Mongo connected:
        # some deployments route autonomous runs elsewhere (or suppress
        # them from the chat sidebar entirely) while still persisting
        # task/run state in Mongo. ``NoopChatHistoryPublisher`` gives the
        # scheduler a no-op target so it doesn't need a null check.
        chat_publisher = NoopChatHistoryPublisher()
        logger.info(
            "ChatHistoryPublisher: disabled (set "
            "CHAT_HISTORY_PUBLISH_ENABLED=true to surface autonomous "
            "runs in the chat sidebar)"
        )

    set_task_store(task_store)
    set_run_store(run_store)
    set_chat_history_publisher(chat_publisher)

    # Webex thread map: lets the scheduler record (messageId -> run_id)
    # for every Webex post_message tool call on a successful run, so a
    # later in-thread reply (delivered by the Webex bot bridge as a
    # /hooks/{task_id}/follow-up POST) can be routed back to the same
    # task. Plain Mongo-backed adapter -- no extra config required when
    # MongoDB is up, and the scheduler treats this as opt-in so tests
    # / deployments without a bot pay nothing for the seam.
    webex_thread_map = MongoWebexThreadMapAdapter(mongo)
    set_webex_thread_map(webex_thread_map)
    logger.info(
        "WebexThreadMap: MongoDB (db=%s, collection=%s, ttl_days=%d)",
        settings.mongodb_database,
        settings.mongodb_webex_thread_map_collection,
        settings.webex_thread_map_ttl_days,
    )

    # MongoDB is the single source of truth for task definitions.
    # At startup we read the persisted task set and register it with
    # the scheduler + webhook router; there is no YAML bootstrap path.
    runtime_tasks = await task_store.list_all()
    logger.info("Loaded %d persisted task(s) from MongoDB", len(runtime_tasks))
    register_webhook_tasks(runtime_tasks)
    register_scheduler_tasks(runtime_tasks)

    # ------------------------------------------------------------------
    # Webex inbound: register the Webex webhook + initialise the client.
    # ------------------------------------------------------------------
    # Driven by ``settings.webex_enabled`` (which is just
    # ``webex_bot_token is not None``). When off, the route returns 503
    # on every request and no Webex API call is ever made -- the
    # feature is fully dormant for deployments that don't use it.
    #
    # Failures here log loudly but do NOT block startup -- this matches
    # the legacy bot's behaviour and prevents a Webex API outage from
    # taking the autonomous-agents service down.
    webex_client: WebexClient | None = None
    if settings.webex_enabled:
        # Type narrowing for the validator-enforced "token + URL set together".
        assert settings.webex_bot_token is not None
        assert settings.webex_bot_public_url is not None
        try:
            webex_client = WebexClient(
                token=settings.webex_bot_token,
                base_url=settings.webex_api_base,
                timeout=settings.webex_http_timeout_seconds,
            )
            me = await webex_client.get_me()
            bot_person_id = me.get("id")
            if not bot_person_id:
                raise RuntimeError(
                    "Webex /people/me returned no id; refusing to start "
                    "Webex inbound without a loopguard identity."
                )
            logger.info("Webex bot identified as personId=%s", bot_person_id)
            set_bot_person_id(bot_person_id)
            set_webex_client(webex_client)

            target_url = (
                f"{settings.webex_bot_public_url.rstrip('/')}"
                "/api/v1/hooks/webex/events"
            )
            try:
                await ensure_webhook_registered(
                    webex_client,
                    target_url=target_url,
                    secret=settings.webex_webhook_secret,
                )
            except httpx.HTTPError as exc:
                # Don't crash on registration failure -- operators may
                # manage registrations manually, and the route still
                # accepts inbound traffic from any pre-existing
                # registration that points at us.
                logger.error(
                    "Webex webhook registration failed (%s); inbound "
                    "route is still live, but Webex may need a manual "
                    "re-registration.",
                    exc,
                )

            if not settings.webex_webhook_secret:
                logger.warning(
                    "Webex inbound enabled WITHOUT WEBEX_WEBHOOK_SECRET. "
                    "Anyone who knows the public URL can forge events. "
                    "Strongly recommended for production."
                )
        except Exception as exc:  # noqa: BLE001 -- registration must not crash startup
            logger.error(
                "Failed to initialise Webex inbound: %s. Route will return "
                "503 until the issue is resolved and the service is "
                "restarted.",
                exc,
            )
            # Tear down any partially-constructed client so we don't
            # leak the httpx connection pool.
            if webex_client is not None:
                await webex_client.aclose()
                webex_client = None
            set_webex_client(None)
            set_bot_person_id(None)
    else:
        logger.info(
            "Webex inbound disabled (WEBEX_BOT_TOKEN unset); "
            "/api/v1/hooks/webex/events will return 503."
        )

    yield

    # Cleanup on shutdown
    logger.info("Shutting down Autonomous Agents service...")

    # Close the Webex HTTP client and set_webex_client(None)
    if webex_client is not None:
        try:
            await webex_client.aclose()
        except Exception as exc:  # noqa: BLE001 -- shutdown best-effort
            logger.warning("Webex client close failed: %s", exc)
    set_webex_client(None)
    set_bot_person_id(None)

    # Stop the scheduler to halt any tasks during shutdown
    scheduler = get_scheduler()
    if scheduler.running:
        scheduler.shutdown(wait=False)

    # Disconnect MongoDB
    reset_mongo_service()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    app = FastAPI(
        title="Autonomous Agents Service",
        description="Schedule and trigger AI agents to run in the background autonomously",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_exception_handler(
        WebhookSecretEncryptionError,
        webhook_secret_encryption_error_handler,
    )

    # Add CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount API routes.
    app.include_router(health.router)
    app.include_router(tasks.router, prefix="/api/v1")
    app.include_router(webex.router, prefix="/api/v1")
    app.include_router(webhooks.router, prefix="/api/v1")

    @app.get("/")
    async def root():
        return {
            "service": "autonomous-agents",
            "version": "0.1.0",
            "docs": "/docs",
        }

    return app


# Application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "autonomous_agents.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )

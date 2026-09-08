"""FastAPI entry point for the lightweight audit service."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request

from ai_platform_engineering.audit_service.config import Settings
from ai_platform_engineering.audit_service.models import AuditEvent, IngestResponse, QueryResponse
from ai_platform_engineering.audit_service.queue_service import AuditQueueService
from ai_platform_engineering.audit_service.storage import (
    AuditQuery,
    LocalAuditStore,
    S3AuditStore,
    S3RetentionError,
)
from ai_platform_engineering.audit_service.verbosity import (
    PRESET_DESCRIPTIONS,
    PRESET_LABELS,
    PRESET_TYPES,
    filter_records,
)

_WINDOWS: dict[str, timedelta] = {
    "5m": timedelta(minutes=5),
    "15m": timedelta(minutes=15),
    "30m": timedelta(minutes=30),
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "12h": timedelta(hours=12),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}
_VALID_TIME_RESOLUTIONS = {"auto", "minute", "hour", "day"}
_LOCAL_RETENTION_CLEANUP_INTERVAL_SECONDS = 60 * 60
_logger = logging.getLogger(__name__)


async def _purge_local_retention(store: LocalAuditStore, retention_days: int) -> None:
    try:
        deleted = await asyncio.to_thread(store.purge_expired, retention_days=retention_days)
    except Exception as exc:  # noqa: BLE001
        _logger.warning("Failed to purge expired local audit logs: %s", exc)
        return
    if deleted:
        _logger.info("Purged %s expired local audit log files", deleted)


async def _run_local_retention_cleanup(store: LocalAuditStore, retention_days: int) -> None:
    # assisted-by Codex Codex-sonnet-4-6
    while True:
        await asyncio.sleep(_LOCAL_RETENTION_CLEANUP_INTERVAL_SECONDS)
        await _purge_local_retention(store, retention_days)


def _storage_health(store: LocalAuditStore | S3AuditStore, settings: Settings) -> dict[str, Any]:
    # assisted-by Codex Codex-sonnet-4-6
    try:
        if isinstance(store, LocalAuditStore):
            return store.storage_health(
                warning_percent=settings.local_disk_warning_percent,
                critical_percent=settings.local_disk_critical_percent,
            )
        return store.storage_health()
    except Exception:  # noqa: BLE001
        _logger.exception("audit storage health check failed")
        health: dict[str, Any] = {
            "backend": settings.backend,
            "status": "down",
            "detail": "storage health check failed; see audit-service logs",
        }
        if settings.backend == "local":
            health["local_path"] = settings.local_path
        elif settings.backend == "s3":
            health.update(
                {
                    "bucket": settings.s3_bucket,
                    "prefix": settings.s3_prefix,
                    "region": settings.s3_region,
                    "endpoint_url": settings.s3_endpoint_url,
                }
            )
        return health


def _parse_datetime(value: str | None, *, default: datetime) -> datetime:
    if value is None:
        return default
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid ISO timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_window(value: str | None) -> timedelta | None:
    if value is None:
        return None
    window = _WINDOWS.get(value.strip().lower())
    if window is None:
        raise HTTPException(
            status_code=400,
            detail="invalid window; expected one of 5m, 15m, 30m, 1h, 6h, 12h, 24h, 7d",
        )
    return window


def _normalize_time_resolution(value: str | None) -> str:
    if value is None:
        return "auto"
    normalized = value.strip().lower()
    if normalized not in _VALID_TIME_RESOLUTIONS:
        raise HTTPException(status_code=400, detail="invalid time_resolution; expected auto, minute, hour, or day")
    return normalized


def _normalize_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        raw_events = payload
    elif isinstance(payload, dict) and isinstance(payload.get("events"), list):
        raw_events = payload["events"]
    elif isinstance(payload, dict):
        raw_events = [payload]
    else:
        raise HTTPException(status_code=400, detail="expected an event object, event array, or {events: [...]}")

    events: list[dict[str, Any]] = []
    for raw in raw_events:
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="each audit event must be a JSON object")
        events.append(AuditEvent.model_validate(raw).to_record())
    return events


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if settings.backend == "local":
        store = LocalAuditStore(settings.local_path, gzip_enabled=settings.local_gzip)
    elif settings.backend == "s3":
        store = S3AuditStore(
            bucket=settings.s3_bucket,
            prefix=settings.s3_prefix,
            region=settings.s3_region,
            endpoint_url=settings.s3_endpoint_url,
        )
    else:
        raise RuntimeError(f"Unsupported AUDIT_SERVICE_BACKEND={settings.backend!r}; expected 'local' or 's3'")
    queue_service = AuditQueueService(
        store,
        queue_max_size=settings.queue_max_size,
        flush_batch_size=settings.flush_batch_size,
        flush_interval_seconds=settings.flush_interval_seconds,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.audit_store = store
        app.state.audit_queue = queue_service
        app.state.audit_settings = settings
        cleanup_task: asyncio.Task[None] | None = None
        if isinstance(store, LocalAuditStore):
            await _purge_local_retention(store, settings.local_retention_days)
            cleanup_task = asyncio.create_task(
                _run_local_retention_cleanup(store, settings.local_retention_days),
                name="audit-local-retention-cleanup",
            )
        await queue_service.start()
        try:
            yield
        finally:
            if cleanup_task is not None:
                cleanup_task.cancel()
                with suppress(asyncio.CancelledError):
                    await cleanup_task
                _ = cleanup_task.cancelled()
            await queue_service.stop()

    app = FastAPI(title="CAIPE Audit Service", version="0.1.0", lifespan=lifespan)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz(request: Request) -> dict[str, Any]:
        service: AuditQueueService = request.app.state.audit_queue
        try:
            service.store.readiness_check()
        except Exception:  # noqa: BLE001
            _logger.exception("audit storage readiness check failed")
            raise HTTPException(status_code=503, detail="storage unavailable")
        status = service.status()
        if not status["running"]:
            raise HTTPException(status_code=503, detail="audit worker is not running")
        return {"status": "ready", **status}

    @app.get("/v1/audit/status")
    async def audit_status(request: Request) -> dict[str, Any]:
        service: AuditQueueService = request.app.state.audit_queue
        current_settings: Settings = request.app.state.audit_settings
        return {
            **service.status(),
            "storage": _storage_health(service.store, current_settings),
            "local_path": current_settings.local_path if current_settings.backend == "local" else None,
            "local_gzip": current_settings.local_gzip if current_settings.backend == "local" else None,
            "local_retention_days": current_settings.local_retention_days
            if current_settings.backend == "local"
            else None,
            "s3_bucket": current_settings.s3_bucket if current_settings.backend == "s3" else None,
            "s3_prefix": current_settings.s3_prefix if current_settings.backend == "s3" else None,
        }

    @app.post("/v1/audit/events", response_model=IngestResponse, status_code=202)
    async def ingest_events(request: Request, payload: Any = Body(...)) -> IngestResponse:
        service: AuditQueueService = request.app.state.audit_queue
        current_settings: Settings = request.app.state.audit_settings
        events = _normalize_payload(payload)
        events = filter_records(events, current_settings.verbosity)
        if not events:
            return IngestResponse(accepted=0, queued=service.queue.qsize())
        if not service.enqueue_many(events):
            raise HTTPException(status_code=503, detail="audit queue full")
        return IngestResponse(accepted=len(events), queued=service.queue.qsize())

    @app.get("/v1/audit/events", response_model=QueryResponse)
    async def read_events(
        request: Request,
        since: str | None = Query(default=None),
        from_: str | None = Query(default=None, alias="from"),
        until: str | None = Query(default=None),
        to: str | None = Query(default=None),
        window: str | None = Query(default=None),
        time_resolution: str | None = Query(default=None),
        limit: int | None = Query(default=None, ge=1),
        type: str | None = Query(default=None),  # noqa: A002
        outcome: str | None = Query(default=None),
        component: str | None = Query(default=None),
        correlation_id: str | None = Query(default=None),
        tenant_id: str | None = Query(default=None),
        source: str | None = Query(default=None),
        action: str | None = Query(default=None),
        capability: str | None = Query(default=None),
        resource_ref: str | None = Query(default=None),
        subject_hash: str | None = Query(default=None),
        reason_code: str | None = Query(default=None),
        agent_name: str | None = Query(default=None),
        tool_name: str | None = Query(default=None),
        user_email: str | None = Query(default=None),
    ) -> QueryResponse:
        store: LocalAuditStore | S3AuditStore = request.app.state.audit_store
        current_settings: Settings = request.app.state.audit_settings
        now = datetime.now(timezone.utc)
        query_until = _parse_datetime(until or to, default=now)
        query_window = _parse_window(window)
        query_since = _parse_datetime(
            since or from_,
            default=query_until - (query_window or timedelta(days=1)),
        )
        if query_since > query_until:
            raise HTTPException(status_code=400, detail="since/from must be before until/to")
        if query_until - query_since > timedelta(days=current_settings.read_max_days):
            raise HTTPException(status_code=400, detail=f"query range exceeds {current_settings.read_max_days} days")

        query_limit = min(limit or current_settings.read_default_limit, current_settings.read_max_limit)
        query_time_resolution = _normalize_time_resolution(time_resolution)
        audit_query = AuditQuery(
            since=query_since,
            until=query_until,
            limit=query_limit,
            time_resolution=query_time_resolution,
            type=type,
            outcome=outcome,
            component=component,
            correlation_id=correlation_id,
            tenant_id=tenant_id,
            source=source,
            action=action,
            capability=capability,
            resource_ref=resource_ref,
            subject_hash=subject_hash,
            reason_code=reason_code,
            agent_name=agent_name,
            tool_name=tool_name,
            user_email=user_email,
        )
        result = await asyncio.to_thread(store.query, audit_query)
        return QueryResponse(records=result.records, total=result.total, limit=query_limit, truncated=result.truncated)

    @app.get("/v1/audit/verbosity")
    async def get_verbosity(request: Request) -> dict[str, Any]:
        current_settings: Settings = request.app.state.audit_settings
        v = current_settings.verbosity
        allowed = sorted(PRESET_TYPES.get(v, frozenset()))
        return {
            "verbosity": v,
            "label": PRESET_LABELS.get(v, v),
            "description": PRESET_DESCRIPTIONS.get(v, ""),
            "allowed_types": allowed,
            "allow_all": len(PRESET_TYPES.get(v, frozenset())) == 0,
            "available_presets": [
                {
                    "name": name,
                    "label": PRESET_LABELS[name],
                    "description": PRESET_DESCRIPTIONS[name],
                    "allowed_types": sorted(types) if types else [],
                    "allow_all": len(types) == 0,
                }
                for name, types in PRESET_TYPES.items()
            ],
        }

    @app.get("/v1/audit/storage")
    async def get_storage_usage(request: Request) -> dict[str, Any]:
        store = request.app.state.audit_store
        current_settings: Settings = request.app.state.audit_settings
        if isinstance(store, LocalAuditStore):
            audit_bytes = await asyncio.to_thread(store.audit_dir_bytes)
            return {
                "backend": "local",
                "audit_bytes": audit_bytes,
                "audit_bytes_human": _format_bytes_local(audit_bytes),
                "local_path": current_settings.local_path,
                "retention_days": current_settings.local_retention_days,
            }
        if isinstance(store, S3AuditStore):
            usage = await asyncio.to_thread(store.storage_usage)
            return {
                "backend": "s3",
                **usage,
                "bucket": current_settings.s3_bucket,
                "prefix": current_settings.s3_prefix,
            }
        return {"backend": "unknown"}

    @app.get("/v1/audit/retention")
    async def get_retention(request: Request) -> dict[str, Any]:
        store = request.app.state.audit_store
        current_settings: Settings = request.app.state.audit_settings
        if isinstance(store, LocalAuditStore):
            return {
                "backend": "local",
                "retention_days": current_settings.local_retention_days,
                "configurable": False,
                "note": "Set AUDIT_SERVICE_LOCAL_RETENTION_DAYS and restart to change.",
            }
        if isinstance(store, S3AuditStore):
            days = await asyncio.to_thread(store.get_s3_retention_days)
            return {
                "backend": "s3",
                "retention_days": days,
                "configurable": True,
                "bucket": current_settings.s3_bucket,
                "prefix": current_settings.s3_prefix,
            }
        return {"backend": "unknown", "configurable": False}

    @app.put("/v1/audit/retention")
    async def set_retention(request: Request, body: Any = Body(...)) -> dict[str, Any]:
        store = request.app.state.audit_store
        current_settings: Settings = request.app.state.audit_settings
        if not isinstance(store, S3AuditStore):
            raise HTTPException(
                status_code=400,
                detail="Retention can only be updated at runtime for the S3 backend. "
                "For local disk, set AUDIT_SERVICE_LOCAL_RETENTION_DAYS and restart.",
            )
        if not isinstance(body, dict) or "days" not in body:
            raise HTTPException(status_code=400, detail='body must be {"days": N}')
        try:
            days = int(body["days"])
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="days must be an integer") from exc
        if days < 0:
            raise HTTPException(status_code=400, detail="days must be >= 0 (use 0 to disable lifecycle rule)")
        try:
            await asyncio.to_thread(store.set_s3_retention_days, days)
        except S3RetentionError as exc:
            _logger.exception(
                "failed to update S3 audit retention: bucket=%s days=%d", current_settings.s3_bucket, days
            )
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        _logger.info("S3 audit retention updated: bucket=%s days=%d", current_settings.s3_bucket, days)
        return {
            "backend": "s3",
            "retention_days": days,
            "bucket": current_settings.s3_bucket,
            "prefix": current_settings.s3_prefix,
            "note": "S3 lifecycle rule updated. Objects created before this change are not affected.",
        }

    return app


def _format_bytes_local(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if amount < 1024 or unit == "TiB":
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{amount:.1f} TiB"


app = create_app()

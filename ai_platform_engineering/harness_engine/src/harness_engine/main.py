"""Standalone Harness Engine FastAPI application."""

from __future__ import annotations

import hmac
import json
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from pymongo.errors import PyMongoError

from harness_engine.adapters import AgentCoreAdapter, ClaudeSDKAdapter
from harness_engine.adapters.base import HarnessAdapter
from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.config import Settings
from harness_engine.coordinator import AgentNotRunnableError, RunCoordinator
from harness_engine.models import (
    TERMINAL_RUN_STATUSES,
    CancelActiveRunRequest,
    ClearAgentSessionRequest,
    ConnectAgentCoreRequest,
    CreateRunRequest,
    EventPage,
    RegisteredAgentCoreProfile,
    RunRecord,
    SaveAgentRequest,
    ValidateAgentDraftRequest,
)
from harness_engine.provisioning import (
    AgentCoreHarnessProvisioner,
    ProviderProvisioningError,
)
from harness_engine.registry import HarnessNotFoundError, HarnessRegistry
from harness_engine.repository import (
    InMemoryRunRepository,
    MongoRunRepository,
    ReplayGapError,
    RevisionConflictError,
    RunAdmissionError,
    RunRepository,
)
from harness_engine.sessions import CAIPEAgentSessionManager

logger = logging.getLogger(__name__)


def _repository(settings: Settings) -> RunRepository:
    if settings.storage_backend == "mongodb":
        return MongoRunRepository(
            settings.mongodb_uri, settings.mongodb_database, settings.event_retention_seconds
        )
    return InMemoryRunRepository()


def create_app(
    *,
    settings: Settings | None = None,
    repository: RunRepository | None = None,
    adapters: list[HarnessAdapter] | None = None,
    agentcore_provisioner: AgentCoreHarnessProvisioner | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings()
    resolved_repository = repository or _repository(resolved_settings)
    resolved_adapters = adapters or [
        AgentCoreAdapter(
            resolved_settings, resource_repository=resolved_repository
        ),
        ClaudeSDKAdapter(resolved_settings),
    ]
    resolved_agentcore_provisioner = (
        agentcore_provisioner or AgentCoreHarnessProvisioner(resolved_settings)
    )
    registry = HarnessRegistry(resolved_adapters)
    session_manager = CAIPEAgentSessionManager(
        resolved_repository,
        registry,
        resolved_settings.internal_token.encode(),
    )
    coordinator = RunCoordinator(
        resolved_repository,
        registry,
        session_manager,
        DefaultPromptCompiler(),
    )

    async def refresh_agentcore_profiles() -> None:
        profiles = await resolved_repository.list_agentcore_profiles()
        targets = {profile.profile_id: profile.target for profile in profiles}
        for adapter in resolved_adapters:
            if isinstance(adapter, AgentCoreAdapter):
                adapter.set_registered_profiles(targets)
        resolved_agentcore_provisioner.set_registered_profiles(targets)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await resolved_repository.initialize()
        await refresh_agentcore_profiles()
        yield
        await coordinator.shutdown()
        await resolved_repository.close()

    app = FastAPI(title="CAIPE Harness Engine", version="0.2.0", lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.repository = resolved_repository
    app.state.registry = registry
    app.state.session_manager = session_manager
    app.state.coordinator = coordinator
    app.state.agentcore_provisioner = resolved_agentcore_provisioner

    async def caller_subject(
        request: Request,
        authorization: Annotated[str | None, Header()] = None,
        x_harness_engine_subject: Annotated[str | None, Header()] = None,
    ) -> str:
        expected = f"Bearer {resolved_settings.internal_token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "Invalid internal service credential"
            )
        if not x_harness_engine_subject:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing caller subject")
        # Each replica reads immutable connections before accepting new work.
        # Event replay does not depend on refreshing the provider catalog.
        if request.url.path in {
            "/api/v1/harnesses", "/api/v1/agent-drafts/validate",
            "/api/v1/runs", "/api/v1/admin/agentcore-connections",
        } or (request.method == "PUT" and request.url.path.startswith("/api/v1/agents/")):
            try:
                await refresh_agentcore_profiles()
            except (PyMongoError, ValueError) as exc:
                logger.error("AgentCore connection registry could not be loaded (%s)", type(exc).__name__)
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "AgentCore connections could not be loaded") from exc
        return x_harness_engine_subject

    @app.post("/api/v1/admin/agentcore-connections", status_code=status.HTTP_201_CREATED)
    async def connect_agentcore(
        body: ConnectAgentCoreRequest,
        subject: str = Depends(caller_subject),
        x_harness_engine_admin: Annotated[str | None, Header()] = None,
    ) -> dict[str, object]:
        # The BFF supplies this marker only after both admin capability and
        # platform system_config authorization; public proxies never forward it.
        if x_harness_engine_admin != "true":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Platform administrator required")
        if body.profile_id in resolved_settings.agentcore_targets():
            raise HTTPException(status.HTTP_409_CONFLICT, "This profile ID is configured by the operator")
        profile = RegisteredAgentCoreProfile(profile_id=body.profile_id, target=body.target(), created_by=subject)
        try:
            await resolved_repository.create_agentcore_profile(profile)
        except RevisionConflictError as exc:
            existing = next((item for item in await resolved_repository.list_agentcore_profiles() if item.profile_id == body.profile_id), None)
            if existing is None or existing.target != profile.target:
                raise HTTPException(status.HTTP_409_CONFLICT, "This connection ID already points to another target; use another ID") from exc
        except PyMongoError as exc:
            logger.error("AgentCore connection %s could not be saved (%s)", body.profile_id, type(exc).__name__)
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Connection could not be saved; retry with the same connection ID") from exc
        await refresh_agentcore_profiles()
        return {"success": True, "data": {"profile_id": profile.profile_id, "provisioning": "shared", "persistence": resolved_settings.storage_backend}}

    def ensure_owner(run: RunRecord | None, subject: str) -> RunRecord:
        if run is None or run.owner_subject != subject:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found")
        return run

    @app.get("/healthz")
    async def health() -> dict[str, object]:
        return {"status": "ok", "service": "harness-engine"}

    @app.get("/api/v1/harnesses")
    async def catalog(_: str = Depends(caller_subject)) -> dict[str, object]:
        return {
            "success": True,
            "data": {
                "contract_version": 1,
                "catalog_revision": registry.catalog_revision,
                "harnesses": registry.catalog(),
            },
        }

    @app.post("/api/v1/agent-drafts/validate")
    async def validate_agent_draft(
        body: ValidateAgentDraftRequest,
        _: str = Depends(caller_subject),
    ) -> dict[str, object]:
        try:
            validation = registry.validate(body.blueprint, body.catalog_revision)
        except HarnessNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown harness") from exc
        return {"success": True, "data": validation}

    @app.get("/api/v1/agents/{agent_id}")
    async def get_agent(agent_id: str, _: str = Depends(caller_subject)) -> dict[str, object]:
        record = await resolved_repository.get_agent(agent_id)
        version = await resolved_repository.get_agent_version(agent_id)
        if record is None or version is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Harness agent not found")
        return {"success": True, "data": {"record": record, "version": version}}

    @app.put("/api/v1/agents/{agent_id}")
    async def put_agent(
        agent_id: str,
        body: SaveAgentRequest,
        _: str = Depends(caller_subject),
    ) -> dict[str, object]:
        if body.blueprint.id != agent_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Agent path and blueprint IDs differ"
            )
        try:
            validation = registry.validate(body.blueprint, body.catalog_revision)
        except HarnessNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown harness") from exc
        if not validation.valid:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"message": "Agent blueprint is invalid", "issues": validation.issues},
            )
        if body.config_fingerprint and body.config_fingerprint != validation.config_fingerprint:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Agent draft changed after server validation"
            )
        current_record = await resolved_repository.get_agent(agent_id)
        if body.expected_revision is not None and (
            current_record is None
            or current_record.revision != body.expected_revision
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Harness agent revision conflict"
            )
        current_resource = await resolved_repository.get_provider_resource(agent_id)
        prepared_resource = None
        resource_created = False
        if validation.normalized_blueprint.harness.id == "agentcore":
            try:
                prepared_resource, resource_created = (
                    await resolved_agentcore_provisioner.ensure(
                        validation.normalized_blueprint, current_resource
                    )
                )
            except ProviderProvisioningError as exc:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, str(exc)
                ) from exc
            if prepared_resource is not None:
                await resolved_repository.save_provider_resource(prepared_resource)

        try:
            record, version = await resolved_repository.save_agent(
                validation.normalized_blueprint,
                validation.config_fingerprint,
                validation.catalog_revision,
                body.expected_revision,
            )
        except RevisionConflictError as exc:
            if prepared_resource is not None:
                if resource_created:
                    try:
                        await resolved_agentcore_provisioner.delete(prepared_resource)
                    except ProviderProvisioningError:
                        pass
                if current_resource is not None:
                    await resolved_repository.save_provider_resource(current_resource)
                else:
                    await resolved_repository.delete_provider_resource(agent_id)
            raise HTTPException(status.HTTP_409_CONFLICT, "Harness agent revision conflict") from exc

        if current_resource is not None and (
            prepared_resource is None
            or current_resource.arn != prepared_resource.arn
        ):
            try:
                await resolved_agentcore_provisioner.delete(current_resource)
            except ProviderProvisioningError:
                # The saved agent no longer references this resource. A later
                # reconciliation pass can retry cleanup without breaking save.
                pass
            if prepared_resource is None:
                await resolved_repository.delete_provider_resource(agent_id)
        return {"success": True, "data": {"record": record, "version": version}}

    @app.delete("/api/v1/agents/{agent_id}")
    async def delete_agent(
        agent_id: str, _: str = Depends(caller_subject)
    ) -> dict[str, object]:
        resource = await resolved_repository.get_provider_resource(agent_id)
        if resource is not None:
            try:
                await resolved_agentcore_provisioner.delete(resource)
            except ProviderProvisioningError as exc:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY, str(exc)
                ) from exc
            await resolved_repository.delete_provider_resource(agent_id)
        deleted = await resolved_repository.delete_agent(agent_id)
        return {"success": True, "data": {"deleted": deleted, "agent_id": agent_id}}

    @app.post("/api/v1/runs", status_code=status.HTTP_202_ACCEPTED)
    async def start_run(
        request: Request,
        body: CreateRunRequest,
        subject: str = Depends(caller_subject),
    ) -> dict[str, object]:
        incoming_traceparent = request.headers.get("traceparent")
        traceparent = (
            incoming_traceparent.lower()
            if incoming_traceparent
            and re.fullmatch(
                r"00-[0-9a-fA-F]{32}-[0-9a-fA-F]{16}-0[01]", incoming_traceparent
            )
            else None
        )
        try:
            run = await coordinator.start_run(body, subject, traceparent)
        except AgentNotRunnableError as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Agent has no runnable harness version"
            ) from exc
        except RunAdmissionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return {"success": True, "data": run}

    @app.post("/api/v1/sessions/lookup")
    async def lookup_session(
        body: ClearAgentSessionRequest, subject: str = Depends(caller_subject)
    ) -> dict[str, object]:
        run = await resolved_repository.get_active_run(subject, body.agent_id, body.conversation_id)
        binding = await session_manager.current(subject, body.agent_id, body.conversation_id)
        harness_id = run.harness_id if run else (
            binding.harness_id if binding and binding.status == "active" else None
        )
        return {"success": True, "data": {"harness_id": harness_id}}

    @app.post("/api/v1/sessions/clear")
    async def clear_session(
        body: ClearAgentSessionRequest,
        subject: str = Depends(caller_subject),
    ) -> dict[str, object]:
        result = await coordinator.clear_session(
            subject, body.agent_id, body.conversation_id
        )
        return {"success": True, "data": result}

    @app.get("/api/v1/runs/{run_id}")
    async def get_run(run_id: str, subject: str = Depends(caller_subject)) -> dict[str, object]:
        return {
            "success": True,
            "data": ensure_owner(await resolved_repository.get_run(run_id), subject),
        }

    @app.exception_handler(ReplayGapError)
    async def replay_gap_error(_: Request, exc: ReplayGapError) -> JSONResponse:
        return JSONResponse(
            {"success": False, "error": str(exc), "code": "replay_unavailable"}, status_code=409
        )

    @app.get("/api/v1/runs/{run_id}/events")
    async def get_events(
        run_id: str,
        subject: str = Depends(caller_subject),
        after: int = Query(0, ge=0),
        wait: float = Query(0.0, ge=0.0, le=30.0),
    ) -> dict[str, object]:
        ensure_owner(await resolved_repository.get_run(run_id), subject)
        events = await (
            resolved_repository.wait_for_events(run_id, after, wait)
            if wait > 0
            else resolved_repository.list_events(run_id, after)
        )
        refreshed = ensure_owner(await resolved_repository.get_run(run_id), subject)
        page = EventPage(
            run=refreshed,
            events=events,
            next_cursor=events[-1].sequence if events else after,
        )
        return {"success": True, "data": page}

    @app.get("/api/v1/runs/{run_id}/events/stream")
    async def stream_events(
        request: Request,
        run_id: str,
        subject: str = Depends(caller_subject),
        after: int = Query(0, ge=0),
    ) -> StreamingResponse:
        ensure_owner(await resolved_repository.get_run(run_id), subject)

        await resolved_repository.list_events(run_id, after)

        async def generate() -> AsyncIterator[str]:
            cursor = after
            while True:
                if await request.is_disconnected():
                    return
                try:
                    events = await resolved_repository.wait_for_events(
                        run_id, cursor, resolved_settings.long_poll_seconds
                    )
                except ReplayGapError:
                    yield 'event: run.failed\ndata: {"code":"replay_unavailable","message":"Replay events are missing or expired"}\n\n'
                    return
                for event in events:
                    cursor = event.sequence
                    yield (
                        f"id: {event.sequence}\nevent: {event.event_type}\n"
                        f"data: {json.dumps(event.data)}\n\n"
                    )
                run = await resolved_repository.get_run(run_id)
                if run and run.status in TERMINAL_RUN_STATUSES and cursor >= run.last_sequence:
                    return
                if not events:
                    yield ": keepalive\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )

    @app.delete("/api/v1/runs/{run_id}")
    async def cancel_run(
        run_id: str, subject: str = Depends(caller_subject)
    ) -> dict[str, object]:
        ensure_owner(await resolved_repository.get_run(run_id), subject)
        return {"success": True, "data": await coordinator.cancel(run_id)}

    @app.post("/api/v1/runs/cancel-active")
    async def cancel_active_run(
        body: CancelActiveRunRequest,
        subject: str = Depends(caller_subject),
    ) -> dict[str, object]:
        result = await coordinator.cancel_active(
            subject, body.agent_id, body.conversation_id
        )
        return {"success": True, "data": result}

    return app


app = create_app()


if __name__ == "__main__":
    settings = Settings()
    uvicorn.run("harness_engine.main:app", host=settings.host, port=settings.port, reload=False)

"""Private SDK worker using the Engine's durable admission and event repository."""

from __future__ import annotations

import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request

from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.config import Settings
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import TERMINAL_RUN_STATUSES, ExecutionIdentity, RunContext
from harness_engine.registry import HarnessRegistry
from harness_engine.repository import (
    InMemoryRunRepository,
    MongoRunRepository,
    ReplayGapError,
    RunAdmissionError,
    RunRepository,
)
from harness_engine.sessions import CAIPEAgentSessionManager


def create_worker_app(
    *,
    settings: Settings | None = None,
    repository: RunRepository | None = None,
    adapter: ClaudeSDKAdapter | None = None,
) -> FastAPI:
    config = settings or Settings()
    if repository is None and config.storage_backend != "mongodb":
        raise ValueError("Remote SDK workers require MongoDB persistence")
    # A worker never shares admission records with its parent control plane.
    worker_config = config.model_copy(update={"mongodb_database": f"{config.mongodb_database}_claude_worker"})
    repo = repository or (
        MongoRunRepository(config.mongodb_uri, worker_config.mongodb_database, config.event_retention_seconds)
        if config.storage_backend == "mongodb"
        else InMemoryRunRepository()
    )
    local = adapter or ClaudeSDKAdapter(worker_config)
    registry = HarnessRegistry([local])
    sessions = CAIPEAgentSessionManager(repo, registry, config.internal_token.encode())
    coordinator = RunCoordinator(repo, registry, sessions, DefaultPromptCompiler())

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await repo.initialize()
        try:
            yield
        finally:
            await coordinator.shutdown()
            await repo.close()

    app = FastAPI(title="Claude SDK worker", lifespan=lifespan)
    app.state.repository = repo

    async def caller(
        authorization: Annotated[str | None, Header()] = None,
        x_harness_engine_subject: Annotated[str | None, Header()] = None,
    ) -> str:
        if (
            not authorization
            or not hmac.compare_digest(authorization, f"Bearer {config.internal_token}")
            or not x_harness_engine_subject
        ):
            raise HTTPException(401, "Invalid worker service identity")
        return x_harness_engine_subject

    async def snapshot(run_id: str, subject: str, after: int = 0, wait: float = 0) -> dict[str, object]:
        run = await repo.get_run(run_id)
        if run is None or run.owner_subject != subject:
            raise HTTPException(404, "Worker run not found")
        try:
            events = (
                await repo.wait_for_events(run_id, after, wait)
                if wait and run.status not in TERMINAL_RUN_STATUSES
                else await repo.list_events(run_id, after)
            )
        except ReplayGapError as exc:
            raise HTTPException(409, "Worker event replay is unavailable") from exc
        run = await repo.get_run(run_id)
        assert run is not None
        binding = await repo.get_session(run.binding_id)
        drained = binding is None or binding.active_run is None or binding.active_run.run_id != run_id
        return {
            "success": True,
            "data": {
                "run": run,
                "events": events,
                "drained": drained,
                "next_cursor": events[-1].sequence if events else after,
            },
        }

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/worker/runs", status_code=202)
    async def start(context: RunContext, request: Request, subject: str = Depends(caller)) -> dict[str, object]:
        if (
            context.binding.owner_subject != subject
            or context.binding.status != "active"
            or context.binding.agent_id != context.blueprint.id
            or context.binding.harness_id != "claude_agent_sdk"
            or context.blueprint.harness.id != "claude_agent_sdk"
            or context.binding.profile_id != context.blueprint.harness.profile_id
            or context.turn.command != "start"
            or context.turn.attachments
        ):
            raise HTTPException(400, "Invalid admitted SDK context")
        validation = registry.validate(context.blueprint)
        if not validation.valid:
            raise HTTPException(409, "Worker profile does not support this execution configuration")
        token = request.headers.get("x-harness-caller-token")
        if context.blueprint.tools.bindings and not token:
            raise HTTPException(401, "MCP tools require delegated caller credentials")
        identity = ExecutionIdentity(subject=subject, bearer=token) if token else None
        context = context.model_copy(
            update={
                "identity": identity,
                "binding": context.binding.model_copy(
                    update={
                        "native_state_key": f"claude-worker:{context.binding.binding_id}",
                    }
                ),
            }
        )
        try:
            run = await coordinator.start_context(context)
        except RunAdmissionError as exc:
            raise HTTPException(409, "Worker run conflicts with an existing execution") from exc
        return {"success": True, "data": {"run": run}}

    @app.get("/api/v1/worker/runs/{run_id}")
    async def events(
        run_id: str, subject: str = Depends(caller), after: int = Query(0, ge=0), wait: float = Query(0, ge=0, le=30)
    ) -> dict[str, object]:
        return await snapshot(run_id, subject, after, wait)

    @app.delete("/api/v1/worker/runs/{run_id}")
    async def cancel(run_id: str, subject: str = Depends(caller)) -> dict[str, object]:
        await snapshot(run_id, subject)
        await coordinator.cancel(run_id)
        return await snapshot(run_id, subject)

    return app


def main() -> None:
    settings = Settings()
    uvicorn.run(create_worker_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()

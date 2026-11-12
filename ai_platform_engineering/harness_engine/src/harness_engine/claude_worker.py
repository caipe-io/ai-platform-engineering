"""Private SDK worker using the Engine's durable admission and event repository."""

from __future__ import annotations

import asyncio
import hmac
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from acp.schema import InitializeRequest, NewSessionRequest, PromptRequest, ResumeSessionRequest
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ValidationError

from harness_engine.acp_events import EXTENSION, event_notification
from harness_engine.adapters.claude_acp import ClaudeACPAdapter
from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.brokers import DefaultPromptCompiler
from harness_engine.claude_acp_tools import ClaudeACPToolBridge
from harness_engine.claude_isolation import check_isolation
from harness_engine.config import Settings
from harness_engine.coordinator import RunCoordinator
from harness_engine.models import TERMINAL_RUN_STATUSES, ExecutionIdentity, RunContext, RunRecord
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
    tool_bridge = ClaudeACPToolBridge(config.port)
    local = adapter or (
        ClaudeACPAdapter(worker_config, tool_bridge=tool_bridge)
        if config.claude_acp_command
        else ClaudeSDKAdapter(worker_config)
    )
    registry = HarnessRegistry([local])
    sessions = CAIPEAgentSessionManager(repo, registry, config.internal_token.encode())
    coordinator = RunCoordinator(repo, registry, sessions, DefaultPromptCompiler())

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        config.require_private_token()
        if config.claude_acp_runtime == "claude_code_cli_acp" and config.claude_cli_isolation == "landlock":
            await check_isolation()
        await repo.initialize()
        try:
            yield
        finally:
            await coordinator.shutdown()
            await repo.close()

    app = FastAPI(title="Claude SDK worker", lifespan=lifespan)
    app.state.repository = repo
    app.mount("/internal/claude-tools", tool_bridge)

    async def caller(
        authorization: Annotated[str | None, Header()] = None,
        x_harness_engine_subject: Annotated[str | None, Header()] = None,
    ) -> str:
        if (
            config.internal_token == "local-development-only"
            or not authorization
            or not hmac.compare_digest(authorization, f"Bearer {config.internal_token}")
            or not x_harness_engine_subject
        ):
            raise HTTPException(401, "Invalid worker service identity")
        return x_harness_engine_subject

    async def owned_run(run_id: str, subject: str) -> RunRecord:
        run = await repo.get_run(run_id)
        if run is None or run.owner_subject != subject:
            raise HTTPException(404, "Worker run not found")
        return run

    async def drain_state(run_id: str, subject: str) -> dict[str, object]:
        # Cancellation and producer drain must not depend on retained events.
        run = await owned_run(run_id, subject)
        binding = await repo.get_session(run.binding_id)
        drained = binding is None or binding.active_run is None or binding.active_run.run_id != run_id
        return {"run": run, "events": [], "drained": drained, "next_cursor": run.last_sequence}

    async def snapshot(run_id: str, subject: str, after: int = 0, wait: float = 0) -> dict[str, object]:
        run = await owned_run(run_id, subject)
        try:
            events = (
                await repo.wait_for_events(run_id, after, wait)
                if wait and run.status not in TERMINAL_RUN_STATUSES
                else await repo.list_events(run_id, after)
            )
        except ReplayGapError as exc:
            raise HTTPException(409, "Worker event replay is unavailable") from exc
        state = await drain_state(run_id, subject)
        return {
            "success": True,
            "data": {**state, "events": events, "next_cursor": events[-1].sequence if events else after},
        }

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/profiles")
    async def profile_catalog(subject: str = Depends(caller)) -> dict[str, object]:
        return {"profiles": local.descriptor.profiles}

    def prepare(context: RunContext, request: Request, subject: str) -> RunContext:
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
            raise HTTPException(422, "Worker profile does not support this execution configuration")
        token = request.headers.get("x-harness-caller-token")
        if context.blueprint.tools.bindings and not token:
            raise HTTPException(401, "MCP tools require delegated caller credentials")
        identity = ExecutionIdentity(subject=subject, bearer=token) if token else None
        return context.model_copy(
            update={
                "identity": identity,
                "binding": context.binding.model_copy(
                    update={
                        "native_state_key": f"claude-worker:{context.binding.binding_id}",
                    }
                ),
            }
        )

    @app.post("/api/v1/worker/runs", status_code=202)
    async def start(context: RunContext, request: Request, subject: str = Depends(caller)) -> dict[str, object]:
        context = prepare(context, request, subject)
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
        await owned_run(run_id, subject)
        await coordinator.cancel(run_id)
        return {"success": True, "data": await drain_state(run_id, subject)}

    @app.get("/api/v1/worker/runs/{run_id}/state")
    async def state(run_id: str, subject: str = Depends(caller)) -> dict[str, object]:
        return {"success": True, "data": await drain_state(run_id, subject)}

    @app.post("/acp", response_model=None)
    async def acp(request: Request, subject: str = Depends(caller)) -> Response:
        # This is a private ACP custom transport, not the draft Streamable HTTP
        # transport. Each prompt response is an NDJSON stream of JSON-RPC frames.
        try:
            rpc = await request.json()
            if not isinstance(rpc, dict) or rpc.get("jsonrpc") != "2.0":
                raise ValueError("Invalid JSON-RPC envelope")
            method, params, rpc_id = rpc["method"], rpc.get("params", {}), rpc.get("id")
            if not isinstance(params, dict):
                raise ValueError("Invalid JSON-RPC params")
            if method != "session/cancel" and (isinstance(rpc_id, bool) or not isinstance(rpc_id, (str, int))):
                raise ValueError("ACP requests require a request ID")
            if method == "initialize":
                init = InitializeRequest.model_validate(params)
                if init.protocol_version != 1:
                    raise ValueError("Only ACP v1 is supported")
                result = {
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": False, "sessionCapabilities": {"resume": {}}},
                    "authMethods": [],
                    "_meta": {
                        EXTENSION: {
                            "transport": "http-ndjson-v1",
                            "durableReplay": True,
                            "operatorModel": True,
                            "runtime": config.claude_acp_runtime if config.claude_acp_command else "sdk",
                        }
                    },
                }
                return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})
            if request.headers.get("acp-protocol-version") != "1":
                raise ValueError("Initialize ACP v1 before session operations")
            metadata = params.get("_meta", {})
            if not isinstance(metadata, dict) or not isinstance(metadata.get(EXTENSION, {}), dict):
                raise ValueError("Invalid Harness metadata")
            meta = metadata.get(EXTENSION, {})
            if method in {"session/new", "session/resume", "session/prompt"}:
                schema = {
                    "session/new": NewSessionRequest,
                    "session/resume": ResumeSessionRequest,
                    "session/prompt": PromptRequest,
                }[method]
                schema.model_validate(params)
                context = prepare(RunContext.model_validate(meta["context"]), request, subject)
                session_id = context.binding.binding_id
                if method != "session/new" and params.get("sessionId") != session_id:
                    raise ValueError("ACP session does not match its admitted binding")
                if method in {"session/new", "session/resume"}:
                    if params.get("mcpServers") or params.get("additionalDirectories"):
                        raise ValueError("MCP servers and workspaces are managed by the worker profile")
                    binding = await repo.get_session(session_id)
                    if method == "session/resume" and (binding is None or binding.owner_subject != subject):
                        raise HTTPException(404, "Worker session not found")
                    if binding and any(
                        getattr(binding, field) != getattr(context.binding, field)
                        for field in (
                            "owner_subject",
                            "agent_id",
                            "conversation_id",
                            "harness_id",
                            "profile_id",
                            "epoch",
                        )
                    ):
                        raise HTTPException(409, "Worker session conflicts with the admitted context")
                    await repo.create_session(
                        context.binding.model_copy(
                            update={
                                "active_run": None,
                                "last_run_id": None,
                                "dispatch_started": False,
                                "pending_interrupt": None,
                                "resume_run_id": None,
                            }
                        )
                    )
                    result = {"sessionId": session_id} if method == "session/new" else {}
                    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})
                if params["prompt"] != [{"type": "text", "text": context.turn.message}]:
                    raise ValueError("Prompt does not match the admitted input")
                after = meta.get("after", 0)
                if isinstance(after, bool) or not isinstance(after, int) or after < 0:
                    raise ValueError("Invalid replay cursor")
                run = await coordinator.start_context(context)
                if after > run.last_sequence:
                    raise ValueError("Replay cursor exceeds the committed journal")

                async def frames() -> AsyncIterator[str]:
                    cursor = after
                    while True:
                        try:
                            page = (await snapshot(run.run_id, subject, cursor, 15))["data"]
                        except HTTPException:
                            yield (
                                json.dumps(
                                    {
                                        "jsonrpc": "2.0",
                                        "id": rpc_id,
                                        "error": {"code": -32001, "message": "Worker event replay is unavailable"},
                                    }
                                )
                                + "\n"
                            )
                            return
                        for event in page["events"]:
                            cursor = event.sequence
                            yield json.dumps(event_notification(session_id, event)) + "\n"
                            if event.event_type == "run.failed" and event.data.get("code") == "execution_unconfirmed":
                                yield (
                                    json.dumps(
                                        {
                                            "jsonrpc": "2.0",
                                            "id": rpc_id,
                                            "error": {
                                                "code": -32002,
                                                "message": "Worker execution could not be confirmed",
                                            },
                                        }
                                    )
                                    + "\n"
                                )
                                return
                        current = page["run"]
                        if (
                            current.status in TERMINAL_RUN_STATUSES
                            and page["drained"]
                            and cursor >= current.last_sequence
                        ):
                            yield (
                                json.dumps(
                                    {
                                        "jsonrpc": "2.0",
                                        "id": rpc_id,
                                        "result": {
                                            "stopReason": "cancelled" if current.status == "cancelled" else "end_turn",
                                            "_meta": {
                                                EXTENSION: {"run": current.model_dump(mode="json"), "drained": True}
                                            },
                                        },
                                    }
                                )
                                + "\n"
                            )
                            return
                        # Blank lines are transport heartbeats, not ACP messages.
                        yield "\n"
                        if current.status in TERMINAL_RUN_STATUSES:
                            await asyncio.sleep(0.025)

                return StreamingResponse(
                    frames(), media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"}
                )
            if method in {"session/cancel", "_caipe/run_state"}:
                run = await owned_run(meta["runId"], subject)
                if params.get("sessionId") != run.binding_id:
                    raise HTTPException(404, "Worker session not found")
                if method == "session/cancel":
                    if "id" in rpc:
                        raise ValueError("ACP cancellation must be a notification")
                    await coordinator.cancel(run.run_id)
                    return Response(status_code=204)
                state = await drain_state(run.run_id, subject)
                state["run"] = run.model_dump(mode="json")
                return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": state})
            return JSONResponse(
                {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": "ACP method not supported"}}
            )
        except RunAdmissionError as exc:
            raise HTTPException(409, "Worker run conflicts with an existing execution") from exc
        except (ValidationError, ValueError, KeyError, TypeError) as exc:
            # Never echo a context or delegated credentials from validation errors.
            raise HTTPException(400, "Invalid ACP worker request") from exc

    return app


def main() -> None:
    settings = Settings()
    uvicorn.run(create_worker_app(settings=settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()

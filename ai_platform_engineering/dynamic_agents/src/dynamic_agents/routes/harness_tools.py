"""Capability-only MCP endpoint; human credentials never substitute authority."""

import asyncio
import json
from collections.abc import AsyncGenerator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from starlette.responses import JSONResponse, StreamingResponse

from dynamic_agents.services.harness_tools import (
    CAPABILITY_HEADER,
    MAX_REQUEST_BYTES,
    HarnessToolError,
    HarnessToolRepository,
)
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.session_runs import await_session_operation

router = APIRouter(prefix="/harness-tools", tags=["harness-tools"])
KEEPALIVE_SECONDS = 10


def _failure(identifier: str | int) -> dict:
    return {"jsonrpc": "2.0", "id": identifier, "error": {
        "code": -32000, "message": "CAIPE could not complete this request; uncertain tool operations are never automatically retried.",
    }}


async def _call_events(repository: HarnessToolRepository, run_id: str, capability: str, message: dict) -> AsyncGenerator[str, None]:
    observer = asyncio.create_task(repository.call(run_id, capability, message))
    try:
        # Send bytes immediately so the reverse proxy establishes an SSE
        # response before the queued tool reaches a potentially long approval.
        yield ": connected\n\n"
        while not observer.done():
            done, _ = await asyncio.wait({observer}, timeout=KEEPALIVE_SECONDS)
            if not done:
                yield ": keepalive\n\n"
        try:
            payload = {"jsonrpc": "2.0", "id": message["id"], "result": observer.result()}
        except Exception:
            payload = _failure(message["id"])
        yield "event: message\ndata: " + json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n\n"
    finally:
        # The producer's durable claim/execution task is owned by the admitted
        # run, not by this API observer or the sandbox's HTTP connection.
        if not observer.done():
            observer.cancel()
        await asyncio.gather(observer, return_exceptions=True)


@router.post("/{run_id}/mcp")
async def harness_mcp(run_id: str, request: Request, mongo: MongoDBService = Depends(get_mongo_service)) -> Response:
    try:
        UUID(run_id)
    except ValueError as exc:
        raise HTTPException(404, "Harness execution not found") from exc
    capability = request.headers.get(CAPABILITY_HEADER, "")
    repository = HarnessToolRepository(mongo)
    try:
        run = await await_session_operation(repository._active, run_id, capability)
    except HarnessToolError as exc:
        raise HTTPException(401, "Invalid or inactive harness capability") from exc
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_REQUEST_BYTES:
            raise HTTPException(413, "MCP request exceeds its configured limit")
    try:
        message = json.loads(body)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            raise ValueError
        if "id" in message and (type(message["id"]) not in {str, int}):
            raise ValueError
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(400, "Invalid MCP JSON-RPC request") from exc
    method, identifier = message["method"], message.get("id")
    if "id" not in message:
        return Response(status_code=202)
    try:
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                "serverInfo": {"name": "caipe-harness-tools", "version": "1.0.0"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": run.get("harness_tools", [])}
        elif method == "tools/call":
            if "text/event-stream" in request.headers.get("accept", ""):
                return StreamingResponse(_call_events(repository, run_id, capability, message), media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
            result = await repository.call(run_id, capability, message)
        else:
            return JSONResponse({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32601, "message": "Method not found"}})
        return JSONResponse({"jsonrpc": "2.0", "id": identifier, "result": result})
    except HarnessToolError:
        return JSONResponse(_failure(identifier))

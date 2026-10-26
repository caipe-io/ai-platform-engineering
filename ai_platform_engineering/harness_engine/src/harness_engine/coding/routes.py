"""Provider capability and human-input routes, sharing Engine run authority."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from contextlib import AsyncExitStack
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from harness_engine.adapters.claude_code_acp import ClaudeCodeACPAdapter
from harness_engine.coding.admission import CodingAdmissionError, ConversationFence, RunFence
from harness_engine.coding.attachments import MAX_ATTACHMENT_BYTES, CodingAttachments, UploadAttachment
from harness_engine.coding.authorization import AuthorizedRunCredentials
from harness_engine.coding.git_http import GitBroker
from harness_engine.coding.inputs import SubmitCodingInput
from harness_engine.coding.resources import CAPABILITY_HEADER, MAX_REQUEST_BYTES, PlatformResourceBroker
from harness_engine.coding.workspace import CanonicalWorkspace
from harness_engine.history import history_headers, registered_history


async def _body(request: Request, maximum: int) -> dict[str, Any]:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum:
            raise HTTPException(413, "The request exceeds its supported size")
    try:
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (UnicodeError, ValueError):
        raise HTTPException(400, "The request must be a JSON object") from None


def install_coding_routes(app: FastAPI, adapters: list[Any], caller_subject: Callable[..., Any]) -> None:
    adapter = next((item for item in adapters if isinstance(item, ClaudeCodeACPAdapter)), None)
    if adapter is None:
        return

    @app.post("/api/v1/attachments")
    async def upload_attachment(request: Request, subject: str = Depends(caller_subject)) -> JSONResponse:
        database = adapter.repository.provider_database
        if database is None or not adapter._configured():
            raise HTTPException(409, "The selected provider does not support canonical attachments")
        try:
            body = await _body(request, 4 * ((MAX_ATTACHMENT_BYTES + 2) // 3) + 4096)
            value = UploadAttachment.model_validate(body)
            if value.expected_harness_id != adapter.descriptor.id:
                raise CodingAdmissionError("The attachment backend differs from its retained conversation")
            fence = ConversationFence(
                database,
                subject=subject,
                agent_id=value.agent_id,
                conversation_id=value.conversation_id,
                harness_id=value.expected_harness_id,
                visible_conversation_id=value.visible_conversation_id,
            )
            credentials = AuthorizedRunCredentials(adapter.settings, fence)
            await credentials.token()
            saved = await CodingAttachments(database).upload(subject, value)
            await credentials.token()
        except ValidationError:
            raise HTTPException(400, "The attachment reference or bytes are invalid") from None
        except CodingAdmissionError as exc:
            raise HTTPException(409, str(exc)) from None
        return JSONResponse({"success": True, "data": saved.model_dump(mode="json")}, status_code=201)

    @app.post("/api/v1/runs/{run_id}/input")
    async def submit_input(run_id: str, request: Request, subject: str = Depends(caller_subject)) -> JSONResponse:
        try:
            value = SubmitCodingInput.model_validate(await _body(request, MAX_REQUEST_BYTES + 4096))
            run, after = await adapter.submit_input(run_id, subject, value)
            identity = await registered_history(adapter.repository, run)
        except (CodingAdmissionError, ValidationError) as exc:
            raise HTTPException(
                409, str(exc) if isinstance(exc, CodingAdmissionError) else "The human decision is invalid"
            ) from None
        return JSONResponse(
            {
                "success": True,
                "data": {
                    "run": run.model_dump(mode="json"),
                    "after_cursor": after,
                    **({"history": identity} if identity else {}),
                },
            },
            headers=history_headers(identity),
        )

    @app.get("/api/v1/files/list")
    async def list_files(
        agent_id: str,
        conversation_id: str,
        visible_conversation_id: str | None = None,
        subject: str = Depends(caller_subject),
    ) -> JSONResponse:
        database = adapter.repository.provider_database
        if database is None:
            raise HTTPException(503, "Canonical workspace storage is unavailable")
        try:
            result = await CanonicalWorkspace(database).list(
                subject, agent_id, conversation_id, visible_conversation_id
            )
        except CodingAdmissionError as exc:
            raise HTTPException(409, str(exc)) from None
        return JSONResponse({"success": True, "data": result})

    @app.get("/api/v1/files/content")
    async def file_content(
        agent_id: str,
        conversation_id: str,
        path: str,
        visible_conversation_id: str | None = None,
        subject: str = Depends(caller_subject),
    ) -> JSONResponse:
        database = adapter.repository.provider_database
        if database is None:
            raise HTTPException(503, "Canonical workspace storage is unavailable")
        try:
            result = await CanonicalWorkspace(database).content(
                subject, agent_id, conversation_id, path, visible_conversation_id
            )
        except CodingAdmissionError as exc:
            raise HTTPException(409, str(exc)) from None
        return JSONResponse({"success": True, "data": result})

    async def git_broker(run_id: str) -> tuple[GitBroker, RunFence]:
        database = adapter.repository.provider_database
        if database is None:
            raise HTTPException(401, "Invalid or inactive coding run")
        try:
            context = await adapter.context(run_id)
            profile = adapter._profiles.get(context.binding.profile_id)
            if profile is None or profile.git is None:
                raise CodingAdmissionError("The selected profile has no approved Git broker policy")
            fence = RunFence(database, context)
            return GitBroker(profile.git, fence, AuthorizedRunCredentials(adapter.settings, fence)), fence
        except CodingAdmissionError as exc:
            raise HTTPException(403, str(exc)) from None

    @app.post("/api/v1/runs/{run_id}/git-capability")
    async def git_capability(run_id: str, request: Request) -> JSONResponse:
        broker, _ = await git_broker(run_id)
        body = await _body(request, 4096)
        if set(body) != {"repository"} or not isinstance(body["repository"], str):
            raise HTTPException(400, "A Git repository identity is required")
        try:
            result = await broker.mint(body["repository"], request.headers.get(CAPABILITY_HEADER, ""))
        except CodingAdmissionError as exc:
            raise HTTPException(403, str(exc)) from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.api_route(
        "/api/v1/runs/{run_id}/git/github.com/{owner}/{repository}/{operation:path}", methods=["GET", "POST"]
    )
    async def git_proxy(run_id: str, owner: str, repository: str, operation: str, request: Request) -> Response:
        broker, fence = await git_broker(run_id)
        if not repository.endswith(".git") or set(request.query_params) - {"service"}:
            raise HTTPException(400, "The Git endpoint is invalid")
        authorization = request.headers.get("authorization", "")
        try:
            scheme, value = authorization.split(" ", 1)
            if scheme.lower() != "basic" or len(value) > 1024:
                raise ValueError
            username, capability = base64.b64decode(value, validate=True).decode().split(":", 1)
            if username != "caipe":
                raise ValueError
        except (ValueError, UnicodeError):
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="CAIPE Git"'})
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > broker.policy.max_pack_bytes + 65536:
                raise HTTPException(413, "The Git pack exceeds its approved size")
        stack = AsyncExitStack()
        try:
            upstream = await stack.enter_async_context(
                broker.proxy(
                    owner + "/" + repository[:-4],
                    capability,
                    method=request.method,
                    operation=operation,
                    service=request.query_params.get("service"),
                    body=bytes(body),
                    content_type=request.headers.get("content-type", ""),
                )
            )
        except CodingAdmissionError as exc:
            await stack.aclose()
            raise HTTPException(403, str(exc)) from None
        except Exception:
            await stack.aclose()
            raise HTTPException(502, "The admitted Git operation could not be confirmed") from None

        async def stream_git() -> Any:
            size = 0
            try:
                async for chunk in upstream.aiter_bytes():
                    await fence.require()
                    size += len(chunk)
                    if size > broker.policy.max_repository_bytes:
                        raise CodingAdmissionError("The Git response exceeds its approved size")
                    yield chunk
                upstream.extensions["caipe_complete"] = True
            finally:
                await stack.aclose()

        return StreamingResponse(
            stream_git(),
            media_type=upstream.headers.get("content-type", "application/octet-stream"),
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/v1/runs/{run_id}/input")
    async def current_input(run_id: str, subject: str = Depends(caller_subject)) -> JSONResponse:
        database = adapter.repository.provider_database
        if database is None:
            raise HTTPException(404, "The coding run is unavailable")
        try:
            context = await adapter.context(run_id, subject)
            run = await adapter.repository.get_run(run_id)
            pending = None
            if run is not None and run.status == "awaiting_input" and run.pending_interrupt_id:
                stored = await asyncio.to_thread(
                    database.harness_runs.find_one,
                    {
                        "run_id": run_id,
                        "owner_subject": subject,
                        "_coding_pending.interrupt_id": run.pending_interrupt_id,
                        "_coding_pending.decision": {"$exists": False},
                    },
                )
                if stored is not None:
                    pending = stored["_coding_pending"]["event"]
            # Read identity is scoped by the retained owner and canonical binding;
            # it grants no tool effect or permission decision.
            del context
            return JSONResponse({"success": True, "data": pending})
        except CodingAdmissionError:
            raise HTTPException(404, "The coding run is unavailable") from None

    async def call_events(fence: RunFence, capability: str, message: dict[str, Any]) -> Any:
        observer = asyncio.create_task(PlatformResourceBroker.call(fence, capability, message))
        try:
            yield ": connected\n\n"
            while not observer.done():
                done, _ = await asyncio.wait({observer}, timeout=10)
                if not done:
                    yield ": keepalive\n\n"
            try:
                result = {"jsonrpc": "2.0", "id": message["id"], "result": observer.result()}
            except Exception:
                result = {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {
                        "code": -32000,
                        "message": "The admitted tool could not complete; uncertain effects were not retried.",
                    },
                }
            yield (
                "event: message\ndata: "
                + json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                + "\n\n"
            )
        finally:
            if not observer.done():
                observer.cancel()
            await asyncio.gather(observer, return_exceptions=True)

    @app.post("/api/v1/runs/{run_id}/mcp")
    async def mcp(run_id: str, request: Request) -> Response:
        database = adapter.repository.provider_database
        if database is None:
            raise HTTPException(401, "Invalid or inactive harness capability")
        capability = request.headers.get(CAPABILITY_HEADER, "")
        try:
            context = await adapter.context(run_id)
            fence = RunFence(database, context)
            run = await PlatformResourceBroker.authorize(fence, capability)
        except CodingAdmissionError:
            raise HTTPException(401, "Invalid or inactive harness capability") from None
        message = await _body(request, MAX_REQUEST_BYTES)
        if (
            message.get("jsonrpc") != "2.0"
            or not isinstance(message.get("method"), str)
            or ("id" in message and type(message["id"]) not in {str, int})
        ):
            raise HTTPException(400, "Invalid MCP JSON-RPC request")
        if "id" not in message:
            return Response(status_code=202)
        method, identifier = message["method"], message["id"]
        if method == "initialize":
            result = {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "caipe-harness-tools", "version": "1.0.0"},
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": run.get("_coding_tools", [])}
        elif method == "tools/call":
            if "text/event-stream" in request.headers.get("accept", ""):
                return StreamingResponse(
                    call_events(fence, capability, message),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )
            try:
                result = await PlatformResourceBroker.call(fence, capability, message)
            except CodingAdmissionError:
                return JSONResponse(
                    {
                        "jsonrpc": "2.0",
                        "id": identifier,
                        "error": {
                            "code": -32000,
                            "message": "The admitted tool could not complete; uncertain effects were not retried.",
                        },
                    }
                )
        else:
            return JSONResponse(
                {"jsonrpc": "2.0", "id": identifier, "error": {"code": -32601, "message": "Method not found"}}
            )
        return JSONResponse({"jsonrpc": "2.0", "id": identifier, "result": result})

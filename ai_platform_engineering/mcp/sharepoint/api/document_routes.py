# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Binary HTTP routes protected by the server's existing MCP authentication."""

from __future__ import annotations

import httpx
from fastmcp import FastMCP
from mcp_agent_auth import middleware as auth
from pydantic import ValidationError
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from api.client import SharePointGraphError
from api.documents import SharePointDocuments
from models import DriveItemInput, ListDriveItemsInput, PageInput, SearchDriveItemsInput


def register_document_routes(server: FastMCP, documents: SharePointDocuments) -> None:
    @server.custom_route("/healthz", methods=["GET"])
    async def health(request: Request) -> Response:
        return JSONResponse({"status": "ok"})

    @server.custom_route("/documents/catalog/libraries", methods=["GET"])
    @server.custom_route("/documents/catalog/items", methods=["GET"])
    async def catalog(request: Request) -> Response:
        """Bounded browse/search for application pickers, using the same site and auth as streams."""
        headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if auth.MCP_AUTH_MODE not in {"shared_key", "oauth2"}:
            return JSONResponse({"error": "SharePoint browsing requires authenticated MCP access."}, status_code=503)
        try:
            params = dict(request.query_params)
            if request.url.path.endswith("/libraries"):
                args = PageInput.model_validate(params)
                page = await documents.client.list_drives(args.limit, args.cursor)
                items = [{key: row.get(key) for key in ("id", "name", "webUrl")} for row in page["items"]]
            else:
                if params.get("query"):
                    args = SearchDriveItemsInput.model_validate(params)
                    await documents._assert_drive(args.drive_id)
                    page = await documents.client.search_drive_items(args.drive_id, args.query, args.limit, args.cursor)
                else:
                    args = ListDriveItemsInput.model_validate(params)
                    await documents._assert_drive(args.drive_id)
                    page = await documents.client.list_drive_items(args.drive_id, args.folder_item_id, args.limit, args.cursor)
                items = []
                for row in page["items"]:
                    if "remoteItem" in row:
                        continue
                    name = str(row.get("name") or "")
                    folder = "folder" in row
                    if not folder and not name.lower().endswith((".pdf", ".pptx")):
                        continue
                    items.append(
                        {
                            "id": row.get("id"),
                            "name": name,
                            "webUrl": row.get("webUrl"),
                            "size": row.get("size"),
                            "folder": folder,
                            "supported": not folder
                            and isinstance(row.get("file"), dict)
                            and int(row.get("size") or 0) <= documents.client.config.max_document_bytes,
                        }
                    )
            return JSONResponse({"items": items, "has_more": page["has_more"], "next_cursor": page["next_cursor"]}, headers=headers)
        except (ValidationError, ValueError):
            return JSONResponse({"error": "Invalid SharePoint browse parameters."}, status_code=400, headers=headers)
        except SharePointGraphError as exc:
            return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status_code, headers=headers)
        except (httpx.HTTPError, TimeoutError):
            return JSONResponse({"error": "SharePoint could not be reached. Try refreshing."}, status_code=504, headers=headers)

    @server.custom_route("/documents/{drive_id}/{item_id}/metadata", methods=["GET"])
    @server.custom_route("/documents/{drive_id}/{item_id}/content", methods=["GET"])
    @server.custom_route("/documents/{drive_id}/{item_id}/folder", methods=["GET"])
    async def document(request: Request) -> Response:
        if auth.MCP_AUTH_MODE not in {"shared_key", "oauth2"}:
            return JSONResponse({"error": "Document streams require MCP_AUTH_MODE=shared_key or oauth2."}, status_code=503)
        try:
            args = DriveItemInput.model_validate(request.path_params)
            headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
            if request.url.path.endswith("/folder"):
                select_files = request.query_params.get("select_files", "false")
                if select_files not in {"true", "false"}:
                    return JSONResponse({"error": "Choose true or false for select_files."}, status_code=400, headers=headers)
                return JSONResponse(await documents.folder_snapshot(args.drive_id, args.item_id, select_files=select_files == "true"), headers=headers)
            if request.url.path.endswith("/metadata"):
                return JSONResponse(await documents.manifest(args.drive_id, args.item_id), headers=headers)
            format = request.query_params.get("format", "original")
            if format not in {"original", "pdf"}:
                return JSONResponse({"error": "Choose original or pdf."}, status_code=400, headers=headers)
            context = documents.stream(args.drive_id, args.item_id, format)
            stream = await context.__aenter__()
            closed = False

            async def close() -> None:
                nonlocal closed
                if not closed:
                    closed = True
                    await context.__aexit__(None, None, None)

            async def body():
                try:
                    async for chunk in stream.body:
                        yield chunk
                finally:
                    await close()

            if stream.content_length is not None:
                headers["Content-Length"] = str(stream.content_length)
            return StreamingResponse(body(), media_type=stream.content_type, headers=headers, background=BackgroundTask(close))
        except ValidationError:
            return JSONResponse({"error": "Invalid document identifier."}, status_code=400)
        except SharePointGraphError as exc:
            return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status_code)
        except (httpx.HTTPError, TimeoutError):
            return JSONResponse({"error": "Document download timed out or could not reach Microsoft."}, status_code=504)

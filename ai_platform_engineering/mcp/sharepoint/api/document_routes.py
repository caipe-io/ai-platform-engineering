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
from api.pages import SITE_PAGES_LIBRARY_ID, SITE_PAGES_ROOT_ID
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
                if args.cursor is None:
                    items.insert(0, {"id": SITE_PAGES_LIBRARY_ID, "name": "Site pages"})
            else:
                if params.get("drive_id") == SITE_PAGES_LIBRARY_ID:
                    args = (
                        SearchDriveItemsInput.model_validate(params) if params.get("query") else ListDriveItemsInput.model_validate(params)
                    )
                    if not params.get("query") and not params.get("folder_item_id"):
                        return JSONResponse({
                            "items": [{"id": SITE_PAGES_ROOT_ID, "name": "Site pages", "folder": True}],
                            "has_more": False, "next_cursor": None,
                        }, headers=headers)
                    if params.get("folder_item_id") not in {None, SITE_PAGES_ROOT_ID}:
                        return JSONResponse({"error": "Choose the Site pages collection."}, status_code=404, headers=headers)
                    page = await documents.pages.list(args.limit, args.cursor, params.get("query", ""))
                    return JSONResponse(
                        {"items": page["items"], "has_more": page["has_more"], "next_cursor": page["next_cursor"]}, headers=headers,
                    )
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
                    document_format = documents.format_for_item(row)
                    if not folder and document_format is None:
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
                            and int(row.get("size") or 0) <= documents.byte_limit(document_format),
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
                snapshot = await documents.folder_snapshot(args.drive_id, args.item_id, select_files=select_files == "true")
                return JSONResponse(snapshot, headers=headers)
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
            # Original HTML is evidence for the preparation worker, never a
            # script-capable page hosted on the MCP service's own origin.
            headers["Content-Disposition"] = "attachment"
            headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
            return StreamingResponse(body(), media_type=stream.content_type, headers=headers, background=BackgroundTask(close))
        except ValidationError:
            return JSONResponse({"error": "Invalid document identifier."}, status_code=400)
        except SharePointGraphError as exc:
            return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status_code)
        except (httpx.HTTPError, TimeoutError):
            return JSONResponse({"error": "Document download timed out or could not reach Microsoft."}, status_code=504)

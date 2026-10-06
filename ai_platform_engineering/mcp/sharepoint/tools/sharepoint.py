# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Read-only SharePoint MCP tool registration."""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from fastmcp import FastMCP
from mcp.shared.exceptions import McpError
from mcp.types import INTERNAL_ERROR, INVALID_PARAMS, ErrorData

from api import SharePointGraphClient, SharePointGraphError
from models import DriveItemInput, ListDriveItemsInput, ListItemsInput, PageInput, ReadFileInput, SearchDriveItemsInput

READ_ONLY_ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}


def _tool_errors[**P, R](func: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
    """Convert network failures into concise, actionable MCP errors."""

    @functools.wraps(func)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        try:
            return await func(*args, **kwargs)
        except SharePointGraphError as exc:
            if exc.status_code == 403:
                message = (
                    "Microsoft Graph denied access to the configured SharePoint site. "
                    "Verify the app has Sites.Selected with a read grant for this site, or Sites.Read.All admin consent."
                )
            elif exc.status_code == 404:
                message = "The requested SharePoint resource was not found within the configured site."
            elif exc.status_code == 429:
                message = "Microsoft Graph throttled the request. Wait briefly, then retry with a smaller page size."
            else:
                message = exc.message
            if exc.request_id:
                message = f"{message} Microsoft request ID: {exc.request_id}."
            code = INVALID_PARAMS if exc.status_code in {400, 404, 413, 415} else INTERNAL_ERROR
            raise McpError(ErrorData(code=code, message=message)) from exc
        except httpx.TimeoutException as exc:
            raise McpError(ErrorData(code=INTERNAL_ERROR, message="Microsoft Graph timed out. Try the request again.")) from exc
        except httpx.RequestError as exc:
            raise McpError(
                ErrorData(code=INTERNAL_ERROR, message="Microsoft Graph could not be reached. Check network connectivity and retry.")
            ) from exc

    return wrapper


def register_tools(server: FastMCP, client: SharePointGraphClient) -> None:
    """Register the complete read-only SharePoint tool surface."""

    @server.tool(name="sharepoint_get_site", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def get_site() -> dict[str, Any]:
        """Get metadata for the single SharePoint site configured on this server."""
        return await client.get_site()

    @server.tool(name="sharepoint_list_document_libraries", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def list_document_libraries(args: PageInput) -> dict[str, Any]:
        """List document libraries in the configured site with cursor pagination."""
        return await client.list_drives(args.limit, args.cursor)

    @server.tool(name="sharepoint_list_drive_items", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def list_drive_items(args: ListDriveItemsInput) -> dict[str, Any]:
        """List files and folders in a document library root or folder."""
        return await client.list_drive_items(args.drive_id, args.folder_item_id, args.limit, args.cursor)

    @server.tool(name="sharepoint_search_drive_items", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def search_drive_items(args: SearchDriveItemsInput) -> dict[str, Any]:
        """Search files and folders within one configured-site document library."""
        return await client.search_drive_items(args.drive_id, args.query, args.limit, args.cursor)

    @server.tool(name="sharepoint_get_drive_item", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def get_drive_item(args: DriveItemInput) -> dict[str, Any]:
        """Get metadata for a file or folder by document-library and item IDs."""
        return await client.get_drive_item(args.drive_id, args.item_id)

    @server.tool(name="sharepoint_read_text_file", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def read_text_file(args: ReadFileInput) -> dict[str, Any]:
        """Read bounded textual content from a supported SharePoint file."""
        return await client.read_text_file(args.drive_id, args.item_id, args.max_characters)

    @server.tool(name="sharepoint_list_lists", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def list_lists(args: PageInput) -> dict[str, Any]:
        """List SharePoint lists in the configured site with cursor pagination."""
        return await client.list_lists(args.limit, args.cursor)

    @server.tool(name="sharepoint_list_items", annotations=READ_ONLY_ANNOTATIONS)
    @_tool_errors
    async def list_items(args: ListItemsInput) -> dict[str, Any]:
        """List rows and selected fields from a SharePoint list."""
        return await client.list_items(args.list_id, args.field_names, args.limit, args.cursor)

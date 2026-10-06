# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""MCP tool registration tests."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from models import SharePointConfig
from tools import register_tools


class FakeClient:
    """Minimal tool-client double."""

    async def get_site(self) -> dict[str, Any]:
        return {"id": "site-1", "displayName": "Example"}


class FakeServer:
    """Capture FastMCP-style tool decorators."""

    def __init__(self) -> None:
        self.tools: dict[str, tuple[Callable[..., Any], dict[str, Any]]] = {}

    def tool(self, *, name: str, annotations: dict[str, Any]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def decorator(function: Callable[..., Any]) -> Callable[..., Any]:
            self.tools[name] = (function, annotations)
            return function

        return decorator


def test_all_registered_tools_are_read_only() -> None:
    server = FakeServer()
    register_tools(server, FakeClient())  # type: ignore[arg-type]

    assert set(server.tools) == {
        "sharepoint_get_site",
        "sharepoint_get_drive_item",
        "sharepoint_list_document_libraries",
        "sharepoint_list_drive_items",
        "sharepoint_list_items",
        "sharepoint_list_lists",
        "sharepoint_read_text_file",
        "sharepoint_search_drive_items",
    }
    for _, tool_annotations in server.tools.values():
        assert tool_annotations == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": True,
        }


def test_example_config_is_not_deployment_specific() -> None:
    config = SharePointConfig(
        tenant_id="00000000-0000-0000-0000-000000000000",
        client_id="11111111-1111-1111-1111-111111111111",
        client_secret="test-secret",
        site_url="https://example.sharepoint.com/sites/example",
    )

    assert config.site_url == "https://example.sharepoint.com/sites/example"

# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""FastMCP server construction tests."""

from __future__ import annotations

import pytest

from models import SharePointConfig
from server import build_server


@pytest.mark.asyncio
async def test_real_fastmcp_server_exposes_read_only_tools() -> None:
    config = SharePointConfig(
        tenant_id="00000000-0000-0000-0000-000000000000",
        client_id="11111111-1111-1111-1111-111111111111",
        client_secret="test-secret",
        site_url="https://example.sharepoint.com/sites/example",
    )

    tools = await build_server(config).list_tools()

    assert {tool.name for tool in tools} == {
        "sharepoint_get_site",
        "sharepoint_get_drive_item",
        "sharepoint_list_document_libraries",
        "sharepoint_list_drive_items",
        "sharepoint_list_items",
        "sharepoint_list_lists",
        "sharepoint_read_text_file",
        "sharepoint_search_drive_items",
    }
    assert all(tool.annotations.readOnlyHint is True for tool in tools)
    assert all(tool.annotations.destructiveHint is False for tool in tools)

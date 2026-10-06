# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""FastMCP server for read-only SharePoint access through Microsoft Graph."""

from __future__ import annotations

import logging
import sys
from typing import Literal

import click
import httpx
from dotenv import load_dotenv
from fastmcp import FastMCP
from mcp_agent_auth.middleware import MCPAuthMiddleware
from starlette.middleware import Middleware

from api import SharePointGraphClient
from models import SharePointConfig
from tools import register_tools

InputTransport = Literal["stdio", "sse", "http", "streamable-http"]
RuntimeTransport = Literal["stdio", "sse", "streamable-http"]


def build_server(
    config: SharePointConfig,
    http_client: httpx.AsyncClient | None = None,
) -> FastMCP:
    """Build a SharePoint MCP server with injectable HTTP transport for tests."""
    server = FastMCP(name="sharepoint_mcp")
    register_tools(server, SharePointGraphClient(config, http_client=http_client))
    return server


@click.command()
@click.option("--port", default=8000, type=click.IntRange(1, 65535), envvar="MCP_PORT", show_default=True)
@click.option(
    "--transport",
    type=click.Choice(["stdio", "sse", "http", "streamable-http"]),
    default="streamable-http",
    envvar="MCP_MODE",
    show_default=True,
)
@click.option("--host", default="127.0.0.1", envvar="MCP_HOST", show_default=True)
@click.option("-v", "--verbose", count=True)
def main(verbose: int, transport: InputTransport, port: int, host: str) -> None:
    """Run the read-only SharePoint MCP server."""
    load_dotenv()
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger(__name__)

    try:
        config = SharePointConfig.from_env()
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    selected: RuntimeTransport = "streamable-http" if transport == "http" else transport
    logger.info("Starting SharePoint MCP transport=%s host=%s port=%s site=%s", selected, host, port, config.site_url)

    server = build_server(config)
    if selected == "stdio":
        server.run(transport="stdio", show_banner=False)
        return

    server.run(
        transport=selected,
        host=host,
        port=port,
        show_banner=False,
        middleware=[Middleware(MCPAuthMiddleware)],
    )


if __name__ == "__main__":
    main()

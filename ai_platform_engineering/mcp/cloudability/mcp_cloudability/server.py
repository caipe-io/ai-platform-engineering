# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Cloudability MCP server."""

import logging
import os

from dotenv import load_dotenv
from fastmcp import FastMCP

from mcp_cloudability.tools import cloudability


def main():
    load_dotenv()
    logging.basicConfig(level=logging.DEBUG)

    logging.getLogger("sse_starlette.sse").setLevel(logging.INFO)
    logging.getLogger("mcp.server.lowlevel.server").setLevel(logging.INFO)

    mcp_mode = os.getenv("MCP_MODE", "STDIO")
    mcp_host = os.getenv("MCP_HOST", "localhost")
    mcp_port = int(os.getenv("MCP_PORT", "8000"))
    server_name = os.getenv("SERVER_NAME", "Cloudability")

    logging.info("Starting MCP server in %s mode on %s:%s", mcp_mode, mcp_host, mcp_port)
    logging.info("MCP Server name: %s", server_name)

    if mcp_mode.lower() in ["sse", "http"]:
        mcp = FastMCP(f"{server_name} MCP Server", host=mcp_host, port=mcp_port)
    else:
        mcp = FastMCP(f"{server_name} MCP Server")

    mcp.tool()(cloudability.get_version)
    mcp.tool()(cloudability.get_cloudability_api_help)
    mcp.tool()(cloudability.cloudability_request)
    mcp.tool()(cloudability.get_budgets)
    mcp.tool()(cloudability.get_views)
    mcp.tool()(cloudability.get_portfolio)

    mcp.run(transport=mcp_mode.lower())


if __name__ == "__main__":
    main()

import logging
import sys
from typing import Literal

import click
from fastmcp import FastMCP
from mcp_agent_auth.middleware import MCPAuthMiddleware
from starlette.middleware import Middleware

from .tools import register_tools

InputTransport = Literal["stdio", "sse", "http", "streamable-http"]
RuntimeTransport = Literal["stdio", "sse", "streamable-http"]


@click.command()
@click.option("--port", default=8000, envvar="MCP_PORT")
@click.option(
  "--transport",
  type=click.Choice(["stdio", "sse", "http", "streamable-http"]),
  default="streamable-http",
  envvar="MCP_MODE",
)
@click.option("--host", default="0.0.0.0", envvar="MCP_HOST")
@click.option("-v", "--verbose", count=True)
def main(verbose: int, transport: InputTransport, port: int, host: str) -> None:
  """Run the CAIPE platform control-plane MCP."""
  level = logging.DEBUG if verbose >= 2 else logging.INFO
  logging.basicConfig(level=level, stream=sys.stderr)
  selected: RuntimeTransport = "streamable-http" if transport == "http" else transport  # type: ignore[assignment]
  server = FastMCP("platform")
  register_tools(server)
  if selected == "stdio":
    server.run(transport=selected)
    return
  server.run(
    transport=selected,
    host=host,
    port=port,
    log_level="DEBUG" if level == logging.DEBUG else "INFO",
    middleware=[Middleware(MCPAuthMiddleware)],
  )


__all__ = ["main"]

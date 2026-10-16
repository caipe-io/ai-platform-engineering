"""Per-server read deadlines for long-running MCP calls."""

from datetime import timedelta

import pytest

from dynamic_agents.models import MCPServerConfig, TransportType
from dynamic_agents.services.mcp_client import build_mcp_connection_config


def _server(server_id: str) -> MCPServerConfig:
    return MCPServerConfig(
        _id=server_id,
        name="Example",
        transport=TransportType.HTTP,
        endpoint=f"https://example.test/mcp/{server_id}",
    )


def test_sse_read_timeout_only_applies_to_named_server(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_SSE_READ_TIMEOUT_OVERRIDES", '{"example":960}')

    selected = build_mcp_connection_config(_server("example"))
    other = build_mcp_connection_config(_server("secondary"))

    assert selected["sse_read_timeout"] == timedelta(minutes=16)
    assert "sse_read_timeout" not in other


@pytest.mark.parametrize("value", ['{"example":true}', '{"example":0}', '[]', '{'])
def test_invalid_sse_read_timeout_config_fails_closed(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("MCP_SSE_READ_TIMEOUT_OVERRIDES", value)

    with pytest.raises(ValueError, match="MCP SSE read timeout|MCP_SSE_READ_TIMEOUT_OVERRIDES"):
        build_mcp_connection_config(_server("example"))

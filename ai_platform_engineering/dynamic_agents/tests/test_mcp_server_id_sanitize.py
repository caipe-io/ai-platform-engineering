"""Tests for MCP server_id sanitization (Bedrock tool name safety).

Covers three layers:
  1. sanitize_server_id_for_prefix — the pure sanitization function
  2. build_mcp_connections — uses safe_id as the connection dict key
  3. filter_tools_by_allowed — uses safe_id for prefix matching
"""

import logging
from unittest.mock import MagicMock

import pytest

from dynamic_agents.models import MCPServerConfig, TransportType
from dynamic_agents.services.mcp_client import (
    build_mcp_connections,
    filter_tools_by_allowed,
    sanitize_server_id_for_prefix,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_server(server_id: str) -> MCPServerConfig:
    return MCPServerConfig(
        _id=server_id,
        name=server_id,
        transport=TransportType.STDIO,
        command="dummy-mcp",
        enabled=True,
    )


def _make_tool(name: str) -> MagicMock:
    tool = MagicMock()
    tool.name = name
    return tool


# ---------------------------------------------------------------------------
# 1. sanitize_server_id_for_prefix — valid inputs (no change, no warning)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("server_id", [
    "slack",
    "github",
    "my-server",
    "my_server",
    "server123",
    "123",
    "a",
    "A-Z_0-9",
    "a" * 100,        # long but valid
    "-leading-hyphen",
    "trailing-hyphen-",
    "_leading_underscore",
])
def test_valid_ids_pass_through_unchanged(server_id):
    assert sanitize_server_id_for_prefix(server_id) == server_id


@pytest.mark.parametrize("server_id", [
    "slack",
    "my-server",
    "server_1",
])
def test_valid_ids_emit_no_warning(server_id, caplog):
    with caplog.at_level(logging.WARNING, logger="dynamic_agents.services.mcp_client"):
        sanitize_server_id_for_prefix(server_id)
    assert caplog.records == []


# ---------------------------------------------------------------------------
# 2. sanitize_server_id_for_prefix — invalid inputs (chars replaced, warning logged)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("server_id, expected", [
    ("$SLACK",         "_SLACK"),        # real-world case: unevaluated env var
    ("$MY_SERVER",     "_MY_SERVER"),    # dollar at start
    ("my$server",      "my_server"),     # dollar in middle
    ("my.server",      "my_server"),     # dot
    ("server@host",    "server_host"),   # at-sign
    ("server/path",    "server_path"),   # slash
    ("server:port",    "server_port"),   # colon
    ("server name",    "server_name"),   # space
    ("$MY.SERVER@1",   "_MY_SERVER_1"),  # multiple invalid chars
    ("$$double",       "__double"),      # consecutive invalid chars each replaced
    ("a!b#c",          "a_b_c"),         # multiple different invalid chars
    ("αβγ",            "___"),           # unicode letters outside ASCII range
    ("tab\there",      "tab_here"),      # tab character
    ("newline\nhere",  "newline_here"),  # newline
])
def test_invalid_chars_replaced_with_underscore(server_id, expected):
    assert sanitize_server_id_for_prefix(server_id) == expected


@pytest.mark.parametrize("server_id", [
    "$SLACK",
    "my.server",
    "server@host",
    "αβγ",
])
def test_invalid_ids_log_warning(server_id, caplog):
    with caplog.at_level(logging.WARNING, logger="dynamic_agents.services.mcp_client"):
        sanitize_server_id_for_prefix(server_id)
    assert len(caplog.records) == 1
    assert server_id in caplog.records[0].message
    assert sanitize_server_id_for_prefix(server_id) in caplog.records[0].message


# ---------------------------------------------------------------------------
# 3. sanitize_server_id_for_prefix — edge cases
# ---------------------------------------------------------------------------


def test_empty_string_returns_empty_string():
    assert sanitize_server_id_for_prefix("") == ""


def test_empty_string_emits_no_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="dynamic_agents.services.mcp_client"):
        sanitize_server_id_for_prefix("")
    assert caplog.records == []


def test_all_invalid_chars_become_all_underscores():
    assert sanitize_server_id_for_prefix("$$$") == "___"


def test_single_valid_char():
    assert sanitize_server_id_for_prefix("a") == "a"


def test_single_invalid_char():
    assert sanitize_server_id_for_prefix("$") == "_"


def test_idempotent_on_already_sanitized_value():
    sanitized = sanitize_server_id_for_prefix("$SLACK")
    assert sanitize_server_id_for_prefix(sanitized) == sanitized


def test_warning_contains_both_original_and_sanitized(caplog):
    with caplog.at_level(logging.WARNING, logger="dynamic_agents.services.mcp_client"):
        result = sanitize_server_id_for_prefix("$SLACK")
    assert len(caplog.records) == 1
    msg = caplog.records[0].message
    assert "$SLACK" in msg
    assert result in msg


# ---------------------------------------------------------------------------
# 4. build_mcp_connections — safe_id used as connection key
# ---------------------------------------------------------------------------


def test_build_mcp_connections_valid_server_id_used_as_key():
    server = _make_server("slack")
    connections = build_mcp_connections([server], ["slack"])
    assert "slack" in connections


def test_build_mcp_connections_invalid_server_id_sanitized_as_key():
    server = _make_server("$SLACK")
    connections = build_mcp_connections([server], ["$SLACK"])
    assert "$SLACK" not in connections
    assert "_SLACK" in connections


def test_build_mcp_connections_multiple_servers_all_sanitized():
    servers = [_make_server("$SLACK"), _make_server("my.github"), _make_server("argocd")]
    connections = build_mcp_connections(servers, ["$SLACK", "my.github", "argocd"])
    assert "$SLACK" not in connections
    assert "my.github" not in connections
    assert "_SLACK" in connections
    assert "my_github" in connections
    assert "argocd" in connections


def test_build_mcp_connections_missing_server_skipped():
    server = _make_server("slack")
    connections = build_mcp_connections([server], ["slack", "nonexistent"])
    assert "slack" in connections
    assert "nonexistent" not in connections
    assert len(connections) == 1


def test_build_mcp_connections_disabled_server_skipped():
    server = _make_server("slack")
    server.enabled = False
    connections = build_mcp_connections([server], ["slack"])
    assert connections == {}


def test_build_mcp_connections_empty_inputs_returns_empty():
    assert build_mcp_connections([], []) == {}


# ---------------------------------------------------------------------------
# 5. filter_tools_by_allowed — safe_id used for prefix matching
# ---------------------------------------------------------------------------


def test_filter_tools_valid_server_id_allow_all():
    tools = [_make_tool("slack_list_channels"), _make_tool("slack_send_message"), _make_tool("github_get_pr")]
    filtered, missing = filter_tools_by_allowed(tools, {"slack": True})
    names = {t.name for t in filtered}
    assert names == {"slack_list_channels", "slack_send_message"}
    assert missing == []


def test_filter_tools_invalid_server_id_sanitized_for_matching():
    """Tools registered under _SLACK prefix (after sanitization) must match allowed $SLACK."""
    tools = [_make_tool("_SLACK_list_channels"), _make_tool("_SLACK_send_message"), _make_tool("github_get_pr")]
    filtered, missing = filter_tools_by_allowed(tools, {"$SLACK": True})
    names = {t.name for t in filtered}
    assert names == {"_SLACK_list_channels", "_SLACK_send_message"}


def test_filter_tools_specific_tools_with_invalid_server_id():
    tools = [_make_tool("_SLACK_conversations_history"), _make_tool("_SLACK_send_message")]
    filtered, missing = filter_tools_by_allowed(tools, {"$SLACK": ["conversations_history"]})
    names = {t.name for t in filtered}
    assert names == {"_SLACK_conversations_history"}
    assert missing == []


def test_filter_tools_specific_tool_missing_reported():
    tools = [_make_tool("_SLACK_send_message")]
    filtered, missing = filter_tools_by_allowed(tools, {"$SLACK": ["conversations_history"]})
    assert filtered == []
    assert "_SLACK_conversations_history" in missing


def test_filter_tools_server_disabled_with_false():
    tools = [_make_tool("slack_send_message")]
    filtered, missing = filter_tools_by_allowed(tools, {"slack": False})
    assert filtered == []
    assert missing == []


def test_filter_tools_empty_list_legacy_allows_all(caplog):
    tools = [_make_tool("slack_send_message"), _make_tool("slack_list_channels")]
    with caplog.at_level(logging.WARNING, logger="dynamic_agents.services.mcp_client"):
        filtered, missing = filter_tools_by_allowed(tools, {"slack": []})
    names = {t.name for t in filtered}
    assert names == {"slack_send_message", "slack_list_channels"}
    assert any("deprecated" in r.message.lower() for r in caplog.records)


def test_filter_tools_mixed_valid_and_invalid_server_ids():
    tools = [
        _make_tool("_SLACK_send_message"),
        _make_tool("github_get_pr"),
        _make_tool("argocd_sync"),
    ]
    allowed = {"$SLACK": True, "github": ["get_pr"], "argocd": False}
    filtered, missing = filter_tools_by_allowed(tools, allowed)
    names = {t.name for t in filtered}
    assert "_SLACK_send_message" in names
    assert "github_get_pr" in names
    assert "argocd_sync" not in names


def test_filter_tools_no_matching_tools_returns_missing():
    tools = [_make_tool("github_get_pr")]
    filtered, missing = filter_tools_by_allowed(tools, {"slack": ["send_message"]})
    assert filtered == []
    assert "slack_send_message" in missing


def test_filter_tools_empty_allowed_returns_empty():
    tools = [_make_tool("slack_send_message")]
    filtered, missing = filter_tools_by_allowed(tools, {})
    assert filtered == []
    assert missing == []


def test_filter_tools_empty_tool_list_returns_empty():
    filtered, missing = filter_tools_by_allowed([], {"slack": True})
    assert filtered == []
    assert missing == []

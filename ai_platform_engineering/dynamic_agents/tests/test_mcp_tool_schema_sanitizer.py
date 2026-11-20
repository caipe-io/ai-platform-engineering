"""Tool schema normalization for provider compatibility."""

from __future__ import annotations

from langchain_core.tools import StructuredTool
from langchain_core.utils.function_calling import convert_to_openai_tool

from dynamic_agents.services.mcp_client import wrap_tools_with_error_handling


async def _echo_tool(**kwargs: object) -> dict[str, object]:
    return dict(kwargs)


def test_wrap_tools_collapses_top_level_anyof_schema():
    # assisted-by Codex Codex-sonnet-4-6
    schema = {
        "title": "JiraLookupArgs",
        "description": "Lookup by issue key or JQL.",
        "anyOf": [
            {
                "type": "object",
                "properties": {"issue_key": {"type": "string"}},
                "required": ["issue_key"],
            },
            {
                "type": "object",
                "properties": {"jql": {"type": "string"}},
                "required": ["jql"],
            },
        ],
    }
    tool = StructuredTool(
        name="jira_lookup",
        description="Lookup Jira issues",
        args_schema=schema,
        coroutine=_echo_tool,
    )

    wrapped = wrap_tools_with_error_handling([tool], agent_name="test-agent")[0]
    tool_schema = wrapped.tool_call_schema
    converted = convert_to_openai_tool(wrapped)
    converted_schema = converted["function"]["parameters"]

    assert "anyOf" not in tool_schema
    assert "anyOf" not in converted_schema
    assert tool_schema["type"] == "object"
    assert set(tool_schema["properties"]) == {"issue_key", "jql"}
    assert "required" not in tool_schema


def test_wrap_tools_resolves_defs_when_collapsing_top_level_anyof_schema():
    schema = {
        "title": "SearchArgs",
        "$defs": {
            "ByName": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
            "ByNamespace": {
                "type": "object",
                "properties": {"namespace": {"type": "string"}},
                "required": ["namespace"],
            },
        },
        "anyOf": [{"$ref": "#/$defs/ByName"}, {"$ref": "#/$defs/ByNamespace"}],
    }
    tool = StructuredTool(
        name="kubernetes_search",
        description="Search Kubernetes resources",
        args_schema=schema,
        coroutine=_echo_tool,
    )

    wrapped = wrap_tools_with_error_handling([tool], agent_name="test-agent")[0]
    tool_schema = wrapped.tool_call_schema

    assert "anyOf" not in tool_schema
    assert set(tool_schema["properties"]) == {"name", "namespace"}
    assert "required" not in tool_schema


def test_wrap_tools_strips_regex_lookaround_patterns():
    schema = {
        "title": "RunQueryArgs",
        "type": "object",
        "properties": {
            "app": {"type": "string", "pattern": r"^(?!\.{1,2}$)(?!-$)[A-Za-z0-9_.-]+$"},
            "query": {"type": "string", "pattern": r"^(?=.*\S)[\s\S]{3,10000}$"},
            "earliest": {"type": "string", "pattern": r"^[-+@\w:.]+$"},
            "opts": {
                "type": "object",
                "properties": {"name": {"type": "string", "pattern": r"^(?<!x)\w+$"}},
            },
        },
        "required": ["query"],
    }
    tool = StructuredTool(
        name="skynet_run_query",
        description="Run a query",
        args_schema=schema,
        coroutine=_echo_tool,
    )

    wrapped = wrap_tools_with_error_handling([tool], agent_name="test-agent")[0]
    props = convert_to_openai_tool(wrapped)["function"]["parameters"]["properties"]

    assert "pattern" not in props["app"]
    assert "pattern" not in props["query"]
    assert "pattern" not in props["opts"]["properties"]["name"]
    assert props["earliest"]["pattern"] == r"^[-+@\w:.]+$"
    assert props["app"]["type"] == "string"

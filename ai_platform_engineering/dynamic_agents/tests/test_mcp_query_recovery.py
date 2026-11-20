"""Search parse failures get actionable guidance without automatic retries."""

from __future__ import annotations

import pytest
from langchain_core.tools import StructuredTool

from dynamic_agents.services.mcp_client import (
    _format_tool_error,
    wrap_tools_with_error_handling,
)


@pytest.mark.parametrize(
    "message",
    [
        "query cannot be parsed",
        "Search failed: Query Cannot Be Parsed near a field filter",
        "QUERY CANNOT BE PARSED: invalid operator",
    ],
)
def test_parse_failure_suggests_a_simpler_query(message: str) -> None:
    result = _format_tool_error("example_search", ValueError(message))

    assert result.startswith(f"ERROR: Tool 'example_search' failed: {message}\n")
    assert "short plain-keyword query" in result
    assert "removing Boolean operators, field filters, and punctuation" in result
    assert "retry once" in result
    assert "use another available source or explain the limitation" in result


def test_parse_failure_is_found_inside_an_exception_group() -> None:
    error = ExceptionGroup("transport wrapper", [ValueError("query cannot be parsed")])

    assert "short plain-keyword query" in _format_tool_error("example_search", error)


@pytest.mark.parametrize("error", [TimeoutError("read timeout"), PermissionError("Forbidden")])
def test_other_errors_keep_the_existing_guidance(error: Exception) -> None:
    assert _format_tool_error("example_search", error) == (
        f"ERROR: Tool 'example_search' failed: {error}\n"
        "You can retry with different arguments or try a different approach."
    )


def test_empty_error_retains_the_exception_type_fallback() -> None:
    assert _format_tool_error("example_search", ValueError()).startswith(
        "ERROR: Tool 'example_search' failed: ValueError\n"
    )


@pytest.mark.parametrize("response_format", ["content", "content_and_artifact"])
async def test_wrapper_returns_guidance_without_retrying(response_format: str) -> None:
    calls = 0

    async def search(query: str) -> str:
        nonlocal calls
        calls += 1
        raise ValueError("query cannot be parsed")

    tool = StructuredTool(
        name="example_search",
        description="Search an example source",
        args_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        coroutine=search,
        response_format=response_format,
    )
    wrapped = wrap_tools_with_error_handling([tool])[0]

    result = await wrapped.coroutine(query="example")

    assert calls == 1
    if response_format == "content_and_artifact":
        result, artifact = result
        assert artifact == []
    assert "short plain-keyword query" in result

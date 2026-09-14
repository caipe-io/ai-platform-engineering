"""Agent<->datasource binding: pin_datasource_filters narrows RAG search tools."""

from __future__ import annotations

from langchain_core.tools import StructuredTool

from dynamic_agents.services.mcp_client import pin_datasource_filters

_SEARCH_SCHEMA = {
    "title": "SearchArgs",
    "type": "object",
    "properties": {
        "query": {"type": "string"},
        "filters": {"type": "object"},
        "limit": {"type": "integer"},
    },
    "required": ["query"],
}


async def _search_coro(**kwargs: object) -> dict[str, object]:
    return dict(kwargs)


def _search_tool(name: str = "knowledge-base_search") -> StructuredTool:
    return StructuredTool(
        name=name,
        description="Search the knowledge base.",
        args_schema=_SEARCH_SCHEMA,
        coroutine=_search_coro,
    )


def test_no_datasource_ids_leaves_tools_untouched():
    tool = _search_tool()
    result = pin_datasource_filters([tool], None, agent_name="test-agent")
    assert result == [tool]


async def test_explicit_empty_datasource_ids_keep_rag_tools_with_empty_scope():
    rag_tool = _search_tool()
    other_tool = _search_tool(name="jira_search")

    result = pin_datasource_filters(
        [other_tool, rag_tool], [], agent_name="test-agent"
    )

    assert result[0] is other_tool
    assert result[1].name == rag_tool.name
    output = await result[1].coroutine(query="deploy process")
    assert output["filters"]["datasource_id"] == []


def test_non_rag_tool_without_filters_arg_is_untouched():
    schema = {"type": "object", "properties": {"query": {"type": "string"}}}
    tool = StructuredTool(
        name="fetch_document", description="Fetch a document.", args_schema=schema, coroutine=_search_coro
    )
    result = pin_datasource_filters([tool], ["kb-1"], agent_name="test-agent")
    assert result == [tool]


def test_rag_tool_without_filters_arg_is_removed():
    schema = {"type": "object", "properties": {"query": {"type": "string"}}}
    tool = StructuredTool(
        name="knowledge-base_graph_raw_query_data",
        description="Raw graph query.",
        args_schema=schema,
        coroutine=_search_coro,
    )

    assert pin_datasource_filters([tool], ["kb-1"], agent_name="test-agent") == []


def test_non_rag_tool_with_filters_arg_is_not_wrapped():
    tool = _search_tool(name="jira_search")

    result = pin_datasource_filters([tool], ["kb-1"], agent_name="test-agent")

    assert result == [tool]


async def test_pins_datasource_id_when_caller_supplies_no_filters():
    tool = _search_tool()
    pinned = pin_datasource_filters([tool], ["kb-1", "kb-2"], agent_name="test-agent")[0]

    output = await pinned.coroutine(query="deploy process")

    assert output["filters"]["datasource_id"] == ["kb-1", "kb-2"]


async def test_intersects_when_caller_requests_a_subset():
    tool = _search_tool()
    pinned = pin_datasource_filters([tool], ["kb-1", "kb-2"], agent_name="test-agent")[0]

    output = await pinned.coroutine(query="deploy process", filters={"datasource_id": ["kb-2", "kb-9"]})

    assert output["filters"]["datasource_id"] == ["kb-2"]


async def test_intersects_when_caller_requests_a_single_string_id():
    tool = _search_tool()
    pinned = pin_datasource_filters([tool], ["kb-1"], agent_name="test-agent")[0]

    output = await pinned.coroutine(query="deploy process", filters={"datasource_id": "kb-9"})

    assert output["filters"]["datasource_id"] == []


async def test_dynamic_provider_is_resolved_for_every_tool_call():
    tool = _search_tool()
    current = ["kb-1"]
    pinned = pin_datasource_filters(
        [tool],
        [],
        agent_name="test-agent",
        datasource_ids_provider=lambda: list(current),
    )[0]

    first = await pinned.coroutine(query="deploy process")
    current[:] = ["kb-2", "kb-3"]
    second = await pinned.coroutine(
        query="deploy process",
        filters={"datasource_id": ["kb-1", "kb-3"]},
    )

    assert first["filters"]["datasource_id"] == ["kb-1"]
    assert second["filters"]["datasource_id"] == ["kb-3"]


async def test_empty_dynamic_collection_fails_closed_without_removing_non_rag_tools():
    rag_tool = _search_tool()
    other_tool = _search_tool(name="jira_search")
    pinned = pin_datasource_filters(
        [other_tool, rag_tool],
        [],
        agent_name="test-agent",
        datasource_ids_provider=lambda: [],
    )

    assert pinned[0] is other_tool
    output = await pinned[1].coroutine(query="deploy process")
    assert output["filters"]["datasource_id"] == []


async def test_wrapping_preserves_tool_metadata_and_tags():
    tool = _search_tool()
    tool.metadata = {"server_id": "knowledge-base"}
    tool.tags = ["rag"]

    pinned = pin_datasource_filters([tool], ["kb-1"], agent_name="test-agent")[0]

    assert pinned.metadata == {"server_id": "knowledge-base"}
    assert pinned.tags == ["rag"]


def test_leaves_non_search_tools_in_the_same_order():
    search = _search_tool()
    other_schema = {"type": "object", "properties": {"name": {"type": "string"}}}
    other = StructuredTool(
        name="sleep", description="Sleep.", args_schema=other_schema, coroutine=_search_coro
    )

    result = pin_datasource_filters([other, search], ["kb-1"], agent_name="test-agent")

    assert result[0] is other
    assert result[1].name == search.name

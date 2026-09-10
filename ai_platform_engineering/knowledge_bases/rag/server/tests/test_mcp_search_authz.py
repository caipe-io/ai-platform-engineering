"""Tests for query-time RBAC on the live agent MCP path (`server/tools.py`).

The FastMCP `/mcp` search/fetch_document/list_datasources_and_entity_types
tools previously ignored the caller's OpenFGA-derived accessible datasource
set entirely — any authenticated MCP caller saw every datasource's content.
`AgentTools._resolve_accessible_datasource_ids` reads the `UserContext` set by
`MCPAuthMiddleware` (via `mcp_user_context_var`) and narrows every tool's
results to what `get_accessible_datasource_ids` returns for that user.

They also previously skipped the two other layers of the intended
authorization chain that the REST `/v1/query` and debug `/v1/mcp/invoke`
paths already enforced: the org-level `organization#can_search` capability
(`server.rbac.authorize_search`) and the per-document ACL tag filter
(`server.doc_acl.merge_acl_filter`). These tests cover both now that
`_execute`/`fetch_document`/`list_datasources_and_entity_types` call them.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from common.models.rag import MCPToolConfig, ParallelSearch
from common.models.rbac import Role, UserContext
from server import tools as tools_module
from server.tools import AgentTools


def _user(role: str = Role.READONLY, email: str = "alice@example.com") -> UserContext:
    return UserContext(
        subject="alice-sub",
        email=email,
        role=role,
        is_authenticated=True,
        groups=[],
    )


def _make_tools() -> AgentTools:
    return AgentTools(
        redis_client=MagicMock(),
        vector_db_query_service=MagicMock(),
        metadata_storage=MagicMock(),
    )


def _make_single_label_config(label: str = "semantic_results", allow_runtime_filters: bool = False) -> MCPToolConfig:
    return MCPToolConfig(
        tool_id="search",
        parallel_searches=[ParallelSearch(label=label, semantic_weight=0.7)],
        allow_runtime_filters=allow_runtime_filters,
        enabled=True,
    )


# ---------------------------------------------------------------------------
# _resolve_accessible_datasource_ids
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_returns_empty_when_no_mcp_user_context(monkeypatch: pytest.MonkeyPatch):
    """No UserContext means `MCPAuthMiddleware` never ran for this request
    (e.g. MCP_AUTH_ENABLED=false) — fail CLOSED rather than unrestricted."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(lambda: None))
    monkeypatch.setattr(tools_module, "is_unsafe_rbac_bypass_enabled", lambda: False)

    assert await at._resolve_accessible_datasource_ids("read") == []


@pytest.mark.asyncio
async def test_resolve_returns_none_when_no_mcp_user_context_and_unsafe_bypass_enabled(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(lambda: None))
    monkeypatch.setattr(tools_module, "is_unsafe_rbac_bypass_enabled", lambda: True)

    assert await at._resolve_accessible_datasource_ids("read") is None


@pytest.mark.asyncio
async def test_resolve_scopes_client_credentials_identity(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    client_user = UserContext(
        subject="ingestor-sub",
        subject_type="service_account",
        client_id="rag-ingestor",
        email="client:rag-ingestor",
        role=Role.INGESTONLY,
        is_authenticated=True,
    )
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(lambda: client_user))
    monkeypatch.setattr(tools_module, "get_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))

    assert await at._resolve_accessible_datasource_ids("read") == ["ds-a"]


@pytest.mark.asyncio
async def test_resolve_returns_none_for_unrestricted_wildcard(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(tools_module, "get_accessible_datasource_ids", AsyncMock(return_value=["*"]))

    assert await at._resolve_accessible_datasource_ids("read") is None


@pytest.mark.asyncio
async def test_resolve_returns_accessible_list_for_scoped_user(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(tools_module, "get_accessible_datasource_ids", AsyncMock(return_value=["ds-a", "ds-b"]))

    assert await at._resolve_accessible_datasource_ids("read") == ["ds-a", "ds-b"]


@pytest.mark.asyncio
async def test_resolve_returns_empty_list_when_nothing_accessible(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(tools_module, "get_accessible_datasource_ids", AsyncMock(return_value=[]))

    assert await at._resolve_accessible_datasource_ids("read") == []


# ---------------------------------------------------------------------------
# search (_make_search_fn / _execute) — org admin / unrestricted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_unrestricted_user_queries_without_datasource_filter(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    await search_fn(query="test", limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"] is None


# ---------------------------------------------------------------------------
# search — scoped user (team member)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_scoped_user_filters_to_accessible_datasources(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    await search_fn(query="test", limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert sorted(kwargs["filters"]["datasource_id"]) == ["ds-a", "ds-b"]


@pytest.mark.asyncio
async def test_search_scoped_user_gets_no_results_when_nothing_accessible(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=[]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    response = await search_fn(query="test", limit=10, thought="")

    assert response == {"semantic_results": []}
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_search_config_narrowed_datasource_intersects_with_accessible(monkeypatch: pytest.MonkeyPatch):
    """A ParallelSearch pinned to specific datasource_ids (config narrowing)
    must intersect with the caller's accessible set, never widen it."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    config = MCPToolConfig(
        tool_id="search",
        parallel_searches=[ParallelSearch(label="results", datasource_ids=["ds-a", "ds-b"], semantic_weight=0.7)],
        allow_runtime_filters=False,
        enabled=True,
    )
    search_fn = at._make_search_fn(config, graph_rag_enabled=False)
    await search_fn(query="test", limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-a"]


@pytest.mark.asyncio
async def test_search_config_narrowed_datasource_empty_intersection_skips_query(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-c"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    config = MCPToolConfig(
        tool_id="search",
        parallel_searches=[ParallelSearch(label="results", datasource_ids=["ds-a", "ds-b"], semantic_weight=0.7)],
        allow_runtime_filters=False,
        enabled=True,
    )
    search_fn = at._make_search_fn(config, graph_rag_enabled=False)
    response = await search_fn(query="test", limit=10, thought="")

    assert response == {"results": []}
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_search_runtime_filter_datasource_narrowed_by_accessible(monkeypatch: pytest.MonkeyPatch):
    """A runtime `filters={"datasource_id": ...}` (allow_runtime_filters=True)
    must also be intersected with the caller's accessible set."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    await search_fn(query="test", filters={"datasource_id": "ds-a"}, limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-a"]


@pytest.mark.asyncio
async def test_search_runtime_filter_intersects_with_custom_tool_config(monkeypatch: pytest.MonkeyPatch):
    """A custom search config must not overwrite an agent-pinned runtime filter."""
    at = _make_tools()
    monkeypatch.setattr(
        AgentTools,
        "_resolve_accessible_datasource_ids",
        AsyncMock(return_value=["ds-a", "ds-b"]),
    )
    at.vector_db_query_service.query = AsyncMock(return_value=[])
    config = MCPToolConfig(
        tool_id="search",
        parallel_searches=[
            ParallelSearch(
                label="results",
                datasource_ids=["ds-a", "ds-b"],
                semantic_weight=0.7,
            ),
        ],
        allow_runtime_filters=True,
        enabled=True,
    )

    search_fn = at._make_search_fn(config, graph_rag_enabled=False)
    await search_fn(
        query="test",
        filters={"datasource_id": ["ds-a"]},
        limit=10,
        thought="",
    )

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-a"]


@pytest.mark.asyncio
async def test_search_runtime_filter_datasource_outside_accessible_returns_empty(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    response = await search_fn(query="test", filters={"datasource_id": "ds-z"}, limit=10, thought="")

    assert response == {"semantic_results": []}
    at.vector_db_query_service.query.assert_not_called()


# ---------------------------------------------------------------------------
# search — collection_id filter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_collection_filter_resolves_to_member_datasources(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    monkeypatch.setattr(tools_module, "get_datasource_ids_for_collection", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    await search_fn(query="test", filters={"collection_id": "coll-1"}, limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert sorted(kwargs["filters"]["datasource_id"]) == ["ds-a", "ds-b"]


@pytest.mark.asyncio
async def test_search_collection_filter_intersects_with_accessible(monkeypatch: pytest.MonkeyPatch):
    """A collection's member datasources must narrow, never widen, the
    caller's RBAC-accessible set."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))
    monkeypatch.setattr(tools_module, "get_datasource_ids_for_collection", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    await search_fn(query="test", filters={"collection_id": "coll-1"}, limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-a"]


@pytest.mark.asyncio
async def test_search_collection_id_and_datasource_id_intersect(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    monkeypatch.setattr(tools_module, "get_datasource_ids_for_collection", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    await search_fn(
        query="test",
        filters={"collection_id": "coll-1", "datasource_id": "ds-b"},
        limit=10,
        thought="",
    )

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-b"]


@pytest.mark.asyncio
async def test_search_unknown_collection_returns_empty(monkeypatch: pytest.MonkeyPatch):
    """An unresolvable collection_id narrows to nothing rather than erroring
    or falling back to unrestricted search."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    monkeypatch.setattr(tools_module, "get_datasource_ids_for_collection", AsyncMock(return_value=[]))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    response = await search_fn(query="test", filters={"collection_id": "coll-unknown"}, limit=10, thought="")

    assert response == {"semantic_results": []}
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_search_multiple_collection_ids_union_member_datasources(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))

    async def _resolve(collection_id: str):
        return {"coll-1": ["ds-a"], "coll-2": ["ds-b"]}.get(collection_id, [])

    monkeypatch.setattr(tools_module, "get_datasource_ids_for_collection", _resolve)
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    await search_fn(query="test", filters={"collection_id": ["coll-1", "coll-2"]}, limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert sorted(kwargs["filters"]["datasource_id"]) == ["ds-a", "ds-b"]


@pytest.mark.asyncio
async def test_search_without_collection_filter_does_not_call_resolver(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    mock_resolve = AsyncMock(side_effect=AssertionError("must not be called"))
    monkeypatch.setattr(tools_module, "get_datasource_ids_for_collection", mock_resolve)
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(allow_runtime_filters=True), graph_rag_enabled=False)
    await search_fn(query="test", filters={"datasource_id": "ds-a"}, limit=10, thought="")

    mock_resolve.assert_not_called()


# ---------------------------------------------------------------------------
# fetch_document
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_document_unrestricted_user_no_datasource_filter(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    at.vector_db_query_service.query = AsyncMock(return_value=[{"id": "chunk-1"}])

    await at.fetch_document("doc-1")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert "datasource_id" not in kwargs["filters"]


@pytest.mark.asyncio
async def test_fetch_document_scoped_user_filters_by_accessible_datasources(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[{"id": "chunk-1"}])

    await at.fetch_document("doc-1")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-a"]


@pytest.mark.asyncio
async def test_fetch_document_returns_not_found_when_nothing_accessible(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=[]))
    at.vector_db_query_service.query = AsyncMock()

    result = await at.fetch_document("doc-1")

    assert "not found" in result
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_fetch_document_narrowed_by_agent_config_filters(monkeypatch: pytest.MonkeyPatch):
    """Agent-config datasource narrowing (client-pinned `filters`) intersects
    with the caller's RBAC-accessible set — narrows, never widens."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.vector_db_query_service.query = AsyncMock(return_value=[{"id": "chunk-1"}])

    await at.fetch_document("doc-1", filters={"datasource_id": ["ds-a"]})

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["datasource_id"] == ["ds-a"]


@pytest.mark.asyncio
async def test_fetch_document_config_narrowed_outside_accessible_returns_not_found(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))
    at.vector_db_query_service.query = AsyncMock()

    result = await at.fetch_document("doc-1", filters={"datasource_id": ["ds-z"]})

    assert "not found" in result
    at.vector_db_query_service.query.assert_not_called()


# ---------------------------------------------------------------------------
# list_datasources_and_entity_types
# ---------------------------------------------------------------------------


def _ds_info(datasource_id: str) -> MagicMock:
    info = MagicMock()
    info.datasource_id = datasource_id
    return info


@pytest.mark.asyncio
async def test_list_datasources_unrestricted_user_sees_all(monkeypatch: pytest.MonkeyPatch):
    ontology_graph = MagicMock()
    ontology_graph.get_all_entity_types = AsyncMock(return_value=["Incident", "Service"])
    at = _make_tools()
    at.ontology_graphdb = ontology_graph
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    at.metadata_storage.fetch_all_datasource_info = AsyncMock(return_value=[_ds_info("ds-a"), _ds_info("ds-b")])

    result = await at.list_datasources_and_entity_types()

    assert sorted(result["datasources"]) == ["ds-a", "ds-b"]
    assert result["entity_types"] == ["Incident", "Service"]
    ontology_graph.get_all_entity_types.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_list_datasources_scoped_user_sees_only_accessible(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    at.data_graphdb = MagicMock()
    at.data_graphdb.get_all_entity_types = AsyncMock(return_value=["Service"])
    at.ontology_graphdb = MagicMock()
    at.ontology_graphdb.get_all_entity_types = AsyncMock(return_value=["Secret", "Service"])
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))
    at.metadata_storage.fetch_all_datasource_info = AsyncMock(return_value=[_ds_info("ds-a"), _ds_info("ds-b")])

    result = await at.list_datasources_and_entity_types()

    assert result["datasources"] == ["ds-a"]
    assert result["entity_types"] == ["Service"]
    at.data_graphdb.get_all_entity_types.assert_awaited_once_with(datasource_ids=["ds-a"])
    at.ontology_graphdb.get_all_entity_types.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_datasources_scoped_user_sees_none_when_nothing_accessible(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    at.data_graphdb = MagicMock()
    at.data_graphdb.get_all_entity_types = AsyncMock(return_value=[])
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=[]))
    at.metadata_storage.fetch_all_datasource_info = AsyncMock(return_value=[_ds_info("ds-a"), _ds_info("ds-b")])

    result = await at.list_datasources_and_entity_types()

    assert result["datasources"] == []
    assert result["entity_types"] == []
    at.data_graphdb.get_all_entity_types.assert_awaited_once_with(datasource_ids=[])


@pytest.mark.asyncio
async def test_list_datasources_narrowed_by_agent_config_filters(monkeypatch: pytest.MonkeyPatch):
    """Agent-config datasource narrowing (client-pinned `filters`) intersects
    with the caller's RBAC-accessible set — narrows, never widens."""
    at = _make_tools()
    at.data_graphdb = MagicMock()
    at.data_graphdb.get_all_entity_types = AsyncMock(return_value=["Incident"])
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a", "ds-b"]))
    at.metadata_storage.fetch_all_datasource_info = AsyncMock(
        return_value=[_ds_info("ds-a"), _ds_info("ds-b"), _ds_info("ds-c")]
    )

    result = await at.list_datasources_and_entity_types(filters={"datasource_id": ["ds-a"]})

    assert result["datasources"] == ["ds-a"]
    assert result["entity_types"] == ["Incident"]
    at.data_graphdb.get_all_entity_types.assert_awaited_once_with(datasource_ids=["ds-a"])


@pytest.mark.asyncio
async def test_list_datasources_config_narrowing_cannot_widen_beyond_accessible(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    at.data_graphdb = MagicMock()
    at.data_graphdb.get_all_entity_types = AsyncMock(return_value=["Incident"])
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=["ds-a"]))
    at.metadata_storage.fetch_all_datasource_info = AsyncMock(
        return_value=[_ds_info("ds-a"), _ds_info("ds-b")]
    )

    result = await at.list_datasources_and_entity_types(filters={"datasource_id": ["ds-a", "ds-b"]})

    assert result["datasources"] == ["ds-a"]
    at.data_graphdb.get_all_entity_types.assert_awaited_once_with(datasource_ids=["ds-a"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method_name", "args"),
    [
        ("graph_explore_ontology_entity", ("Service",)),
        ("graph_shortest_path_between_entity_types", ("Service", "Incident", "")),
        ("graph_raw_query_ontology", ("MATCH (n) RETURN n", "")),
    ],
)
@pytest.mark.parametrize(
    ("accessible", "filters"),
    [
        (["ds-a"], None),
        (["ds-a"], {"datasource_id": ["ds-a"]}),
        (None, {"datasource_id": ["ds-a"]}),
    ],
)
async def test_ontology_tools_fail_closed_for_any_bounded_datasource_scope(
    method_name: str,
    args: tuple[object, ...],
    accessible: list[str] | None,
    filters: dict[str, list[str]] | None,
):
    at = _make_tools()
    at.ontology_graphdb = MagicMock()
    at._authorize_search_tool = AsyncMock(return_value=(_user(), accessible))

    result = await getattr(at, method_name)(
        *args,
        filters=filters,
    )

    assert "requires unrestricted datasource access" in result
    at.ontology_graphdb.get_all_entity_types.assert_not_called()
    at.ontology_graphdb.raw_query.assert_not_called()


# ---------------------------------------------------------------------------
# authorize_search gate — search / fetch_document / list_datasources
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_denied_without_search_capability_raises(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(
        tools_module,
        "authorize_search",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="no search capability")),
    )
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)

    with pytest.raises(HTTPException):
        await search_fn(query="test", limit=10, thought="")
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_search_allowed_when_authorize_search_passes(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(tools_module, "authorize_search", AsyncMock(return_value=None))
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    await search_fn(query="test", limit=10, thought="")

    at.vector_db_query_service.query.assert_called_once()


@pytest.mark.asyncio
async def test_search_without_mcp_user_context_fails_closed(monkeypatch: pytest.MonkeyPatch):
    """No middleware context can never become an unrestricted search."""
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(lambda: None))
    monkeypatch.setattr(tools_module, "is_unsafe_rbac_bypass_enabled", lambda: False)
    mock_authorize = AsyncMock(side_effect=AssertionError("must not be called"))
    monkeypatch.setattr(tools_module, "authorize_search", mock_authorize)
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    response = await search_fn(query="test", limit=10, thought="")

    mock_authorize.assert_not_called()
    at.vector_db_query_service.query.assert_not_called()
    assert response == {"semantic_results": []}


@pytest.mark.asyncio
async def test_fetch_document_denied_without_search_capability_raises(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(
        tools_module,
        "authorize_search",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="no search capability")),
    )
    at.vector_db_query_service.query = AsyncMock(return_value=[{"id": "chunk-1"}])

    result = await at.fetch_document("doc-1")

    # fetch_document catches all exceptions and returns an error string
    # rather than propagating, matching its existing error-handling pattern.
    assert "Error fetching document" in result
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_list_datasources_denied_without_search_capability(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(
        tools_module,
        "authorize_search",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="no search capability")),
    )
    at.metadata_storage.fetch_all_datasource_info = AsyncMock(return_value=[_ds_info("ds-a")])

    result = await at.list_datasources_and_entity_types()

    assert "Error fetching datasources" in result
    at.metadata_storage.fetch_all_datasource_info.assert_not_called()


# ---------------------------------------------------------------------------
# Document ACL tag filter (server.doc_acl.merge_acl_filter) on the MCP path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_applies_doc_acl_filter_when_enabled(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(tools_module, "authorize_search", AsyncMock(return_value=None))
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    monkeypatch.setattr(tools_module, "merge_acl_filter", lambda filters, user: {**(filters or {}), "metadata.acl_tags": ["__public__"]})
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    await search_fn(query="test", limit=10, thought="")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["metadata.acl_tags"] == ["__public__"]


@pytest.mark.asyncio
async def test_search_skips_doc_acl_filter_when_no_mcp_user_context(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(lambda: None))
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=[]))
    mock_merge = MagicMock(side_effect=AssertionError("must not be called"))
    monkeypatch.setattr(tools_module, "merge_acl_filter", mock_merge)
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    await search_fn(query="test", limit=10, thought="")

    mock_merge.assert_not_called()
    at.vector_db_query_service.query.assert_not_called()


@pytest.mark.asyncio
async def test_fetch_document_applies_doc_acl_filter_when_enabled(monkeypatch: pytest.MonkeyPatch):
    at = _make_tools()
    monkeypatch.setattr(AgentTools, "_get_mcp_user_context", staticmethod(_user))
    monkeypatch.setattr(tools_module, "authorize_search", AsyncMock(return_value=None))
    monkeypatch.setattr(AgentTools, "_resolve_accessible_datasource_ids", AsyncMock(return_value=None))
    monkeypatch.setattr(tools_module, "merge_acl_filter", lambda filters, user: {**(filters or {}), "metadata.acl_tags": ["__public__"]})
    at.vector_db_query_service.query = AsyncMock(return_value=[{"id": "chunk-1"}])

    await at.fetch_document("doc-1")

    _, kwargs = at.vector_db_query_service.query.call_args
    assert kwargs["filters"]["metadata.acl_tags"] == ["__public__"]

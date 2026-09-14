# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for truncation marker behaviour in AgentTools._make_search_fn.

These are regression tests for commit 6d825e70 (PR #1044) which removed
per-result [Content truncated. Use fetch_document...] markers from search
results, inadvertently breaking the model's bounded-fetch protocol and causing
fetch_document to be called indefinitely in deep-research mode.

The fix (applied in this PR) removes the old `truncation_markers_shown < 2`
cap so that EVERY truncated result with a document_id gets its own marker.

Each test is designed to be a concrete regression guard:
  - test_ten_truncated_results_all_marked: would have failed with old code (only 2 markers)
  - test_marker_format_exact: guards the exact CTA text the model follows
  - test_all_truncated_results_get_markers: the primary regression test

Setup:
  These tests run against the AgentTools class in server.tools.
  All external I/O (VectorDB, Redis, MetadataStorage) is mocked.
  The search_result_truncate_length module constant is patched per-test.

Usage:
  From within ai_platform_engineering/knowledge_bases/rag/server/:
    uv run pytest tests/test_tools_truncation.py -v

  From the repo root (requires make test-rag-unit):
    make test-rag-unit
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TRUNCATE_LEN = 500   # mirrors default SEARCH_RESULT_TRUNCATE_LENGTH env var


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_result(page_content: str, document_id: str = "", score: float = 0.9) -> MagicMock:
  """Build a mock QueryResult with the minimum attributes _run_one accesses."""
  result = MagicMock()
  result.document = MagicMock()
  result.document.page_content = page_content
  result.document.metadata = {"document_id": document_id} if document_id else {}
  result.score = score
  return result


def _long(n: int = 1000) -> str:
  """Return page_content longer than _TRUNCATE_LEN (> 500 chars)."""
  return "a" * n


def _short(n: int = 100) -> str:
  """Return page_content shorter than _TRUNCATE_LEN (< 500 chars)."""
  return "b" * n


def _make_single_label_config(label: str = "semantic_results"):
  """Create a minimal MCPToolConfig with one parallel search lane."""
  from common.models.rag import MCPToolConfig, ParallelSearch
  return MCPToolConfig(
    tool_id="search",
    parallel_searches=[ParallelSearch(label=label, semantic_weight=0.7)],
    allow_runtime_filters=False,
    enabled=True,
  )


def _make_tools():
  """Create an authorized AgentTools instance with all I/O mocked out.

  These tests isolate result formatting, not MCP authentication. The live
  implementation deliberately fails closed when no middleware-provided caller
  exists, so model that already-authorized boundary explicitly here.
  """
  from server.tools import AgentTools
  tools = AgentTools(
    redis_client=MagicMock(),
    vector_db_query_service=MagicMock(),
    metadata_storage=MagicMock(),
  )
  tools._resolve_accessible_datasource_ids = AsyncMock(return_value=None)
  return tools


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTruncationMarkers:
  """Regression tests for the per-result fetch_document truncation markers."""

  @pytest.mark.asyncio
  async def test_all_truncated_results_get_markers(self):
    """
    REGRESSION GUARD: every truncated result must get a marker.

    Old code capped markers at 2 per search call, leaving results [2..N]
    without markers. The model then used the generic overthink-prompt
    directive to fetch all of them, causing the infinite loop.
    """
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id=f"doc-{i}") for i in range(5)
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test query", limit=10, thought="test")

    out = response["semantic_results"]
    marker_count = sum(1 for r in out if "[Content truncated. Use fetch_document" in r["text_content"])
    assert marker_count == 5, (
      f"Expected one marker per truncated result (5), got {marker_count}. "
      "Old code with `truncation_markers_shown < 2` would return 2."
    )

  @pytest.mark.asyncio
  async def test_ten_truncated_results_all_marked(self):
    """
    Stronger regression test: 10 truncated results → 10 markers.

    The old code (before this fix) would only add 2 markers per search call
    regardless of how many results were truncated. This test would fail on
    the old code and explicitly catches the regression.
    """
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id=f"doc-{i}") for i in range(10)
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=20, thought="")

    out = response["semantic_results"]
    marker_count = sum(1 for r in out if "[Content truncated. Use fetch_document" in r["text_content"])
    assert marker_count == 10, (
      f"Expected 10 markers, got {marker_count}. "
      "Old code (truncation_markers_shown < 2) would return exactly 2."
    )

  @pytest.mark.asyncio
  async def test_short_results_no_marker(self):
    """Results where page_content fits within the truncate limit get no marker."""
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_short(), document_id="doc-short"),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    assert "[Content truncated" not in text

  @pytest.mark.asyncio
  async def test_truncated_without_doc_id_no_marker(self):
    """
    Truncated content without a document_id in metadata gets no marker.

    The marker CTA requires a document_id to be actionable for the model.
    If document_id is missing, silently skip (don't add a broken CTA).
    """
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id=""),  # metadata has no document_id
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    assert "[Content truncated" not in text

  @pytest.mark.asyncio
  async def test_marker_contains_correct_document_id(self):
    """The truncation marker embeds the exact document_id from result metadata."""
    doc_id = "example-deployment-guide-v2"
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id=doc_id),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    assert f"document_id='{doc_id}'" in text, (
      f"Marker must contain document_id='{doc_id}', got: {text[-300:]}"
    )

  @pytest.mark.asyncio
  async def test_marker_format_exact(self):
    """
    The marker follows the exact CTA format the model is trained to respect.

    Changing this format (e.g. removing "if needed") could alter model behaviour.
    This test acts as a change-detection guard.
    """
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id="my-doc-id"),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    expected = "[Content truncated. Use fetch_document with document_id='my-doc-id' to get full content if needed.]"
    assert expected in text, (
      f"Exact marker format not found.\nExpected: {expected}\nGot (last 200 chars): {text[-200:]}"
    )

  @pytest.mark.asyncio
  async def test_mixed_results_selective_markers(self):
    """
    Markers appear only on truncated results that have a document_id.

    Input mix:
      [0] long + doc_id  → marker expected
      [1] short + doc_id → NO marker (not truncated)
      [2] long + no-id   → NO marker (no document_id)
      [3] long + doc_id  → marker expected
    """
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id="doc-A"),    # marker
      _make_result(_short(), document_id="doc-B"),   # no marker (short)
      _make_result(_long(), document_id=""),         # no marker (no doc_id)
      _make_result(_long(), document_id="doc-D"),    # marker
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=10, thought="")

    out = response["semantic_results"]
    assert "[Content truncated" in out[0]["text_content"],     "result[0] (long+id) must have marker"
    assert "[Content truncated" not in out[1]["text_content"], "result[1] (short+id) must NOT have marker"
    assert "[Content truncated" not in out[2]["text_content"], "result[2] (long+no-id) must NOT have marker"
    assert "[Content truncated" in out[3]["text_content"],     "result[3] (long+id) must have marker"

  @pytest.mark.asyncio
  async def test_marker_appended_after_snippet(self):
    """Marker is appended AFTER the formatted snippet, not prepended."""
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id="doc-order"),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    marker_pos = text.find("[Content truncated")
    assert marker_pos > 0, "Marker must come after the snippet content"
    # Marker must be the very last thing in the text
    assert text.endswith("]"), f"Text must end with marker ']', got: {text[-50:]!r}"

  @pytest.mark.asyncio
  async def test_empty_results_no_crash(self):
    """Empty result list produces empty output dict without raising."""
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=10, thought="")

    assert response == {"semantic_results": []}

  @pytest.mark.asyncio
  async def test_result_output_structure(self):
    """Every result dict has text_content, metadata, and score keys."""
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id="doc-1", score=0.95),
      _make_result(_short(), document_id="doc-2", score=0.80),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=10, thought="")

    for result in response["semantic_results"]:
      assert "text_content" in result
      assert "metadata" in result
      assert "score" in result

  @pytest.mark.asyncio
  async def test_multi_lane_search_both_lanes_marked(self):
    """
    In a multi-lane (parallel) search, truncation markers are added
    independently in each lane — both semantic and keyword results get markers.
    """
    from common.models.rag import MCPToolConfig, ParallelSearch
    config = MCPToolConfig(
      tool_id="search",
      parallel_searches=[
        ParallelSearch(label="semantic_results", semantic_weight=0.7),
        ParallelSearch(label="keyword_results", semantic_weight=0.2),
      ],
      allow_runtime_filters=False,
      enabled=True,
    )

    at = _make_tools()
    # Both lanes return the same mock results
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result(_long(), document_id="doc-X"),
      _make_result(_long(), document_id="doc-Y"),
    ])

    search_fn = at._make_search_fn(config, graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    for lane in ("semantic_results", "keyword_results"):
      lane_results = response[lane]
      for r in lane_results:
        assert "[Content truncated" in r["text_content"], (
          f"Lane '{lane}' result missing truncation marker"
        )

  @pytest.mark.asyncio
  async def test_exactly_at_truncate_length_no_marker(self):
    """
    Content with len == truncate_length is NOT truncated (boundary check).
    Only len > truncate_length triggers the marker.
    """
    at = _make_tools()
    # Exactly at the boundary
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result("x" * _TRUNCATE_LEN, document_id="doc-boundary"),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    assert "[Content truncated" not in text, (
      "Content exactly at truncate_length must NOT get a marker (not truncated)"
    )

  @pytest.mark.asyncio
  async def test_one_above_truncate_length_gets_marker(self):
    """Content with len == truncate_length + 1 IS truncated and gets a marker."""
    at = _make_tools()
    at.vector_db_query_service.query = AsyncMock(return_value=[
      _make_result("x" * (_TRUNCATE_LEN + 1), document_id="doc-just-over"),
    ])

    search_fn = at._make_search_fn(_make_single_label_config(), graph_rag_enabled=False)
    with patch("server.tools.search_result_truncate_length", _TRUNCATE_LEN):
      response = await search_fn(query="test", limit=5, thought="")

    text = response["semantic_results"][0]["text_content"]
    assert "[Content truncated" in text, (
      "Content one char above truncate_length MUST get a marker"
    )

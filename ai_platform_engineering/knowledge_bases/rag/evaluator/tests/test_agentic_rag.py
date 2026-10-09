import json
import os
import unittest.mock as mock

from deepeval_eval.engine.agentic_rag import (
    AgenticRAG,
    AgenticRetriever,
    _dedupe_preserve_order,
    _extract_text_from_parts,
    _parse_rag_context_artifact,
    clean_snippet_markdown,
    default_agentic_rag_client,
)

# ============================================================
# 1. clean_snippet_markdown
# ============================================================


def test_clean_snippet_markdown_positive():
    # Positive: Strip prefix, bold markers, ellipses, and extra whitespace
    raw = "  **Snippet:** ...**CAIPE** uses **nomic-embed-text**...  "
    expected = "CAIPE uses nomic-embed-text"
    assert clean_snippet_markdown(raw) == expected


def test_clean_snippet_markdown_negative():
    # Negative: Handles empty string and None/empty inputs gracefully
    assert clean_snippet_markdown("") == ""
    assert clean_snippet_markdown(None) is None


# ============================================================
# 2. _extract_text_from_parts
# ============================================================


def test_extract_text_from_parts_positive():
    # Positive: Concatenate text parts
    parts = [
        {"kind": "text", "text": "Hello "},
        {"kind": "image", "url": "http://img"},
        {"kind": "text", "text": "world!"},
    ]
    assert _extract_text_from_parts(parts) == "Hello world!"


def test_extract_text_from_parts_negative():
    # Negative: Empty parts or parts without text/kind
    assert _extract_text_from_parts([]) == ""
    assert _extract_text_from_parts([{"kind": "image"}, {"text": "ignored"}]) == ""


# ============================================================
# 3. _parse_rag_context_artifact
# ============================================================


def test_parse_rag_context_artifact_positive_search():
    # Positive: parses search results shape (semantic and keyword results)
    search_data = {
        "semantic_results": [
            {"text_content": "**Snippet:** text1", "document_id": "doc1"},
            {"text_content": "text2", "metadata": {"doc_id": "doc2"}},
        ],
        "keyword_results": [
            {"text_content": "text3", "metadata": {"document_id": 3}},
        ],
    }
    raw = json.dumps(search_data)
    parsed = _parse_rag_context_artifact(raw)
    assert parsed == [
        ("text1", "doc1"),
        ("text2", "doc2"),
        ("text3", "3"),
    ]


def test_hybrid_search_deduplication_and_k_bounds():
    """Verify hybrid search dual arrays (semantic + keyword) deduplicate by document_id and fall in [k, 2k]."""
    from deepeval_eval.engine.agentic_rag import _dedupe_and_merge_contexts

    k = 2
    # Hybrid search produces up to k semantic + up to k keyword items
    search_data = {
        "semantic_results": [
            {
                "text_content": "**Snippet:** Overlapping doc content",
                "metadata": {"document_id": "dsid_ae068ee4aa9640159427cd941bef0238"},
            },
            {
                "text_content": "**Snippet:** Semantic unique content",
                "metadata": {"document_id": "dsid_semantic_unique_01"},
            },
        ],
        "keyword_results": [
            {
                "text_content": "**Snippet:** Overlapping doc content full extended text",
                "metadata": {"document_id": "dsid_ae068ee4aa9640159427cd941bef0238"},
            },
            {
                "text_content": "**Snippet:** Keyword unique content",
                "metadata": {"document_id": "dsid_keyword_unique_02"},
            },
        ],
    }
    raw = json.dumps(search_data)
    parsed = _parse_rag_context_artifact(raw)
    # Total raw results is 4 (2*k)
    assert len(parsed) == 4

    deduped = _dedupe_and_merge_contexts(parsed)
    # Total unique deduplicated items must be between k (2) and 2*k (4). Here 3 unique docs.
    assert k <= len(deduped) <= 2 * k
    assert len(deduped) == 3
    # Overlapping document selects longer content snippet
    doc_map = dict((doc_id, content) for content, doc_id in deduped)
    assert (
        doc_map["dsid_ae068ee4aa9640159427cd941bef0238"]
        == "Overlapping doc content full extended text"
    )


def test_parse_rag_context_artifact_positive_general_results():
    # Positive: parses "results" key or any key ending with "results"
    search_data = {
        "results": [
            {
                "text_content": "**Snippet:** text_res",
                "metadata": {"document_id": "dsid_ae068ee4aa9640159427cd941bef0238"},
            }
        ]
    }
    raw = json.dumps(search_data)
    parsed = _parse_rag_context_artifact(raw)
    assert parsed == [
        ("text_res", "dsid_ae068ee4aa9640159427cd941bef0238"),
    ]


def test_parse_rag_context_artifact_positive_fetch():
    # Positive: parses fetch_document list shape
    fetch_data = [
        {"document": {"page_content": "doc_content_1", "document_id": "doc1"}},
        {"document": {"page_content": "doc_content_2", "doc_id": "doc2"}},
    ]
    raw = json.dumps(fetch_data)
    parsed = _parse_rag_context_artifact(raw)
    assert parsed == [
        ("doc_content_1", "doc1"),
        ("doc_content_2", "doc2"),
    ]


def test_parse_rag_context_artifact_negative():
    # Negative: Handles invalid JSON and None
    assert _parse_rag_context_artifact("invalid-json") == []
    assert _parse_rag_context_artifact(None) == []


# ============================================================
# 4. _dedupe_preserve_order
# ============================================================


def test_dedupe_preserve_order_positive():
    # Positive: Dedupes by first element (content) in tuple, preserving order
    items = [
        ("a", "id1"),
        ("b", "id2"),
        ("a", "id3"),
        ("c", "id4"),
    ]
    assert _dedupe_preserve_order(items) == [
        ("a", "id1"),
        ("b", "id2"),
        ("c", "id4"),
    ]


def test_dedupe_preserve_order_negative():
    # Negative: Handles empty list
    assert _dedupe_preserve_order([]) == []


# ============================================================
# 5. AgenticRetriever
# ============================================================


def test_agentic_retriever_init_positive():
    # Positive: Initialize with custom options
    ret = AgenticRetriever(agent_api_url="http://custom", timeout=10.0, insecure=True)
    assert ret.agent_api_url == "http://custom"
    assert ret.timeout == 10.0
    assert ret.insecure is True


def test_agentic_retriever_init_negative():
    # Negative: Default config fallback
    with mock.patch.dict(os.environ, {"INSECURE_SSL": "false"}):
        ret = AgenticRetriever()
        assert ret.agent_api_url is not None
        assert ret.timeout == 200.0
        assert ret.insecure is False


def test_agentic_retriever_fit():
    # Positive/Negative: fit does not crash and updates internal variables
    ret = AgenticRetriever()
    ret.fit(["doc1", "doc2"])
    assert ret.documents == ["doc1", "doc2"]
    assert ret.documents_metadata == [{}, {}]


def test_agentic_retriever_get_top_k_positive():
    # Positive: extracts answer and contexts from gateway response
    ret = AgenticRetriever()
    mock_contexts = [("c1", "d1")]

    def fake_query_gateway(*args, **kwargs):
        ret.last_answer = "This is the final answer."
        return mock_contexts

    with mock.patch.object(ret, "_query_gateway", side_effect=fake_query_gateway):
        res = ret.get_top_k("test query", k=2)
        assert res == [(0, 1.0)]
        assert ret.documents == ["c1"]
        assert ret.documents_metadata == [{"doc_id": "d1"}]
        assert ret.last_answer == "This is the final answer."


def test_agentic_retriever_get_top_k_negative():
    # Negative: empty/failed response
    ret = AgenticRetriever()
    with mock.patch.object(ret, "_query_gateway", return_value=[]):
        assert ret.get_top_k("test query") == []
        assert ret.documents == []
        assert ret.documents_metadata == []
        assert ret.last_answer == ""


# ============================================================
# 6. AgenticRAG
# ============================================================


def test_agentic_rag_init_positive():
    # Positive: Initialize with values
    rag = AgenticRAG(agent_api_url="http://custom", timeout=50.0, insecure=True)
    assert rag.model_name == "agentic"
    assert rag._agentic_retriever.agent_api_url == "http://custom"
    assert rag._agentic_retriever.timeout == 50.0
    assert rag._agentic_retriever.insecure is True


def test_agentic_rag_init_negative():
    # Negative: Default init
    rag = AgenticRAG()
    assert rag.model_name == "agentic"
    assert rag._agentic_retriever.agent_api_url is not None


def test_dedupe_and_merge_contexts_dup() -> None:
    from deepeval_eval.engine.agentic_rag import _dedupe_and_merge_contexts

    # Duplicate doc_id with longer content replaces shorter content + invalid items
    items = [
        None,
        "invalid_item",
        ("only_one_elem",),
        ("short", "d1"),
        ("longer content here", "d1"),
        ("no doc id content", None),
    ]
    res = _dedupe_and_merge_contexts(items)
    assert len(res) == 2
    assert res[0] == ("longer content here", "d1")
    assert res[1][1] is None


def test_agentic_rag_usage_artifacts_parsing() -> None:
    from deepeval_eval.engine.agentic_rag import AgenticRAG

    rag = AgenticRAG(agent_api_url="http://localhost:8000")
    rag._agentic_retriever.last_answer = "Ans"
    rag._agentic_retriever.documents = ["Doc"]
    rag._agentic_retriever.documents_metadata = [{"doc_id": "d1"}]
    rag._agentic_retriever.last_raw_response = {
        "result": {
            "artifacts": [
                {
                    "metadata": {
                        "usage_metadata": {
                            "input_tokens": 10,
                            "output_tokens": 5,
                        }
                    }
                }
            ]
        }
    }
    with mock.patch.object(
        rag._agentic_retriever, "get_top_k", return_value=[(0, 0.9)]
    ):
        res = rag.query("Q?", run_id="run1")
        assert res["usage"] == {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
        }
        assert res["answer"] == "Ans"
        assert len(res["retrieved_docs"]) == 1


def test_agentic_rag_usage_prompt_tokens_fallback() -> None:
    from deepeval_eval.engine.agentic_rag import AgenticRAG

    rag = AgenticRAG(agent_api_url="http://localhost:8000")
    rag._agentic_retriever.last_answer = "Ans"
    rag._agentic_retriever.documents = ["Doc"]
    rag._agentic_retriever.documents_metadata = [{"doc_id": "d1"}]
    rag._agentic_retriever.last_raw_response = {
        "metadata": {
            "usage_metadata": {
                "prompt_tokens": 20,
                "completion_tokens": 10,
                "total_tokens": 30,
            }
        }
    }
    with mock.patch.object(
        rag._agentic_retriever, "get_top_k", return_value=[(0, 0.9)]
    ):
        res = rag.query("Q?", run_id="r1")
        assert res["usage"]["prompt_tokens"] == 20
        assert res["usage"]["completion_tokens"] == 10
        assert res["usage"]["total_tokens"] == 30

    ret = rag._agentic_retriever
    with mock.patch.object(ret, "get_top_k", return_value=[(0, 0.9)]):
        res_ret = ret.retrieve("Q?")
        assert res_ret.input_tokens == 20
        assert res_ret.output_tokens == 10
        assert res_ret.total_tokens == 30


def test_agentic_retriever_error_fallback() -> None:
    from deepeval_eval.engine.agentic_rag import AgenticRetriever

    retriever = AgenticRetriever(agent_api_url="http://localhost:8000")
    with mock.patch.object(
        retriever, "get_top_k", side_effect=ValueError("Gateway connection error")
    ):
        res = retriever.retrieve("What is X?")
        assert res.error == "Gateway connection error"
        assert res.answer == ""
        assert res.contexts == []


def test_agentic_rag_query_default_run_id() -> None:
    from deepeval_eval.engine.agentic_rag import AgenticRAG

    rag = AgenticRAG(agent_api_url="http://localhost:8000")
    rag._agentic_retriever.last_answer = "Ans"
    rag._agentic_retriever.documents = ["Doc text"]
    rag._agentic_retriever.documents_metadata = [{"doc_id": "d1"}]
    with mock.patch.object(
        rag._agentic_retriever, "get_top_k", return_value=[(0, 0.9)]
    ):
        res = rag.query("Test question", run_id=None)
        assert res["answer"] == "Ans"
        assert len(res["retrieved_docs"]) == 1


@mock.patch("deepeval_eval.engine.agentic_rag.AgenticRAG.export_traces_to_log")
def test_agentic_rag_query_positive(mock_export):
    # Positive: successful query and usage parsing
    rag = AgenticRAG()
    ret = rag._agentic_retriever

    mock_export.return_value = "log_path.json"

    def fake_get_top_k(*args, **kwargs):
        ret.last_answer = "the answer"
        ret.documents = ["context content"]
        ret.documents_metadata = [{"doc_id": "doc1"}]
        ret.last_raw_response = {
            "result": {
                "metadata": {
                    "usage_metadata": {
                        "input_tokens": 10,
                        "output_tokens": 20,
                        "total_tokens": 30,
                    }
                }
            }
        }
        return [(0, 1.0)]

    with mock.patch.object(ret, "get_top_k", side_effect=fake_get_top_k):
        res = rag.query("question text", top_k=2, trace_log=True)
        assert res["answer"] == "the answer"
        assert res["retrieved_doc_ids"] == ["doc1"]
        assert len(res["retrieved_docs"]) == 1
        assert res["retrieved_docs"][0]["content"] == "context content"


@mock.patch("deepeval_eval.engine.agentic_rag.AgenticRAG.export_traces_to_log")
def test_agentic_rag_query_negative(mock_export):
    # Negative: exception during query flow
    rag = AgenticRAG()
    ret = rag._agentic_retriever

    mock_export.return_value = "error_log_path.json"
    with mock.patch.object(
        ret, "get_top_k", side_effect=Exception("Retriever failure")
    ):
        res = rag.query("question text")
        assert "Error processing query: Retriever failure" in res["answer"]
        assert res["retrieved_docs"] == []
        assert res["retrieved_doc_ids"] == []
        assert res["usage"] is None
        assert res["logs"] == "error_log_path.json"


def test_extract_usage_from_response_three_paths():
    from deepeval_eval.engine.agentic_rag import _extract_usage_from_response

    # 1. response metadata.usage_metadata
    assert _extract_usage_from_response(
        {
            "metadata": {
                "usage_metadata": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                }
            }
        }
    ) == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
    }
    # 2. usage_metadata inside result.metadata
    assert _extract_usage_from_response(
        {
            "result": {
                "metadata": {
                    "usage_metadata": {
                        "input_tokens": 2,
                        "output_tokens": 3,
                        "total_tokens": 5,
                    }
                }
            }
        }
    ) == {
        "input_tokens": 2,
        "output_tokens": 3,
        "total_tokens": 5,
    }
    # 3. None when missing
    assert _extract_usage_from_response({}) == {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    }


# ============================================================
# 7. default_agentic_rag_client
# ============================================================


def test_default_agentic_rag_client_positive():
    # Positive
    rag = default_agentic_rag_client(
        agent_api_url="http://sup", timeout=10.0, insecure=True
    )
    assert isinstance(rag, AgenticRAG)
    assert rag._agentic_retriever.agent_api_url == "http://sup"
    assert rag._agentic_retriever.timeout == 10.0


def test_default_agentic_rag_client_negative():
    # Negative: default values
    rag = default_agentic_rag_client()
    assert isinstance(rag, AgenticRAG)


# ============================================================
# 8. _query_gateway
# ============================================================


@mock.patch("httpx.stream")
@mock.patch("httpx.post")
def test_agentic_retriever_query_gateway_positive(mock_post, mock_stream):
    # Setup mock for conv_url
    mock_conv_resp = mock.Mock()
    mock_conv_resp.status_code = 201
    mock_conv_resp.json.return_value = {"data": {"conversation": {"_id": "conv-123"}}}
    mock_post.return_value = mock_conv_resp

    # Setup mock for stream_url
    mock_stream_resp = mock.MagicMock()
    mock_stream_resp.status_code = 200
    mock_stream_resp.iter_lines.return_value = [
        "event: content",
        'data: {"text": "thinking..."}',
        "event: tool_end",
        'data: {"result": "{\\"semantic_results\\": [{\\"text_content\\": \\"doc content\\", \\"document_id\\": \\"doc-99\\"}]}"}',
        "event: content",
        'data: {"text": "hello"}',
        "event: done",
        "",
    ]
    mock_stream.return_value.__enter__.return_value = mock_stream_resp

    ret = AgenticRetriever(agent_api_url="https://gateway.service")
    res = ret._query_gateway("test question", k=1)

    assert res == [("doc content", "doc-99")]
    assert ret.last_answer == "hello"


@mock.patch("httpx.post")
def test_agentic_retriever_query_gateway_negative(mock_post):
    mock_post.side_effect = Exception("Connection error")

    ret = AgenticRetriever(agent_api_url="https://gateway.service")
    res = ret._query_gateway("test question", k=1)

    assert res == []
    assert ret.last_answer == ""


# ============================================================
# 9. Trace Logging Tests
# ============================================================


@mock.patch("httpx.stream")
@mock.patch("httpx.post")
def test_agentic_retriever_trace_log_positive(mock_post, mock_stream, tmp_path):
    # Setup mock for conv_url
    mock_conv_resp = mock.Mock()
    mock_conv_resp.status_code = 201
    mock_conv_resp.json.return_value = {"data": {"conversation": {"_id": "conv-123"}}}
    mock_post.return_value = mock_conv_resp

    # Setup mock for stream_url
    mock_stream_resp = mock.MagicMock()
    mock_stream_resp.status_code = 200
    mock_stream_resp.iter_lines.return_value = [
        "event: content",
        'data: {"text": "hello"}',
        "event: tool_end",
        'data: {"result": "{\\"semantic_results\\": [{\\"text_content\\": \\"doc content\\", \\"document_id\\": \\"doc-99\\"}]}"}',
    ]
    mock_stream.return_value.__enter__.return_value = mock_stream_resp

    log_dir = tmp_path / "logs"
    ret = AgenticRetriever(
        agent_api_url="https://gateway.service",
        trace_log=True,
        log_dir=log_dir,
    )
    res = ret._query_gateway("test question", k=1, run_id="test_run_123")

    assert res == [("doc content", "doc-99")]
    log_file_path = log_dir / "test_run_123_agent_trace.log"
    assert log_file_path.exists()
    content = log_file_path.read_text(encoding="utf-8")
    assert "[event: content]" in content
    assert '"text": "hello"' in content


@mock.patch("httpx.stream")
@mock.patch("httpx.post")
def test_agentic_retriever_trace_log_negative(mock_post, mock_stream, tmp_path):
    # Setup mock for conv_url
    mock_conv_resp = mock.Mock()
    mock_conv_resp.status_code = 201
    mock_conv_resp.json.return_value = {"data": {"conversation": {"_id": "conv-123"}}}
    mock_post.return_value = mock_conv_resp

    # Setup mock for stream_url
    mock_stream_resp = mock.MagicMock()
    mock_stream_resp.status_code = 200
    mock_stream_resp.iter_lines.return_value = [
        "event: content",
        'data: {"text": "hello"}',
    ]
    mock_stream.return_value.__enter__.return_value = mock_stream_resp

    log_dir = tmp_path / "logs"
    # trace_log explicitly False
    ret = AgenticRetriever(
        agent_api_url="https://gateway.service",
        trace_log=False,
        log_dir=log_dir,
    )
    res = ret._query_gateway("test question", k=1, run_id="test_run_123")

    assert res == []
    # Log file should NOT exist
    assert not any(log_dir.glob("*.log")) if log_dir.exists() else True


def test_agentic_rag_query_trace_written_when_trace_log_enabled(tmp_path):
    """query_trace JSON is written to log_dir when trace_log=True."""
    rag = AgenticRAG(
        agent_api_url="http://localhost:8000",
        log_dir=tmp_path,
        trace_log=True,
    )
    rag._agentic_retriever.last_answer = "Ans"
    rag._agentic_retriever.documents = ["Doc"]
    rag._agentic_retriever.documents_metadata = [{"doc_id": "d1"}]
    with mock.patch.object(
        rag._agentic_retriever, "get_top_k", return_value=[(0, 0.9)]
    ):
        rag.query("Q?", run_id="run_abc", trace_log=True)

    trace_files = list(tmp_path.glob("*_query_trace.json"))
    assert len(trace_files) == 1


def test_agentic_rag_query_trace_not_written_when_trace_log_disabled(tmp_path):
    """query_trace JSON is NOT written when trace_log=False."""
    rag = AgenticRAG(
        agent_api_url="http://localhost:8000",
        log_dir=tmp_path,
        trace_log=False,
    )
    rag._agentic_retriever.last_answer = "Ans"
    rag._agentic_retriever.documents = ["Doc"]
    rag._agentic_retriever.documents_metadata = [{"doc_id": "d1"}]
    with mock.patch.object(
        rag._agentic_retriever, "get_top_k", return_value=[(0, 0.9)]
    ):
        rag.query("Q?", run_id="run_xyz", trace_log=False)

    trace_files = list(tmp_path.glob("*_query_trace.json"))
    assert len(trace_files) == 0


# ============================================================
# 10. Retry Logic & fail_on_error Tests
# ============================================================


@mock.patch("httpx.post")
def test_agentic_retriever_fail_on_error(mock_post):
    mock_post.side_effect = Exception("Persistent failure")
    ret = AgenticRetriever(agent_api_url="https://gateway.service", fail_on_error=True)
    import pytest

    with pytest.raises(Exception, match="Persistent failure"):
        ret.retrieve("test question")


@mock.patch("httpx.stream")
@mock.patch("httpx.post")
@mock.patch("time.sleep")  # avoid actual sleeping during tests
@mock.patch.object(AgenticRetriever, "_get_oidc_token", return_value="fake-token")
def test_agentic_retriever_retry_success(
    mock_get_token, mock_sleep, mock_post, mock_stream
):
    # First attempt: httpx.post raises an exception (e.g. timeout)
    # Second attempt: succeeds
    mock_conv_resp = mock.Mock()
    mock_conv_resp.status_code = 201
    mock_conv_resp.json.return_value = {"data": {"conversation": {"_id": "conv-456"}}}

    mock_post.side_effect = [Exception("Transient timeout"), mock_conv_resp]

    # Setup mock for stream_url on the second attempt
    mock_stream_resp = mock.MagicMock()
    mock_stream_resp.status_code = 200
    mock_stream_resp.iter_lines.return_value = [
        "event: content",
        'data: {"text": "hello on retry"}',
    ]
    mock_stream.return_value.__enter__.return_value = mock_stream_resp

    ret = AgenticRetriever(agent_api_url="https://gateway.service")
    res = ret._query_gateway("test question", k=1)

    assert res == []
    assert ret.last_answer == "hello on retry"
    assert mock_post.call_count == 2
    assert mock_sleep.call_count == 1


@mock.patch("httpx.stream")
@mock.patch("httpx.post")
@mock.patch.object(AgenticRetriever, "_get_oidc_token", return_value="fake-token")
def test_agentic_retriever_preserves_sse_usage_metadata(
    mock_get_token, mock_post, mock_stream
):
    mock_conv_resp = mock.Mock()
    mock_conv_resp.status_code = 201
    mock_conv_resp.json.return_value = {"data": {"conversation": {"_id": "conv-789"}}}
    mock_post.return_value = mock_conv_resp

    mock_stream_resp = mock.MagicMock()
    mock_stream_resp.status_code = 200
    mock_stream_resp.iter_lines.return_value = [
        "event: content",
        'data: {"text": "Answer text"}',
        "event: done",
        'data: {"usage_metadata": {"prompt_tokens": 15646, "completion_tokens": 125, "total_tokens": 15771}}',
    ]
    mock_stream.return_value.__enter__.return_value = mock_stream_resp

    ret = AgenticRetriever(agent_api_url="https://gateway.service")
    result = ret.retrieve("test question", k=1)

    assert result.answer == "Answer text"
    assert result.input_tokens == 15646
    assert result.output_tokens == 125
    assert result.total_tokens == 15771


@mock.patch.object(AgenticRetriever, "get_top_k", return_value=[])
def test_agentic_rag_query_default_run_id_positive(mock_get_top_k):
    rag = AgenticRAG(agent_api_url="https://gateway.service")
    rag._agentic_retriever.last_answer = "test answer"
    res = rag.query("What is the capital?")

    assert res["answer"] == "test answer"
    assert len(rag.traces) > 0
    assert rag.traces[0].data["question"] == "What is the capital?"
    run_id = rag.traces[0].data["run_id"]
    assert len(run_id.split("_")) == 3  # Format: YYYYMMDD_HHMMSS_####


def test_parse_rag_context_artifact_single_dict_and_list_formats() -> None:
    from deepeval_eval.engine.agentic_rag import _parse_rag_context_artifact

    # Single dict with "document" key
    single_doc_payload = {
        "document": {
            "page_content": "This is single document content.",
            "document_id": "doc-single-101",
        }
    }
    res_single = _parse_rag_context_artifact(single_doc_payload)
    assert len(res_single) == 1
    assert res_single[0] == ("This is single document content.", "doc-single-101")

    # List of document items
    list_payload = [
        {"document": {"page_content": "Page content 1", "metadata": {"doc_id": "d1"}}},
        {"document": {"text_content": "Text content 2", "doc_id": "d2"}},
    ]
    res_list = _parse_rag_context_artifact(list_payload)
    assert len(res_list) == 2
    assert res_list[0] == ("Page content 1", "d1")
    assert res_list[1] == ("Text content 2", "d2")


def test_extract_usage_from_artifacts_metadata() -> None:
    from deepeval_eval.engine.agentic_rag import _extract_usage_from_response

    resp = {
        "result": {
            "artifacts": [
                {
                    "metadata": {
                        "usage": {
                            "input_tokens": 150,
                            "output_tokens": 40,
                            "total_tokens": 190,
                        }
                    }
                }
            ]
        }
    }
    usage = _extract_usage_from_response(resp)
    assert usage["input_tokens"] == 150
    assert usage["output_tokens"] == 40
    assert usage["total_tokens"] == 190


def test_agentic_retriever_get_oidc_token_delegates_to_token_manager() -> None:
    ret = AgenticRetriever(auth_token="static-token-abc")
    assert ret._get_oidc_token() == "static-token-abc"


@mock.patch("httpx.stream")
@mock.patch("httpx.post")
def test_agentic_retriever_401_retry_and_malformed_sse(mock_post, mock_stream) -> None:
    # First post returns 401, second post returns 201
    resp_401 = mock.Mock(status_code=401)
    resp_201 = mock.Mock(status_code=201)
    resp_201.json.return_value = {"data": {"conversation": {"_id": "conv-retry-123"}}}
    mock_post.side_effect = [resp_401, resp_201]

    # SSE stream with malformed JSON data lines and tool_start resetting last_answer
    mock_stream_resp = mock.MagicMock(status_code=200)
    mock_stream_resp.iter_lines.return_value = [
        "event: tool_start",
        "data: {malformed json",
        "event: content",
        'data: {"text": "Retried answer"}',
    ]
    mock_stream.return_value.__enter__.return_value = mock_stream_resp

    ret = AgenticRetriever(
        agent_api_url="https://gateway.example.org", datasource_id=None
    )
    with mock.patch.object(ret.token_manager, "force_refresh") as mock_refresh:
        ret._query_gateway("Test query")
        mock_refresh.assert_called_once()
        assert ret.last_answer == "Retried answer"


def test_agentic_retriever_when_url_has_dynamic_agents_suffix_normalizes_to_base_url() -> (
    None
):
    ret = AgenticRetriever(
        agent_api_url="http://caipe-caipe-ui:3000/api/dynamic-agents"
    )
    assert ret.agent_api_url == "http://caipe-caipe-ui:3000"


def test_agentic_retriever_when_url_has_api_v1_suffix_normalizes_to_base_url() -> None:
    ret = AgenticRetriever(agent_api_url="http://caipe-caipe-ui:3000/api/v1")
    assert ret.agent_api_url == "http://caipe-caipe-ui:3000"


def test_agentic_retriever_when_url_has_api_chat_suffix_normalizes_to_base_url() -> (
    None
):
    ret = AgenticRetriever(agent_api_url="http://caipe-caipe-ui:3000/api/chat")
    assert ret.agent_api_url == "http://caipe-caipe-ui:3000"


def test_agentic_retriever_when_url_is_clean_base_preserves_url() -> None:
    ret = AgenticRetriever(agent_api_url="http://caipe-caipe-ui:3000")
    assert ret.agent_api_url == "http://caipe-caipe-ui:3000"


def test_agentic_retriever_when_settings_has_trailing_slash_normalizes_cleanly() -> (
    None
):
    ret = AgenticRetriever(
        agent_api_url="http://caipe-caipe-ui:3000/api/dynamic-agents/"
    )
    assert ret.agent_api_url == "http://caipe-caipe-ui:3000"

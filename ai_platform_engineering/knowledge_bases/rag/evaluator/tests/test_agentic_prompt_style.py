from __future__ import annotations

from unittest.mock import MagicMock, patch

from deepeval_eval.clients.rag import AgenticRagAdapter
from deepeval_eval.engine.agentic_rag import AgenticRetriever


def test_agentic_retriever_formats_pre_retrieval_prompt_style() -> None:
    """Verify AgenticRetriever applies search_tool_name and build_agentic_prompt."""
    retriever = AgenticRetriever(
        agent_api_url="http://mock-agent:8000",
        datasource_id="test_ds",
        search_tool_name="hybrid_search",
        fail_on_error=False,
    )

    with patch.object(retriever, "_query_gateway", return_value=[]) as mock_gateway:
        retriever.get_top_k(
            query="What is the request size limit?",
            prompt_style="agentic_generation",
        )

        mock_gateway.assert_called_once()
        sent_query = mock_gateway.call_args[0][0]
        assert "When calling the `hybrid_search` tool" in sent_query
        assert "What is the request size limit?" in sent_query


def test_agentic_rag_adapter_passes_prompt_style_and_args() -> None:
    """Verify AgenticRagAdapter passes prompt_style and prompt_args down to retriever."""
    adapter = AgenticRagAdapter(
        agent_url="http://mock-agent:8000",
        datasource_id="test_ds",
        search_tool_name="hybrid_search",
        prompt_args={"domain": "compliance"},
    )
    mock_retriever = MagicMock()
    mock_retriever.retrieve.return_value = MagicMock(
        answer="10MB limit",
        contexts=["Context 1"],
        latency_ms=100.0,
        input_tokens=10,
        output_tokens=5,
        total_tokens=15,
        log_file=None,
    )
    mock_retriever.documents_metadata = [{"doc_id": "doc1"}]
    adapter.retriever = mock_retriever

    res = adapter.query(
        question="What is the request size limit?",
        prompt_style="agentic_short",
        prompt_args={"domain": "compliance"},
        search_tool_name="hybrid_search",
    )

    assert res.answer == "10MB limit"
    mock_retriever.retrieve.assert_called_once()
    assert mock_retriever.retrieve.call_args[1]["prompt_style"] == "agentic_short"
    assert mock_retriever.retrieve.call_args[1]["prompt_args"] == {
        "domain": "compliance"
    }
    assert mock_retriever.retrieve.call_args[1]["search_tool_name"] == "hybrid_search"

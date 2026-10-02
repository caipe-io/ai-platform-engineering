from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from deepeval_eval.clients.rag import AgenticRagAdapter, RagQueryResult


def test_rag_query_result_with_valid_attributes_returns_expected_values() -> None:
    res = RagQueryResult(
        answer="Paris",
        contexts=["Context A"],
        sources=[{"document_id": "doc1"}],
        retrieved_doc_ids=["doc1"],
        latency_sec=0.5,
        latency_ms=500.0,
    )
    assert res.answer == "Paris"
    assert res.contexts == ["Context A"]
    assert res.retrieved_doc_ids == ["doc1"]
    assert res.latency_sec == 0.5
    assert res.latency_ms == 500.0


def test_rag_query_result_with_empty_inputs_returns_default_values() -> None:
    res = RagQueryResult(
        answer="",
        contexts=[],
        sources=[],
        retrieved_doc_ids=[],
    )
    assert res.answer == ""
    assert res.latency_sec == 0.0
    assert res.log_file == ""


def test_agentic_rag_adapter_query_returns_retrieved_documents_and_metrics(
    tmp_path: Path,
) -> None:
    mock_retriever = MagicMock()
    mock_agentic_result = MagicMock()
    mock_agentic_result.answer = "Agentic Answer"
    mock_agentic_result.contexts = ["Context 1 text long enough for testing"]
    mock_agentic_result.latency_ms = 1200.0
    mock_agentic_result.task_id = "task-123"
    mock_agentic_result.input_tokens = 100
    mock_agentic_result.output_tokens = 50
    mock_agentic_result.total_tokens = 150
    mock_agentic_result.log_file = "results/deepeval_test_trace.log"

    mock_retriever.retrieve.return_value = mock_agentic_result
    mock_retriever.documents_metadata = [{"doc_id": "doc_meta_1"}]

    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ):
        adapter = AgenticRagAdapter(
            agent_url="http://localhost:8000", results_dir=tmp_path
        )
        result = adapter.query("What is the prompt?", top_k=2)

        assert result.answer == "Agentic Answer"
        assert result.contexts == ["Context 1 text long enough for testing"]
        assert result.retrieved_doc_ids == ["doc_meta_1"]
        assert result.latency_ms == 1200.0
        assert result.latency_sec == 1.2
        assert result.log_file == "results/deepeval_test_trace.log"


def test_agentic_rag_adapter_empty_query_returns_empty_result(
    tmp_path: Path,
) -> None:
    mock_retriever = MagicMock()
    mock_agentic_result = MagicMock()
    mock_agentic_result.answer = ""
    mock_agentic_result.contexts = []
    mock_agentic_result.latency_ms = 0.0
    mock_agentic_result.task_id = "empty"
    mock_agentic_result.input_tokens = 0
    mock_agentic_result.output_tokens = 0
    mock_agentic_result.total_tokens = 0

    mock_retriever.retrieve.return_value = mock_agentic_result
    mock_retriever.documents_metadata = []

    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ):
        adapter = AgenticRagAdapter(
            agent_url="http://localhost:8000", results_dir=tmp_path
        )
        result = adapter.query("Missing query")

        assert result.answer == ""
        assert result.contexts == []
        assert result.retrieved_doc_ids == []


def test_agentic_rag_adapter_datasource_id_forwarding(tmp_path: Path) -> None:
    mock_retriever = MagicMock()
    mock_agentic_result = MagicMock()
    mock_agentic_result.answer = "Enterprise Answer"
    mock_agentic_result.contexts = ["Enterprise Doc"]
    mock_agentic_result.latency_ms = 100.0
    mock_agentic_result.task_id = "task-ds"
    mock_agentic_result.input_tokens = 10
    mock_agentic_result.output_tokens = 10
    mock_agentic_result.total_tokens = 20

    mock_retriever.retrieve.return_value = mock_agentic_result
    mock_retriever.documents_metadata = []

    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ) as mock_init:
        adapter = AgenticRagAdapter(
            agent_url="http://localhost:8000",
            results_dir=tmp_path,
            datasource_id="enterprise_rag_bench",
        )
        mock_init.assert_called_once_with(
            agent_api_url="http://localhost:8000",
            timeout=200.0,
            log_dir=tmp_path,
            fail_on_error=False,
            datasource_id="enterprise_rag_bench",
            agent_id=None,
            trace_log=False,
            user_subject=None,
            user_token=None,
        )
        res = adapter.query("Enterprise Query?", datasource_id="override_ds")
        mock_retriever.retrieve.assert_called_with(
            "Enterprise Query?",
            k=3,
            datasource_id="override_ds",
            dataset_name=None,
            experiment_name=None,
            run_id=None,
            log_file_prefix=None,
        )
        assert res.answer == "Enterprise Answer"

        # Fallback to self.datasource_id when omitted in query()
        adapter.query("Enterprise Query 2?")
        mock_retriever.retrieve.assert_called_with(
            "Enterprise Query 2?",
            k=3,
            datasource_id="enterprise_rag_bench",
            dataset_name=None,
            experiment_name=None,
            run_id=None,
            log_file_prefix=None,
        )


def test_agentic_rag_adapter_agent_id_forwarding(tmp_path: Path) -> None:
    mock_retriever = MagicMock()
    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ) as mock_init:
        adapter = AgenticRagAdapter(
            agent_url="http://localhost:8000",
            results_dir=tmp_path,
            agent_id="custom-agent-v2",
        )
        mock_init.assert_called_once_with(
            agent_api_url="http://localhost:8000",
            timeout=200.0,
            log_dir=tmp_path,
            fail_on_error=False,
            datasource_id=None,
            agent_id="custom-agent-v2",
            trace_log=False,
            user_subject=None,
            user_token=None,
        )
        assert adapter.agent_id == "custom-agent-v2"


def test_agentic_rag_adapter_trace_log_forwarding(tmp_path: Path) -> None:
    mock_retriever = MagicMock()
    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ) as mock_init:
        AgenticRagAdapter(
            agent_url="http://localhost:8000",
            results_dir=tmp_path,
            trace_log=True,
        )
        mock_init.assert_called_once_with(
            agent_api_url="http://localhost:8000",
            timeout=200.0,
            log_dir=tmp_path,
            trace_log=True,
            fail_on_error=False,
            datasource_id=None,
            agent_id=None,
            user_subject=None,
            user_token=None,
        )


def test_agentic_rag_adapter_initialization_with_all_optional_parameters(
    tmp_path: Path,
) -> None:
    mock_retriever = MagicMock()
    mock_db = MagicMock()
    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ) as mock_init:
        adapter = AgenticRagAdapter(
            agent_url="http://localhost:8000",
            results_dir=tmp_path,
            db_manager=mock_db,
            prompt_args={"key": "val"},
            search_tool_name="custom_search",
            fetch_tool_name="custom_fetch",
            insecure=True,
            user_subject="user-123",
            user_token="token-abc",
        )
        mock_init.assert_called_once_with(
            agent_api_url="http://localhost:8000",
            timeout=200.0,
            log_dir=tmp_path,
            trace_log=False,
            fail_on_error=False,
            datasource_id=None,
            agent_id=None,
            user_subject="user-123",
            user_token="token-abc",
            db_manager=mock_db,
            prompt_args={"key": "val"},
            search_tool_name="custom_search",
            fetch_tool_name="custom_fetch",
            insecure=True,
        )
        assert adapter.db_manager == mock_db
        assert adapter.prompt_args == {"key": "val"}
        assert adapter.user_subject == "user-123"
        assert adapter.user_token == "token-abc"


def test_agentic_rag_adapter_query_forwarding_prompt_args_and_tools(
    tmp_path: Path,
) -> None:
    mock_retriever = MagicMock()
    mock_agentic_result = MagicMock(
        answer="Answer",
        contexts=["ctx"],
        latency_ms=200.0,
        input_tokens=10,
        output_tokens=5,
        total_tokens=15,
        log_file="",
    )
    mock_retriever.retrieve.return_value = mock_agentic_result
    mock_retriever.documents_metadata = []

    with patch(
        "deepeval_eval.engine.agentic_rag.AgenticRetriever", return_value=mock_retriever
    ):
        adapter = AgenticRagAdapter(
            agent_url="http://localhost:8000",
            results_dir=tmp_path,
            fetch_tool_name="default_fetch",
        )
        res = adapter.query(
            "Test Question?",
            prompt_style="detailed",
            prompt_args={"arg1": "val1"},
            search_tool_name="search_v2",
            fetch_tool_name="fetch_v2",
        )
        mock_retriever.retrieve.assert_called_with(
            "Test Question?",
            k=3,
            datasource_id=None,
            dataset_name=None,
            experiment_name=None,
            run_id=None,
            log_file_prefix=None,
            prompt_style="detailed",
            prompt_args={"arg1": "val1"},
            search_tool_name="search_v2",
            fetch_tool_name="fetch_v2",
        )
        assert res.answer == "Answer"

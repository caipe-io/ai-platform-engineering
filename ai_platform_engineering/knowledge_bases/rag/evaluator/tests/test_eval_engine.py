from pathlib import Path
from unittest.mock import MagicMock

from deepeval_eval.datasets.loader import InMemoryDataLoader
from deepeval_eval.engine.eval_engine import EvalConfig, run_evaluation


def test_eval_config_without_args_uses_default_values():
    config = EvalConfig()
    assert config.dataset_name == "enterprise"
    assert config.answer_mode == "generate"
    assert config.top_k == 3
    assert config.agentic is True


def test_eval_config_with_oracle_testing_sets_ground_truth_mode():
    config = EvalConfig(oracle_testing=True)
    assert config.oracle_retrieval is True
    assert config.answer_mode == "ground_truth"


def test_eval_config_to_config_args_returns_serialized_dict():
    config = EvalConfig(
        dataset_name="hotpotqa",
        top_k=5,
        questions_file=Path("/tmp/questions.jsonl"),
    )
    config_dict = config.to_config_args()
    assert config_dict["dataset_name"] == "hotpotqa"
    assert config_dict["top_k"] == 5
    assert config_dict["questions_file"] == "/tmp/questions.jsonl"


def test_run_evaluation_with_in_memory_data_loader_executes_queries_and_returns_results(
    tmp_path: Path,
):
    config = EvalConfig(
        dataset_name="custom_ds",
        results_dir=tmp_path / "results",
    )
    dataset = [
        {
            "question_id": "q1",
            "user_input": "What is CAIPE?",
            "reference": "CAIPE is an AI platform.",
        }
    ]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "CAIPE is an AI platform."
    mock_query_res.contexts = ["CAIPE is an AI platform."]
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 10
    mock_query_res.output_tokens = 10
    mock_query_res.total_tokens = 20
    mock_query_res.latency_sec = 0.5
    mock_query_res.latency_ms = 500
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    res = run_evaluation(
        config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )
    assert len(res) == 1
    assert res[0]["dataset_name"] == "custom_ds"
    assert res[0]["user_input"] == "What is CAIPE?"


def test_run_evaluation_with_question_ids_and_indices_filters_dataset_subset(
    tmp_path: Path,
):
    dataset = [
        {"question_id": "q101", "user_input": "Q1", "reference": "A1"},
        {"question_id": "q102", "user_input": "Q2", "reference": "A2"},
        {"question_id": "q103", "user_input": "Q3", "reference": "A3"},
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 5
    mock_query_res.output_tokens = 5
    mock_query_res.total_tokens = 10
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    # Filter by question_ids
    config_ids = EvalConfig(results_dir=tmp_path / "res1", question_ids="q102")
    res_ids = run_evaluation(
        config=config_ids, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )
    assert len(res_ids) == 1
    assert res_ids[0]["question_id"] == "q102"

    # Filter by question_indices (range and single index)
    config_idx = EvalConfig(results_dir=tmp_path / "res2", question_indices="1-2, 3")
    res_idx = run_evaluation(
        config=config_idx, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )
    assert len(res_idx) == 3


def test_run_evaluation_captures_and_preserves_actual_input(
    tmp_path: Path,
) -> None:
    """Verify that run_evaluation propagates distinct actual_input from RAG query result."""
    dataset = [
        {
            "question_id": "q_actual_1",
            "user_input": "What is the timeout limit?",
            "reference": "10s",
        }
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "10s"
    mock_query_res.contexts = ["Limit is 10s"]
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 5
    mock_query_res.output_tokens = 5
    mock_query_res.total_tokens = 10
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_query_res.actual_input = (
        "Instructions: Read docs.\n\nWhat is the timeout limit?"
    )
    mock_rag_client.query.return_value = mock_query_res

    config = EvalConfig(results_dir=tmp_path / "res_actual", dataset_name="enterprise")
    res = run_evaluation(
        config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )

    assert len(res) == 1
    assert res[0]["user_input"] == "What is the timeout limit?"
    assert (
        res[0]["actual_input"]
        == "Instructions: Read docs.\n\nWhat is the timeout limit?"
    )


def test_run_evaluation_when_actual_input_is_none_defaults_to_user_input(
    tmp_path: Path,
) -> None:
    """Verify that run_evaluation defaults actual_input to user_input when actual_input is None or empty."""
    dataset = [
        {
            "question_id": "q_actual_2",
            "user_input": "Default fallback question?",
            "reference": "ref",
        }
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 0
    mock_query_res.output_tokens = 0
    mock_query_res.total_tokens = 0
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_query_res.actual_input = None
    mock_rag_client.query.return_value = mock_query_res

    config = EvalConfig(
        results_dir=tmp_path / "res_actual_none", dataset_name="enterprise"
    )
    res = run_evaluation(
        config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )

    assert len(res) == 1
    assert res[0]["user_input"] == "Default fallback question?"
    assert res[0]["actual_input"] == "Default fallback question?"


def test_run_evaluation_with_prompt_config_and_db_forwards_options_to_rag_client(
    tmp_path: Path,
):
    prompt_yaml = tmp_path / "prompt_config.yaml"
    prompt_yaml.write_text(
        "styles:\n  custom:\n    system_prompt: sys\n    user_template: '{context} {question}'\n",
        encoding="utf-8",
    )

    dataset = [
        {"question_id": "q1", "user_input": "Test prompt config?", "reference": "Ref"}
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    config = EvalConfig(
        results_dir=tmp_path / "res_prompt",
        prompt_config=prompt_yaml,
        db_connection_string="sqlite:///:memory:",
    )
    res = run_evaluation(
        config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )
    assert len(res) == 1


class MockGoodMetric:
    def __init__(self):
        self.score = 0.95
        self.reason = "Good response"

    def measure(self, test_case):
        pass

    def is_successful(self):
        return True


class MockBrokenGetReasonMetric:
    def __init__(self):
        self.score = 0.85
        self.reason = "Valid reason"

    def measure(self, test_case):
        pass

    def is_successful(self):
        return True

    def get_reason(self):
        raise AttributeError(
            "'MockBrokenGetReasonMetric' object has no attribute 'get_reason'"
        )


def test_run_evaluation_preserves_metric_scores_and_reasons(tmp_path: Path):
    dataset = [
        {"question_id": "q_metric", "user_input": "Test metric?", "reference": "Ref"}
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    good_metric = MockGoodMetric()
    broken_metric = MockBrokenGetReasonMetric()

    config = EvalConfig(results_dir=tmp_path / "res_metrics")
    res = run_evaluation(
        config=config,
        data_loader=loader,
        rag_client=mock_rag_client,
        metrics=[good_metric, broken_metric],
    )
    assert len(res) == 1
    metrics_res = res[0]["metrics"]
    assert metrics_res["MockGoodMetric"]["score"] == 0.95
    assert metrics_res["MockGoodMetric"]["reason"] == "Good response"
    assert metrics_res["MockGoodMetric"]["success"] is True

    # Check that score was PRESERVED despite get_reason throwing AttributeError
    assert metrics_res["MockBrokenGetReasonMetric"]["score"] == 0.85
    assert metrics_res["MockBrokenGetReasonMetric"]["reason"] == "Valid reason"
    assert metrics_res["MockBrokenGetReasonMetric"]["success"] is True


def test_build_rag_client_with_oracle_retrieval_returns_oracle_client():
    from unittest.mock import patch

    from deepeval_eval.engine.eval_engine import _build_rag_client

    config_oracle = EvalConfig(oracle_retrieval=True)
    with (
        patch("deepeval_eval.clients.search_rag.build_search_rag_client"),
        patch("deepeval_eval.clients.oracle.OracleRagClient") as mock_oracle_cls,
    ):
        _build_rag_client(config_oracle)
        mock_oracle_cls.assert_called_once()


def test_build_rag_client_with_agentic_flag_returns_agentic_adapter():
    from unittest.mock import patch

    from deepeval_eval.engine.eval_engine import _build_rag_client

    config_agentic = EvalConfig(agentic=True)
    with patch("deepeval_eval.clients.rag.AgenticRagAdapter") as mock_agentic_cls:
        _build_rag_client(config_agentic)
        mock_agentic_cls.assert_called_once()


def test_build_rag_client_with_db_manager_and_prompt_args_configures_properties():
    from unittest.mock import patch

    from deepeval_eval.engine.eval_engine import _build_rag_client

    config_std = EvalConfig(agentic=False, prompt_args={"key": "value"})
    mock_db = MagicMock()
    with patch(
        "deepeval_eval.clients.search_rag.build_search_rag_client"
    ) as mock_builder:
        mock_client = MagicMock()
        mock_builder.return_value = mock_client
        client = _build_rag_client(config_std, db_manager=mock_db)
        assert client == mock_client
        assert client.db_manager == mock_db
        assert client.prompt_args == {"key": "value"}


def test_run_evaluation_with_question_set_id_initializes_db_loader(tmp_path: Path):
    from unittest.mock import patch

    from deepeval_eval.core.config import DatabaseSettings

    config = EvalConfig(
        question_set_id=42,
        db=DatabaseSettings(postgres_host="localhost"),
        results_dir=tmp_path / "res_qs",
    )
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    mock_loader_instance = MagicMock()
    mock_loader_instance.load.return_value = [
        {"question_id": "q1", "user_input": "Q", "reference": "R"}
    ]

    with (
        patch(
            "deepeval_eval.datasets.loader.QuestionSetDataLoader",
            return_value=mock_loader_instance,
        ),
        patch("deepeval_eval.db.db_manager.DatabaseManager"),
    ):
        results = run_evaluation(
            config=config,
            rag_client=mock_rag_client,
            metrics=[],
        )
        assert len(results) == 1
        assert results[0]["user_input"] == "Q"


def test_run_evaluation_with_malformed_question_indices_skips_invalid_entries(
    tmp_path: Path,
):
    dataset = [
        {"question_id": "q1", "user_input": "Q1", "reference": "A1"},
        {"question_id": "q2", "user_input": "Q2", "reference": "A2"},
    ]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    # Indices with invalid formats should be gracefully skipped
    config = EvalConfig(
        results_dir=tmp_path / "res_invalid_idx",
        question_indices="invalid-range, 999, abc, 1",
    )
    res = run_evaluation(
        config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[]
    )
    assert len(res) == 1
    assert res[0]["question_id"] == "q1"


class MockCallableGetReasonMetric:
    def __init__(self):
        self.score = 0.90
        self.reason = None

    def measure(self, test_case, _show_indicator=False):
        pass

    def is_successful(self):
        return True

    def get_reason(self):
        return "Calculated reason dynamically"


def test_run_evaluation_with_callable_get_reason_metric_resolves_dynamic_reason(
    tmp_path: Path,
):
    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    metric = MockCallableGetReasonMetric()
    config = EvalConfig(results_dir=tmp_path / "res_dyn_reason", show_indicator=True)
    res = run_evaluation(
        config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[metric]
    )
    assert len(res) == 1
    assert (
        res[0]["metrics"]["MockCallableGetReasonMetric"]["reason"]
        == "Calculated reason dynamically"
    )


class MockFailingMetric:
    def measure(self, test_case):
        raise RuntimeError("Metric execution exploded")

    def is_successful(self):
        return False


def test_run_evaluation_with_fail_on_error_enabled_escalates_exception(tmp_path: Path):
    import pytest

    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    failing_metric = MockFailingMetric()
    config = EvalConfig(results_dir=tmp_path / "res_fail", fail_on_error=True)
    with pytest.raises(RuntimeError, match="Metric execution exploded"):
        run_evaluation(
            config=config,
            data_loader=loader,
            rag_client=mock_rag_client,
            metrics=[failing_metric],
        )


def test_run_evaluation_when_quality_gate_passes_returns_successful_results(
    tmp_path: Path,
):
    from unittest.mock import patch

    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    config_pass = EvalConfig(results_dir=tmp_path / "res_gate_pass", gate=True)
    with patch("deepeval_eval.engine.gate.run_gate_on_results", return_value=True):
        res = run_evaluation(
            config=config_pass,
            data_loader=loader,
            rag_client=mock_rag_client,
            metrics=[],
        )
        assert len(res) == 1


def test_run_evaluation_when_quality_gate_fails_raises_quality_gate_error(
    tmp_path: Path,
):
    from unittest.mock import patch

    import pytest

    from deepeval_eval.engine.eval_engine import QualityGateError

    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock()
    mock_query_res.answer = "Ans"
    mock_query_res.contexts = []
    mock_query_res.sources = []
    mock_query_res.retrieved_doc_ids = []
    mock_query_res.input_tokens = 1
    mock_query_res.output_tokens = 1
    mock_query_res.total_tokens = 2
    mock_query_res.latency_sec = 0.1
    mock_query_res.latency_ms = 100
    mock_query_res.log_file = None
    mock_rag_client.query.return_value = mock_query_res

    config_fail = EvalConfig(results_dir=tmp_path / "res_gate_fail", gate=True)
    with patch("deepeval_eval.engine.gate.run_gate_on_results", return_value=False):
        with pytest.raises(QualityGateError, match="failed quality gate"):
            run_evaluation(
                config=config_fail,
                data_loader=loader,
                rag_client=mock_rag_client,
                metrics=[],
            )


def test_run_evaluation_without_rag_client_builds_default_rag_client(
    tmp_path: Path,
) -> None:
    from unittest.mock import patch

    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Ans",
        contexts=[],
        sources=[],
        retrieved_doc_ids=[],
        input_tokens=1,
        output_tokens=1,
        total_tokens=2,
        latency_sec=0.1,
        latency_ms=100,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    config = EvalConfig(results_dir=tmp_path / "res_default_client")
    with patch(
        "deepeval_eval.engine.eval_engine._build_rag_client",
        return_value=mock_rag_client,
    ) as mock_builder:
        res = run_evaluation(
            config=config, data_loader=loader, rag_client=None, metrics=[]
        )
        assert len(res) == 1
        mock_builder.assert_called_once_with(config)


def test_run_evaluation_with_postgres_sink_init_failure_logs_warning(
    tmp_path: Path,
) -> None:
    from unittest.mock import patch

    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Ans",
        contexts=[],
        sources=[],
        retrieved_doc_ids=[],
        input_tokens=1,
        output_tokens=1,
        total_tokens=2,
        latency_sec=0.1,
        latency_ms=100,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    config = EvalConfig(results_dir=tmp_path / "res_pg_fail")
    with patch(
        "deepeval_eval.sinks.psql_sink.PostgresResultSink",
        side_effect=RuntimeError("PG connect failure"),
    ):
        res = run_evaluation(
            config=config, data_loader=loader, rag_client=mock_rag_client, metrics=[]
        )
        assert len(res) == 1


def test_run_evaluation_with_custom_sinks_saves_to_provided_sinks_only(
    tmp_path: Path,
) -> None:
    dataset = [{"question_id": "q1", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)
    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Ans",
        contexts=[],
        sources=[],
        retrieved_doc_ids=[],
        input_tokens=1,
        output_tokens=1,
        total_tokens=2,
        latency_sec=0.1,
        latency_ms=100,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    custom_sink = MagicMock()
    config = EvalConfig(results_dir=tmp_path / "res_custom_sinks")

    res = run_evaluation(
        config=config,
        data_loader=loader,
        rag_client=mock_rag_client,
        metrics=[],
        sinks=[custom_sink],
    )
    assert len(res) == 1
    custom_sink.save.assert_called_once()


def test_run_evaluation_with_non_default_deepeval_metrics_executes_successfully(
    tmp_path: Path,
) -> None:
    """Test running evaluation using metrics not in the default 12 baseline set but available in deepeval.metrics."""
    from unittest.mock import MagicMock

    from deepeval_eval.engine.metrics import build_metric_instance

    dataset = [
        {
            "question_id": "q_non_default",
            "user_input": "Summarize the Kubernetes architecture.",
            "reference": "Kubernetes consists of control plane and worker nodes.",
            "expected_doc_ids": ["doc1"],
        }
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Kubernetes contains control plane components like apiserver and worker nodes with kubelet.",
        contexts=[
            "Control plane has apiserver, etcd, scheduler. Workers have kubelet."
        ],
        sources=[{"document_id": "doc1"}],
        retrieved_doc_ids=["doc1"],
        input_tokens=15,
        output_tokens=20,
        total_tokens=35,
        latency_sec=0.25,
        latency_ms=250,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    # Create non-default DeepEval metric instances (e.g. ExactMatchMetric, HallucinationMetric, ToxicityMetric)
    mock_judge = MagicMock()
    em_metric = build_metric_instance(
        {"name": "exact_match", "threshold": 1.0}, mock_judge
    )

    # Mock measurement behavior for judge-based metrics to avoid actual LLM calls
    mock_hallucination = MagicMock()
    mock_hallucination.__class__.__name__ = "HallucinationMetric"
    mock_hallucination.name = "HallucinationMetric"
    mock_hallucination.threshold = 0.5
    mock_hallucination.score = 0.95
    mock_hallucination.reason = "Output is grounded."
    mock_hallucination.is_successful.return_value = True
    mock_hallucination.measure.return_value = 0.95

    mock_toxicity = MagicMock()
    mock_toxicity.__class__.__name__ = "ToxicityMetric"
    mock_toxicity.name = "ToxicityMetric"
    mock_toxicity.threshold = 0.1
    mock_toxicity.score = 0.0
    mock_toxicity.reason = "Zero toxic language detected."
    mock_toxicity.is_successful.return_value = True
    mock_toxicity.measure.return_value = 0.0

    metrics = [em_metric, mock_hallucination, mock_toxicity]

    config = EvalConfig(
        results_dir=tmp_path / "res_non_default_metrics",
        metrics=["exact_match", "hallucination", "toxicity"],
    )

    res = run_evaluation(
        config=config,
        data_loader=loader,
        rag_client=mock_rag_client,
        metrics=metrics,
    )

    assert len(res) == 1
    row = res[0]
    # Check that metric scores were collected into evaluation output row['metrics']
    assert "metrics" in row
    assert "ExactMatchMetric" in row["metrics"]
    assert "HallucinationMetric" in row["metrics"]
    assert "ToxicityMetric" in row["metrics"]
    assert row["metrics"]["HallucinationMetric"]["score"] == 0.95
    assert row["metrics"]["HallucinationMetric"]["success"] is True
    assert row["metrics"]["HallucinationMetric"]["reason"] == "Output is grounded."
    assert row["metrics"]["ToxicityMetric"]["score"] == 0.0
    assert row["metrics"]["ToxicityMetric"]["success"] is True


def test_run_evaluation_with_custom_geval_metric_executes_successfully(
    tmp_path: Path,
) -> None:
    """Test running evaluation using a dynamically configured custom G-Eval metric."""
    from unittest.mock import MagicMock

    from deepeval.metrics import GEval

    from deepeval_eval.engine.metrics import build_metric_instance

    dataset = [
        {
            "question_id": "q_custom_geval",
            "user_input": "Explain zero trust architecture.",
            "reference": "Zero trust assumes breach and verifies every request.",
            "expected_doc_ids": ["doc_sec_1"],
        }
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Zero trust architecture verifies every access request explicitly and assumes network breach.",
        contexts=["Core principle of zero trust is never trust, always verify."],
        sources=[{"document_id": "doc_sec_1"}],
        retrieved_doc_ids=["doc_sec_1"],
        input_tokens=12,
        output_tokens=18,
        total_tokens=30,
        latency_sec=0.2,
        latency_ms=200,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    from deepeval.models.base_model import DeepEvalBaseLLM

    class DummyJudge(DeepEvalBaseLLM):
        def __init__(self):
            super().__init__(model="test")

        def load_model(self, *args, **kwargs):
            return None

        def get_model_name(self, *args, **kwargs) -> str:
            return "dummy-judge"

        def generate(self, prompt: str, schema=None, **kwargs) -> str:
            return ""

        async def a_generate(self, prompt: str, schema=None, **kwargs) -> str:
            return ""

    mock_judge = DummyJudge()
    custom_geval_cfg = {
        "name": "zero_trust_adherence",
        "metric_type": "g_eval",
        "threshold": 0.8,
        "evaluation_params": ["input", "actual_output", "expected_output"],
        "criteria": "Verify that the explanation adheres strictly to zero trust security principles.",
        "evaluation_steps": [
            "Check if explicit verification is mentioned.",
            "Check if assuming breach is mentioned.",
        ],
    }

    # Instantiate custom G-Eval metric
    custom_geval = build_metric_instance(custom_geval_cfg, mock_judge)
    assert isinstance(custom_geval, GEval)

    # Mock measure behavior on the GEval instance
    custom_geval.measure = MagicMock(return_value=0.9)
    custom_geval.score = 0.9
    custom_geval.reason = "Accurately covers all zero trust tenets."
    custom_geval.is_successful = MagicMock(return_value=True)

    config = EvalConfig(
        results_dir=tmp_path / "res_custom_geval",
        metrics=["zero_trust_adherence"],
    )

    res = run_evaluation(
        config=config,
        data_loader=loader,
        rag_client=mock_rag_client,
        metrics=[custom_geval],
    )

    assert len(res) == 1
    row = res[0]
    assert "metrics" in row
    # In DeepEval, GEval metrics are identified by their configured name
    assert "zero_trust_adherence" in row["metrics"]
    assert row["metrics"]["zero_trust_adherence"]["score"] == 0.9
    assert row["metrics"]["zero_trust_adherence"]["success"] is True
    assert (
        row["metrics"]["zero_trust_adherence"]["reason"]
        == "Accurately covers all zero trust tenets."
    )


def test_run_evaluation_with_custom_geval_metric_low_score_marks_unsuccessful(
    tmp_path: Path,
) -> None:
    """Test custom G-Eval metric scoring below threshold sets success to False and records low score."""
    from unittest.mock import MagicMock

    from deepeval.metrics import GEval
    from deepeval.models.base_model import DeepEvalBaseLLM

    from deepeval_eval.engine.metrics import build_metric_instance

    dataset = [
        {
            "question_id": "q_geval_low_score",
            "user_input": "Explain zero trust architecture.",
            "reference": "Zero trust assumes breach and verifies every request.",
            "expected_doc_ids": ["doc_sec_1"],
        }
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Trust everything inside the local network perimeter without checking.",
        contexts=["Outdated perimeter model."],
        sources=[{"document_id": "doc_sec_1"}],
        retrieved_doc_ids=["doc_sec_1"],
        input_tokens=10,
        output_tokens=10,
        total_tokens=20,
        latency_sec=0.1,
        latency_ms=100,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    class DummyJudge(DeepEvalBaseLLM):
        def __init__(self):
            super().__init__(model="test")

        def load_model(self, *args, **kwargs):
            return None

        def get_model_name(self, *args, **kwargs) -> str:
            return "dummy-judge"

        def generate(self, prompt: str, schema=None, **kwargs) -> str:
            return ""

        async def a_generate(self, prompt: str, schema=None, **kwargs) -> str:
            return ""

    mock_judge = DummyJudge()
    custom_geval = build_metric_instance(
        {
            "name": "zero_trust_adherence",
            "metric_type": "g_eval",
            "threshold": 0.8,
            "evaluation_params": ["input", "actual_output"],
            "criteria": "Verify zero trust adherence.",
        },
        mock_judge,
    )
    assert isinstance(custom_geval, GEval)

    # Simulate poor score and failure
    custom_geval.measure = MagicMock(return_value=0.1)
    custom_geval.score = 0.1
    custom_geval.reason = "Violates zero trust: assumes implicit perimeter trust."
    custom_geval.is_successful = MagicMock(return_value=False)

    config = EvalConfig(
        results_dir=tmp_path / "res_custom_geval_low",
        metrics=["zero_trust_adherence"],
    )

    res = run_evaluation(
        config=config,
        data_loader=loader,
        rag_client=mock_rag_client,
        metrics=[custom_geval],
    )

    assert len(res) == 1
    row = res[0]
    assert "metrics" in row
    assert row["metrics"]["zero_trust_adherence"]["score"] == 0.1
    assert row["metrics"]["zero_trust_adherence"]["success"] is False
    assert (
        row["metrics"]["zero_trust_adherence"]["reason"]
        == "Violates zero trust: assumes implicit perimeter trust."
    )


def test_run_evaluation_with_custom_geval_metric_execution_error_records_failure_reason(
    tmp_path: Path,
) -> None:
    """Test custom G-Eval metric throwing exception is caught and recorded when fail_on_error is False."""
    from unittest.mock import MagicMock

    from deepeval.models.base_model import DeepEvalBaseLLM

    from deepeval_eval.engine.metrics import build_metric_instance

    dataset = [{"question_id": "q_geval_err", "user_input": "Q", "reference": "R"}]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Ans",
        contexts=[],
        sources=[],
        retrieved_doc_ids=[],
        input_tokens=5,
        output_tokens=5,
        total_tokens=10,
        latency_sec=0.1,
        latency_ms=100,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    class DummyJudge(DeepEvalBaseLLM):
        def __init__(self):
            super().__init__(model="test")

        def load_model(self, *args, **kwargs):
            return None

        def get_model_name(self, *args, **kwargs) -> str:
            return "dummy-judge"

        def generate(self, prompt: str, schema=None, **kwargs) -> str:
            return ""

        async def a_generate(self, prompt: str, schema=None, **kwargs) -> str:
            return ""

    mock_judge = DummyJudge()
    custom_geval = build_metric_instance(
        {
            "name": "zero_trust_adherence",
            "metric_type": "g_eval",
            "threshold": 0.8,
            "evaluation_params": ["input", "actual_output"],
            "criteria": "Verify zero trust adherence.",
        },
        mock_judge,
    )
    custom_geval.measure = MagicMock(
        side_effect=RuntimeError("LLM judge service unavailable")
    )

    config = EvalConfig(
        results_dir=tmp_path / "res_geval_err",
        fail_on_error=False,
        metrics=["zero_trust_adherence"],
    )

    res = run_evaluation(
        config=config,
        data_loader=loader,
        rag_client=mock_rag_client,
        metrics=[custom_geval],
    )

    assert len(res) == 1
    row = res[0]
    assert row["metrics"]["zero_trust_adherence"]["score"] is None
    assert row["metrics"]["zero_trust_adherence"]["success"] is False
    assert (
        "LLM judge service unavailable"
        in row["metrics"]["zero_trust_adherence"]["reason"]
    )


def test_run_evaluation_with_non_default_deepeval_metrics_execution_error_raises_when_fail_on_error(
    tmp_path: Path,
) -> None:
    """Test non-default DeepEval metric throwing exception raises immediately when fail_on_error is True."""
    from unittest.mock import MagicMock

    import pytest

    dataset = [
        {"question_id": "q_non_default_err", "user_input": "Q", "reference": "R"}
    ]
    loader = InMemoryDataLoader(dataset)

    mock_rag_client = MagicMock()
    mock_query_res = MagicMock(
        answer="Ans",
        contexts=[],
        sources=[],
        retrieved_doc_ids=[],
        input_tokens=5,
        output_tokens=5,
        total_tokens=10,
        latency_sec=0.1,
        latency_ms=100,
        log_file=None,
    )
    mock_rag_client.query.return_value = mock_query_res

    mock_hallucination = MagicMock()
    mock_hallucination.__class__.__name__ = "HallucinationMetric"
    mock_hallucination.measure.side_effect = ValueError(
        "Hallucination embedding failure"
    )

    config = EvalConfig(
        results_dir=tmp_path / "res_non_default_fail_on_err",
        fail_on_error=True,
        metrics=["hallucination"],
    )

    with pytest.raises(ValueError, match="Hallucination embedding failure"):
        run_evaluation(
            config=config,
            data_loader=loader,
            rag_client=mock_rag_client,
            metrics=[mock_hallucination],
        )

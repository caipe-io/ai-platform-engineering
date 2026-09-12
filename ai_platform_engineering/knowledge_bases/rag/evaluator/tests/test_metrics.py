from __future__ import annotations

from unittest.mock import MagicMock

from deepeval.models.base_model import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase

from deepeval_eval.engine.metrics import (
    AnswerCorrectnessMetric,
    ContainsReferenceMetric,
    MRRMetric,
    NDCGAtKMetric,
    NormalizedExactMatchMetric,
    RetrievalPrecisionMetric,
    RetrievalRecallMetric,
    answer_scores,
    build_metrics,
    doc_id_scores,
    get_metric_column_name,
    normalize_answer,
)
from deepeval_eval.sinks.protocol import EvaluatorMetric


class DummyJudge(DeepEvalBaseLLM):
    def __init__(self):
        super().__init__(model="test")

    def load_model(self, *args, **kwargs):
        return None

    def get_model_name(self, *args, **kwargs) -> str:
        return "dummy"

    def generate(self, prompt: str, schema=None, **kwargs) -> str:
        return ""

    async def a_generate(self, prompt: str, schema=None, **kwargs) -> str:
        return ""


def test_get_metric_column_name() -> None:
    assert get_metric_column_name("MRRMetric") == "mrr"
    assert get_metric_column_name("NDCGAtKMetric") == "ndcg_at_k"
    assert get_metric_column_name("AnswerCorrectnessMetric") == "answer_correctness"
    assert get_metric_column_name("ContextualPrecisionMetric") == "contextual_precision"
    assert get_metric_column_name("RetrievalRecallMetric") == "retrieval_recall"


def test_build_metrics_positive() -> None:
    mock_model = DummyJudge()
    metrics = build_metrics(mock_model)
    assert len(metrics) == 12
    assert any(isinstance(m, MRRMetric) for m in metrics)
    assert any(isinstance(m, NDCGAtKMetric) for m in metrics)
    assert any(isinstance(m, RetrievalRecallMetric) for m in metrics)
    assert any(isinstance(m, RetrievalPrecisionMetric) for m in metrics)
    assert any(isinstance(m, NormalizedExactMatchMetric) for m in metrics)
    assert any(isinstance(m, ContainsReferenceMetric) for m in metrics)


def test_build_metrics_negative() -> None:
    import pytest

    with pytest.raises(Exception):
        build_metrics(None)


def test_evaluator_metric_protocol_compliance() -> None:
    custom_metrics: list[EvaluatorMetric] = [
        NormalizedExactMatchMetric(),
        ContainsReferenceMetric(),
        MRRMetric(),
        NDCGAtKMetric(),
        RetrievalRecallMetric(),
        RetrievalPrecisionMetric(),
    ]
    test_case = LLMTestCase(
        input="q",
        actual_output="a",
        expected_output="a",
        metadata={"retrieved_doc_ids": ["doc1"], "expected_doc_ids": ["doc1"]},
    )
    for m in custom_metrics:
        assert hasattr(m, "name")
        assert hasattr(m, "threshold")
        assert hasattr(m, "score")
        m.measure(test_case)
        assert hasattr(m, "get_reason")
        assert hasattr(m, "is_successful")
        assert isinstance(m.get_reason(), str)
        assert isinstance(m.is_successful(), bool)


def test_doc_id_scores_positive() -> None:
    retrieved = [
        {"document_id": "doc1"},
        {"document_id": "doc2"},
        {"document_id": "doc3"},
    ]
    expected = ["doc2", "doc4"]
    recall, precision = doc_id_scores(retrieved, expected)
    assert recall == 0.5  # 1 hit out of 2 expected
    assert round(precision, 4) == round(1 / 3, 4)  # 1 hit out of 3 retrieved


def test_doc_id_scores_negative() -> None:
    # No expected doc IDs
    recall, precision = doc_id_scores([{"document_id": "doc1"}], [])
    assert recall == 0.0
    assert precision == 0.0

    # Empty retrieved
    recall2, precision2 = doc_id_scores([], ["doc1"])
    assert recall2 == 0.0
    assert precision2 == 0.0


def test_normalize_answer_positive() -> None:
    raw = "The quick brown fox, a simple dog!"
    normalized = normalize_answer(raw)
    assert normalized == "quick brown fox simple dog"


def test_normalize_answer_negative() -> None:
    assert normalize_answer("") == ""
    assert normalize_answer("a an the !!!") == ""


def test_answer_scores_positive() -> None:
    exact, partial = answer_scores("Paris", "Paris")
    assert exact == 1.0
    assert partial == 1.0

    exact2, partial2 = answer_scores("The capital of France is Paris", "Paris")
    assert exact2 == 0.0
    assert partial2 == 1.0


def test_answer_scores_negative() -> None:
    exact, partial = answer_scores("London", "")
    assert exact == 0.0
    assert partial == 0.0

    exact2, partial2 = answer_scores("London", "Paris")
    assert exact2 == 0.0
    assert partial2 == 0.0


def test_normalized_exact_match_metric_positive() -> None:
    metric = NormalizedExactMatchMetric()
    test_case = LLMTestCase(
        input="What is the capital of France?",
        actual_output="Paris",
        expected_output="Paris",
    )
    score = metric.measure(test_case)
    assert score == 1.0
    assert metric.is_successful() is True
    assert "1.0000" in metric.get_reason()


def test_normalized_exact_match_metric_negative() -> None:
    metric = NormalizedExactMatchMetric()
    test_case = LLMTestCase(
        input="What is the capital of France?",
        actual_output="London",
        expected_output="Paris",
    )
    score = metric.measure(test_case)
    assert score == 0.0
    assert metric.is_successful() is False


def test_contains_reference_metric_positive() -> None:
    metric = ContainsReferenceMetric()
    test_case = LLMTestCase(
        input="Where is Paris?",
        actual_output="The capital of France is Paris",
        expected_output="Paris",
    )
    score = metric.measure(test_case)
    assert score == 1.0
    assert metric.is_successful() is True
    assert "1.0000" in metric.get_reason()


def test_contains_reference_metric_negative() -> None:
    metric = ContainsReferenceMetric()
    test_case = LLMTestCase(
        input="Where is Paris?",
        actual_output="The capital of France is Berlin",
        expected_output="Paris",
    )
    score = metric.measure(test_case)
    assert score == 0.0
    assert metric.is_successful() is False


def test_answer_correctness_metric_positive() -> None:
    mock_model = DummyJudge()
    metric = AnswerCorrectnessMetric(name="TestCorrectness", model=mock_model)
    metric.geval_judge = MagicMock()
    metric.geval_judge.measure.return_value = 0.9
    metric.geval_judge.is_successful.return_value = True
    metric.geval_judge.reason = "High factual match"

    test_case = LLMTestCase(
        input="What is 2+2?", actual_output="4", expected_output="4"
    )
    score = metric.measure(test_case)
    assert score == 0.9
    assert metric.is_successful() is True
    assert metric.get_reason() == "High factual match"


def test_answer_correctness_metric_negative() -> None:
    mock_model = DummyJudge()
    metric = AnswerCorrectnessMetric(name="TestCorrectness", model=mock_model)
    metric.geval_judge = MagicMock()
    metric.geval_judge.measure.return_value = 0.1
    metric.geval_judge.is_successful.return_value = False
    metric.geval_judge.reason = "Incorrect answer"

    test_case = LLMTestCase(
        input="What is 2+2?", actual_output="5", expected_output="4"
    )
    score = metric.measure(test_case)
    assert score == 0.1
    assert metric.is_successful() is False
    assert metric.get_reason() == "Incorrect answer"


def test_mrr_metric_positive() -> None:
    metric = MRRMetric()
    test_case = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={
            "retrieved_doc_ids": ["docA", "docB", "docC"],
            "expected_doc_ids": ["docB"],
        },
    )
    score = metric.measure(test_case)
    assert score == 0.5  # Rank 2 -> 1/2
    assert metric.is_successful() is True
    assert "0.5000" in metric.get_reason()


def test_mrr_metric_negative() -> None:
    metric = MRRMetric()

    # No match
    test_case_no_match = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={"retrieved_doc_ids": ["docA", "docB"], "expected_doc_ids": ["docZ"]},
    )
    assert metric.measure(test_case_no_match) == 0.0
    assert metric.is_successful() is False

    # Missing metadata
    test_case_empty = LLMTestCase(input="test", actual_output="out")
    assert metric.measure(test_case_empty) == 0.0


def test_ndcg_at_k_metric_positive() -> None:
    metric = NDCGAtKMetric(k=3)
    test_case = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={
            "retrieved_doc_ids": ["doc1", "doc2", "doc3"],
            "expected_doc_ids": ["doc1", "doc3"],
        },
    )
    score = metric.measure(test_case)
    assert score > 0.0
    assert metric.is_successful() is True
    assert "nDCG@3" in metric.get_reason()


def test_ndcg_effective_k_max_len_and_top_k() -> None:
    """Verify effective_k uses max(len(retrieved_ids), top_k)."""
    metric = NDCGAtKMetric()

    # Case 1: len(retrieved_ids) > top_k (3 items retrieved, top_k=2 -> effective_k=3)
    tc1 = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={
            "retrieved_doc_ids": ["doc1", "doc2", "doc3"],
            "expected_doc_ids": ["doc3"],
            "top_k": 2,
        },
    )
    metric.measure(tc1)
    assert "nDCG@3" in metric.get_reason()

    # Case 2: len(retrieved_ids) < top_k (2 items retrieved, top_k=5 -> effective_k=5)
    tc2 = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={
            "retrieved_doc_ids": ["doc1", "doc2"],
            "expected_doc_ids": ["doc1", "doc2", "doc3", "doc4", "doc5"],
            "top_k": 5,
        },
    )
    metric.measure(tc2)
    assert "nDCG@5" in metric.get_reason()


def test_ndcg_at_k_metric_negative() -> None:
    metric = NDCGAtKMetric(k=3)

    # Empty expected doc IDs
    test_case_empty = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={"retrieved_doc_ids": ["doc1"], "expected_doc_ids": []},
    )
    assert metric.measure(test_case_empty) == 0.0
    assert metric.is_successful() is False

    # No overlapping doc IDs
    test_case_no_match = LLMTestCase(
        input="test",
        actual_output="out",
        metadata={"retrieved_doc_ids": ["doc1"], "expected_doc_ids": ["docX"]},
    )
    assert metric.measure(test_case_no_match) == 0.0


def test_retrieval_recall_metric_positive() -> None:
    metric = RetrievalRecallMetric()
    test_case = LLMTestCase(
        input="q",
        actual_output="a",
        metadata={
            "retrieved_doc_ids": ["doc1", "doc2"],
            "expected_doc_ids": ["doc2", "doc3"],
        },
    )
    score = metric.measure(test_case)
    assert score == 0.5  # 1 hit out of 2 expected
    assert metric.is_successful() is True
    assert "0.5000" in metric.get_reason()


def test_retrieval_recall_metric_negative() -> None:
    metric = RetrievalRecallMetric()
    test_case = LLMTestCase(
        input="q",
        actual_output="a",
        metadata={"retrieved_doc_ids": ["doc1"], "expected_doc_ids": []},
    )
    assert metric.measure(test_case) == 0.0


def test_retrieval_precision_metric_positive() -> None:
    metric = RetrievalPrecisionMetric()
    test_case = LLMTestCase(
        input="q",
        actual_output="a",
        metadata={"retrieved_doc_ids": ["doc1", "doc2"], "expected_doc_ids": ["doc2"]},
    )
    score = metric.measure(test_case)
    assert score == 0.5  # 1 hit out of 2 retrieved
    assert metric.is_successful() is True
    assert "0.5000" in metric.get_reason()


def test_retrieval_precision_metric_negative() -> None:
    metric = RetrievalPrecisionMetric()
    test_case = LLMTestCase(
        input="q",
        actual_output="a",
        metadata={"retrieved_doc_ids": [], "expected_doc_ids": ["doc1"]},
    )
    assert metric.measure(test_case) == 0.0

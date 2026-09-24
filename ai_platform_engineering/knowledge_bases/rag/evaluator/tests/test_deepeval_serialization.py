import json
from pathlib import Path

import pytest

from deepeval_eval.sinks import write_evaluation_results


class DummyObject:
    def __repr__(self):
        return "<DummyObject>"


@pytest.fixture
def sample_results():
    return [
        {
            "question_id": "q1",
            "question": "question 1",
            "user_input": "question 1",
            "reference": "ref 1",
            "expected_doc_ids": ["doc_1"],
            "category": "cat1",
            "actual_output": "ans 1",
            "retrieved_contexts": ["ctx 1"],
            "retrieved_doc_ids": ["doc_1"],
            "doc_id_recall": 1.0,
            "doc_id_precision": 1.0,
            "metrics": {
                "AnswerRelevancyMetric": {"score": 0.9, "reason": "good"},
                "FaithfulnessMetric": {"score": 0.9, "reason": "good"},
            },
            "evaluator_input_tokens": 10,
            "evaluator_output_tokens": 20,
            "evaluator_total_tokens": 30,
            "latency": 5.0,
            "total_tokens": 100,
            "log_file": "log1",
        }
    ]


def test_write_evaluation_results_serialization_positive(
    tmp_path: Path, sample_results
):
    config_args = {"datasource_id": "test_ds", "top_k": 5, "agentic": True}
    write_evaluation_results(
        results_dir=tmp_path,
        prefix="enterprise_deepeval_test_ds",
        results=sample_results,
        evaluation_time=10.0,
        config_args=config_args,
    )
    summary_files = list(tmp_path.glob("*_summary.json"))
    assert len(summary_files) == 1
    with open(summary_files[0], encoding="utf-8") as f:
        data = json.load(f)
        assert data["config_args"]["top_k"] == 5


def test_write_evaluation_results_serialization_negative(
    tmp_path: Path, sample_results
):
    config_args = {
        "datasource_id": "test_ds",
        "custom_obj": DummyObject(),
        "_private_val": "secret",
    }
    write_evaluation_results(
        results_dir=tmp_path,
        prefix="enterprise_deepeval_test_ds",
        results=sample_results,
        evaluation_time=10.0,
        config_args=config_args,
    )
    summary_files = list(tmp_path.glob("*_summary.json"))
    assert len(summary_files) == 1
    with open(summary_files[0], encoding="utf-8") as f:
        data = json.load(f)
        assert data["config_args"]["custom_obj"] == "<DummyObject>"
        assert "_private_val" not in data["config_args"]

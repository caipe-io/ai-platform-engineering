from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from deepeval_eval.clients.oracle import OracleRagClient


def test_oracle_rag_client_ground_truth_mode_positive() -> None:
    mock_caipe = MagicMock()
    mock_caipe.query_raw.return_value = [
        {
            "document": {
                "page_content": "Oracle retrieved context.",
                "metadata": {"document_id": "oracle_doc_1"},
            }
        }
    ]

    client = OracleRagClient(caipe_client=mock_caipe)
    res = client.query(
        question="What is the answer?",
        reference="Ground truth answer",
        datasource_id="ds_123",
        top_k=2,
        answer_mode="ground_truth",
    )

    assert res.answer == "Ground truth answer"
    assert res.contexts == ["Oracle retrieved context."]
    assert res.retrieved_doc_ids == ["oracle_doc_1"]
    mock_caipe.query_raw.assert_called_once_with(
        "What is the answer? Ground truth answer", datasource_id="ds_123", limit=2
    )


def test_oracle_rag_client_generated_mode_positive() -> None:
    mock_caipe = MagicMock()
    mock_caipe.query_raw.return_value = [
        {
            "document": {
                "page_content": "Context for generation.",
                "metadata": {"document_id": "oracle_doc_2"},
            }
        }
    ]
    mock_llm = MagicMock()
    mock_llm.generate.return_value = "LLM generated response"

    client = OracleRagClient(caipe_client=mock_caipe)
    res = client.query(
        question="What is the capital?",
        reference="Paris",
        datasource_id=None,
        answer_mode="generate",
        dataset_name="enterprise",
        llm_client=mock_llm,
    )

    assert res.answer == "LLM generated response"
    assert res.contexts == ["Context for generation."]
    assert res.retrieved_doc_ids == ["oracle_doc_2"]


def test_oracle_rag_client_generated_mode_negative() -> None:
    mock_caipe = MagicMock()
    mock_caipe.query_raw.return_value = []

    client = OracleRagClient(caipe_client=mock_caipe)

    with pytest.raises(ValueError, match="llm_client is required"):
        client.query(
            question="What is the capital?",
            reference="Paris",
            datasource_id=None,
            answer_mode="generate",
            llm_client=None,
        )


def test_oracle_rag_client_invalid_answer_mode_raises_value_error() -> None:
    mock_caipe = MagicMock()
    mock_caipe.query_raw.return_value = []
    client = OracleRagClient(caipe_client=mock_caipe)

    with pytest.raises(ValueError, match="Invalid answer_mode: unknown_mode"):
        client.query(
            question="What is the capital?",
            reference="Paris",
            datasource_id=None,
            answer_mode="unknown_mode",
        )

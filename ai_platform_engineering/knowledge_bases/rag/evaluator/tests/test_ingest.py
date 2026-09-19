from __future__ import annotations

import argparse
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.ingest.ingest import (
    build_parser,
    main,
    run_ingest,
)


def test_ingest_build_parser_defaults() -> None:
    parser = build_parser()
    args = parser.parse_args([])
    assert args.dataset_name == "enterprise"
    assert args.rag_url is None
    assert args.reset is False
    assert args.skip_ingest is False
    assert args.start_offset == 0


def test_ingest_build_parser_custom_args(tmp_path: Path) -> None:
    parser = build_parser()
    args = parser.parse_args(
        [
            "--dataset-name",
            "hotpotqa",
            "--rag-url",
            "http://caipe:9000",
            "--reset",
            "--skip-ingest",
            "--start-offset",
            "500",
            "--data-dir",
            str(tmp_path),
        ]
    )
    assert args.dataset_name == "hotpotqa"
    assert args.rag_url == "http://caipe:9000"
    assert args.reset is True
    assert args.skip_ingest is True
    assert args.start_offset == 500
    assert args.data_dir == tmp_path


def test_run_ingest_dispatch_positive(tmp_path: Path) -> None:
    """Verify run_ingest dynamically resolves and executes dataset ingestor."""
    args_ent = argparse.Namespace(dataset_name="enterprise_rag_bench", skip_ingest=True)
    mock_bundle = MagicMock()
    mock_ingestor = MagicMock()
    mock_ingestor.prepare_bundle.return_value = mock_bundle

    with (
        patch(
            "deepeval_eval.ingest.ingest.get_dataset_ingestor",
            return_value=mock_ingestor,
        ) as mock_get,
        patch("deepeval_eval.ingest.ingest.execute_ingestion_pipeline") as mock_exec,
    ):
        run_ingest(args_ent)
        mock_get.assert_called_once_with("enterprise_rag_bench")
        mock_ingestor.prepare_bundle.assert_called_once_with(args_ent)
        mock_exec.assert_called_once_with(mock_bundle, args_ent)


def test_run_ingest_unsupported_dataset_negative() -> None:
    args = argparse.Namespace(dataset_name="invalid_dataset")
    with pytest.raises(
        ValueError, match="Unsupported dataset for ingestion: invalid_dataset"
    ):
        run_ingest(args)


def test_run_enterprise_ingest_skip_ingest(tmp_path: Path) -> None:
    args = argparse.Namespace(
        dataset_name="enterprise",
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        results_dir=tmp_path / "results",
        sources=["confluence"],
        num_questions=2,
        questions_per_category=1,
        limit_per_source=10,
        skip_ingest=True,
    )

    mock_q = MagicMock(expected_doc_ids=["doc1"])
    mock_doc = MagicMock(doc_id="doc1")

    with (
        patch(
            "deepeval_eval.datasets.enterprise.load_questions", return_value=[mock_q]
        ),
        patch(
            "deepeval_eval.datasets.enterprise.select_questions", return_value=[mock_q]
        ),
        patch(
            "deepeval_eval.datasets.enterprise.fetch_documents", return_value=[mock_doc]
        ),
        patch("deepeval_eval.datasets.enterprise.write_corpus") as mock_write_corpus,
        patch("deepeval_eval.datasets.enterprise.write_questions") as mock_write_q,
    ):
        run_ingest(args)
        mock_write_corpus.assert_called_once()
        mock_write_q.assert_called_once()


def test_run_enterprise_ingest_with_caipe_ingest_positive(tmp_path: Path) -> None:
    """Verify run_ingest executes full CAIPE ingestion workflow for enterprise when skip_ingest=False."""
    args = argparse.Namespace(
        dataset_name="enterprise",
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        results_dir=tmp_path / "results",
        sources=["confluence"],
        num_questions=2,
        questions_per_category=1,
        limit_per_source=10,
        skip_ingest=False,
        reset=True,
        rag_url="http://localhost:9446",
        auth_token="token_123",
        datasource_id="ds_123",
        datasource_name="DS 123",
        batch_size=50,
    )

    mock_q = MagicMock(expected_doc_ids=["doc1"])
    mock_doc = MagicMock(doc_id="doc1")
    mock_client = MagicMock()
    mock_client.register_ingestor.return_value = ("ingestor_1", 100)
    mock_client.open_job.return_value = "job_1"

    with (
        patch(
            "deepeval_eval.datasets.enterprise.load_questions", return_value=[mock_q]
        ),
        patch(
            "deepeval_eval.datasets.enterprise.select_questions", return_value=[mock_q]
        ),
        patch(
            "deepeval_eval.datasets.enterprise.fetch_documents", return_value=[mock_doc]
        ),
        patch(
            "deepeval_eval.ingest.ingest.build_ingest_rag_client",
            return_value=mock_client,
        ),
        patch("deepeval_eval.datasets.enterprise.write_corpus"),
        patch("deepeval_eval.datasets.enterprise.write_questions"),
    ):
        run_ingest(args)
        mock_client.reset_datasource.assert_called_once_with("ds_123")
        mock_client.register_ingestor.assert_called_once()
        mock_client.upsert_datasource.assert_called_once()
        mock_client.open_job.assert_called_once()
        mock_client.ingest_batch.assert_called_once()
        mock_client.close_job.assert_called_once_with(
            "job_1", "EnterpriseRAG-Bench ingestion complete"
        )


def test_run_hotpotqa_ingest_skip_ingest(tmp_path: Path) -> None:
    args = argparse.Namespace(
        dataset_name="hotpotqa",
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        results_dir=tmp_path / "results",
        questions_zip=tmp_path / "q.zip",
        documents_zip=tmp_path / "d.zip",
        limit=10,
        questions_per_category=5,
        categories=None,
        distractors_per_question=2,
        max_docs=20,
        skip_ingest=True,
    )

    mock_q = {"question_id": "q1", "expected_doc_ids": ["doc1"]}
    mock_doc = {"document_id": "doc1"}

    with (
        patch(
            "deepeval_eval.datasets.hotpotqa.resolve_zip",
            return_value=tmp_path / "zip.zip",
        ),
        patch("deepeval_eval.datasets.hotpotqa.load_questions", return_value=[mock_q]),
        patch(
            "deepeval_eval.datasets.hotpotqa.select_questions", return_value=[mock_q]
        ),
        patch(
            "deepeval_eval.datasets.hotpotqa.load_document_pool",
            return_value=[mock_doc],
        ),
        patch(
            "deepeval_eval.datasets.hotpotqa.select_documents", return_value=[mock_doc]
        ),
        patch("deepeval_eval.datasets.hotpotqa.write_corpus") as mock_write_corpus,
        patch("deepeval_eval.datasets.hotpotqa.write_questions") as mock_write_q,
    ):
        run_ingest(args)
        mock_write_corpus.assert_called_once()
        mock_write_q.assert_called_once()


def test_run_hotpotqa_ingest_with_caipe_ingest_positive(tmp_path: Path) -> None:
    """Verify run_ingest executes full CAIPE ingestion workflow for hotpotqa when skip_ingest=False."""
    args = argparse.Namespace(
        dataset_name="hotpotqa",
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        results_dir=tmp_path / "results",
        questions_zip=tmp_path / "q.zip",
        documents_zip=tmp_path / "d.zip",
        limit=10,
        questions_per_category=5,
        categories=None,
        distractors_per_question=2,
        max_docs=20,
        skip_ingest=False,
        reset=True,
        rag_url="http://localhost:9446",
        auth_token="token_456",
        datasource_id="ds_hotpot",
        datasource_name="DS Hotpot",
        batch_size=20,
    )

    mock_q = {"question_id": "q1", "expected_doc_ids": ["doc1"]}
    mock_doc = {"document_id": "doc1", "title": "Doc Title", "text": "Doc text"}
    mock_client = MagicMock()
    mock_client.register_ingestor.return_value = ("ingestor_2", 50)
    mock_client.open_job.return_value = "job_2"

    with (
        patch(
            "deepeval_eval.datasets.hotpotqa.resolve_zip",
            return_value=tmp_path / "zip.zip",
        ),
        patch("deepeval_eval.datasets.hotpotqa.load_questions", return_value=[mock_q]),
        patch(
            "deepeval_eval.datasets.hotpotqa.select_questions", return_value=[mock_q]
        ),
        patch(
            "deepeval_eval.datasets.hotpotqa.load_document_pool",
            return_value=[mock_doc],
        ),
        patch(
            "deepeval_eval.datasets.hotpotqa.select_documents", return_value=[mock_doc]
        ),
        patch(
            "deepeval_eval.ingest.ingest.build_ingest_rag_client",
            return_value=mock_client,
        ),
        patch("deepeval_eval.datasets.hotpotqa.write_corpus"),
        patch("deepeval_eval.datasets.hotpotqa.write_questions"),
    ):
        run_ingest(args)
        mock_client.reset_datasource.assert_called_once_with("ds_hotpot")
        mock_client.register_ingestor.assert_called_once()
        mock_client.upsert_datasource.assert_called_once()
        mock_client.open_job.assert_called_once()
        mock_client.ingest_batch.assert_called_once()
        mock_client.close_job.assert_called_once_with(
            "job_2", "HotpotQA DeepEval ingestion complete"
        )


def test_main_cli_execution_positive() -> None:
    """Verify main function parses arguments and triggers ingestion."""
    with (
        patch("sys.argv", ["ingest", "--skip-ingest"]),
        patch("deepeval_eval.ingest.ingest.run_ingest") as mock_run_ingest,
    ):
        main()
        mock_run_ingest.assert_called_once()


def test_setup_ingest_client_insecure_and_secure() -> None:
    """Verify setup_ingest_client properly configures SSL verification from insecure flag."""
    from deepeval_eval.ingest.ingest import setup_ingest_client

    args_insecure = argparse.Namespace(
        rag_url="http://example.com:9000",
        auth_token="token-abc",
        insecure=True,
    )
    with patch("deepeval_eval.ingest.ingest.build_ingest_rag_client") as mock_build:
        setup_ingest_client(args_insecure)
        mock_build.assert_called_once()
        settings = mock_build.call_args[0][0]
        assert settings.insecure is True

    args_secure = argparse.Namespace(
        rag_url="http://example.com:9000",
        auth_token="token-abc",
        insecure=False,
    )
    with patch("deepeval_eval.ingest.ingest.build_ingest_rag_client") as mock_build:
        setup_ingest_client(args_secure)
        mock_build.assert_called_once()
        settings = mock_build.call_args[0][0]
        assert settings.insecure is False


def test_ingest_payloads_to_caipe_offset_and_no_reset() -> None:
    """Verify ingest_payloads_to_caipe handles offset resumption and does not call reset when reset=False."""
    from deepeval_eval.ingest.ingest import ingest_payloads_to_caipe

    mock_client = MagicMock()
    mock_client.register_ingestor.return_value = ("ing_1", 2)
    mock_client.open_job.return_value = "job_offset_1"

    payloads = [{"doc": f"d_{i}"} for i in range(5)]

    job_id = ingest_payloads_to_caipe(
        client=mock_client,
        datasource_id="ds_custom",
        datasource_name="DS Custom",
        ingestor_type="type_1",
        ingestor_name="name_1",
        payloads=payloads,
        batch_size=2,
        start_offset=1,
        reset=False,
    )

    assert job_id == "job_offset_1"
    mock_client.reset_datasource.assert_not_called()
    mock_client.register_ingestor.assert_called_once()
    # 5 items with start_offset=1 -> remaining 4 items -> 2 batches of size 2
    assert mock_client.ingest_batch.call_count == 2
    mock_client.close_job.assert_called_once_with(
        "job_offset_1", "Dataset ingestion complete"
    )


def test_execute_ingestion_pipeline_custom_paths(tmp_path: Path) -> None:
    """Verify execute_ingestion_pipeline respects explicit corpus and question CLI file paths."""
    from deepeval_eval.datasets.base import DatasetBundle
    from deepeval_eval.ingest.ingest import execute_ingestion_pipeline

    custom_corpus_jsonl = tmp_path / "custom_corpus.jsonl"
    custom_corpus_csv = tmp_path / "custom_corpus.csv"
    custom_q_jsonl = tmp_path / "custom_q.jsonl"
    custom_q_csv = tmp_path / "custom_q.csv"

    mock_bundle = MagicMock(spec=DatasetBundle)
    mock_bundle.write_corpus_fn = MagicMock()
    mock_bundle.write_questions_fn = MagicMock()
    mock_bundle.docs = []
    mock_bundle.selected_questions = []
    mock_bundle.docs_by_id = {}

    args = argparse.Namespace(
        skip_ingest=True,
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        results_dir=tmp_path / "results",
        corpus_jsonl=custom_corpus_jsonl,
        corpus_csv=custom_corpus_csv,
        questions_file=custom_q_jsonl,
        questions_csv=custom_q_csv,
    )

    execute_ingestion_pipeline(mock_bundle, args)
    mock_bundle.write_corpus_fn.assert_called_once_with(
        [], custom_corpus_jsonl, custom_corpus_csv
    )
    mock_bundle.write_questions_fn.assert_called_once_with(
        [], {}, custom_q_jsonl, custom_q_csv
    )

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from deepeval_eval.sinks.psql_sink import PostgresResultSink


def test_postgres_result_sink_init_db_with_provided_conn_creates_tables() -> None:
    """Verify init_db executes table creation DDL on provided connection."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    sink.init_db(conn=mock_conn)

    mock_cursor.execute.call_count == 2
    assert (
        "CREATE TABLE IF NOT EXISTS evaluation_runs"
        in mock_cursor.execute.call_args_list[0][0][0]
    )
    mock_conn.commit.assert_not_called()


def test_postgres_result_sink_init_db_standalone_opens_and_commits_conn() -> None:
    """Verify init_db opens and commits standalone database connection."""
    mock_conn = MagicMock()
    mock_conn.closed = False
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    with patch.object(sink, "_get_connection", return_value=mock_conn):
        sink.init_db()

    assert mock_cursor.execute.call_count == 2
    mock_conn.commit.assert_called_once()


def test_postgres_result_sink_write_results_executes_run_and_result_inserts() -> None:
    """Verify write_results inserts run summary and row-level evaluation results into PostgreSQL."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    sample_results = [
        {
            "question_id": "q1",
            "question": "What is CAIPE?",
            "answer": "CAIPE is an AI platform.",
            "contexts": ["Context text"],
            "doc_ids": ["doc_1"],
            "latency_sec": 0.8,
            "AnswerRelevancy": 0.95,
        }
    ]

    with (
        patch.object(sink, "_get_connection", return_value=mock_conn),
        patch("psycopg2.extras.execute_values") as mock_execute_values,
    ):
        sink.save(
            results_dir=Path("/tmp"),
            prefix="test",
            results=sample_results,
            evaluation_time=1.5,
            config_args={"datasource": "test_ds", "run_id": "run_test_1"},
        )

        assert mock_cursor.execute.call_count == 4
        mock_execute_values.assert_called_once()
        mock_conn.commit.assert_called_once()


def test_postgres_result_sink_maps_retrieved_contexts_and_doc_ids_aliases_to_db_columns() -> (
    None
):
    """Verify write_results extracts retrieved_contexts and retrieved_doc_ids aliases properly into columns."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    sample_results = [
        {
            "question_id": "q10",
            "user_input": "What are the default limits?",
            "actual_output": "The default limit is 10 MiB.",
            "retrieved_contexts": ["Context line 1", "Context line 2"],
            "retrieved_doc_ids": ["doc_chunk_1"],
            "expected_doc_ids": ["doc_chunk_1"],
            "latency": 2.5,
            "doc_id_recall": 1.0,
            "doc_id_precision": 1.0,
        }
    ]

    with (
        patch.object(sink, "_get_connection", return_value=mock_conn),
        patch("psycopg2.extras.execute_values") as mock_execute_values,
    ):
        sink.save(
            results_dir=Path("/tmp"),
            prefix="test_alias",
            results=sample_results,
            evaluation_time=2.5,
            config_args={"datasource": "test_ds", "run_id": "job_alias_123"},
        )

        mock_execute_values.assert_called_once()
        call_args = mock_execute_values.call_args[0]
        rows_inserted = call_args[2]
        assert len(rows_inserted) == 1
        inserted_row = rows_inserted[0]
        # Tuple structure:
        # (run_id, question_id, user_input, actual_input, reference, actual_output, context, retrieved_contexts, expected_doc_ids, retrieved_doc_ids, metrics, latency_sec, pipeline_usage)
        assert inserted_row[0] == "job_alias_123"
        assert inserted_row[1] == "q10"
        assert inserted_row[2] == "What are the default limits?"
        assert inserted_row[3] == "What are the default limits?"
        assert inserted_row[4] == ""
        assert inserted_row[5] == "The default limit is 10 MiB."
        import json

        assert json.loads(inserted_row[6]) == ""
        assert json.loads(inserted_row[7]) == ["Context line 1", "Context line 2"]
        assert json.loads(inserted_row[8]) == ["doc_chunk_1"]
        assert json.loads(inserted_row[9]) == ["doc_chunk_1"]
        metrics_dict = json.loads(inserted_row[10])
        # Ensure retrieved_contexts and retrieved_doc_ids were not included in metrics json
        assert "retrieved_contexts" not in metrics_dict
        assert "retrieved_doc_ids" not in metrics_dict
        assert "expected_doc_ids" not in metrics_dict
        assert metrics_dict["doc_id_recall"] == 1.0


def test_query_runs_when_postgres_unconfigured_returns_empty_list() -> None:
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = False
    sink = PostgresResultSink(db_manager=mock_db)
    assert sink.query_runs() == []


def test_save_with_custom_actual_input_persists_exact_enriched_prompt() -> None:
    """Verify that PostgresResultSink correctly persists distinct user_input and actual_input columns."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    custom_input = "Instructions: Search knowledge base.\n\nAnswer: What is CAIPE?"
    sample_results = [
        {
            "question_id": "q_actual_in_1",
            "user_input": "What is CAIPE?",
            "actual_input": custom_input,
            "reference": "CAIPE platform",
            "actual_output": "CAIPE is an AI platform.",
            "retrieved_contexts": ["CAIPE context"],
            "expected_doc_ids": ["doc_1"],
            "retrieved_doc_ids": ["doc_1"],
            "latency": 1.2,
        }
    ]

    with (
        patch.object(sink, "_get_connection", return_value=mock_conn),
        patch("psycopg2.extras.execute_values") as mock_execute_values,
    ):
        sink.save(
            results_dir=Path("/tmp"),
            prefix="test_actual_input",
            results=sample_results,
            evaluation_time=1.2,
            config_args={"datasource": "test_ds", "run_id": "run_actual_input_123"},
        )

        mock_execute_values.assert_called_once()
        inserted_row = mock_execute_values.call_args[0][2][0]
        assert inserted_row[0] == "run_actual_input_123"
        assert inserted_row[1] == "q_actual_in_1"
        assert inserted_row[2] == "What is CAIPE?"
        assert inserted_row[3] == custom_input
        assert inserted_row[4] == "CAIPE platform"
        assert inserted_row[5] == "CAIPE is an AI platform."


def test_query_runs_when_postgres_configured_queries_and_returns_rows() -> None:
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.fetchall.return_value = [
        {"run_id": "run-1", "dataset_name": "enterprise"}
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
    mock_db.get_connection.return_value = mock_conn

    sink = PostgresResultSink(db_manager=mock_db)
    runs = sink.query_runs(limit=5)
    assert len(runs) == 1
    assert runs[0]["run_id"] == "run-1"


def test_query_evaluation_results_when_postgres_configured_returns_rows() -> None:
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = True
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.fetchall.return_value = [
        {"id": 1, "question_id": "q1", "actual_output": "out"}
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
    mock_db.get_connection.return_value = mock_conn

    sink = PostgresResultSink(db_manager=mock_db)
    res = sink.query_evaluation_results("run-1")
    assert len(res) == 1
    assert res[0]["question_id"] == "q1"


def test_query_evaluation_results_when_not_postgres_returns_empty() -> None:
    mock_db = MagicMock()
    mock_db.is_postgres.return_value = False
    sink = PostgresResultSink(db_manager=mock_db)
    assert sink.query_evaluation_results("run-1") == []


def test_postgres_result_sink_save_with_extended_metadata_and_tokens() -> None:
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    results = [
        {
            "question_id": "q1",
            "category": "compliance",
            "level": "hard",
            "log_file": "trace.log",
            "failure_cause": "Timeout",
            "evaluator_prompt_tokens": 100,
            "evaluator_completion_tokens": 50,
            "evaluator_total_tokens": 150,
            "latency": 1.2,
            "pipeline_usage": {
                "prompt_tokens": 80,
                "completion_tokens": 40,
                "total_tokens": 120,
            },
        }
    ]

    class UnserializableObj:
        def __str__(self):
            return "unserializable_str"

    config_args = {
        "dataset_name": "enterprise",
        "_private_key": "private",
        "llm_api_key": "secret",
        "auth_token": "secret_tok",
        "custom_obj": UnserializableObj(),
    }

    with (
        patch.object(sink, "_get_connection", return_value=mock_conn),
        patch("psycopg2.extras.execute_values") as mock_execute_values,
    ):
        sink.save(Path("/tmp"), "prefix", results, 5.0, config_args)
        mock_execute_values.assert_called_once()
        mock_conn.commit.assert_called_once()


def test_postgres_result_sink_save_when_connection_fails_logs_warning_and_returns() -> (
    None
):
    sink = PostgresResultSink()
    with patch.object(
        sink, "_get_connection", side_effect=RuntimeError("Connection refused")
    ):
        sink.save(Path("/tmp"), "prefix", [], 1.0, {})

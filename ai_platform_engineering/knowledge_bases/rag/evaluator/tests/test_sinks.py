import csv
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from deepeval_eval.sinks import (
    CompositeResultSink,
    FileLogSink,
    FileResultSink,
    PostgresResultSink,
    ResultSink,
    calculate_latency_percentiles,
    categorize_failure_causes,
    compute_all_metric_averages,
    discover_all_metrics,
    write_evaluation_results,
)
from deepeval_eval.sinks.metrics_aggregator import compute_metric_averages


def _mock_record(ar_score=0.9, fa_score=0.8, custom_score=0.95):
    return {
        "question_id": "q1",
        "question": "What is AI?",
        "latency": 1.2,
        "total_tokens": 150,
        "doc_id_recall": 1.0,
        "doc_id_precision": 0.5,
        "metrics": {
            "AnswerRelevancyMetric": {
                "score": ar_score,
                "success": True,
                "reason": "Good",
            },
            "FaithfulnessMetric": {
                "score": fa_score,
                "success": True,
                "reason": "Faithful",
            },
            "CustomNewMetric": {
                "score": custom_score,
                "success": True,
                "reason": "Custom ok",
            },
        },
    }


def test_discover_all_metrics():
    records = [_mock_record()]
    discovered = discover_all_metrics(records)
    assert "AnswerRelevancyMetric" in discovered
    assert "FaithfulnessMetric" in discovered
    assert "CustomNewMetric" in discovered


def test_compute_metric_averages():
    records = [_mock_record(ar_score=0.8), _mock_record(ar_score=1.0)]
    averages = compute_metric_averages(
        records, ["AnswerRelevancyMetric", "FaithfulnessMetric"]
    )
    assert averages["AnswerRelevancyMetric"] == 0.9
    assert averages["FaithfulnessMetric"] == 0.8


def test_compute_all_metric_averages():
    records = [_mock_record(ar_score=0.8), _mock_record(ar_score=1.0)]
    averages = compute_all_metric_averages(records)
    assert averages["answer_relevancy"] == 0.9
    assert averages["faithfulness"] == 0.8
    assert averages["retrieval_recall"] == 1.0
    assert averages["retrieval_precision"] == 0.5


def test_calculate_latency_percentiles():
    p50, p95 = calculate_latency_percentiles([1.0, 2.0, 3.0, 4.0, 5.0])
    assert p50 == 3.0
    assert p95 == 5.0
    # Empty case
    assert calculate_latency_percentiles([]) == (0.0, 0.0)


def test_categorize_failure_causes():
    records = [
        {"metrics": {"FaithfulnessMetric": {"score": 0.3}}},
        {"metrics": {"ContextualRecallMetric": {"score": 0.4}}},
        {"metrics": {"AnswerRelevancyMetric": {"score": 0.2}}},
        {"metrics": {"FaithfulnessMetric": {"score": 0.9}}},
    ]
    counts = categorize_failure_causes(records)
    assert counts["hallucination"] == 1
    assert counts["poor_retrieval"] == 1
    assert counts["incorrect_generation"] == 1
    assert counts["none"] == 1


def test_file_result_sink_saves(tmp_path: Path):
    sink = FileResultSink()
    results = [_mock_record() for _ in range(3)]
    config_args = {"datasource": "test_ds", "top_k": 3}
    sink.save(tmp_path, "test_prefix", results, 5.0, config_args)

    all_json = list(tmp_path.glob("test_prefix_*.json"))
    summary_files = list(tmp_path.glob("test_prefix_*_summary.json"))
    json_files = [f for f in all_json if not f.name.endswith("_summary.json")]
    csv_files = list(tmp_path.glob("test_prefix_*.csv"))

    assert len(json_files) == 1
    assert len(csv_files) == 1
    assert len(summary_files) == 1

    summary_data = json.loads(summary_files[0].read_text(encoding="utf-8"))
    assert summary_data["datasource"] == "test_ds"
    assert "metrics" in summary_data


def test_csv_contains_all_metric_scores_and_reasons(tmp_path: Path):
    record = {
        "question_id": "q100",
        "benchmark": "enterprise",
        "question": "What is CAIPE?",
        "user_input": "What is CAIPE?",
        "reference": "CAIPE is an AI platform",
        "actual_output": "CAIPE is an AI platform",
        "metrics": {
            "AnswerRelevancyMetric": {
                "score": 0.92,
                "success": True,
                "reason": "Highly relevant answer",
            },
            "FaithfulnessMetric": {
                "score": 0.88,
                "success": True,
                "reason": "Faithful to context",
            },
            "AnswerCorrectnessMetric": {
                "score": 0.95,
                "success": True,
                "reason": "Factually correct",
            },
            "ContextualRelevancyMetric": {
                "score": 0.85,
                "success": True,
                "reason": "Relevant context",
            },
            "ContextualPrecisionMetric": {
                "score": 0.90,
                "success": True,
                "reason": "Precise context",
            },
            "ContextualRecallMetric": {
                "score": 0.80,
                "success": True,
                "reason": "High recall",
            },
            "MRRMetric": {"score": 1.0, "success": True, "reason": "Top rank match"},
            "NDCGAtKMetric": {
                "score": 0.99,
                "success": True,
                "reason": "High NDCG gain",
            },
        },
    }

    sink = FileResultSink()
    sink.save(tmp_path, "csv_test", [record], 2.5, {"datasource": "enterprise"})

    csv_files = list(tmp_path.glob("csv_test_*.csv"))
    assert len(csv_files) == 1

    with csv_files[0].open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # First row should be the question result record
    row = rows[0]
    assert row["question_id"] == "q100"
    assert float(row["answer_relevancy"]) == 0.92
    assert row["answer_relevancy_reason"] == "Highly relevant answer"
    assert float(row["faithfulness"]) == 0.88
    assert row["faithfulness_reason"] == "Faithful to context"
    assert float(row["answer_correctness"]) == 0.95
    assert row["answer_correctness_reason"] == "Factually correct"

    # Second row should be the AVERAGE_METRICS row
    avg_row = rows[1]
    assert avg_row["question"] == "AVERAGE_METRICS"
    assert float(avg_row["answer_relevancy"]) == 0.92


class CustomDuckTypedSink:
    """A duck-typed custom sink that does NOT inherit from any base class, satisfying ResultSink Protocol."""

    def __init__(self):
        self.saved = False

    def save(
        self,
        results_dir: Path,
        prefix: str,
        results: list[dict],
        evaluation_time: float,
        config_args: dict,
    ) -> None:
        self.saved = True


def test_custom_duck_typed_sink_with_protocol(tmp_path: Path):
    custom_sink: ResultSink = CustomDuckTypedSink()

    # Structural check - static typing contract verification
    write_evaluation_results(
        results_dir=tmp_path,
        prefix="custom_test",
        results=[_mock_record()],
        evaluation_time=1.0,
        config_args={"datasource": "custom"},
        sinks=[custom_sink],
    )
    assert custom_sink.saved is True


def test_composite_result_sink(tmp_path: Path):
    sink1 = CustomDuckTypedSink()
    sink2 = CustomDuckTypedSink()

    composite = CompositeResultSink([sink1])
    composite.add_sink(sink2)
    composite.save(tmp_path, "comp", [_mock_record()], 1.0, {})

    assert sink1.saved is True
    assert sink2.saved is True


@patch.object(PostgresResultSink, "_get_connection")
def test_database_result_sink_query_runs(mock_get_conn):
    mock_psycopg2_extras = MagicMock()
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_get_conn.return_value = mock_conn
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
    mock_cursor.fetchall.return_value = [
        {
            "run_id": "run_1",
            "batch_id": "b1",
            "config_name": "cfg",
            "loaded_at": "2026-07-22",
            "config_json": "{}",
        }
    ]

    with patch.dict(
        "sys.modules",
        {"psycopg2": MagicMock(), "psycopg2.extras": mock_psycopg2_extras},
    ):
        db_sink = PostgresResultSink(
            connection_string="postgresql://user:pass@localhost:5432/db"
        )
        runs = db_sink.query_runs(limit=5)

    assert len(runs) == 1
    assert runs[0]["run_id"] == "run_1"


def test_database_result_sink_missing_psycopg2():
    with patch.dict("sys.modules", {"psycopg2": None, "psycopg2.extras": None}):
        db_sink = PostgresResultSink(
            connection_string="postgresql://user:pass@localhost:5432/db"
        )
        runs = db_sink.query_runs(limit=5)
        assert runs == []

        # Ensure save does not crash when psycopg2 is missing
        db_sink.save(Path("/tmp"), "test", [], 1.0, {})


def test_database_result_sink_get_connection_positive():
    """Verify PostgresResultSink._get_connection connects using connection_string or env vars."""
    mock_psycopg2 = MagicMock()
    with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
        sink = PostgresResultSink("postgresql://user:pass@localhost:5432/db")
        sink._get_connection()
        mock_psycopg2.connect.assert_called_with(
            "postgresql://user:pass@localhost:5432/db", connect_timeout=5
        )

        mock_psycopg2.reset_mock()
        sink_env = PostgresResultSink()
        with patch.dict(
            "os.environ",
            {
                "DATABASE_URL": "",
                "POSTGRES_HOST": "db.host",
                "POSTGRES_PORT": "5433",
                "POSTGRES_DB": "test_db",
                "POSTGRES_USER": "test_user",
                "POSTGRES_PASSWORD": "test_password",
            },
        ):
            sink_env._get_connection()
            mock_psycopg2.connect.assert_called_with(
                host="db.host",
                port="5433",
                dbname="test_db",
                user="test_user",
                password="test_password",
                sslmode="prefer",
                connect_timeout=5,
            )


def test_database_result_sink_init_db_positive():
    """Verify init_db executes table creation DDL on provided connection without premature commit."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    sink.init_db(conn=mock_conn)

    assert mock_cursor.execute.call_count == 2
    assert (
        "CREATE TABLE IF NOT EXISTS evaluation_runs"
        in mock_cursor.execute.call_args_list[0][0][0]
    )
    mock_conn.commit.assert_not_called()


def test_database_result_sink_init_db_standalone_positive():
    """Verify init_db opens and closes connection when conn is not passed."""
    mock_conn = MagicMock()
    mock_conn.closed = False
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    sink = PostgresResultSink()
    with patch.object(sink, "_get_connection", return_value=mock_conn):
        sink.init_db()

    assert mock_cursor.execute.call_count == 2
    mock_conn.commit.assert_called_once()
    mock_conn.close.assert_called_once()


def test_database_result_sink_save_positive(tmp_path: Path):
    """Verify PostgresResultSink.save executes DB insertion and commits."""
    mock_psycopg2 = MagicMock()
    mock_extras = MagicMock()
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    with (
        patch.dict(
            "sys.modules",
            {"psycopg2": mock_psycopg2, "psycopg2.extras": mock_extras},
        ),
        patch.object(PostgresResultSink, "_get_connection", return_value=mock_conn),
    ):
        sink = PostgresResultSink(auto_init=False)
        sink.save(
            tmp_path,
            "prefix",
            [_mock_record()],
            1.0,
            {"batch_id": "b123", "run_id": "r123", "config_name": "test_cfg"},
        )
        assert mock_cursor.execute.call_count >= 3
        mock_extras.execute_values.assert_called_once()
        mock_conn.commit.assert_called_once()


def test_database_result_sink_save_connection_failure_negative(tmp_path: Path):
    """Verify PostgresResultSink.save handles connection failure gracefully."""
    mock_psycopg2 = MagicMock()
    mock_extras = MagicMock()

    with (
        patch.dict(
            "sys.modules",
            {"psycopg2": mock_psycopg2, "psycopg2.extras": mock_extras},
        ),
        patch.object(
            PostgresResultSink,
            "_get_connection",
            side_effect=Exception("Connection refused"),
        ),
    ):
        sink = PostgresResultSink()
        # Should not raise exception
        sink.save(tmp_path, "prefix", [_mock_record()], 1.0, {})


def test_database_result_sink_save_execution_failure_negative(tmp_path: Path):
    """Verify PostgresResultSink.save rolls back on execution error."""
    mock_psycopg2 = MagicMock()
    mock_extras = MagicMock()
    mock_conn = MagicMock()
    mock_conn.closed = False
    mock_cursor = MagicMock()
    mock_cursor.execute.side_effect = Exception("DB Execution error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    with (
        patch.dict(
            "sys.modules",
            {"psycopg2": mock_psycopg2, "psycopg2.extras": mock_extras},
        ),
        patch.object(PostgresResultSink, "_get_connection", return_value=mock_conn),
    ):
        sink = PostgresResultSink()
        sink.save(tmp_path, "prefix", [_mock_record()], 1.0, {})
        mock_conn.rollback.assert_called_once()


def test_postgres_result_sink_explicit_connection_string():
    """Verify explicit connection_string kwarg takes precedence."""
    sink = PostgresResultSink(
        connection_string="postgresql://user:pass@argshost:5432/argsdb",
        auto_init=False,
    )
    assert sink.connection_string == "postgresql://user:pass@argshost:5432/argsdb"


def test_postgres_result_sink_db_settings_connection_string():
    """Verify db_settings connection_string is used when connection_string is None."""
    from pydantic import SecretStr

    from deepeval_eval.core.config import DatabaseSettings

    db_settings = DatabaseSettings(
        connection_string=SecretStr(
            "postgresql://user:pass@settingshost:5432/settingsdb"
        )
    )
    sink = PostgresResultSink(db_settings=db_settings, auto_init=False)
    assert (
        sink.connection_string == "postgresql://user:pass@settingshost:5432/settingsdb"
    )


def test_postgres_result_sink_explicit_overrides_db_settings():
    """Verify explicit connection_string kwarg overrides db_settings."""
    from pydantic import SecretStr

    from deepeval_eval.core.config import DatabaseSettings

    db_settings = DatabaseSettings(
        connection_string=SecretStr(
            "postgresql://user:pass@settingshost:5432/settingsdb"
        )
    )
    sink = PostgresResultSink(
        connection_string="postgresql://user:pass@overridehost:5432/overridedb",
        db_settings=db_settings,
        auto_init=False,
    )
    assert (
        sink.connection_string == "postgresql://user:pass@overridehost:5432/overridedb"
    )


def test_postgres_result_sink_env_var_resolution():
    """Verify environment variable POSTGRES_CONNECTION_STRING resolution."""
    with patch.dict(
        "os.environ",
        {
            "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@envhost:5432/envdb",
            "DATABASE_URL": "postgresql://user:pass@envhost:5432/envdb",
        },
    ):
        sink = PostgresResultSink(auto_init=False)
        assert sink.connection_string == "postgresql://user:pass@envhost:5432/envdb"


def test_postgres_result_sink_db_manager_injection():
    """Verify pre-constructed db_manager injection."""
    mock_manager = MagicMock()
    mock_manager.connection_string = "postgresql://user:pass@managerhost:5432/managerdb"
    sink = PostgresResultSink(db_manager=mock_manager, auto_init=False)
    assert sink.db_manager is mock_manager
    assert sink.connection_string == "postgresql://user:pass@managerhost:5432/managerdb"


# ============================================================
# FileLogSink Tests
# ============================================================


def test_file_log_sink_make_stream_log_path_with_run_id(tmp_path: Path):
    """Non-UUID run_id produces deterministic filename with _agent_trace.log suffix."""
    sink = FileLogSink()
    path = sink.make_stream_log_path(tmp_path / "logs", "deepeval_ds", run_id="my_run")
    assert path.parent.exists()
    assert path.name == "my_run_agent_trace.log"


def test_file_log_sink_make_stream_log_path_with_uuid_run_id(tmp_path: Path):
    """UUID run_id falls back to prefix+timestamp pattern."""
    import re

    sink = FileLogSink()
    uuid_run = "123e4567-e89b-12d3-a456-426614174000"
    path = sink.make_stream_log_path(tmp_path / "logs", "deepeval_ds", run_id=uuid_run)
    assert re.match(r"deepeval_ds_\d{8}-\d{6}_agent_trace\.log", path.name)


def test_file_log_sink_make_stream_log_path_no_run_id(tmp_path: Path):
    """No run_id falls back to prefix+timestamp pattern."""
    import re

    sink = FileLogSink()
    path = sink.make_stream_log_path(tmp_path / "logs", "deepeval_ds")
    assert re.match(r"deepeval_ds_\d{8}-\d{6}_agent_trace\.log", path.name)


def test_file_log_sink_make_query_trace_path(tmp_path: Path):
    """Query trace path uses sanitized run_id with _query_trace.json suffix."""
    sink = FileLogSink()
    path = sink.make_query_trace_path(tmp_path / "logs", "my_run_id")
    assert path.name == "my_run_id_query_trace.json"
    assert path.parent.exists()


def test_file_log_sink_write_query_trace_writes_file(tmp_path: Path):
    """write_query_trace creates a readable JSON file with expected structure."""
    from datetime import datetime

    class _FakeTrace:
        event_type = "query_start"
        component = "test"
        data = {"key": "value"}
        timestamp = datetime(2026, 1, 1, 12, 0, 0)

    sink = FileLogSink()
    path = sink.write_query_trace(
        tmp_path, "run1", "What is AI?", {"answer": "ok"}, [_FakeTrace()]
    )
    assert path.exists()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["question"] == "What is AI?"
    assert data["result"] == {"answer": "ok"}
    assert len(data["traces"]) == 1
    assert data["traces"][0]["event_type"] == "query_start"


def test_file_log_sink_write_query_trace_no_trace_log_returns_empty_str(tmp_path: Path):
    """FileLogSink gating is the caller's responsibility — no files if caller skips it."""
    assert list(tmp_path.glob("query_trace_*.json")) == []


def test_file_log_sink_open_stream_log_exception_returns_none_handle(
    tmp_path: Path,
) -> None:
    sink = FileLogSink()
    # Mocking open on the path to raise OSError
    with patch("pathlib.Path.open", side_effect=OSError("Cannot write")):
        path, handle = sink.open_stream_log(tmp_path, run_id="run_err")
        assert handle is None
        assert "run_err" in str(path)


def test_file_log_sink_write_stream_line_with_invalid_json_data_and_events() -> None:
    mock_file = MagicMock()
    sink = FileLogSink()

    # 1. event line
    sink.write_stream_line(mock_file, "event: start")
    mock_file.write.assert_called_with("\n[event: start]\n")

    # 2. valid json data line
    mock_file.reset_mock()
    sink.write_stream_line(mock_file, 'data: {"key": "value"}')
    assert '{\n  "key": "value"\n}\n' in mock_file.write.call_args_list[0][0][0]

    # 3. invalid json data line
    mock_file.reset_mock()
    sink.write_stream_line(mock_file, "data: invalid json content")
    mock_file.write.assert_called_with("data: invalid json content\n")

    # 4. regular text line
    mock_file.reset_mock()
    sink.write_stream_line(mock_file, "plain log message")
    mock_file.write.assert_called_with("plain log message\n")


def test_file_log_sink_make_query_trace_path_with_uuid_run_id(tmp_path: Path) -> None:
    sink = FileLogSink()
    uuid_run = "123e4567-e89b-12d3-a456-426614174000"
    path = sink.make_query_trace_path(tmp_path, run_id=uuid_run, prefix="eval")
    assert "_query_trace.json" in path.name


def test_file_log_sink_write_query_trace_exception_handling(tmp_path: Path) -> None:
    sink = FileLogSink()
    with patch("pathlib.Path.write_text", side_effect=OSError("Write trace failure")):
        path = sink.write_query_trace(tmp_path, "run_fail", "Q?", {}, [])
        assert path.name == "run_fail_query_trace.json"

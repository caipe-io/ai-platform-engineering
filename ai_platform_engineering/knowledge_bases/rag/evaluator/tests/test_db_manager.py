from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from deepeval_eval.core.config import DatabaseSettings
from deepeval_eval.db.db_manager import DatabaseManager


@pytest.fixture
def clean_db_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in [
        "DATABASE_URL",
        "LANGGRAPH_CHECKPOINT_POSTGRES_DSN",
        "POSTGRES_DSN",
        "DB_CONNECTION_STRING",
        "POSTGRES_HOST",
        "PGHOST",
        "DB_HOST",
    ]:
        monkeypatch.delenv(var, raising=False)


def test_db_manager_init_with_secret_str_connection_string():
    """Verify DatabaseManager __init__ unpacks SecretStr connection string."""
    secret_conn = SecretStr("postgresql://user:pass@localhost:5432/testdb")
    with patch.object(DatabaseManager, "init_db") as mock_init:
        db = DatabaseManager(connection_string=secret_conn)
        assert db.connection_string == "postgresql://user:pass@localhost:5432/testdb"
        assert db.is_postgres() is True
        mock_init.assert_called_once()


def test_db_manager_init_with_db_settings_secret_str():
    """Verify DatabaseManager __init__ extracts SecretStr connection_string from db_settings."""
    settings = DatabaseSettings(
        connection_string=SecretStr("postgresql://user2:pass2@localhost:5432/db2")
    )
    with patch.object(DatabaseManager, "init_db") as mock_init:
        db = DatabaseManager(db_settings=settings)
        assert db.connection_string == "postgresql://user2:pass2@localhost:5432/db2"
        mock_init.assert_called_once()


def test_db_manager_init_with_db_settings_plain_str():
    """Verify DatabaseManager __init__ extracts plain string connection_string from db_settings."""
    settings = DatabaseSettings(
        connection_string="postgresql://user3:pass3@localhost:5432/db3"
    )
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(db_settings=settings)
        assert db.connection_string == "postgresql://user3:pass3@localhost:5432/db3"


def test_db_manager_init_with_settings_keyword_arg():
    """Verify DatabaseManager __init__ supports settings= keyword argument."""
    settings = DatabaseSettings(
        connection_string="postgresql://user4:pass4@localhost:5432/db4"
    )
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(settings=settings)
        assert db.connection_string == "postgresql://user4:pass4@localhost:5432/db4"
        assert db.is_postgres() is True


def test_db_manager_init_with_db_settings_passed_as_first_arg_identifies_postgres():
    """Verify DatabaseManager __init__ treats DatabaseSettings passed as first positional arg as db_settings."""
    settings = DatabaseSettings(
        connection_string="postgresql://user_pos:pass_pos@localhost:5432/posdb"
    )
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(settings)
        assert db.is_postgres() is True
        assert (
            db.connection_string
            == "postgresql://user_pos:pass_pos@localhost:5432/posdb"
        )


def test_db_manager_init_handles_startup_init_db_failure(caplog):
    """Verify DatabaseManager __init__ catches and logs exception if init_db fails on startup."""
    with patch.object(
        DatabaseManager, "init_db", side_effect=RuntimeError("Connection refused")
    ):
        with caplog.at_level(logging.WARNING):
            db = DatabaseManager(
                connection_string="postgresql://user:pass@localhost:5432/db"
            )
            assert db.is_postgres() is True
            assert "PostgreSQL schema init failed on startup" in caplog.text


def test_db_manager_properties_and_setter(clean_db_env):
    """Verify db_settings property, connection_string setter, and postgres_host property."""
    db = DatabaseManager()
    assert isinstance(db.db_settings, DatabaseSettings)

    # Set connection_string via setter
    db.connection_string = "postgresql://newuser:newpass@localhost:5432/newdb"
    assert db.connection_string == "postgresql://newuser:newpass@localhost:5432/newdb"
    assert db.is_postgres() is True

    # Empty string fallback
    db.connection_string = "   "
    assert db.connection_string is None


def test_db_manager_get_connection_unconfigured_raises_runtime_error(clean_db_env):
    """Verify get_connection raises RuntimeError when PostgreSQL is not configured."""
    empty_settings = DatabaseSettings()
    empty_settings.connection_string = None
    empty_settings.postgres_host = None
    db = DatabaseManager(db_settings=empty_settings)
    db.connection_string = None
    with patch.object(db, "is_postgres", return_value=False):
        with pytest.raises(RuntimeError, match="PostgreSQL database is not configured"):
            db.get_connection()


def test_db_manager_get_connection_with_connection_string():
    """Verify get_connection calls psycopg2.connect with connection_string."""
    mock_psycopg2 = MagicMock()
    with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
        db = DatabaseManager(
            connection_string="postgresql://usr:pwd@localhost:5432/testdb"
        )
        db.get_connection()
        mock_psycopg2.connect.assert_called_with(
            "postgresql://usr:pwd@localhost:5432/testdb", connect_timeout=5
        )


def test_db_manager_get_connection_with_individual_settings(clean_db_env):
    """Verify get_connection calls psycopg2.connect with host/port/dbname/user/password/sslmode when no connection string."""
    mock_psycopg2 = MagicMock()
    with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
        settings = DatabaseSettings(
            postgres_host="db.example.internal",
            postgres_port="5433",
            postgres_db="analytics",
            postgres_user="admin_user",
            postgres_password=SecretStr("supersecret"),
            pgsslmode="require",
        )
        db = DatabaseManager(db_settings=settings)
        # Clear explicit connection string
        db._explicit_connection_string = None
        db.get_connection()
        mock_psycopg2.connect.assert_called_with(
            host="db.example.internal",
            port="5433",
            dbname="analytics",
            user="admin_user",
            password="supersecret",
            sslmode="require",
            connect_timeout=5,
        )


def test_db_manager_sub_managers_cached():
    """Verify questions, evaluation, and prompt_styles properties create and cache sub-managers."""
    db = DatabaseManager()
    q1 = db.questions
    q2 = db.questions
    assert q1 is q2

    e1 = db.evaluation
    e2 = db.evaluation
    assert e1 is e2

    p1 = db.prompt_styles
    p2 = db.prompt_styles
    assert p1 is p2


def test_db_manager_init_db_non_postgres():
    """Verify init_db returns early when is_postgres is False."""
    db = DatabaseManager()
    with patch.object(db, "is_postgres", return_value=False):
        db.init_db()  # Should not raise or initialize anything


def test_db_manager_init_db_postgres_success_and_failure(caplog):
    """Verify init_db initializes tables and handles sub-manager init errors."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    with (
        patch.object(db.evaluation, "init_tables") as mock_eval_init,
        patch.object(db.questions, "init_tables") as mock_q_init,
        patch.object(db.prompt_styles, "init_tables") as mock_prompt_init,
    ):
        db.init_db()
        mock_eval_init.assert_called_once()
        mock_q_init.assert_called_once()
        mock_prompt_init.assert_called_once()

    # When table init raises exception
    with (
        patch.object(
            db.evaluation, "init_tables", side_effect=Exception("Table lock conflict")
        ),
        caplog.at_level(logging.WARNING),
    ):
        db.init_db()
        assert "PostgreSQL schema initialization skipped" in caplog.text


def test_db_manager_execute_write_success():
    """Verify execute_write executes query on cursor, commits, and closes connection."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        db.execute_write("UPDATE table SET x=%s WHERE id=%s", (10, "id-1"))
        mock_cur.execute.assert_called_once_with(
            "UPDATE table SET x=%s WHERE id=%s", (10, "id-1")
        )
        mock_conn.commit.assert_called_once()
        mock_conn.close.assert_called_once()


def test_db_manager_execute_write_error_with_rollback():
    """Verify execute_write rolls back and re-raises exception on query failure."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Deadlock detected")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        with pytest.raises(RuntimeError, match="Deadlock detected"):
            db.execute_write("UPDATE table SET x=%s", (1,))
        mock_conn.rollback.assert_called_once()
        mock_conn.close.assert_called_once()


def test_db_manager_execute_write_error_rollback_also_fails():
    """Verify execute_write re-raises original error even if rollback raises an exception."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("Primary failure")
    mock_conn.rollback.side_effect = Exception("Rollback connection lost")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        with pytest.raises(RuntimeError, match="Primary failure"):
            db.execute_write("UPDATE table SET x=%s", (1,))
        mock_conn.close.assert_called_once()


def test_db_manager_query_all_success():
    """Verify query_all returns dict records from RealDictCursor."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.return_value = [
        {"id": 1, "name": "alpha"},
        {"id": 2, "name": "beta"},
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        results = db.query_all("SELECT * FROM table WHERE active=%s", (True,))
        assert len(results) == 2
        assert results[0] == {"id": 1, "name": "alpha"}
        assert results[1] == {"id": 2, "name": "beta"}
        mock_conn.close.assert_called_once()


def test_db_manager_query_all_error_with_rollback():
    """Verify query_all rolls back and closes connection when query fails."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.side_effect = RuntimeError("Query timeout")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        with pytest.raises(RuntimeError, match="Query timeout"):
            db.query_all("SELECT * FROM table")
        mock_conn.rollback.assert_called_once()
        mock_conn.close.assert_called_once()


def test_db_manager_query_all_error_rollback_exception():
    """Verify query_all re-raises query error even if rollback raises exception."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.side_effect = RuntimeError("Primary query error")
    mock_conn.rollback.side_effect = Exception("Rollback fail")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        with pytest.raises(RuntimeError, match="Primary query error"):
            db.query_all("SELECT * FROM table")
        mock_conn.close.assert_called_once()


def test_db_manager_verify_postgres_connection_success():
    """Verify verify_postgres_connection succeeds when connection and init_db work."""
    db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(db, "get_connection", return_value=mock_conn):
        with patch.object(db, "init_db") as mock_init:
            db.verify_postgres_connection()
            mock_cur.execute.assert_called_with("SELECT 1;")
            mock_init.assert_called_once()
            mock_conn.close.assert_called_once()


def test_db_manager_verify_postgres_connection_failure_raises_runtime_error():
    """Verify verify_postgres_connection raises RuntimeError when connection fails."""
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    with patch.object(
        db, "get_connection", side_effect=Exception("Database unreachable")
    ):
        with pytest.raises(RuntimeError, match="PostgreSQL verification failed"):
            db.verify_postgres_connection()


def test_evaluation_db_manager_get_cached_job_by_hash_hit():
    """Verify get_cached_job_by_hash returns formatted cached job when valid run exists."""
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = (
        "job-123",
        "hash-abc",
        "completed",
        '{"top_k": 3, "user_info": {"email": "test@example.com"}}',
        1700000000.0,
        1700000050.0,
        None,
        {"faithfulness": 0.95},
        {},
        {},
        1.2,
        2.5,
        50.0,
        10,
        10,
    )
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    with patch.object(db, "is_postgres", return_value=True):
        with patch.object(db, "get_connection", return_value=mock_conn):
            with patch.object(
                db.evaluation,
                "get_job_results_payload",
                return_value=[{"question": "q1"}],
            ):
                res = db.evaluation.get_cached_job_by_hash(
                    "hash-abc", ttl_seconds=86400
                )
                assert res is not None
                assert res["job_id"] == "job-123"
                assert res["eval_hash"] == "hash-abc"
                assert res["status"] == "completed"
                assert res["cached"] is True
                assert res["summary"]["metrics"] == {"faithfulness": 0.95}
                assert res["results"] == [{"question": "q1"}]


def test_evaluation_db_manager_get_cached_job_by_hash_when_missing_or_non_postgres_returns_none():
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager()
    with patch.object(db, "is_postgres", return_value=False):
        assert db.evaluation.get_cached_job_by_hash("hash-abc") is None

    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = None
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    with patch.object(db, "is_postgres", return_value=True):
        with patch.object(db, "get_connection", return_value=mock_conn):
            assert db.evaluation.get_cached_job_by_hash("hash-xyz") is None


def test_evaluation_db_manager_get_job_results_payload_when_records_exist_returns_formatted_results():
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchall.return_value = [
        (
            "q1",
            "What is CAIPE?",
            "AI platform",
            "CAIPE is an AI platform",
            None,
            ["doc1"],
            ["doc1"],
            ["doc1"],
            {"geval": 1.0},
            0.8,
            {},
        )
    ]
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    with patch.object(db, "is_postgres", return_value=True):
        with patch.object(db, "get_connection", return_value=mock_conn):
            results = db.evaluation.get_job_results_payload("job-123")
            assert len(results) == 1
            assert results[0]["question_id"] == "q1"
            assert results[0]["actual_output"] == "CAIPE is an AI platform"


def test_evaluation_db_manager_save_job_to_queue_when_postgres_executes_upsert_write():
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string="postgresql://usr:pwd@localhost/db")
    with patch.object(db, "is_postgres", return_value=True):
        with patch.object(db, "execute_write") as mock_write:
            db.evaluation.save_job_to_queue(
                job_id="job-cached-1",
                eval_hash="hash-123",
                status="completed",
                config_json='{"dataset_name": "enterprise"}',
                created_at=1787700000.0,
                started_at=1787700000.0,
                completed_at=1787700010.0,
                error=None,
            )
            mock_write.assert_called_once()
            query, params = mock_write.call_args[0]
            assert "INSERT INTO eval_job_queue" in query
            assert "ON CONFLICT (job_id) DO UPDATE" in query
            assert params == (
                "job-cached-1",
                "hash-123",
                "status" if False else "completed",
                '{"dataset_name": "enterprise"}',
                1787700000.0,
                1787700000.0,
                1787700010.0,
                None,
            )


def test_evaluation_db_manager_save_job_to_queue_when_non_postgres_noop():
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager()
    with patch.object(db, "is_postgres", return_value=False):
        with patch.object(db, "execute_write") as mock_write:
            db.evaluation.save_job_to_queue(
                job_id="job-cached-2",
                eval_hash="hash-456",
                status="completed",
                config_json="{}",
                created_at=1787700000.0,
            )
            mock_write.assert_not_called()


def test_evaluation_db_manager_get_job_results_payload_when_unconfigured_returns_empty_list():
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager()
    with patch.object(db, "is_postgres", return_value=False):
        assert db.evaluation.get_job_results_payload("job-123") == []


def test_database_manager_init_with_database_settings_as_first_argument() -> None:
    from deepeval_eval.core.config import DatabaseSettings

    settings = DatabaseSettings(postgres_host="pg.example.org", postgres_db="evaldb")
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string=settings)
        assert db.postgres_host == "pg.example.org"


def test_verify_postgres_connection_when_not_postgres_raises_runtime_error() -> None:
    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager()
    with patch.object(db, "is_postgres", return_value=False):
        with pytest.raises(RuntimeError, match="PostgreSQL database is required"):
            db.verify_postgres_connection()


def test_verify_postgres_connection_success() -> None:
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string="postgresql://u:p@localhost:5432/db")
    with patch.object(db, "get_connection", return_value=mock_conn):
        db.verify_postgres_connection()
        mock_cur.execute.assert_any_call("SELECT 1;")
        assert mock_conn.close.call_count >= 1


def test_execute_write_and_query_all_rollback_on_exception() -> None:
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.execute.side_effect = RuntimeError("DB write error")
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.closed = False

    with patch.object(DatabaseManager, "init_db"):
        db = DatabaseManager(connection_string="postgresql://u:p@localhost:5432/db")
    with patch.object(db, "get_connection", return_value=mock_conn):
        # execute_write exception and rollback
        with pytest.raises(RuntimeError, match="DB write error"):
            db.execute_write("UPDATE t SET x = 1;", ())
        mock_conn.rollback.assert_called_once()
        mock_conn.close.assert_called_once()

        # query_all exception and rollback
        mock_conn.rollback.reset_mock()
        mock_conn.close.reset_mock()
        with pytest.raises(RuntimeError, match="DB write error"):
            db.query_all("SELECT * FROM t;")
        mock_conn.rollback.assert_called_once()
        mock_conn.close.assert_called_once()

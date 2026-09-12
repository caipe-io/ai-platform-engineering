from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any

from pydantic import SecretStr

from deepeval_eval.core.config import DatabaseSettings

if TYPE_CHECKING:
    from deepeval_eval.db.evaluation_db_manager import EvaluationDBManager
    from deepeval_eval.db.question_db_manager import QuestionDBManager

logger = logging.getLogger(__name__)


class DatabaseManager:
    """Standardized PostgreSQL database manager."""

    def __init__(
        self,
        connection_string: str | SecretStr | DatabaseSettings | None = None,
        db_settings: DatabaseSettings | None = None,
        settings: DatabaseSettings | None = None,
    ):
        if db_settings is None and settings is not None:
            db_settings = settings

        if isinstance(connection_string, DatabaseSettings):
            if db_settings is None:
                db_settings = connection_string
            connection_string = None

        raw_conn = (
            connection_string.get_secret_value()
            if isinstance(connection_string, SecretStr)
            else (str(connection_string) if connection_string is not None else None)
        )
        if (
            raw_conn is None
            and db_settings is not None
            and getattr(db_settings, "connection_string", None)
        ):
            setting_conn = db_settings.connection_string
            raw_conn = (
                setting_conn.get_secret_value()
                if isinstance(setting_conn, SecretStr)
                else (str(setting_conn) if setting_conn is not None else None)
            )
        self._explicit_connection_string = raw_conn
        self._db_settings = db_settings
        self._lock = threading.Lock()
        if self.is_postgres():
            try:
                self.init_db()
            except Exception as exc:
                logger.warning(
                    f"PostgreSQL schema init failed on startup (DB may be unreachable): {exc}"
                )

    @property
    def db_settings(self) -> DatabaseSettings:
        if getattr(self, "_db_settings", None) is not None:
            return self._db_settings
        return DatabaseSettings()

    @property
    def connection_string(self) -> str | None:
        if (
            getattr(self, "_explicit_connection_string", None)
            and self._explicit_connection_string.strip() != ""
        ):
            return self._explicit_connection_string

        settings = self.db_settings
        conn = (
            settings.connection_string.get_secret_value()
            if isinstance(settings.connection_string, SecretStr)
            else (
                str(settings.connection_string) if settings.connection_string else None
            )
        )
        return conn if conn and conn.strip() != "" else None

    @connection_string.setter
    def connection_string(self, val: str | None) -> None:
        self._explicit_connection_string = val

    @property
    def postgres_host(self) -> str | None:
        return self.db_settings.postgres_host

    def is_postgres(self) -> bool:
        conn_str = self.connection_string
        if conn_str:
            return conn_str.startswith("postgresql://") or conn_str.startswith(
                "postgres://"
            )
        return bool(self.postgres_host)

    def get_connection(self) -> Any:
        if not self.is_postgres():
            raise RuntimeError("PostgreSQL database is not configured.")

        import sys

        psycopg2 = sys.modules.get("psycopg2") or __import__("psycopg2")

        conn_str = self.connection_string
        if conn_str:
            return psycopg2.connect(conn_str, connect_timeout=5)

        settings = self.db_settings
        return psycopg2.connect(
            host=settings.postgres_host or "localhost",
            port=settings.postgres_port,
            dbname=settings.postgres_db,
            user=settings.postgres_user,
            password=settings.postgres_password.get_secret_value(),
            sslmode=settings.pgsslmode,
            connect_timeout=5,
        )

    @property
    def questions(self) -> QuestionDBManager:
        from deepeval_eval.db.question_db_manager import QuestionDBManager

        if not hasattr(self, "_questions_db"):
            self._questions_db = QuestionDBManager(self)
        return self._questions_db

    @property
    def evaluation(self) -> EvaluationDBManager:
        from deepeval_eval.db.evaluation_db_manager import EvaluationDBManager

        if not hasattr(self, "_eval_db"):
            self._eval_db = EvaluationDBManager(self)
        return self._eval_db

    @property
    def prompt_styles(self) -> Any:
        from deepeval_eval.db.prompt_db_manager import PromptDBManager

        if not hasattr(self, "_prompt_db"):
            self._prompt_db = PromptDBManager(self)
        return self._prompt_db

    @property
    def metrics(self) -> Any:
        from deepeval_eval.db.metric_db_manager import MetricDBManager

        if not hasattr(self, "_metric_db"):
            self._metric_db = MetricDBManager(self)
        return self._metric_db

    def verify_postgres_connection(self) -> None:
        """Strictly verify PostgreSQL connection and schema initialization; fail loudly on error."""
        if not self.is_postgres():
            raise RuntimeError(
                "PostgreSQL database is required for CAIPE Evaluator service. "
                "Please configure POSTGRES_HOST or DATABASE_URL."
            )
        try:
            conn = self.get_connection()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1;")
            finally:
                if conn is not None and not getattr(conn, "closed", False):
                    conn.close()
            self.init_db()
        except Exception as err:
            raise RuntimeError(f"PostgreSQL verification failed: {err}") from err

    def init_db(self) -> None:
        """Initialize PostgreSQL schema tables if not present."""
        if not self.is_postgres():
            return
        with self._lock:
            try:
                self.evaluation.init_tables()
                self.questions.init_tables()
                self.prompt_styles.init_tables()
                self.metrics.init_tables()
            except Exception as exc:
                logger.warning(f"PostgreSQL schema initialization skipped: {exc}")

    def execute_write(self, query: str, params: tuple[Any, ...]) -> None:
        with self._lock:
            conn = self.get_connection()
            try:
                with conn.cursor() as cur:
                    cur.execute(query, params)
                conn.commit()
            except Exception:
                if conn is not None and hasattr(conn, "rollback"):
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                raise
            finally:
                if conn is not None and not getattr(conn, "closed", False):
                    conn.close()

    def query_all(
        self, query: str, params: tuple[Any, ...] = ()
    ) -> list[dict[str, Any]]:
        with self._lock:
            conn = self.get_connection()
            try:
                from psycopg2.extras import RealDictCursor

                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute(query, params)
                    rows = cur.fetchall()
                    return [dict(row) for row in rows]
            except Exception:
                if conn is not None and hasattr(conn, "rollback"):
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                raise
            finally:
                if conn is not None and not getattr(conn, "closed", False):
                    conn.close()

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from deepeval_eval.db.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class MetricDBManager:
    """PostgreSQL database manager for DeepEval Metrics and Metric Sets with Admin-Managed RBAC."""

    def __init__(self, db_manager: DatabaseManager) -> None:
        self.db_manager = db_manager

    def init_tables(self) -> None:
        """Initialize PostgreSQL schema for eval_metrics, metric_sets, and metric_set_items."""
        if not self.db_manager.is_postgres():
            return

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS eval_metrics (
                        name              VARCHAR(100) PRIMARY KEY,
                        display_name      VARCHAR(200) NOT NULL,
                        description       TEXT,
                        metric_type       VARCHAR(50) NOT NULL DEFAULT 'builtin',
                        metric_class      VARCHAR(100),
                        threshold         FLOAT NOT NULL DEFAULT 0.5,
                        parameters        JSONB DEFAULT '{}'::jsonb,
                        evaluation_params JSONB DEFAULT '[]'::jsonb,
                        criteria          TEXT,
                        evaluation_steps  JSONB DEFAULT '[]'::jsonb,
                        visibility        VARCHAR(20) NOT NULL DEFAULT 'public',
                        owner_id          VARCHAR(100),
                        owner_team        VARCHAR(100),
                        is_system         BOOLEAN NOT NULL DEFAULT false,
                        created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                        updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                    );

                    CREATE INDEX IF NOT EXISTS idx_eval_metrics_type ON eval_metrics(metric_type);
                    CREATE INDEX IF NOT EXISTS idx_eval_metrics_system ON eval_metrics(is_system);

                    CREATE TABLE IF NOT EXISTS metric_sets (
                        name         VARCHAR(100) PRIMARY KEY,
                        display_name VARCHAR(200) NOT NULL,
                        description  TEXT,
                        visibility   VARCHAR(20) NOT NULL DEFAULT 'public',
                        owner_id     VARCHAR(100),
                        owner_team   VARCHAR(100),
                        is_system    BOOLEAN NOT NULL DEFAULT false,
                        created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                        updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
                    );

                    CREATE TABLE IF NOT EXISTS metric_set_items (
                        metric_set_name  VARCHAR(100) NOT NULL REFERENCES metric_sets(name) ON DELETE CASCADE,
                        metric_name      VARCHAR(100) NOT NULL REFERENCES eval_metrics(name) ON DELETE CASCADE,
                        custom_threshold FLOAT,
                        PRIMARY KEY (metric_set_name, metric_name)
                    );
                    """
                )
            conn.commit()
            self._seed_default_metrics_and_sets(conn)
        except Exception as exc:
            conn.rollback()
            logger.exception(f"Failed to initialize metrics database tables: {exc}")
            raise
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def _seed_default_metrics_and_sets(self, conn: Any) -> None:
        """Seed default system metrics and metric sets."""
        from deepeval_eval.engine.metrics import list_builtin_metric_metadata

        default_metrics = list_builtin_metric_metadata()

        with conn.cursor() as cur:
            for item in default_metrics:
                cur.execute(
                    """
                    INSERT INTO eval_metrics (
                        name, display_name, description, metric_type, metric_class,
                        threshold, parameters, evaluation_params, criteria, evaluation_steps,
                        visibility, is_system
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s::jsonb, %s::jsonb, %s, %s::jsonb,
                        'public', true
                    )
                    ON CONFLICT (name) DO NOTHING;
                    """,
                    (
                        item["name"],
                        item["display_name"],
                        item.get("description", ""),
                        item.get("metric_type", "builtin"),
                        item.get("metric_class"),
                        item.get("default_threshold", 0.5),
                        json.dumps({}),
                        json.dumps(
                            ["input", "actual_output", "expected_output"]
                            if item["name"] == "answer_correctness"
                            else []
                        ),
                        "Compare generated output directly with reference."
                        if item["name"] == "answer_correctness"
                        else None,
                        json.dumps(
                            [
                                "Verify factual accuracy against expected output.",
                                "Assess discrepancies or omissions.",
                            ]
                            if item["name"] == "answer_correctness"
                            else []
                        ),
                    ),
                )

            # Seed default metric sets
            cur.execute(
                """
                INSERT INTO metric_sets (name, display_name, description, visibility, is_system)
                VALUES 
                    ('default', 'Default Metrics', 'Standard baseline suite of 12 RAG evaluation metrics', 'public', true),
                    ('rag_core', 'RAG Core Metrics', 'Faithfulness, Relevancy, Answer Correctness, Context Precision and Recall', 'public', true),
                    ('retrieval_fast', 'Fast Retrieval Suite', 'Deterministic MRR, nDCG, Retrieval Recall/Precision, and Exact Match', 'public', true),
                    ('all_available', 'All Available Metrics', 'All built-in DeepEval metrics and deterministic scorers', 'public', true)
                ON CONFLICT (name) DO NOTHING;
                """
            )

            # Seed metric set items
            rag_12_metrics = [
                "answer_relevancy",
                "faithfulness",
                "answer_correctness",
                "contextual_relevancy",
                "contextual_precision",
                "contextual_recall",
                "mrr",
                "ndcg_at_k",
                "retrieval_recall",
                "retrieval_precision",
                "normalized_exact_match",
                "contains_reference",
            ]
            for m_name in rag_12_metrics:
                cur.execute(
                    """
                    INSERT INTO metric_set_items (metric_set_name, metric_name)
                    VALUES ('default', %s)
                    ON CONFLICT DO NOTHING;
                    """,
                    (m_name,),
                )

            rag_core_metrics = [
                ("rag_core", "faithfulness"),
                ("rag_core", "answer_relevancy"),
                ("rag_core", "answer_correctness"),
                ("rag_core", "contextual_precision"),
                ("rag_core", "contextual_recall"),
            ]
            for set_name, metric_name in rag_core_metrics:
                cur.execute(
                    """
                    INSERT INTO metric_set_items (metric_set_name, metric_name)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING;
                    """,
                    (set_name, metric_name),
                )

            retrieval_metrics = [
                ("retrieval_fast", "mrr"),
                ("retrieval_fast", "ndcg_at_k"),
                ("retrieval_fast", "retrieval_recall"),
                ("retrieval_fast", "retrieval_precision"),
                ("retrieval_fast", "normalized_exact_match"),
            ]
            for set_name, metric_name in retrieval_metrics:
                cur.execute(
                    """
                    INSERT INTO metric_set_items (metric_set_name, metric_name)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING;
                    """,
                    (set_name, metric_name),
                )

            for m in default_metrics:
                cur.execute(
                    """
                    INSERT INTO metric_set_items (metric_set_name, metric_name)
                    VALUES ('all_available', %s)
                    ON CONFLICT DO NOTHING;
                    """,
                    (m["name"],),
                )

        conn.commit()

    def get_metric(self, name: str) -> dict[str, Any] | None:
        """Fetch single metric by name."""
        if not self.db_manager.is_postgres():
            return None

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT name, display_name, description, metric_type, metric_class,
                           threshold, parameters, evaluation_params, criteria, evaluation_steps,
                           visibility, owner_id, owner_team, is_system, created_at, updated_at
                    FROM eval_metrics
                    WHERE name = %s;
                    """,
                    (name.strip().lower(),),
                )
                row = cur.fetchone()
                if not row:
                    return None
                return self._row_to_metric_dict(row)
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def list_metrics(
        self,
        metric_type: str | None = None,
        page: int = 1,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], int]:
        """List metrics with pagination."""
        if not self.db_manager.is_postgres():
            return [], 0

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                where_clauses = ["1=1"]
                params: list[Any] = []
                if metric_type:
                    where_clauses.append("metric_type = %s")
                    params.append(metric_type)

                where_sql = " AND ".join(where_clauses)
                cur.execute(
                    f"SELECT COUNT(*) FROM eval_metrics WHERE {where_sql};",
                    tuple(params),
                )
                total = cur.fetchone()[0]

                offset = (page - 1) * limit
                cur.execute(
                    f"""
                    SELECT name, display_name, description, metric_type, metric_class,
                           threshold, parameters, evaluation_params, criteria, evaluation_steps,
                           visibility, owner_id, owner_team, is_system, created_at, updated_at
                    FROM eval_metrics
                    WHERE {where_sql}
                    ORDER BY is_system DESC, name ASC
                    LIMIT %s OFFSET %s;
                    """,
                    tuple(params + [limit, offset]),
                )
                rows = cur.fetchall()
                items = [self._row_to_metric_dict(r) for r in rows]
                return items, total
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def upsert_metric(
        self,
        name: str,
        display_name: str,
        description: str | None = None,
        metric_type: str = "builtin",
        metric_class: str | None = None,
        threshold: float = 0.5,
        parameters: dict[str, Any] | None = None,
        evaluation_params: list[str] | None = None,
        criteria: str | None = None,
        evaluation_steps: list[str] | None = None,
        visibility: str = "public",
        owner_id: str | None = None,
        owner_team: str | None = None,
        is_system: bool = False,
    ) -> dict[str, Any]:
        """Upsert a metric record."""
        if not self.db_manager.is_postgres():
            raise RuntimeError("PostgreSQL is not configured.")

        clean_name = name.strip().lower()
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO eval_metrics (
                        name, display_name, description, metric_type, metric_class,
                        threshold, parameters, evaluation_params, criteria, evaluation_steps,
                        visibility, owner_id, owner_team, is_system, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s::jsonb, %s::jsonb, %s, %s::jsonb,
                        %s, %s, %s, %s, now()
                    )
                    ON CONFLICT (name) DO UPDATE SET
                        display_name = EXCLUDED.display_name,
                        description = EXCLUDED.description,
                        metric_type = EXCLUDED.metric_type,
                        metric_class = EXCLUDED.metric_class,
                        threshold = EXCLUDED.threshold,
                        parameters = EXCLUDED.parameters,
                        evaluation_params = EXCLUDED.evaluation_params,
                        criteria = EXCLUDED.criteria,
                        evaluation_steps = EXCLUDED.evaluation_steps,
                        visibility = EXCLUDED.visibility,
                        owner_team = EXCLUDED.owner_team,
                        updated_at = now()
                    RETURNING name, display_name, description, metric_type, metric_class,
                              threshold, parameters, evaluation_params, criteria, evaluation_steps,
                              visibility, owner_id, owner_team, is_system, created_at, updated_at;
                    """,
                    (
                        clean_name,
                        display_name,
                        description,
                        metric_type,
                        metric_class,
                        threshold,
                        json.dumps(parameters or {}),
                        json.dumps(evaluation_params or []),
                        criteria,
                        json.dumps(evaluation_steps or []),
                        visibility,
                        owner_id,
                        owner_team,
                        is_system,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                return self._row_to_metric_dict(row)
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def delete_metric(self, name: str) -> bool:
        """Delete a custom metric (blocked on is_system=True)."""
        if not self.db_manager.is_postgres():
            return False

        clean_name = name.strip().lower()
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT is_system FROM eval_metrics WHERE name = %s;", (clean_name,)
                )
                row = cur.fetchone()
                if not row:
                    return False
                if row[0]:
                    raise ValueError("System metrics cannot be deleted.")

                cur.execute("DELETE FROM eval_metrics WHERE name = %s;", (clean_name,))
                deleted = cur.rowcount > 0
                conn.commit()
                return deleted
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def get_metric_set(self, name: str) -> dict[str, Any] | None:
        """Fetch single metric set by name."""
        if not self.db_manager.is_postgres():
            return None

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT name, display_name, description, visibility, owner_id, owner_team,
                           is_system, created_at, updated_at
                    FROM metric_sets
                    WHERE name = %s;
                    """,
                    (name.strip().lower(),),
                )
                row = cur.fetchone()
                if not row:
                    return None
                return self._row_to_metric_set_dict(row)
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def get_metric_set_with_metrics(self, name: str) -> dict[str, Any] | None:
        """Fetch metric set along with all bundled metrics."""
        set_rec = self.get_metric_set(name)
        if not set_rec:
            return None

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT m.name, m.display_name, m.description, m.metric_type, m.metric_class,
                           COALESCE(i.custom_threshold, m.threshold) as threshold,
                           m.parameters, m.evaluation_params, m.criteria, m.evaluation_steps,
                           m.visibility, m.owner_id, m.owner_team, m.is_system, m.created_at, m.updated_at
                    FROM metric_set_items i
                    JOIN eval_metrics m ON i.metric_name = m.name
                    WHERE i.metric_set_name = %s
                    ORDER BY m.name ASC;
                    """,
                    (name.strip().lower(),),
                )
                rows = cur.fetchall()
                set_rec["metrics"] = [self._row_to_metric_dict(r) for r in rows]
                return set_rec
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def list_metric_sets(
        self,
        page: int = 1,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], int]:
        """List metric sets with pagination."""
        if not self.db_manager.is_postgres():
            return [], 0

        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM metric_sets;")
                total = cur.fetchone()[0]

                offset = (page - 1) * limit
                cur.execute(
                    """
                    SELECT name, display_name, description, visibility, owner_id, owner_team,
                           is_system, created_at, updated_at
                    FROM metric_sets
                    ORDER BY is_system DESC, name ASC
                    LIMIT %s OFFSET %s;
                    """,
                    (limit, offset),
                )
                rows = cur.fetchall()
                items = [self._row_to_metric_set_dict(r) for r in rows]
                return items, total
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def upsert_metric_set(
        self,
        name: str,
        display_name: str,
        description: str | None = None,
        visibility: str = "public",
        owner_id: str | None = None,
        owner_team: str | None = None,
        is_system: bool = False,
        metrics: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Upsert a metric set and its items."""
        if not self.db_manager.is_postgres():
            raise RuntimeError("PostgreSQL is not configured.")

        clean_name = name.strip().lower()
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO metric_sets (
                        name, display_name, description, visibility, owner_id, owner_team,
                        is_system, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, now()
                    )
                    ON CONFLICT (name) DO UPDATE SET
                        display_name = EXCLUDED.display_name,
                        description = EXCLUDED.description,
                        visibility = EXCLUDED.visibility,
                        owner_team = EXCLUDED.owner_team,
                        updated_at = now()
                    RETURNING name, display_name, description, visibility, owner_id, owner_team,
                              is_system, created_at, updated_at;
                    """,
                    (
                        clean_name,
                        display_name,
                        description,
                        visibility,
                        owner_id,
                        owner_team,
                        is_system,
                    ),
                )
                row = cur.fetchone()

                if metrics is not None:
                    cur.execute(
                        "DELETE FROM metric_set_items WHERE metric_set_name = %s;",
                        (clean_name,),
                    )
                    for m in metrics:
                        m_name = m.get("metric_name") or m.get("name")
                        if m_name:
                            cur.execute(
                                """
                                INSERT INTO metric_set_items (metric_set_name, metric_name, custom_threshold)
                                VALUES (%s, %s, %s)
                                ON CONFLICT (metric_set_name, metric_name) DO UPDATE SET
                                    custom_threshold = EXCLUDED.custom_threshold;
                                """,
                                (
                                    clean_name,
                                    m_name.strip().lower(),
                                    m.get("custom_threshold"),
                                ),
                            )

                conn.commit()
                res = self._row_to_metric_set_dict(row)
                if metrics is not None:
                    res["metrics"] = metrics
                return res
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def delete_metric_set(self, name: str) -> bool:
        """Delete a custom metric set (blocked on is_system=True)."""
        if not self.db_manager.is_postgres():
            return False

        clean_name = name.strip().lower()
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT is_system FROM metric_sets WHERE name = %s;", (clean_name,)
                )
                row = cur.fetchone()
                if not row:
                    return False
                if row[0]:
                    raise ValueError("System metric sets cannot be deleted.")

                cur.execute("DELETE FROM metric_sets WHERE name = %s;", (clean_name,))
                deleted = cur.rowcount > 0
                conn.commit()
                return deleted
        finally:
            if conn is not None and not getattr(conn, "closed", False):
                conn.close()

    def _row_to_metric_dict(self, row: tuple[Any, ...]) -> dict[str, Any]:
        params = row[6]
        if isinstance(params, str):
            params = json.loads(params)
        eval_params = row[7]
        if isinstance(eval_params, str):
            eval_params = json.loads(eval_params)
        eval_steps = row[9]
        if isinstance(eval_steps, str):
            eval_steps = json.loads(eval_steps)

        return {
            "name": row[0],
            "display_name": row[1],
            "description": row[2],
            "metric_type": row[3],
            "metric_class": row[4],
            "threshold": float(row[5]) if row[5] is not None else 0.5,
            "parameters": params or {},
            "evaluation_params": eval_params or [],
            "criteria": row[8],
            "evaluation_steps": eval_steps or [],
            "visibility": row[10] or "public",
            "owner_id": row[11],
            "owner_team": row[12],
            "is_system": bool(row[13]),
            "created_at": str(row[14]) if row[14] else None,
            "updated_at": str(row[15]) if row[15] else None,
        }

    def _row_to_metric_set_dict(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "name": row[0],
            "display_name": row[1],
            "description": row[2],
            "visibility": row[3] or "public",
            "owner_id": row[4],
            "owner_team": row[5],
            "is_system": bool(row[6]),
            "created_at": str(row[7]) if row[7] else None,
            "updated_at": str(row[8]) if row[8] else None,
        }

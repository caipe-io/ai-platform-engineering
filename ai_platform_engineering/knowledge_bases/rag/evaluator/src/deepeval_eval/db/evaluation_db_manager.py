from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from deepeval_eval.db.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class EvaluationDBManager:
    """PostgreSQL database manager for Evaluation jobs, runs, and results."""

    def __init__(self, db_manager: DatabaseManager) -> None:
        self.db_manager = db_manager

    def init_tables(self, conn: Any | None = None) -> None:
        """Initialize PostgreSQL schema tables for evaluation jobs and results."""
        if conn is None and not self.db_manager.is_postgres():
            return

        close_conn = False
        if conn is None:
            conn = self.db_manager.get_connection()
            close_conn = True
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS eval_job_queue (
                        job_id       TEXT PRIMARY KEY,
                        eval_hash    TEXT NOT NULL,
                        status       TEXT NOT NULL,
                        config_json  TEXT NOT NULL,
                        created_at   DOUBLE PRECISION NOT NULL,
                        started_at   DOUBLE PRECISION,
                        completed_at DOUBLE PRECISION,
                        error        TEXT
                    );
                    CREATE TABLE IF NOT EXISTS batches (
                        batch_id    TEXT PRIMARY KEY,
                        created_at  TIMESTAMP NOT NULL DEFAULT now(),
                        description TEXT
                    );
                    CREATE TABLE IF NOT EXISTS runs (
                        run_id       TEXT PRIMARY KEY,
                        batch_id     TEXT NOT NULL,
                        config_name  TEXT NOT NULL,
                        config_json  JSONB,
                        started_at   TIMESTAMP,
                        finished_at  TIMESTAMP,
                        loaded_at    TIMESTAMP NOT NULL DEFAULT now()
                    );
                    CREATE TABLE IF NOT EXISTS eval_results (
                        id         BIGSERIAL PRIMARY KEY,
                        run_id     TEXT NOT NULL,
                        batch_id   TEXT NOT NULL,
                        question   TEXT,
                        row_data   JSONB
                    );
                    CREATE TABLE IF NOT EXISTS run_summary (
                        run_id        TEXT PRIMARY KEY,
                        p50_latency   DOUBLE PRECISION,
                        p95_latency   DOUBLE PRECISION,
                        summary_json  JSONB
                    );
                    CREATE TABLE IF NOT EXISTS evaluation_runs (
                        run_id VARCHAR(255) PRIMARY KEY,
                        dataset_name VARCHAR(255),
                        total_questions INT,
                        completed_questions INT DEFAULT 0,
                        total_duration_seconds FLOAT DEFAULT 0,
                        p50_latency_sec FLOAT DEFAULT 0,
                        p95_latency_sec FLOAT DEFAULT 0,
                        metrics JSONB DEFAULT '{}'::jsonb,
                        failure_causes JSONB DEFAULT '{}'::jsonb,
                        evaluator_usage JSONB DEFAULT '{}'::jsonb,
                        status VARCHAR(50) DEFAULT 'RUNNING',
                        config JSONB DEFAULT '{}'::jsonb,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS evaluation_results (
                        id SERIAL PRIMARY KEY,
                        run_id VARCHAR(255) REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
                        question_id VARCHAR(255),
                        user_input TEXT,
                        actual_input TEXT,
                        reference TEXT,
                        actual_output TEXT,
                        context JSONB,
                        retrieved_contexts JSONB,
                        expected_doc_ids JSONB,
                        retrieved_doc_ids JSONB,
                        metrics JSONB,
                        latency_sec FLOAT,
                        pipeline_usage JSONB,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );
                    ALTER TABLE evaluation_results DROP COLUMN IF EXISTS question;
                    ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS actual_input TEXT;
                    ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS context JSONB;
                    ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS retrieved_contexts JSONB;
                    ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS expected_doc_ids JSONB;
                    ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS retrieved_doc_ids JSONB;
                    DO $$
                    BEGIN
                        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='evaluation_results' AND column_name='contexts') THEN
                            UPDATE evaluation_results SET retrieved_contexts = contexts WHERE retrieved_contexts IS NULL;
                            ALTER TABLE evaluation_results DROP COLUMN contexts;
                        END IF;
                        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='evaluation_results' AND column_name='doc_ids') THEN
                            UPDATE evaluation_results SET retrieved_doc_ids = doc_ids WHERE retrieved_doc_ids IS NULL;
                            ALTER TABLE evaluation_results DROP COLUMN doc_ids;
                        END IF;
                    END $$;
                    CREATE INDEX IF NOT EXISTS idx_eval_job_queue_status_created ON eval_job_queue (status, created_at);
                    CREATE INDEX IF NOT EXISTS idx_eval_job_queue_eval_hash_status ON eval_job_queue (eval_hash, status, created_at);
                    CREATE INDEX IF NOT EXISTS idx_evaluation_results_run_id ON evaluation_results (run_id);
                    """
                )
                cur.execute(
                    "SELECT setval('evaluation_results_id_seq', (SELECT COALESCE(MAX(id), 1) FROM evaluation_results));"
                )
            if close_conn:
                conn.commit()
        except Exception as exc:
            if close_conn and conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.warning(f"EvaluationDBManager schema initialization skipped: {exc}")
            raise
        finally:
            if close_conn and conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def save_job_to_queue(
        self,
        job_id: str,
        eval_hash: str,
        status: str,
        config_json: str,
        created_at: float,
        started_at: float | None = None,
        completed_at: float | None = None,
        error: str | None = None,
    ) -> None:
        """Save a job record to eval_job_queue table in PostgreSQL."""
        if not self.db_manager.is_postgres():
            return
        self.db_manager.execute_write(
            """
            INSERT INTO eval_job_queue (job_id, eval_hash, status, config_json, created_at, started_at, completed_at, error)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (job_id) DO UPDATE SET
                eval_hash = EXCLUDED.eval_hash,
                status = EXCLUDED.status,
                config_json = EXCLUDED.config_json,
                started_at = EXCLUDED.started_at,
                completed_at = EXCLUDED.completed_at,
                error = EXCLUDED.error;
            """,
            (
                job_id,
                eval_hash,
                status,
                config_json,
                created_at,
                started_at,
                completed_at,
                error,
            ),
        )

    def get_cached_job_by_hash(
        self, eval_hash: str, ttl_seconds: int = 86400
    ) -> dict[str, Any] | None:
        """Retrieve a completed evaluation job with matching eval_hash within TTL."""
        if not eval_hash or not self.db_manager.is_postgres():
            return None
        min_created_at = time.time() - ttl_seconds
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT q.job_id, q.eval_hash, q.status, q.config_json, q.created_at, q.completed_at, q.error,
                           r.metrics, r.failure_causes, r.evaluator_usage, r.p50_latency_sec, r.p95_latency_sec,
                           r.total_duration_seconds, r.total_questions, r.completed_questions
                    FROM eval_job_queue q
                    JOIN evaluation_runs r ON q.job_id = r.run_id
                    WHERE q.eval_hash = %s
                      AND q.status = 'completed'
                      AND q.created_at >= %s
                    ORDER BY q.created_at DESC
                    LIMIT 1;
                    """,
                    (eval_hash, min_created_at),
                )
                row = cur.fetchone()
                if not row:
                    return None

                config_args = {}
                if row[3]:
                    try:
                        config_args = (
                            json.loads(row[3]) if isinstance(row[3], str) else row[3]
                        )
                    except Exception:
                        pass

                summary = {}
                if row[7] is not None:
                    summary = {
                        "total_items": row[13] or 0,
                        "evaluation_time_seconds": round(float(row[12] or 0.0), 2),
                        "p50_latency": round(float(row[10] or 0.0), 4),
                        "p95_latency": round(float(row[11] or 0.0), 4),
                        "metrics": row[7] if isinstance(row[7], dict) else {},
                        "failure_causes": row[8] if isinstance(row[8], dict) else {},
                        "deepeval_evaluator_usage": row[9]
                        if isinstance(row[9], dict)
                        else {},
                    }

                results = self.get_job_results_payload(row[0])

                return {
                    "job_id": row[0],
                    "status": row[2],
                    "created_at": float(row[4]) if row[4] else 0.0,
                    "completed_at": float(row[5]) if row[5] else None,
                    "cached": True,
                    "eval_hash": row[1],
                    "evaluation_time": float(row[12] or 0.0),
                    "config_args": config_args,
                    "summary": summary,
                    "results": results,
                    "user_info": config_args.get("user_info"),
                    "error": row[6],
                }
        finally:
            conn.close()

    def get_job_results_payload(self, job_id: str) -> list[dict[str, Any]]:
        """Retrieve evaluation results rows from evaluation_results table for a job_id/run_id."""
        if not job_id or not self.db_manager.is_postgres():
            return []
        conn = self.db_manager.get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT question_id, user_input, reference, actual_output,
                           context, retrieved_contexts, expected_doc_ids, retrieved_doc_ids,
                           metrics, latency_sec, pipeline_usage, actual_input
                    FROM evaluation_results
                    WHERE run_id = %s
                    ORDER BY id ASC;
                    """,
                    (job_id,),
                )
                rows = cur.fetchall()
                if not rows:
                    # Fallback: Check if job_id was a cached job and fetch from source run_id with same eval_hash
                    cur.execute(
                        """
                        SELECT r.question_id, r.user_input, r.reference, r.actual_output,
                               r.context, r.retrieved_contexts, r.expected_doc_ids, r.retrieved_doc_ids,
                               r.metrics, r.latency_sec, r.pipeline_usage, r.actual_input
                        FROM eval_job_queue q
                        JOIN eval_job_queue q_orig ON q.eval_hash = q_orig.eval_hash
                        JOIN evaluation_results r ON q_orig.job_id = r.run_id
                        WHERE q.job_id = %s
                        ORDER BY r.id ASC;
                        """,
                        (job_id,),
                    )
                    rows = cur.fetchall()
                results = []
                for r in rows:
                    q_id = r[0]
                    u_in = r[1]
                    ref = r[2]
                    act_out = r[3]
                    ctx_gt = r[4]
                    ret_ctx = r[5]
                    exp_docs = r[6]
                    ret_docs = r[7]
                    metrics_val = r[8]
                    lat = r[9]
                    pipe_usage = r[10]
                    act_in = r[11] if len(r) > 11 else None
                    ctx_gt_val = (
                        ctx_gt
                        if not isinstance(ctx_gt, str)
                        else (json.loads(ctx_gt) if ctx_gt else None)
                    )
                    ret_ctx_list = (
                        ret_ctx
                        if isinstance(ret_ctx, list)
                        else (json.loads(ret_ctx) if ret_ctx else [])
                    )
                    exp_doc_list = (
                        exp_docs
                        if isinstance(exp_docs, list)
                        else (json.loads(exp_docs) if exp_docs else [])
                    )
                    ret_doc_list = (
                        ret_docs
                        if isinstance(ret_docs, list)
                        else (json.loads(ret_docs) if ret_docs else [])
                    )
                    row_dict: dict[str, Any] = {
                        "question_id": q_id,
                        "user_input": u_in or "",
                        "actual_input": act_in or u_in or "",
                        "reference": ref or "",
                        "actual_output": act_out or "",
                        "context": ctx_gt_val,
                        "retrieved_contexts": ret_ctx_list,
                        "expected_doc_ids": exp_doc_list,
                        "retrieved_doc_ids": ret_doc_list,
                        "latency": float(lat or 0.0),
                    }
                    if metrics_val:
                        m_dict = (
                            metrics_val
                            if isinstance(metrics_val, dict)
                            else json.loads(metrics_val)
                        )
                        row_dict.update(m_dict)
                    if pipe_usage:
                        p_dict = (
                            pipe_usage
                            if isinstance(pipe_usage, dict)
                            else json.loads(pipe_usage)
                        )
                        row_dict["pipeline_usage"] = p_dict
                    results.append(row_dict)
                return results
        finally:
            conn.close()

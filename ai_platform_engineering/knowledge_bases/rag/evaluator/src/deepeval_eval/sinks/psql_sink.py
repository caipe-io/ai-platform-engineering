from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field, SecretStr

from deepeval_eval.db import DatabaseManager

if TYPE_CHECKING:
    from deepeval_eval.core.config import DatabaseSettings

logger = logging.getLogger(__name__)


class PipelineTokenUsage(BaseModel):
    """Token usage metrics for the RAG pipeline generation under test."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class EvaluatorUsage(BaseModel):
    """Token and execution metrics for the DeepEval evaluator judge calls."""

    evaluation_time_seconds: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class RunSummaryPayload(BaseModel):
    """Structured, validated schema for evaluation run summaries persisted to PostgreSQL."""

    experiment_name: str
    datasource: str = "unknown"
    config_args: dict[str, Any] = Field(default_factory=dict)
    p50_latency: float = 0.0
    p95_latency: float = 0.0
    total_tokens: int = 0
    rag_pipeline_token_usage: PipelineTokenUsage = Field(
        default_factory=PipelineTokenUsage
    )
    total_results: int = 0
    metrics: dict[str, float] = Field(default_factory=dict)
    failure_causes: dict[str, int] = Field(default_factory=dict)
    deepeval_evaluator_usage: EvaluatorUsage = Field(default_factory=EvaluatorUsage)


class PostgresResultSink:
    """Persists evaluation run directly to PostgreSQL tables (evaluation_runs & evaluation_results)."""

    def __init__(
        self,
        connection_string: str | Any | None = None,
        db_settings: DatabaseSettings | None = None,
        auto_init: bool = True,
        db_manager: DatabaseManager | Any | None = None,
    ):
        if db_manager is not None:
            self.db_manager = db_manager
        else:
            conn_str = connection_string
            if (
                conn_str is None
                and db_settings is not None
                and db_settings.connection_string
            ):
                raw_conn = db_settings.connection_string
                conn_str = (
                    raw_conn.get_secret_value()
                    if isinstance(raw_conn, SecretStr)
                    else (str(raw_conn) if raw_conn is not None else None)
                )
            self.db_manager = DatabaseManager(
                connection_string=conn_str, db_settings=db_settings
            )
        self.connection_string = self.db_manager.connection_string
        if auto_init and self.db_manager.is_postgres():
            try:
                self.init_db()
            except Exception as exc:
                logger.debug(
                    f"Deferred DB schema initialization on sink creation: {exc}"
                )

    def _get_connection(self) -> Any:
        return self.db_manager.get_connection()

    def query_runs(self, limit: int = 10) -> list[dict[str, Any]]:
        """Query recent evaluation runs stored in evaluation_runs table."""
        if not self.db_manager.is_postgres():
            logger.warning("PostgreSQL is not configured; returning empty runs list.")
            return []

        try:
            from psycopg2.extras import RealDictCursor
        except (ImportError, ModuleNotFoundError):
            logger.warning("psycopg2 is not installed; skipping database query.")
            return []

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT run_id, dataset_name, total_questions, completed_questions,
                           total_duration_seconds, p50_latency_sec, p95_latency_sec,
                           metrics, failure_causes, evaluator_usage, status, config, created_at
                    FROM evaluation_runs
                    ORDER BY created_at DESC
                    LIMIT %s;
                    """,
                    (limit,),
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            if (
                conn is not None
                and hasattr(conn, "close")
                and not getattr(conn, "closed", False)
            ):
                conn.close()

    def query_evaluation_results(self, run_id: str) -> list[dict[str, Any]]:
        """Query per-question evaluation results for a specific run in evaluation_results table."""
        if not self.db_manager.is_postgres():
            return []

        try:
            from psycopg2.extras import RealDictCursor
        except (ImportError, ModuleNotFoundError):
            return []

        conn = None
        try:
            conn = self._get_connection()
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT id, run_id, question_id, user_input, actual_input, reference, actual_output,
                           context, retrieved_contexts, expected_doc_ids, retrieved_doc_ids,
                           metrics, latency_sec, pipeline_usage, created_at
                    FROM evaluation_results
                    WHERE run_id = %s
                    ORDER BY id ASC;
                    """,
                    (run_id,),
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            if (
                conn is not None
                and hasattr(conn, "close")
                and not getattr(conn, "closed", False)
            ):
                conn.close()

    def init_db(self, conn: Any | None = None) -> None:
        """Initialize evaluation_runs and evaluation_results tables via EvaluationDBManager."""
        passed_conn = conn if conn is not None else self._get_connection()
        self.db_manager.evaluation.init_tables(conn=passed_conn)
        if conn is None and passed_conn is not None:
            if hasattr(passed_conn, "commit"):
                try:
                    passed_conn.commit()
                except Exception:
                    pass
            if hasattr(passed_conn, "close") and not getattr(
                passed_conn, "closed", False
            ):
                try:
                    passed_conn.close()
                except Exception:
                    pass

    def save(
        self,
        results_dir: Path,
        prefix: str,
        results: list[dict[str, Any]],
        evaluation_time: float,
        config_args: dict[str, Any],
    ) -> None:
        try:
            from psycopg2.extras import execute_values
        except (ImportError, ModuleNotFoundError):
            logger.warning("psycopg2 is not installed; skipping database persistence.")
            return

        prefix = (
            config_args.get("experiment_name")
            or config_args.get("dataset_name")
            or config_args.get("datasource")
            or prefix
        )
        run_id = (
            config_args.get("run_id") or f"{prefix}_{time.strftime('%Y%m%d-%H%M%S')}"
        )
        dataset_name = (
            config_args.get("dataset_name") or config_args.get("datasource") or prefix
        )

        try:
            conn = self._get_connection()
        except Exception as exc:
            logger.warning(
                f"Failed to connect to database for direct persistence: {exc}"
            )
            return

        try:
            self.init_db(conn)

            from deepeval_eval.sinks.metrics_aggregator import (
                calculate_latency_percentiles,
                categorize_failure_causes,
                compute_all_metric_averages,
            )

            latencies = [
                r.get("latency", 0.0) for r in results if r.get("latency") is not None
            ]
            p50_latency, p95_latency = calculate_latency_percentiles(latencies)
            all_metric_averages = compute_all_metric_averages(results)

            rag_prompt_tokens = 0
            rag_completion_tokens = 0
            evaluator_prompt_tokens = 0
            evaluator_completion_tokens = 0

            for r in results:
                p_tok = r.get("prompt_tokens") or r.get("input_tokens") or 0
                c_tok = (
                    r.get("completion_tokens")
                    or r.get("output_tokens")
                    or r.get("generation_tokens")
                    or 0
                )
                rag_prompt_tokens += p_tok
                rag_completion_tokens += c_tok
                evaluator_prompt_tokens += (
                    r.get("evaluator_prompt_tokens")
                    or r.get("evaluator_input_tokens")
                    or 0
                )
                evaluator_completion_tokens += (
                    r.get("evaluator_completion_tokens")
                    or r.get("evaluator_output_tokens")
                    or 0
                )

            evaluator_usage = {
                "evaluation_time_seconds": evaluation_time,
                "prompt_tokens": evaluator_prompt_tokens,
                "completion_tokens": evaluator_completion_tokens,
                "total_tokens": evaluator_prompt_tokens + evaluator_completion_tokens,
            }
            failure_counts = categorize_failure_causes(results)

            serializable_config = {}
            for k, v in config_args.items():
                if k.startswith("_") or k in ("llm_api_key", "auth_token"):
                    continue
                try:
                    json.dumps(v)
                    serializable_config[k] = v
                except (TypeError, OverflowError):
                    serializable_config[k] = str(v)

            with conn.cursor() as cur:
                # Insert / update evaluation_runs
                cur.execute(
                    """
                    INSERT INTO evaluation_runs (
                        run_id, dataset_name, total_questions, completed_questions,
                        total_duration_seconds, p50_latency_sec, p95_latency_sec,
                        metrics, failure_causes, evaluator_usage, status, config, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (run_id) DO UPDATE SET
                        dataset_name = EXCLUDED.dataset_name,
                        total_questions = EXCLUDED.total_questions,
                        completed_questions = EXCLUDED.completed_questions,
                        total_duration_seconds = EXCLUDED.total_duration_seconds,
                        p50_latency_sec = EXCLUDED.p50_latency_sec,
                        p95_latency_sec = EXCLUDED.p95_latency_sec,
                        metrics = EXCLUDED.metrics,
                        failure_causes = EXCLUDED.failure_causes,
                        evaluator_usage = EXCLUDED.evaluator_usage,
                        status = EXCLUDED.status,
                        config = EXCLUDED.config;
                    """,
                    (
                        run_id,
                        dataset_name,
                        len(results),
                        len(results),
                        evaluation_time,
                        p50_latency,
                        p95_latency,
                        json.dumps(all_metric_averages),
                        json.dumps(failure_counts),
                        json.dumps(evaluator_usage),
                        "COMPLETED",
                        json.dumps(serializable_config),
                    ),
                )

                # Clear old per-question rows for idempotency before re-inserting
                cur.execute(
                    "DELETE FROM evaluation_results WHERE run_id = %s", (run_id,)
                )

                non_metric_keys = {
                    "question_id",
                    "user_input",
                    "actual_input",
                    "reference",
                    "actual_output",
                    "context",
                    "retrieved_contexts",
                    "retrieved_doc_ids",
                    "expected_doc_ids",
                    "latency",
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                    "pipeline_usage",
                    "metrics",
                    "benchmark",
                    "dataset_name",
                    "answer_mode",
                }

                eval_rows = []
                for idx, r in enumerate(results):
                    q_id = str(r.get("question_id") or (idx + 1))
                    user_input = r.get("user_input") or ""
                    actual_input = r.get("actual_input") or user_input
                    reference = r.get("reference") or ""
                    actual_output = r.get("actual_output") or ""
                    context = r.get("context") or ""
                    retrieved_contexts = r.get("retrieved_contexts") or []
                    expected_doc_ids = r.get("expected_doc_ids") or []
                    retrieved_doc_ids = r.get("retrieved_doc_ids") or []
                    latency_sec = float(r.get("latency") or 0.0)

                    row_metrics = {}
                    for k, v in r.items():
                        if k not in non_metric_keys and isinstance(
                            v, (int, float, bool)
                        ):
                            row_metrics[k] = v

                    if "category" in r and r["category"]:
                        row_metrics["category"] = r["category"]
                    if "level" in r and r["level"]:
                        row_metrics["level"] = r["level"]
                    if "log_file" in r and r["log_file"]:
                        row_metrics["log_file"] = r["log_file"]
                    if "failure_cause" in r and r["failure_cause"]:
                        row_metrics["failure_cause"] = r["failure_cause"]
                    if "evaluator_prompt_tokens" in r:
                        row_metrics["evaluator_prompt_tokens"] = r[
                            "evaluator_prompt_tokens"
                        ]
                    if "evaluator_completion_tokens" in r:
                        row_metrics["evaluator_completion_tokens"] = r[
                            "evaluator_completion_tokens"
                        ]
                    if "evaluator_total_tokens" in r:
                        row_metrics["evaluator_total_tokens"] = r[
                            "evaluator_total_tokens"
                        ]

                    pipe_usage = r.get("pipeline_usage")
                    if not pipe_usage:
                        p_tok = r.get("input_tokens") or 0
                        c_tok = r.get("output_tokens") or 0
                        t_tok = r.get("total_tokens") or (p_tok + c_tok)
                        pipe_usage = {
                            "prompt_tokens": p_tok,
                            "completion_tokens": c_tok,
                            "total_tokens": t_tok,
                        }

                    eval_rows.append(
                        (
                            run_id,
                            q_id,
                            user_input,
                            actual_input,
                            reference,
                            actual_output,
                            json.dumps(context),
                            json.dumps(retrieved_contexts),
                            json.dumps(expected_doc_ids),
                            json.dumps(retrieved_doc_ids),
                            json.dumps(row_metrics),
                            latency_sec,
                            json.dumps(pipe_usage),
                        )
                    )

                execute_values(
                    cur,
                    """
                    INSERT INTO evaluation_results (
                        run_id, question_id, user_input, actual_input, reference, actual_output,
                        context, retrieved_contexts, expected_doc_ids, retrieved_doc_ids,
                        metrics, latency_sec, pipeline_usage
                    ) VALUES %s
                    """,
                    eval_rows,
                    template="(%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s::jsonb)",
                )

                conn.commit()
            logger.info(
                f"Persisted run '{run_id}' ({len(results)} rows) to PostgreSQL evaluation_runs & evaluation_results."
            )
        except Exception:
            if conn is not None and hasattr(conn, "rollback"):
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.exception("Failed to insert eval results into database.")
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

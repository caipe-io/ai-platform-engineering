from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from deepeval_eval.api.auth import (
    RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE,
    UserContext,
    sync_authorize_agent_subject,
    sync_authorize_datasource_subject,
    sync_authorize_evaluate_subject,
    sync_authorize_question_set_subject,
)
from deepeval_eval.api.job_queue import DatabaseManager, PersistentJobQueue
from deepeval_eval.api.telemetry import telemetry_metrics
from deepeval_eval.auth.obo_exchange import (
    OboExchangeError,
    exchange_token_for_user,
    is_obo_enabled,
)
from deepeval_eval.core.config import (
    DEFAULT_DATA_DIR,
    DEFAULT_GATE_CONFIG,
    DEFAULT_RESULTS_DIR,
    EvalConfig,
    get_eval_config,
    get_job_purge_rate,
    get_max_in_memory_jobs,
)
from deepeval_eval.core.io_utils import sanitize_path
from deepeval_eval.engine.eval_engine import (
    _build_rag_client,
    run_evaluation,
)
from deepeval_eval.sinks import PostgresResultSink, ResultSink

logger = logging.getLogger(__name__)

# Server-level configuration read from EvalConfig singleton at startup
SERVER_PROMPT_CONFIG: Path | None = (
    get_eval_config().prompt_config.resolve()
    if get_eval_config().prompt_config
    else None
)


def validate_safe_path(user_path: str | Path | None) -> Path | None:
    """Validate that specified file path resides strictly within approved sandbox directories."""
    if not user_path:
        return None
    path_obj = Path(user_path).expanduser().resolve()
    allowed_roots = [
        Path(tempfile.gettempdir()).resolve(),
        DEFAULT_DATA_DIR.resolve(),
        (DEFAULT_DATA_DIR.parent / "evals").resolve(),
    ]
    is_safe = any(
        path_obj == root or root in path_obj.parents for root in allowed_roots
    )
    if not is_safe:
        raise HTTPException(
            status_code=400,
            detail=f"Access to file path '{user_path}' is restricted: path is outside allowed sandbox directories.",
        )
    return path_obj


def sanitize_config_args(config_dict: dict[str, Any]) -> dict[str, Any]:
    """Sanitize configuration fields to prevent credential leakage in outputs."""
    sensitive_keys = {
        "llm_api_key",
        "auth_token",
        "client_secret",
        "db_connection_string",
    }
    path_keys = {"questions_file", "results_dir", "log_file"}
    sanitized = {}
    for k, v in config_dict.items():
        if k in sensitive_keys or v is None:
            continue
        if k in path_keys and isinstance(v, str):
            sanitized[k] = sanitize_path(v)
        else:
            sanitized[k] = v
    return sanitized


def compute_eval_hash(
    config_dict: dict[str, Any], dataset_bytes: bytes | None = None
) -> str:
    """Compute a deterministic UUID (v5-style) fingerprint for evaluation parameters.

    Returns a canonical UUID string derived from the SHA-256 digest of the
    normalised config. Using UUID format ensures eval_hash is path-safe and
    consistent with job_id, allowing the same uuid.UUID() sanitiser to be
    applied to both when constructing cache file paths.
    """
    hash_obj = hashlib.sha256()

    # Filter out transient non-config keys, ephemeral tempfiles, and submitter metadata to allow global parameter caching
    ignored_keys = {
        "force_rerun",
        "llm_api_key",
        "auth_token",
        "client_secret",
        "db_connection_string",
        "questions_file",
        "submitter_subject",
        "submitter_email",
        "submitter_role",
        "owner_team",
        "visibility",
    }
    normalized_config = {
        k: str(v)
        for k, v in sorted(config_dict.items())
        if v is not None and k not in ignored_keys
    }
    hash_obj.update(json.dumps(normalized_config, sort_keys=True).encode("utf-8"))

    if dataset_bytes:
        hash_obj.update(dataset_bytes)

    # Use first 16 bytes of SHA-256 digest as UUID bytes for a stable, path-safe identifier
    return str(uuid.UUID(bytes=hash_obj.digest()[:16]))


def _build_job_summary(
    results: list[dict[str, Any]], eval_time: float
) -> dict[str, Any]:
    """Compute metrics aggregation stats and summary for job output."""
    from deepeval_eval.sinks import (
        calculate_latency_percentiles,
        categorize_failure_causes,
        compute_all_metric_averages,
    )

    latencies = [r.get("latency", 0.0) for r in results if "latency" in r]
    p50_latency, p95_latency = calculate_latency_percentiles(latencies)
    total_tokens_sum = sum(r.get("total_tokens", 0) for r in results)
    all_metric_averages = compute_all_metric_averages(results)
    failure_counts = categorize_failure_causes(results)

    evaluator_prompt_tokens = sum(
        r.get("evaluator_prompt_tokens") or r.get("evaluator_input_tokens") or 0
        for r in results
    )
    evaluator_completion_tokens = sum(
        r.get("evaluator_completion_tokens") or r.get("evaluator_output_tokens") or 0
        for r in results
    )
    evaluator_total_tokens = evaluator_prompt_tokens + evaluator_completion_tokens

    return {
        "total_items": len(results),
        "evaluation_time_seconds": round(eval_time, 2),
        "p50_latency": round(p50_latency, 4),
        "p95_latency": round(p95_latency, 4),
        "total_tokens": total_tokens_sum,
        "metrics": all_metric_averages,
        "failure_causes": failure_counts,
        "deepeval_evaluator_usage": {
            "evaluation_time_seconds": round(eval_time, 2),
            "prompt_tokens": evaluator_prompt_tokens,
            "completion_tokens": evaluator_completion_tokens,
            "total_tokens": evaluator_total_tokens,
        },
    }


class JobManager:
    """In-memory state machine and manager for background evaluation jobs."""

    def __init__(
        self,
        db_manager: DatabaseManager,
        max_in_memory_jobs: int | None = None,
        purge_rate: float | None = None,
    ):
        self.jobs: dict[str, dict[str, Any]] = {}
        self.hash_to_job_id: dict[str, str] = {}
        self.db_manager = db_manager
        self.MAX_IN_MEMORY_JOBS = (
            max_in_memory_jobs
            if max_in_memory_jobs is not None
            else get_max_in_memory_jobs()
        )
        self.purge_rate = purge_rate if purge_rate is not None else get_job_purge_rate()
        self._lock = threading.Lock()

    def create_job(
        self,
        eval_hash: str,
        config_dict: dict[str, Any],
        force_rerun: bool = False,
        user: UserContext | None = None,
    ) -> dict[str, Any]:
        from deepeval_eval.api.evaluation_jobs import JobStatusEnum

        user_info = (
            {
                "subject": user.subject,
                "email": user.email,
                "role": user.role,
                "client_id": user.client_id,
            }
            if user
            else None
        )
        with self._lock:
            # Evict oldest finished jobs if in-memory limit is reached (purge configurable % of MAX_IN_MEMORY_JOBS)
            if len(self.jobs) >= self.MAX_IN_MEMORY_JOBS:
                finished_ids = [
                    jid
                    for jid, j in self.jobs.items()
                    if j["status"] in (JobStatusEnum.COMPLETED, JobStatusEnum.FAILED)
                ]
                purge_count = max(1, int(self.MAX_IN_MEMORY_JOBS * self.purge_rate))
                for jid in finished_ids[:purge_count]:
                    evicted_job = self.jobs.pop(jid, None)
                    if (
                        evicted_job
                        and evicted_job.get("eval_hash") in self.hash_to_job_id
                    ):
                        del self.hash_to_job_id[evicted_job["eval_hash"]]

            # Check cache deduplication first (PostgreSQL-backed)
            if not force_rerun:
                cached_data = self.db_manager.evaluation.get_cached_job_by_hash(
                    eval_hash, ttl_seconds=86400
                )
                if cached_data:
                    telemetry_metrics.record_cache_hit()
                    cached_results = cached_data.get("results") or []
                    cached_summary = cached_data.get("summary") or {}
                    if not cached_summary and cached_results:
                        cached_summary = _build_job_summary(
                            cached_results, cached_data.get("evaluation_time", 0.0)
                        )
                    # Create dedicated unique job_id owned by current caller, populated from cache
                    job_id = str(uuid.uuid4())
                    now = time.time()
                    sanitized_config = sanitize_config_args(config_dict)
                    cached_job = {
                        "job_id": job_id,
                        "status": JobStatusEnum.COMPLETED,
                        "created_at": now,
                        "completed_at": now,
                        "cached": True,
                        "eval_hash": eval_hash,
                        "evaluation_time": cached_data.get("evaluation_time", 0.0),
                        "config_args": sanitized_config,
                        "summary": cached_summary,
                        "results": cached_results,
                        "user_info": user_info,
                        "error": None,
                    }
                    self.jobs[job_id] = cached_job
                    self.hash_to_job_id[eval_hash] = job_id
                    try:
                        self.db_manager.evaluation.save_job_to_queue(
                            job_id=job_id,
                            eval_hash=eval_hash,
                            status="completed",
                            config_json=json.dumps(sanitized_config),
                            created_at=now,
                            started_at=now,
                            completed_at=now,
                            error=None,
                        )
                        # Fully persist self-contained run and per-question results under the new job_id
                        if cached_results and self.db_manager.is_postgres():
                            sink = PostgresResultSink(db_manager=self.db_manager)
                            sink_config = dict(sanitized_config)
                            sink_config["run_id"] = job_id
                            sink.save(
                                results_dir=DEFAULT_RESULTS_DIR,
                                prefix=job_id,
                                results=cached_results,
                                evaluation_time=cached_data.get("evaluation_time", 0.0),
                                config_args=sink_config,
                            )
                    except Exception as q_err:
                        logger.warning(
                            "Failed saving cached job to DB tables: %s", q_err
                        )
                    return cached_job

            telemetry_metrics.record_cache_miss()

            job_id = str(uuid.uuid4())
            job = {
                "job_id": job_id,
                "status": JobStatusEnum.PENDING,
                "created_at": time.time(),
                "completed_at": None,
                "cached": False,
                "eval_hash": eval_hash,
                "evaluation_time": 0.0,
                "config_args": sanitize_config_args(config_dict),
                "summary": {},
                "results": [],
                "user_info": user_info,
                "error": None,
            }
            self.jobs[job_id] = job
            self.hash_to_job_id[eval_hash] = job_id
            return job

    def update_job(self, job_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Thread-safely update fields on an existing job."""
        with self._lock:
            job = self.jobs.get(job_id)
            if job:
                job.update(updates)
                return dict(job)
            return None

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self.jobs.get(job_id)
            if job:
                db_job = persistent_job_queue.get_job(job_id)
                if db_job:
                    job["status"] = db_job["status"]
                    if db_job.get("started_at"):
                        job["started_at"] = db_job["started_at"]
                    if db_job.get("completed_at"):
                        job["completed_at"] = db_job["completed_at"]
                    if db_job.get("error"):
                        job["error"] = db_job["error"]
                return dict(job)
        db_job = persistent_job_queue.get_job(job_id)
        if db_job:
            return {
                "job_id": job_id,
                "status": db_job["status"],
                "created_at": db_job.get("created_at", time.time()),
                "completed_at": db_job.get("completed_at"),
                "cached": False,
                "eval_hash": db_job.get("eval_hash", ""),
                "evaluation_time": 0.0,
                "config_args": db_job.get("config_args", {}),
                "summary": {},
                "results": [],
                "user_info": None,
                "error": db_job.get("error"),
            }
        return None

    def list_jobs(
        self, allowed_ids: list[str] | None = None, user_email: str | None = None
    ) -> list[dict[str, Any]]:
        with self._lock:
            local_jobs = {j["job_id"]: dict(j) for j in self.jobs.values()}
        db_jobs = persistent_job_queue.list_jobs(
            allowed_ids=allowed_ids, user_email=user_email
        )
        for dj in db_jobs:
            jid = dj["job_id"]
            if jid in local_jobs:
                local_jobs[jid]["status"] = dj["status"]
                if dj.get("completed_at"):
                    local_jobs[jid]["completed_at"] = dj["completed_at"]
                if dj.get("error"):
                    local_jobs[jid]["error"] = dj["error"]
            else:
                local_jobs[jid] = {
                    "job_id": jid,
                    "status": dj["status"],
                    "created_at": dj.get("created_at", time.time()),
                    "completed_at": dj.get("completed_at"),
                    "cached": False,
                    "eval_hash": dj.get("eval_hash", ""),
                    "evaluation_time": 0.0,
                    "config_args": dj.get("config_args", {}),
                    "summary": {},
                    "results": [],
                    "user_info": None,
                    "error": dj.get("error"),
                }

        if allowed_ids is not None:
            allowed_set = set(allowed_ids)
            filtered_jobs = [j for jid, j in local_jobs.items() if jid in allowed_set]
            if not allowed_set and user_email:
                filtered_jobs = [
                    j
                    for j in local_jobs.values()
                    if (
                        j.get("config_args", {}).get("user_info", {}).get("email")
                        == user_email
                        or j.get("config_args", {}).get("created_by") == user_email
                        or j.get("config_args", {}).get("visibility") == "public"
                    )
                ]
            return sorted(filtered_jobs, key=lambda j: j["created_at"], reverse=True)

        return sorted(
            list(local_jobs.values()), key=lambda j: j["created_at"], reverse=True
        )

    def get_job_results_payload(self, job_id: str) -> list[dict[str, Any]]:
        with self._lock:
            job = self.jobs.get(job_id)
            if job and job.get("results"):
                return job["results"]
        return self.db_manager.evaluation.get_job_results_payload(job_id)


# Global instances initialized
db_manager = DatabaseManager()
job_manager = JobManager(db_manager)
persistent_job_queue = PersistentJobQueue(db_manager)


def execute_evaluation_job(
    job_id: str,
    req: Any,
    temp_file_path: str | None = None,
    user_subject: str | None = None,
    user_token: str | None = None,
) -> None:
    from deepeval_eval.api.evaluation_jobs import JobStatusEnum

    job = job_manager.get_job(job_id)
    if not job:
        return

    logger.info(
        f"Starting evaluation job '{job_id}' (dataset: {req.dataset_name}, max_items: {req.max_items})"
    )
    job_manager.update_job(job_id, {"status": JobStatusEnum.RUNNING})
    start_time = time.time()

    try:
        raw_qfile = getattr(req, "questions_file", None) or temp_file_path
        q_file = validate_safe_path(raw_qfile) if raw_qfile else None
        p_config = SERVER_PROMPT_CONFIG
        results_dir = DEFAULT_RESULTS_DIR
        g_config = DEFAULT_GATE_CONFIG

        q_ids_str = (
            ",".join(req.question_ids)
            if isinstance(req.question_ids, list)
            else req.question_ids
        )
        q_idx_str = (
            ",".join(str(i) for i in req.question_indices)
            if isinstance(req.question_indices, list)
            else req.question_indices
        )

        eval_config = EvalConfig(
            dataset_name=req.dataset_name,
            question_set_id=req.question_set_id,
            answer_mode=req.answer_mode,
            datasource_id=req.datasource_id,
            data_dir=DEFAULT_DATA_DIR,
            questions_file=q_file,
            prompt_style=req.prompt_style,
            prompt_config=p_config,
            prompt_args=req.prompt_args,
            metric_set=req.metric_set,
            metrics=req.metrics,
            max_items=req.max_items,
            limit_per_category=req.limit_per_category,
            top_k=req.top_k,
            max_context_chars=req.max_context_chars,
            llm_model=req.llm_model,
            agentic=req.agentic,
            agent_id=req.agent_id,
            fail_on_error=req.fail_on_error,
            oracle_retrieval=req.oracle_retrieval,
            oracle_testing=req.oracle_testing,
            gate=req.gate,
            gate_config=g_config,
            results_dir=results_dir,
            question_ids=q_ids_str,
            question_indices=q_idx_str,
            run_id=job_id,
            experiment_name=req.experiment_name,
            dynamic_tool=req.dynamic_tool,
            semantic_weight=req.semantic_weight,
            extra_filters=req.extra_filters,
            tool_description=req.tool_description,
        )
        if user_subject:
            setattr(eval_config, "submitter_subject", user_subject)
        if user_token:
            setattr(eval_config, "user_token", user_token)

        ctx: Any = contextlib.nullcontext()
        if eval_config.dynamic_tool:
            from deepeval_eval.clients.mcp_tool_manager import DynamicMCPToolManager
            from deepeval_eval.clients.search_rag import build_search_rag_client

            crud_rag_client = build_search_rag_client(
                eval_config.caipe,
                user_subject=user_subject,
                user_token=user_token,
            )
            run_id = eval_config.run_id or job_id
            tool_mgr = DynamicMCPToolManager(
                rag_client=crud_rag_client,
                run_id=run_id,
                datasource_ids=[eval_config.datasource_id]
                if eval_config.datasource_id
                else [],
                semantic_weight=eval_config.semantic_weight,
                extra_filters=eval_config.extra_filters,
                description=eval_config.tool_description or "",
            )
            eval_config.search_tool_name = tool_mgr.tool_id
            if (
                hasattr(eval_config, "agentic_settings")
                and eval_config.agentic_settings
            ):
                eval_config.agentic_settings.search_tool_name = tool_mgr.tool_id
            ctx = tool_mgr

        eval_sinks: list[ResultSink] = []
        try:
            eval_sinks.append(PostgresResultSink(db_manager=db_manager))
        except Exception as db_err:
            logger.warning(
                f"PostgresResultSink initialization for job '{job_id}' failed: {db_err}"
            )

        with ctx:
            rag_client = _build_rag_client(eval_config, db_manager=db_manager)
            results = run_evaluation(
                eval_config, rag_client=rag_client, sinks=eval_sinks
            )

        end_time = time.time()
        eval_time = end_time - start_time
        telemetry_metrics.record_evaluation(eval_time)

        summary = _build_job_summary(results, eval_time)

        job_manager.update_job(
            job_id,
            {
                "status": JobStatusEnum.COMPLETED,
                "completed_at": end_time,
                "evaluation_time": eval_time,
                "results": results,
                "summary": summary,
            },
        )
        logger.info(
            f"Completed evaluation job '{job_id}' in {eval_time:.2f}s with {len(results)} evaluated items."
        )

    except Exception as e:
        job_manager.update_job(
            job_id,
            {
                "status": JobStatusEnum.FAILED,
                "completed_at": time.time(),
                "error": str(e),
            },
        )
        raise
    finally:
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
                parent_dir = Path(temp_file_path).parent.resolve()
                system_temp = Path(tempfile.gettempdir()).resolve()
                if (
                    parent_dir.exists()
                    and (system_temp in parent_dir.parents or parent_dir == system_temp)
                    and parent_dir.name.startswith("eval_")
                ):
                    shutil.rmtree(parent_dir, ignore_errors=True)
            except Exception as cleanup_err:
                logger.warning(
                    f"Failed to clean up temporary upload directory: {cleanup_err}"
                )


def _run_queued_evaluation(job_id: str, raw_config: dict[str, Any]) -> None:
    """Task executor callback for PersistentJobQueue worker threads."""
    from deepeval_eval.api.evaluation_jobs import EvaluationRequest

    temp_file_path: Path | None = None
    try:
        subject = raw_config.get("submitter_subject")
        submitter_role = raw_config.get("submitter_role")

        # 1. JIT authorization check: verify submitter still holds evaluator and resource permissions
        if subject:
            if not sync_authorize_evaluate_subject(subject, role=submitter_role):
                logger.warning(
                    f"Job {job_id} aborted: submitter {subject} no longer holds can_evaluate permission."
                )
                raise PermissionError(
                    f"EVAL_AUTHZ_REVOKED: Submitter permission revoked since submission for subject={subject}"
                )

            target_agent_id = raw_config.get("agent_id")
            if target_agent_id and not sync_authorize_agent_subject(
                subject, target_agent_id, role=submitter_role
            ):
                logger.warning(
                    f"Job {job_id} aborted: submitter {subject} no longer holds access to agent '{target_agent_id}'."
                )
                raise PermissionError(
                    f"EVAL_AUTHZ_REVOKED: Submitter access to agent '{target_agent_id}' revoked since submission for subject={subject}"
                )

            target_ds_id = raw_config.get("datasource_id")
            if target_ds_id and not sync_authorize_datasource_subject(
                subject, target_ds_id, role=submitter_role
            ):
                logger.warning(
                    f"Job {job_id} aborted: submitter {subject} no longer holds access to datasource '{target_ds_id}'."
                )
                raise PermissionError(
                    f"EVAL_AUTHZ_REVOKED: Submitter access to datasource '{target_ds_id}' revoked since submission for subject={subject}"
                )

            target_qset_id = raw_config.get("question_set_id")
            if target_qset_id and not sync_authorize_question_set_subject(
                subject, target_qset_id, role=submitter_role
            ):
                logger.warning(
                    f"Job {job_id} aborted: submitter {subject} no longer holds access to question set '{target_qset_id}'."
                )
                raise PermissionError(
                    f"EVAL_AUTHZ_REVOKED: Submitter access to question set '{target_qset_id}' revoked since submission for subject={subject}"
                )

        # 2. OBO token exchange for user submissions when enabled
        user_token: str | None = None
        is_m2m = submitter_role == RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE
        if is_obo_enabled() and subject and not is_m2m:
            try:
                user_token = exchange_token_for_user(subject)
                logger.info(
                    "Acquired OBO delegated bearer token for job=%s (subject=%s)",
                    job_id,
                    subject,
                )
            except OboExchangeError as exc:
                logger.exception(
                    "Job %s OBO token exchange failed for subject %s", job_id, subject
                )
                raise PermissionError(
                    f"EVAL_OBO_FAILED: Cannot obtain delegated user token for submitter {subject}: {exc}"
                ) from exc

        q_file_str = raw_config.get("questions_file")
        if q_file_str:
            temp_file_path = Path(q_file_str)

        req = EvaluationRequest(
            **{
                k: v
                for k, v in raw_config.items()
                if k in EvaluationRequest.model_fields
            }
        )
        execute_evaluation_job(
            job_id,
            req,
            temp_file_path=str(temp_file_path) if temp_file_path else None,
            user_subject=subject,
            user_token=user_token,
        )
    finally:
        if temp_file_path and temp_file_path.exists():
            try:
                parent_dir = temp_file_path.parent.resolve()
                system_temp = Path(tempfile.gettempdir()).resolve()
                if (
                    parent_dir.exists()
                    and (system_temp in parent_dir.parents or parent_dir == system_temp)
                    and parent_dir.name.startswith("eval_")
                ):
                    shutil.rmtree(parent_dir, ignore_errors=True)
                else:
                    temp_file_path.unlink(missing_ok=True)
            except Exception as cleanup_err:
                logger.warning(
                    f"Failed to clean up temporary upload directory in queued task: {cleanup_err}"
                )


persistent_job_queue.set_task_executor(_run_queued_evaluation)

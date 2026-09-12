from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Response,
)
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from deepeval_eval.api.auth import (
    UserContext,
    authorize_evaluation_access,
    get_current_user,
)
from deepeval_eval.api.evaluation_jobs import (
    USER_INFO_FIELD_DESCRIPTION,
    JobStatusEnum,
)
from deepeval_eval.api.job_manager import (
    _build_job_summary,
    db_manager,
    job_manager,
)
from deepeval_eval.core.config import DEFAULT_RESULTS_DIR
from deepeval_eval.sinks import PostgresResultSink
from deepeval_eval.sinks.file_sink import format_results_as_csv

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Evaluation Results"])


# ---------------------------------------------------------------------------
# Pydantic Request & Response Models (DTOs)
# ---------------------------------------------------------------------------


class EvaluationResultsResponse(BaseModel):
    job_id: str
    status: JobStatusEnum
    created_at: float
    completed_at: float | None = None
    cached: bool = False
    eval_hash: str
    evaluation_time: float = 0.0
    config_args: dict[str, Any] = Field(default_factory=dict)
    summary: dict[str, Any] = Field(default_factory=dict)
    results: list[dict[str, Any]] = Field(default_factory=list)
    user_info: dict[str, Any] | None = Field(
        default=None, description=USER_INFO_FIELD_DESCRIPTION
    )


class EvaluationSummaryResponse(BaseModel):
    job_id: str
    status: JobStatusEnum
    created_at: float
    completed_at: float | None = None
    cached: bool = False
    eval_hash: str
    evaluation_time: float = 0.0
    config_args: dict[str, Any] = Field(default_factory=dict)
    summary: dict[str, Any] = Field(default_factory=dict)
    user_info: dict[str, Any] | None = Field(
        default=None, description=USER_INFO_FIELD_DESCRIPTION
    )


# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------


def format_summary_as_csv(job_id: str, job_data: dict[str, Any]) -> str:
    """Format evaluation summary metadata and aggregated metrics into CSV string representation."""
    import csv
    import io

    output = io.StringIO()
    writer = csv.writer(output)

    summary = job_data.get("summary", {})
    metrics = summary.get("metrics", {})

    headers = [
        "job_id",
        "status",
        "evaluation_time_seconds",
        "total_items",
        "p50_latency",
        "p95_latency",
        "total_tokens",
    ] + list(metrics.keys())

    values = [
        job_id,
        job_data.get("status", ""),
        job_data.get("evaluation_time", 0.0),
        summary.get("total_items", 0),
        summary.get("p50_latency", 0.0),
        summary.get("p95_latency", 0.0),
        summary.get("total_tokens", 0),
    ] + [metrics[k] for k in metrics]

    writer.writerow(headers)
    writer.writerow(values)
    return output.getvalue()


# ---------------------------------------------------------------------------
# Route Handlers
# ---------------------------------------------------------------------------


@router.get(
    "/jobs/{job_id}/results",
    summary="Get Evaluation Job Results",
    responses={
        400: {
            "description": "Bad Request - Job is not completed or unsupported format requested"
        },
        404: {"description": "Not Found - Job with specified ID does not exist"},
        500: {"description": "Internal Server Error - Job execution failed"},
    },
)
async def get_job_results(
    job_id: str,
    format: str = Query("json", description="Output format: 'json' or 'csv'"),
    user: UserContext = Depends(get_current_user),
) -> Any:
    """Retrieve evaluation results for a completed job in JSON or CSV format."""
    await authorize_evaluation_access(user, job_id, "read")
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

    if job["status"] == JobStatusEnum.FAILED:
        raise HTTPException(
            status_code=500,
            detail=f"Job '{job_id}' failed with error: {job.get('error')}",
        )

    if job["status"] != JobStatusEnum.COMPLETED:
        raise HTTPException(
            status_code=400,
            detail=f"Job '{job_id}' is still in status '{job['status']}'",
        )

    results = job_manager.get_job_results_payload(job_id)

    requested_format = format.lower()
    if requested_format not in ("json", "csv"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{format}'. Supported: 'json', 'csv'.",
        )

    if requested_format == "csv":
        datasource = job.get("config_args", {}).get("dataset_name", "enterprise")
        evaluation_time = job.get("evaluation_time", 0.0)
        csv_content = format_results_as_csv(
            results=results,
            evaluation_time=evaluation_time,
            datasource=datasource,
        )
        headers = {
            "Content-Disposition": f"attachment; filename=job_{job_id}_results.csv"
        }

        def generate_csv_chunks() -> Iterator[bytes]:
            yield csv_content.encode("utf-8")

        return StreamingResponse(
            generate_csv_chunks(),
            media_type="text/csv",
            headers=headers,
        )

    job_data = dict(job)
    safe_results = results or []
    if safe_results and (
        not job_data.get("summary") or "metrics" not in job_data.get("summary", {})
    ):
        job_data["summary"] = _build_job_summary(
            safe_results, job.get("evaluation_time", 0.0)
        )

    def generate_json_chunks() -> Iterator[bytes]:
        meta = {
            "job_id": job_data.get("job_id"),
            "status": job_data.get("status"),
            "created_at": job_data.get("created_at"),
            "completed_at": job_data.get("completed_at"),
            "cached": job_data.get("cached", False),
            "eval_hash": job_data.get("eval_hash", ""),
            "evaluation_time": job_data.get("evaluation_time", 0.0),
            "config_args": job_data.get("config_args", {}),
            "summary": job_data.get("summary", {}),
            "user_info": job_data.get("user_info"),
        }
        safe_meta = jsonable_encoder(meta)
        meta_json = json.dumps(safe_meta, ensure_ascii=False)
        prefix = (
            meta_json[:-1] + ',"results":['
            if meta_json.endswith("}")
            else meta_json + ',"results":['
        )
        yield prefix.encode("utf-8")

        for idx, item in enumerate(safe_results):
            chunk = ("," if idx > 0 else "") + json.dumps(
                item, ensure_ascii=False, default=str
            )
            yield chunk.encode("utf-8")

        yield b"]}"

    return StreamingResponse(
        generate_json_chunks(),
        media_type="application/json",
    )


@router.get(
    "/jobs/{job_id}/summary",
    summary="Get Evaluation Job Summary Only",
    responses={
        400: {
            "description": "Bad Request - Job is not completed or unsupported format requested"
        },
        404: {"description": "Not Found - Job with specified ID does not exist"},
        500: {"description": "Internal Server Error - Job execution failed"},
    },
)
async def get_job_summary(
    job_id: str,
    format: str = Query("json", description="Output format: 'json' or 'csv'"),
    user: UserContext = Depends(get_current_user),
) -> Any:
    """Retrieve only the summary metadata and aggregated metrics for a completed job in JSON or CSV format."""
    await authorize_evaluation_access(user, job_id, "read")
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

    if job["status"] == JobStatusEnum.FAILED:
        raise HTTPException(
            status_code=500,
            detail=f"Job '{job_id}' failed with error: {job.get('error')}",
        )

    if job["status"] != JobStatusEnum.COMPLETED:
        raise HTTPException(
            status_code=400,
            detail=f"Job '{job_id}' is still in status '{job['status']}'",
        )

    requested_format = format.lower()
    if requested_format not in ("json", "csv"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{format}'. Supported: 'json', 'csv'.",
        )

    job_data = dict(job)
    job_data.pop("results", None)

    if not job_data.get("summary") or "metrics" not in job_data.get("summary", {}):
        results = job_manager.get_job_results_payload(job_id)
        if results:
            job_data["summary"] = _build_job_summary(
                results, job.get("evaluation_time", 0.0)
            )

    if requested_format == "csv":
        csv_content = format_summary_as_csv(job_id, job_data)
        headers = {
            "Content-Disposition": f"attachment; filename=job_{job_id}_summary.csv"
        }
        return Response(
            content=csv_content,
            media_type="text/csv",
            headers=headers,
        )

    return EvaluationSummaryResponse(**job_data)


@router.post(
    "/jobs/{job_id}/save-db",
    summary="Save Completed Job Results to Database",
    responses={
        400: {
            "description": "Bad Request - Job is not completed or contains no results"
        },
        404: {"description": "Not Found - Job with specified ID does not exist"},
        500: {
            "description": "Internal Server Error - Failed to persist results to database"
        },
    },
)
async def save_job_results_to_db(
    job_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist completed job results to PostgreSQL database on demand."""
    await authorize_evaluation_access(user, job_id, "manage")
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

    if job["status"] != JobStatusEnum.COMPLETED:
        raise HTTPException(
            status_code=400, detail=f"Job '{job_id}' is in status '{job['status']}'"
        )

    results = job_manager.get_job_results_payload(job_id)
    if not results:
        raise HTTPException(
            status_code=400, detail="No evaluation results found for job"
        )

    try:
        sink = PostgresResultSink(db_manager=db_manager)
        sink.save(
            results_dir=Path(DEFAULT_RESULTS_DIR),
            prefix=job["config_args"].get("dataset_name", "enterprise"),
            results=results,
            evaluation_time=job.get("evaluation_time", 0.0),
            config_args=job["config_args"],
        )
        return {
            "job_id": job_id,
            "status": "success",
            "message": "Evaluation results successfully saved to PostgreSQL database",
        }
    except Exception as e:
        logger.exception(f"Failed to persist results for job '{job_id}' to DB: {e}")
        raise HTTPException(
            status_code=500, detail=f"Failed to persist results to PostgreSQL DB: {e}"
        )


@router.get(
    "/results/db",
    summary="Query Database Evaluation Runs",
    responses={
        500: {
            "description": "Internal Server Error - Failed to query database evaluation runs"
        },
    },
)
def query_db_evaluation_runs(
    limit: int = Query(10, ge=1, le=100),
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Query recent evaluation experiment runs stored in PostgreSQL database."""
    try:
        sink = PostgresResultSink(db_manager=db_manager)
        runs = sink.query_runs(limit=limit)

        return {"count": len(runs), "runs": runs}
    except Exception as e:
        logger.exception(f"Failed to query database evaluation runs: {e}")
        raise HTTPException(
            status_code=500, detail=f"Failed to query database evaluation runs: {e}"
        )


@router.get(
    "/results/db/{run_id}",
    summary="Query Detailed Database Evaluation Results for a Run",
    responses={
        500: {
            "description": "Internal Server Error - Failed to query evaluation results for run"
        },
    },
)
def query_db_evaluation_results(
    run_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Query per-question evaluation results for a specific run in PostgreSQL database."""
    try:
        sink = PostgresResultSink(db_manager=db_manager)
        results = sink.query_evaluation_results(run_id)
        return {"run_id": run_id, "count": len(results), "results": results}
    except Exception as e:
        logger.exception(f"Failed to query evaluation results for run '{run_id}': {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to query evaluation results for run '{run_id}': {e}",
        )

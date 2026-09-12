from __future__ import annotations

import hashlib
import json
import logging
from enum import Enum
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field

from deepeval_eval.api.auth import (
    ResourceType,
    ResourceVisibility,
    UserContext,
    authorize_agent_access,
    authorize_datasource_access,
    authorize_evaluate,
    authorize_evaluation_access,
    authorize_question_set_access,
    get_allowed_resource_ids,
    get_current_user,
    update_resource_visibility,
    write_evaluation_ownership,
)
from deepeval_eval.api.job_manager import (
    compute_eval_hash,
    db_manager,
    job_manager,
    persistent_job_queue,
)
from deepeval_eval.core.prompt_style import DEFAULT_PROMPT_STYLE

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Evaluation Jobs"])

USER_INFO_FIELD_DESCRIPTION = "Authenticated user/client identity details"


# ---------------------------------------------------------------------------
# Pydantic Request & Response Models (DTOs)
# ---------------------------------------------------------------------------


class JobStatusEnum(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class EvaluationRequest(BaseModel):
    question_set_id: int | None = Field(
        default=None,
        description="ID of a Question Set stored in Question Set Manager to evaluate",
    )
    dataset_name: str = Field(
        default="enterprise",
        description="Dataset name (e.g. enterprise, hotpotqa) or custom benchmark",
    )
    answer_mode: str = Field(
        default="generate",
        description="Evaluation answer mode: 'generate' or 'ground_truth'",
    )
    oracle_testing: bool = Field(
        default=False,
        description="Shortcut flag to enable oracle_retrieval and ground_truth answer mode",
    )
    datasource_id: str | None = Field(
        default=None, description="Target CAIPE datasource ID"
    )
    search_tool_name: str | None = Field(
        default=None,
        description="Target MCP search tool name (default: knowledge-base_search)",
    )
    fetch_tool_name: str | None = Field(
        default=None,
        description="Target MCP fetch document tool name (default: knowledge-base_fetch_document)",
    )
    prompt_style: str | None = Field(
        default=DEFAULT_PROMPT_STYLE,
        description="Prompt style (e.g. generation, short, agentic_generation, agentic_short, or custom)",
    )
    prompt_args: dict[str, Any] = Field(
        default_factory=dict,
        description="Dynamic key-value arguments for prompt template variable substitution (e.g. tool_name)",
    )
    metric_set: str | None = Field(
        default=None,
        description="Name of a pre-configured metric set bundle to evaluate (e.g. 'rag_core', 'retrieval_fast')",
    )
    metrics: list[str] | None = Field(
        default=None,
        description="List of specific metric names to evaluate (e.g. ['faithfulness', 'answer_relevancy'])",
    )
    max_items: int | None = Field(
        default=None, ge=1, description="Maximum number of items to evaluate"
    )
    limit_per_category: int | None = Field(
        default=None, ge=1, description="Limit items per category"
    )
    top_k: int = Field(
        default=3, ge=1, description="Number of context documents to retrieve"
    )
    max_context_chars: int = Field(
        default=12000, ge=100, description="Max context characters to pass to evaluator"
    )
    llm_model: str | None = Field(default=None, description="Custom LLM model name")
    agentic: bool = Field(
        default=True,
        description="Route queries through CAIPE dynamic agents streaming endpoint",
    )
    agent_id: str | None = Field(
        default=None,
        description="Optional CAIPE agent ID for agentic RAG evaluations",
    )
    fail_on_error: bool = Field(
        default=False, description="Fail loudly if a query evaluation fails"
    )
    oracle_retrieval: bool = Field(
        default=False, description="Enable oracle (question + reference) retrieval"
    )
    gate: bool = Field(default=False, description="Apply quality gate after evaluation")
    force_rerun: bool = Field(
        default=False,
        description="Bypass evaluation deduplication cache and force rerun",
    )
    question_ids: list[str] | None = Field(
        default=None, description="List of specific question IDs to evaluate"
    )
    question_indices: list[int] | None = Field(
        default=None, description="List of specific question indices to evaluate"
    )
    owner_team: str | None = Field(
        default=None, description="Owning team slug for RBAC authorization"
    )
    visibility: str | None = Field(
        default="private", description="Visibility mode: private, team, or public"
    )
    experiment_name: str | None = Field(
        default=None,
        description="Optional experiment name to label and group evaluation runs",
    )
    dynamic_tool: bool = Field(
        default=False,
        description="Provision an ephemeral MCP custom search tool for this evaluation run and delete it after",
    )
    semantic_weight: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Semantic (dense) weight for hybrid search (0.0=keyword-only, 1.0=semantic-only). Keyword weight is auto-computed as 1.0 - semantic_weight.",
    )
    extra_filters: dict[str, Any] = Field(
        default_factory=dict,
        description="Extra metadata filters applied to this evaluation's search (e.g. {'document_type': 'pdf'})",
    )
    tool_description: str | None = Field(
        default=None,
        description="Optional description for the ephemeral MCP tool shown to the LLM agent",
    )


class ChangeVisibilityRequest(BaseModel):
    visibility: ResourceVisibility = Field(
        default=ResourceVisibility.PRIVATE,
        description="Target visibility mode: 'private', 'team', or 'public'",
    )
    owner_team: str | None = Field(
        default=None, description="Optional target owner team slug"
    )


class JobResponse(BaseModel):
    job_id: str
    status: JobStatusEnum
    created_at: float
    completed_at: float | None = None
    cached: bool = False
    eval_hash: str
    error: str | None = None
    config_args: dict[str, Any] = Field(
        default_factory=dict,
        description="Configuration parameters and dataset details for the evaluation run",
    )
    user_info: dict[str, Any] | None = Field(
        default=None, description=USER_INFO_FIELD_DESCRIPTION
    )


# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------


def _parse_dataset_bytes(file_bytes: bytes, filename: str) -> list[dict[str, Any]]:
    """Parse uploaded dataset bytes (JSON, JSONL, or CSV) in-memory into question dicts."""
    ext = Path(filename).suffix.lower() if filename else ".json"
    text = file_bytes.decode("utf-8-sig", errors="replace")
    rows: list[dict[str, Any]] = []

    if ext == ".jsonl":
        for line in text.splitlines():
            line_str = line.strip()
            if line_str:
                try:
                    parsed = json.loads(line_str)
                    if isinstance(parsed, dict):
                        rows.append(parsed)
                except Exception:
                    pass
    elif ext == ".csv":
        import csv
        import io

        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            rows.append(dict(row))
    else:
        # JSON format
        try:
            data = json.loads(text)
            if isinstance(data, list):
                rows = [r for r in data if isinstance(r, dict)]
            elif isinstance(data, dict):
                if "questions" in data and isinstance(data["questions"], list):
                    rows = [r for r in data["questions"] if isinstance(r, dict)]
                elif "items" in data and isinstance(data["items"], list):
                    rows = [r for r in data["items"] if isinstance(r, dict)]
                else:
                    rows = [data]
        except Exception:
            pass

    normalized: list[dict[str, Any]] = []
    for idx, r in enumerate(rows):
        q_id = str(r.get("question_id") or r.get("id") or (idx + 1))
        u_in = str(
            r.get("input") or r.get("user_input") or r.get("question") or ""
        ).strip()
        if not u_in:
            continue
        exp_out = str(
            r.get("expected_output")
            or r.get("reference")
            or r.get("ground_truth")
            or ""
        )
        cat = r.get("category") or "basic"
        level = r.get("level")
        doc_ids = r.get("expected_doc_ids") or []
        if isinstance(doc_ids, str):
            doc_ids = [doc_ids]
        ctx = r.get("context")
        extra = {
            k: v
            for k, v in r.items()
            if k
            not in (
                "question_id",
                "id",
                "input",
                "user_input",
                "question",
                "expected_output",
                "reference",
                "ground_truth",
                "category",
                "level",
                "expected_doc_ids",
                "context",
            )
        }
        normalized.append(
            {
                "question_id": q_id,
                "input": u_in,
                "expected_output": exp_out,
                "category": cat,
                "level": level,
                "expected_doc_ids": doc_ids,
                "context": ctx,
                "extra": extra or None,
            }
        )
    return normalized


async def _prepare_job_from_question_set(
    set_id: int, request: EvaluationRequest, user: UserContext
) -> JobResponse:
    qset = db_manager.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set with ID={set_id} not found in database.",
        )

    if qset.get("question_count", 0) == 0:
        res = db_manager.questions.list_questions(set_id=set_id, page=1, limit=1)
        if not res["items"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Question set ID={set_id} contains no questions.",
            )

    if request.dataset_name == "enterprise" and qset.get("name"):
        request.dataset_name = qset["name"]

    request.question_set_id = set_id

    if request.datasource_id:
        await authorize_datasource_access(user, request.datasource_id, "read")
    if request.agent_id:
        await authorize_agent_access(user, request.agent_id, "read")

    set_hash = qset.get("content_hash") or f"{set_id}_{qset.get('updated_at')}"
    config_dict = request.model_dump()
    if user.subject:
        config_dict["submitter_subject"] = user.subject
    if user.email:
        config_dict["submitter_email"] = user.email
    if user.role:
        config_dict["submitter_role"] = user.role

    eval_hash = compute_eval_hash(config_dict, dataset_bytes=set_hash.encode("utf-8"))

    job = job_manager.create_job(
        eval_hash, config_dict, force_rerun=request.force_rerun, user=user
    )

    await write_evaluation_ownership(
        job["job_id"], request.owner_team, request.visibility, user
    )

    if job["cached"]:
        return JobResponse(**job)

    persistent_job_queue.enqueue(job["job_id"], eval_hash, config_dict)
    return JobResponse(**job)


# ---------------------------------------------------------------------------
# Route Handlers
# ---------------------------------------------------------------------------


@router.post(
    "/eval/jobs",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit Evaluation Job",
    responses={
        400: {
            "description": "Bad Request - Invalid request parameters or empty question set"
        },
        404: {"description": "Not Found - Referenced question set not found"},
    },
)
async def submit_eval_job(
    request: EvaluationRequest,
    user: UserContext = Depends(get_current_user),
) -> JobResponse:
    """Submit an evaluation job asynchronously using JSON request parameters."""
    await authorize_evaluate(user)

    if request.datasource_id:
        await authorize_datasource_access(user, request.datasource_id, "read")
    if request.agent_id:
        await authorize_agent_access(user, request.agent_id, "read")

    if request.question_set_id is not None:
        await authorize_question_set_access(user, str(request.question_set_id), "read")
        return await _prepare_job_from_question_set(
            request.question_set_id, request, user
        )

    config_dict = request.model_dump()
    if user.subject:
        config_dict["submitter_subject"] = user.subject
    if user.email:
        config_dict["submitter_email"] = user.email
    if user.role:
        config_dict["submitter_role"] = user.role

    eval_hash = compute_eval_hash(config_dict)

    job = job_manager.create_job(
        eval_hash, config_dict, force_rerun=request.force_rerun, user=user
    )

    await write_evaluation_ownership(
        job["job_id"], request.owner_team, request.visibility, user
    )

    if job["cached"]:
        return JobResponse(**job)

    persistent_job_queue.enqueue(job["job_id"], eval_hash, config_dict)
    return JobResponse(**job)


@router.post(
    "/eval/jobs/question-sets/{set_id}",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit Evaluation Job for Question Set",
    responses={
        400: {"description": "Bad Request - Question set contains no questions"},
        404: {"description": "Not Found - Question set with specified ID not found"},
    },
)
async def submit_eval_job_for_question_set(
    set_id: int,
    request: EvaluationRequest | None = None,
    user: UserContext = Depends(get_current_user),
) -> JobResponse:
    """Submit an evaluation job targeting a Question Set stored in Question Set Manager."""
    await authorize_evaluate(user)
    await authorize_question_set_access(user, str(set_id), "read")
    req = request or EvaluationRequest()
    req.question_set_id = set_id
    return await _prepare_job_from_question_set(set_id, req, user)


@router.post(
    "/eval/jobs/upload",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit Evaluation Job with Dataset File Upload",
    responses={
        400: {
            "description": "Bad Request - Uploaded file is empty or contains no valid questions"
        },
    },
)
async def submit_eval_job_with_upload(
    file: UploadFile = File(..., description="Dataset file (JSON/CSV)"),
    dataset_name: str = Query("custom_upload", description="Dataset name"),
    answer_mode: str = Query(
        "generate", description="Answer mode: generate or ground_truth"
    ),
    oracle_testing: bool = Query(
        False,
        description="Shortcut flag to enable oracle_retrieval and ground_truth answer mode",
    ),
    datasource_id: str | None = Query(None, description="Target CAIPE datasource ID"),
    search_tool_name: str | None = Query(
        None, description="Target MCP search tool name (default: knowledge-base_search)"
    ),
    fetch_tool_name: str | None = Query(
        None,
        description="Target MCP fetch document tool name (default: knowledge-base_fetch_document)",
    ),
    prompt_style: str | None = Query(
        DEFAULT_PROMPT_STYLE,
        description="Prompt style (e.g. generation, short, agentic_generation, agentic_short)",
    ),
    prompt_args: str | None = Query(
        None,
        description='JSON string of dynamic key-value prompt_args (e.g. \'{"domain": "compliance"}\')',
    ),
    max_items: int | None = Query(None, description="Maximum items to evaluate"),
    limit_per_category: int | None = Query(
        None, description="Limit items per category"
    ),
    top_k: int = Query(3, description="Top-k documents"),
    max_context_chars: int = Query(12000, description="Max context characters"),
    llm_model: str | None = Query(None, description="Custom LLM model name"),
    agentic: bool = Query(
        True,
        description="Route queries through CAIPE dynamic agents streaming endpoint",
    ),
    agent_id: str | None = Query(None, description="Optional CAIPE agent ID"),
    fail_on_error: bool = Query(
        False, description="Fail loudly if a query evaluation fails"
    ),
    oracle_retrieval: bool = Query(
        False, description="Enable oracle (question + reference) retrieval"
    ),
    gate: bool = Query(False, description="Apply quality gate after evaluation"),
    force_rerun: bool = Query(False, description="Force rerun ignoring cache"),
    owner_team: str | None = Query(
        None, description="Owning team slug for RBAC authorization"
    ),
    visibility: str | None = Query(
        "private", description="Visibility mode: private, team, or public"
    ),
    experiment_name: str | None = Query(
        None, description="Optional experiment name to label and group evaluation runs"
    ),
    dynamic_tool: bool = Query(
        False,
        description="Provision an ephemeral MCP custom search tool for this run and delete it after",
    ),
    semantic_weight: float = Query(
        0.5,
        ge=0.0,
        le=1.0,
        description="Semantic (dense) weight for hybrid search (0.0=keyword-only, 1.0=semantic-only). Keyword weight is auto-computed as 1.0 - semantic_weight.",
    ),
    extra_filters: str | None = Query(
        None,
        description='JSON string of extra metadata filters (e.g. \'{"document_type": "pdf"}\')',
    ),
    tool_description: str | None = Query(
        None,
        description="Optional description for the ephemeral MCP tool shown to the LLM agent",
    ),
    metric_set: str | None = Query(
        None,
        description="Name of pre-configured metric set bundle (e.g. 'default', 'rag_core')",
    ),
    metrics: list[str] | None = Query(
        None,
        description="List of individual metric names to evaluate",
    ),
    user: UserContext = Depends(get_current_user),
) -> JobResponse:
    """Submit an evaluation job by uploading a dataset file (multipart/form-data)."""
    await authorize_evaluate(user)

    if datasource_id:
        await authorize_datasource_access(user, datasource_id, "read")
    if agent_id:
        await authorize_agent_access(user, agent_id, "read")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    content_hash = hashlib.sha256(file_bytes).hexdigest()
    existing_qset = db_manager.questions.find_by_content_hash(content_hash)

    if existing_qset:
        set_id = existing_qset["id"]
        ds_name = (
            dataset_name
            if (dataset_name and dataset_name not in ("custom_upload", "enterprise"))
            else existing_qset["name"]
        )
    else:
        questions = _parse_dataset_bytes(file_bytes, file.filename or "dataset.json")
        if not questions:
            raise HTTPException(
                status_code=400, detail="Uploaded file contains no valid questions"
            )
        ext = (
            Path(file.filename).suffix.lower().lstrip(".") if file.filename else "json"
        )
        raw_name = (
            Path(file.filename).stem if file.filename else f"upload_{content_hash[:8]}"
        )
        ds_name = (
            dataset_name
            if (dataset_name and dataset_name not in ("custom_upload", "enterprise"))
            else raw_name
        )
        qset = db_manager.questions.create_question_set(
            name=ds_name,
            description=f"Uploaded dataset from {file.filename or 'file'}",
            source_format=ext or "json",
            content_hash=content_hash,
        )
        set_id = qset["id"]
        db_manager.questions.add_questions(set_id, questions)

    parsed_prompt_args: dict[str, Any] = {}
    if prompt_args:
        try:
            parsed_prompt_args = (
                json.loads(prompt_args) if isinstance(prompt_args, str) else prompt_args
            )
        except Exception:
            pass

    parsed_extra_filters: dict[str, Any] = {}
    if extra_filters:
        try:
            parsed_extra_filters = (
                json.loads(extra_filters)
                if isinstance(extra_filters, str)
                else extra_filters
            )
        except Exception:
            pass

    req = EvaluationRequest(
        dataset_name=ds_name,
        question_set_id=set_id,
        answer_mode=answer_mode,
        datasource_id=datasource_id,
        search_tool_name=search_tool_name,
        fetch_tool_name=fetch_tool_name,
        prompt_style=prompt_style,
        prompt_args=parsed_prompt_args,
        metric_set=metric_set,
        metrics=metrics,
        max_items=max_items,
        limit_per_category=limit_per_category,
        top_k=top_k,
        max_context_chars=max_context_chars,
        llm_model=llm_model,
        agentic=agentic,
        agent_id=agent_id,
        fail_on_error=fail_on_error,
        oracle_retrieval=oracle_retrieval,
        gate=gate,
        force_rerun=force_rerun,
        oracle_testing=oracle_testing,
        owner_team=owner_team,
        visibility=visibility,
        experiment_name=experiment_name,
        dynamic_tool=dynamic_tool,
        semantic_weight=semantic_weight,
        extra_filters=parsed_extra_filters,
        tool_description=tool_description,
    )

    config_dict = req.model_dump()
    eval_hash = compute_eval_hash(
        config_dict, dataset_bytes=content_hash.encode("utf-8")
    )

    job = job_manager.create_job(
        eval_hash, config_dict, force_rerun=force_rerun, user=user
    )

    await write_evaluation_ownership(job["job_id"], owner_team, visibility, user)

    if job["cached"]:
        return JobResponse(**job)

    persistent_job_queue.enqueue(job["job_id"], eval_hash, config_dict)
    return JobResponse(**job)


@router.get(
    "/jobs",
    response_model=list[JobResponse],
    summary="List Evaluation Jobs",
)
async def list_jobs(
    user: UserContext = Depends(get_current_user),
) -> list[JobResponse]:
    """List all submitted evaluation jobs authorized for the current user."""
    allowed_ids = await get_allowed_resource_ids(user, "evaluation", "can_read")
    jobs = job_manager.list_jobs(allowed_ids=allowed_ids, user_email=user.email)
    return [JobResponse(**j) for j in jobs]


@router.get(
    "/jobs/{job_id}",
    response_model=JobResponse,
    summary="Poll Job Status",
    responses={
        404: {"description": "Not Found - Job with specified ID does not exist"},
    },
)
async def get_job_status(
    job_id: str,
    user: UserContext = Depends(get_current_user),
) -> JobResponse:
    """Retrieve status and metadata for a specific job ID."""
    await authorize_evaluation_access(user, job_id, "read")
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    return JobResponse(**job)


@router.patch(
    "/jobs/{job_id}/visibility",
    response_model=JobResponse,
    summary="Update Evaluation Job Visibility & Ownership",
    responses={
        404: {"description": "Not Found - Job with specified ID does not exist"},
    },
)
async def update_job_visibility(
    job_id: str,
    request: ChangeVisibilityRequest,
    user: UserContext = Depends(get_current_user),
) -> JobResponse:
    """Update visibility ('private', 'team', 'public') and owner team for an evaluation job."""
    await authorize_evaluation_access(user, job_id, "manage")
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

    await update_resource_visibility(
        ResourceType.EVALUATION, job_id, request.visibility, request.owner_team, user
    )

    vis_val = (
        request.visibility.value
        if hasattr(request.visibility, "value")
        else str(request.visibility)
    )
    if "config_json" in job and isinstance(job["config_json"], dict):
        job["config_json"]["visibility"] = vis_val
        if request.owner_team:
            job["config_json"]["owner_team"] = request.owner_team
    elif "config_args" in job and isinstance(job["config_args"], dict):
        job["config_args"]["visibility"] = vis_val
        if request.owner_team:
            job["config_args"]["owner_team"] = request.owner_team

    return JobResponse(**job)

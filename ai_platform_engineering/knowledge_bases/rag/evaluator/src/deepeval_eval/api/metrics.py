from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from deepeval_eval.api.auth import (
    Role,
    UserContext,
    authorize_metric_access,
    get_current_user,
    require_role,
)
from deepeval_eval.db.db_manager import DatabaseManager
from deepeval_eval.engine.metrics import list_builtin_metric_metadata

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/metrics", tags=["Metrics"])


# ---------------------------------------------------------------------------
# Pydantic Request & Response DTOs
# ---------------------------------------------------------------------------


class BuiltinMetricItem(BaseModel):
    name: str
    display_name: str
    description: str
    metric_type: str
    metric_class: str | None = None
    default_threshold: float = 0.5
    requires_llm_judge: bool = False


class MetricCreate(BaseModel):
    name: str = Field(..., description="Unique metric slug/key")
    display_name: str = Field(..., description="Human-readable metric name")
    description: str | None = Field(
        default=None, description="Detailed explanation of the metric"
    )
    metric_type: str = Field(
        default="g_eval",
        description="Metric type: only 'g_eval' is permitted for dynamically created metrics via API",
    )
    threshold: float = Field(
        default=0.5, ge=0.0, le=1.0, description="Passing score threshold"
    )
    parameters: dict[str, Any] = Field(
        default_factory=dict, description="Optional hyperparameters"
    )
    evaluation_params: list[str] = Field(
        default_factory=lambda: ["input", "actual_output"],
        description="List of LLMTestCase fields to extract: input, actual_output, expected_output, retrieval_context, context",
    )
    criteria: str | None = Field(
        default=None, description="LLM judge evaluation criteria prompt"
    )
    evaluation_steps: list[str] = Field(
        default_factory=list, description="Ordered step-by-step scoring instructions"
    )
    visibility: str = Field(
        default="public", description="Visibility mode: public, team, or private"
    )
    owner_team: str | None = Field(default=None, description="Owning team slug")


class MetricUpdate(BaseModel):
    display_name: str | None = Field(default=None, description="Updated display name")
    description: str | None = Field(default=None, description="Updated description")
    threshold: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Updated threshold"
    )
    parameters: dict[str, Any] | None = Field(
        default=None, description="Updated parameters"
    )
    evaluation_params: list[str] | None = Field(
        default=None, description="Updated evaluation params"
    )
    criteria: str | None = Field(default=None, description="Updated criteria")
    evaluation_steps: list[str] | None = Field(
        default=None, description="Updated evaluation steps"
    )
    visibility: str | None = Field(default=None, description="Updated visibility")
    owner_team: str | None = Field(default=None, description="Updated owning team slug")


class MetricResponse(BaseModel):
    name: str
    display_name: str
    description: str | None = None
    metric_type: str = "builtin"
    metric_class: str | None = None
    threshold: float = 0.5
    parameters: dict[str, Any] = Field(default_factory=dict)
    evaluation_params: list[str] = Field(default_factory=list)
    criteria: str | None = None
    evaluation_steps: list[str] = Field(default_factory=list)
    visibility: str = "public"
    owner_id: str | None = None
    owner_team: str | None = None
    is_system: bool = False
    created_at: str | None = None
    updated_at: str | None = None


class MetricListResponse(BaseModel):
    items: list[MetricResponse]
    total: int
    page: int
    limit: int
    total_pages: int


def _get_db_manager() -> DatabaseManager:
    return DatabaseManager()


# ---------------------------------------------------------------------------
# REST Endpoint Handlers
# ---------------------------------------------------------------------------


@router.get("/builtins", response_model=list[BuiltinMetricItem])
async def list_builtin_metrics() -> list[BuiltinMetricItem]:
    """List all registered code-backed built-in metric types and their schemas."""
    metadata = list_builtin_metric_metadata()
    return [BuiltinMetricItem(**m) for m in metadata]


@router.get("", response_model=MetricListResponse)
async def list_metrics(
    metric_type: str | None = Query(
        default=None,
        description="Filter by metric_type ('builtin', 'custom_code', 'g_eval')",
    ),
    page: int = Query(default=1, ge=1, description="Page index (1-based)"),
    limit: int = Query(default=50, ge=1, le=200, description="Items per page"),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricListResponse:
    """List configured metrics (public read-only to all authenticated users)."""
    items, total = db.metrics.list_metrics(
        metric_type=metric_type, page=page, limit=limit
    )
    total_pages = max(1, (total + limit - 1) // limit) if total > 0 else 1

    return MetricListResponse(
        items=[MetricResponse(**item) for item in items],
        total=total,
        page=page,
        limit=limit,
        total_pages=total_pages,
    )


@router.get(
    "/{name}",
    response_model=MetricResponse,
    responses={404: {"description": "Not Found - Metric not found"}},
)
async def get_metric(
    name: str,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricResponse:
    """Get full details of a specific metric by name (public read-only)."""
    clean_name = name.strip().lower()
    rec = db.metrics.get_metric(clean_name)
    if not rec:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Metric '{clean_name}' not found.",
        )
    authorize_metric_access(user, rec, scope="read")
    return MetricResponse(**rec)


@router.post(
    "",
    response_model=MetricResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"description": "Bad Request - Invalid metric type"},
        409: {"description": "Conflict - Metric already exists"},
    },
)
async def create_metric(
    payload: MetricCreate,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricResponse:
    """Create a new custom G-Eval metric. Restricted to administrators."""
    clean_name = payload.name.strip().lower()

    if payload.metric_type != "g_eval":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only 'g_eval' metrics can be dynamically created via API. Builtin and custom code metrics must be pre-registered in the codebase.",
        )

    existing = db.metrics.get_metric(clean_name)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Metric '{clean_name}' already exists.",
        )

    user_id = getattr(user, "subject", None) or getattr(user, "client_id", None)

    created_record = db.metrics.upsert_metric(
        name=clean_name,
        display_name=payload.display_name,
        description=payload.description,
        metric_type="g_eval",
        threshold=payload.threshold,
        parameters=payload.parameters,
        evaluation_params=payload.evaluation_params,
        criteria=payload.criteria,
        evaluation_steps=payload.evaluation_steps,
        visibility=payload.visibility,
        owner_id=user_id,
        owner_team=payload.owner_team,
        is_system=False,
    )
    return MetricResponse(**created_record)


@router.put(
    "/{name}",
    response_model=MetricResponse,
    responses={
        404: {"description": "Not Found - Metric not found"},
    },
)
async def update_metric(
    name: str,
    payload: MetricUpdate,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricResponse:
    """Update metric configuration or thresholds. Restricted to administrators."""
    clean_name = name.strip().lower()
    rec = db.metrics.get_metric(clean_name)
    if not rec:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Metric '{clean_name}' not found.",
        )

    authorize_metric_access(user, rec, scope="manage")

    updated_record = db.metrics.upsert_metric(
        name=clean_name,
        display_name=payload.display_name
        if payload.display_name is not None
        else rec.get("display_name"),
        description=payload.description
        if payload.description is not None
        else rec.get("description"),
        metric_type=rec.get("metric_type", "builtin"),
        metric_class=rec.get("metric_class"),
        threshold=payload.threshold
        if payload.threshold is not None
        else rec.get("threshold", 0.5),
        parameters=payload.parameters
        if payload.parameters is not None
        else rec.get("parameters", {}),
        evaluation_params=payload.evaluation_params
        if payload.evaluation_params is not None
        else rec.get("evaluation_params", []),
        criteria=payload.criteria
        if payload.criteria is not None
        else rec.get("criteria"),
        evaluation_steps=payload.evaluation_steps
        if payload.evaluation_steps is not None
        else rec.get("evaluation_steps", []),
        visibility=payload.visibility
        if payload.visibility is not None
        else rec.get("visibility", "public"),
        owner_id=rec.get("owner_id"),
        owner_team=payload.owner_team
        if payload.owner_team is not None
        else rec.get("owner_team"),
        is_system=bool(rec.get("is_system")),
    )
    return MetricResponse(**updated_record)


@router.delete(
    "/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        400: {"description": "Bad Request - Failed to delete metric"},
        403: {"description": "Forbidden - System metrics cannot be deleted"},
        404: {"description": "Not Found - Metric not found"},
    },
)
async def delete_metric(
    name: str,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> None:
    """Delete a custom metric. Restricted to administrators."""
    clean_name = name.strip().lower()
    rec = db.metrics.get_metric(clean_name)
    if not rec:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Metric '{clean_name}' not found.",
        )

    authorize_metric_access(user, rec, scope="delete")

    try:
        success = db.metrics.delete_metric(clean_name)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to delete metric '{clean_name}'.",
            )
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(val_err),
        ) from val_err

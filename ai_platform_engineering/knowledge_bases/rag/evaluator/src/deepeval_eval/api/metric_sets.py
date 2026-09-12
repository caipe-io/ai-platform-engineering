from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from deepeval_eval.api.auth import (
    Role,
    UserContext,
    authorize_metric_set_access,
    get_current_user,
    require_role,
)
from deepeval_eval.db.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/metric-sets", tags=["Metric Sets"])


# ---------------------------------------------------------------------------
# Pydantic Request & Response DTOs
# ---------------------------------------------------------------------------


class MetricSetItemCreate(BaseModel):
    metric_name: str = Field(..., description="Unique metric slug to include in set")
    custom_threshold: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Optional custom threshold override for this set",
    )


class MetricSetCreate(BaseModel):
    name: str = Field(..., description="Unique metric set slug (e.g. 'rag_core')")
    display_name: str = Field(..., description="Human-readable metric set name")
    description: str | None = Field(
        default=None, description="Detailed explanation of the metric set bundle"
    )
    visibility: str = Field(
        default="public", description="Visibility mode: public, team, or private"
    )
    owner_team: str | None = Field(default=None, description="Owning team slug")
    metrics: list[MetricSetItemCreate] = Field(
        default_factory=list, description="List of metrics to bundle into this set"
    )


class MetricSetUpdate(BaseModel):
    display_name: str | None = Field(default=None, description="Updated display name")
    description: str | None = Field(default=None, description="Updated description")
    visibility: str | None = Field(default=None, description="Updated visibility")
    owner_team: str | None = Field(default=None, description="Updated owning team slug")
    metrics: list[MetricSetItemCreate] | None = Field(
        default=None, description="Updated list of metrics to bundle"
    )


class MetricSetItemResponse(BaseModel):
    name: str | None = None
    metric_name: str | None = None
    display_name: str | None = None
    metric_type: str | None = None
    threshold: float | None = None
    custom_threshold: float | None = None


class MetricSetResponse(BaseModel):
    name: str
    display_name: str
    description: str | None = None
    visibility: str = "public"
    owner_id: str | None = None
    owner_team: str | None = None
    is_system: bool = False
    metrics: list[dict[str, Any]] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


class MetricSetListResponse(BaseModel):
    items: list[MetricSetResponse]
    total: int
    page: int
    limit: int
    total_pages: int


def _get_db_manager() -> DatabaseManager:
    return DatabaseManager()


# ---------------------------------------------------------------------------
# REST Endpoint Handlers
# ---------------------------------------------------------------------------


@router.get("", response_model=MetricSetListResponse)
async def list_metric_sets(
    page: int = Query(default=1, ge=1, description="Page index (1-based)"),
    limit: int = Query(default=50, ge=1, le=200, description="Items per page"),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricSetListResponse:
    """List configured metric sets (public read-only to all authenticated users)."""
    items, total = db.metrics.list_metric_sets(page=page, limit=limit)
    total_pages = max(1, (total + limit - 1) // limit) if total > 0 else 1

    # Enrich each metric set with its bundled metrics
    enriched_items: list[MetricSetResponse] = []
    for item in items:
        set_with_metrics = db.metrics.get_metric_set_with_metrics(item["name"])
        if set_with_metrics:
            enriched_items.append(MetricSetResponse(**set_with_metrics))
        else:
            enriched_items.append(MetricSetResponse(**item))

    return MetricSetListResponse(
        items=enriched_items,
        total=total,
        page=page,
        limit=limit,
        total_pages=total_pages,
    )


@router.get(
    "/{name}",
    response_model=MetricSetResponse,
    responses={404: {"description": "Not Found - Metric set not found"}},
)
async def get_metric_set(
    name: str,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricSetResponse:
    """Get details of a specific metric set including its bundled metrics (public read-only)."""
    clean_name = name.strip().lower()
    rec = db.metrics.get_metric_set_with_metrics(clean_name)
    if not rec:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Metric set '{clean_name}' not found.",
        )
    authorize_metric_set_access(user, rec, scope="read")
    return MetricSetResponse(**rec)


@router.post(
    "",
    response_model=MetricSetResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"description": "Bad Request - Invalid metric reference"},
        409: {"description": "Conflict - Metric set already exists"},
    },
)
async def create_metric_set(
    payload: MetricSetCreate,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricSetResponse:
    """Create a new metric set bundle. Restricted to administrators."""
    clean_name = payload.name.strip().lower()
    existing = db.metrics.get_metric_set(clean_name)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Metric set '{clean_name}' already exists.",
        )

    # Validate that bundled metrics exist in database
    metrics_to_bundle: list[dict[str, Any]] = []
    for item in payload.metrics:
        m_rec = db.metrics.get_metric(item.metric_name)
        if not m_rec:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot bundle non-existent metric '{item.metric_name}'.",
            )
        metrics_to_bundle.append(
            {"metric_name": item.metric_name, "custom_threshold": item.custom_threshold}
        )

    user_id = getattr(user, "subject", None) or getattr(user, "client_id", None)

    created_record = db.metrics.upsert_metric_set(
        name=clean_name,
        display_name=payload.display_name,
        description=payload.description,
        visibility=payload.visibility,
        owner_id=user_id,
        owner_team=payload.owner_team,
        is_system=False,
        metrics=metrics_to_bundle,
    )
    return MetricSetResponse(**created_record)


@router.put(
    "/{name}",
    response_model=MetricSetResponse,
    responses={
        404: {"description": "Not Found - Metric set not found"},
    },
)
async def update_metric_set(
    name: str,
    payload: MetricSetUpdate,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> MetricSetResponse:
    """Update a metric set bundle or its items. Restricted to administrators."""
    clean_name = name.strip().lower()
    rec = db.metrics.get_metric_set(clean_name)
    if not rec:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Metric set '{clean_name}' not found.",
        )

    authorize_metric_set_access(user, rec, scope="manage")

    metrics_to_bundle: list[dict[str, Any]] | None = None
    if payload.metrics is not None:
        metrics_to_bundle = []
        for item in payload.metrics:
            m_rec = db.metrics.get_metric(item.metric_name)
            if not m_rec:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Cannot bundle non-existent metric '{item.metric_name}'.",
                )
            metrics_to_bundle.append(
                {
                    "metric_name": item.metric_name,
                    "custom_threshold": item.custom_threshold,
                }
            )

    updated_record = db.metrics.upsert_metric_set(
        name=clean_name,
        display_name=payload.display_name
        if payload.display_name is not None
        else rec.get("display_name"),
        description=payload.description
        if payload.description is not None
        else rec.get("description"),
        visibility=payload.visibility
        if payload.visibility is not None
        else rec.get("visibility", "public"),
        owner_id=rec.get("owner_id"),
        owner_team=payload.owner_team
        if payload.owner_team is not None
        else rec.get("owner_team"),
        is_system=bool(rec.get("is_system")),
        metrics=metrics_to_bundle,
    )
    return MetricSetResponse(**updated_record)


@router.delete(
    "/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        400: {"description": "Bad Request - Failed to delete metric set"},
        403: {"description": "Forbidden - System metric sets cannot be deleted"},
        404: {"description": "Not Found - Metric set not found"},
    },
)
async def delete_metric_set(
    name: str,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> None:
    """Delete a custom metric set. Restricted to administrators."""
    clean_name = name.strip().lower()
    rec = db.metrics.get_metric_set(clean_name)
    if not rec:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Metric set '{clean_name}' not found.",
        )

    authorize_metric_set_access(user, rec, scope="delete")

    try:
        success = db.metrics.delete_metric_set(clean_name)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to delete metric set '{clean_name}'.",
            )
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(val_err),
        ) from val_err

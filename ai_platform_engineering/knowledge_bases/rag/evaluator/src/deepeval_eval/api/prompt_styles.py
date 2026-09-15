from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from deepeval_eval.api.auth import (
    Role,
    UserContext,
    authorize_prompt_style_access,
    get_current_user,
    has_permission,
    require_role,
)
from deepeval_eval.db.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/prompt-styles", tags=["Prompt Styles"])


# ---------------------------------------------------------------------------
# Pydantic Request & Response DTOs
# ---------------------------------------------------------------------------


class PromptStyleCreate(BaseModel):
    name: str = Field(..., description="Unique prompt style name (slug)")
    description: str | None = Field(
        default=None, description="Optional description of prompt style"
    )
    style_type: str = Field(
        default="generation",
        description="Style mode: 'generation' (post-retrieval) or 'agentic' (pre-retrieval instruction)",
    )
    template: str = Field(
        ...,
        description="Prompt template string (e.g. 'Answer: {question}\\nContext: {context}')",
    )
    visibility: str = Field(
        default="private", description="Visibility mode: private, team, or public"
    )
    owner_team: str | None = Field(
        default=None, description="Optional owning team slug"
    )


class PromptStyleUpdate(BaseModel):
    description: str | None = Field(default=None, description="Updated description")
    style_type: str | None = Field(default=None, description="Updated style type")
    template: str | None = Field(
        default=None, description="Updated prompt template string"
    )
    visibility: str | None = Field(default=None, description="Updated visibility mode")
    owner_team: str | None = Field(default=None, description="Updated owning team slug")


class PromptStyleResponse(BaseModel):
    name: str
    description: str | None = None
    style_type: str = "generation"
    template: str
    visibility: str = "private"
    owner_id: str | None = None
    owner_team: str | None = None
    is_system: bool = False
    created_at: str | None = None
    updated_at: str | None = None


class PromptStyleListResponse(BaseModel):
    items: list[PromptStyleResponse]
    total: int
    page: int
    limit: int
    total_pages: int


def _get_db_manager() -> DatabaseManager:
    return DatabaseManager()


# ---------------------------------------------------------------------------
# REST Endpoint Handlers
# ---------------------------------------------------------------------------


@router.get("", response_model=PromptStyleListResponse)
async def list_prompt_styles(
    style_type: str | None = Query(
        default=None, description="Filter by style_type ('generation' or 'agentic')"
    ),
    page: int = Query(default=1, ge=1, description="Page index (1-based)"),
    limit: int = Query(default=50, ge=1, le=200, description="Items per page"),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(_get_db_manager),
) -> PromptStyleListResponse:
    """List prompt styles accessible to current user based on App-Level Visibility filtering."""
    user_id = getattr(user, "subject", None) or getattr(user, "client_id", None)
    user_teams = getattr(user, "groups", None) or []
    is_admin = has_permission(user.role, Role.ADMIN)

    offset = (page - 1) * limit
    items_raw, total = db.prompt_styles.list_prompt_styles(
        user_id=user_id,
        user_teams=user_teams,
        is_admin=is_admin,
        style_type=style_type,
        limit=limit,
        offset=offset,
    )

    items = [PromptStyleResponse(**item) for item in items_raw]
    total_pages = (total + limit - 1) // limit if total > 0 else 1

    return PromptStyleListResponse(
        items=items,
        total=total,
        page=page,
        limit=limit,
        total_pages=total_pages,
    )


@router.get(
    "/{name}",
    response_model=PromptStyleResponse,
    responses={
        404: {"description": "Not Found - Prompt style not found"},
    },
)
async def get_prompt_style(
    name: str,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(_get_db_manager),
) -> PromptStyleResponse:
    """Get prompt style by name."""
    style_record = db.prompt_styles.get_prompt_style(name)
    if not style_record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Prompt style '{name}' not found.",
        )

    authorize_prompt_style_access(user, style_record, scope="read")
    return PromptStyleResponse(**style_record)


@router.post(
    "",
    response_model=PromptStyleResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        409: {"description": "Conflict - Prompt style already exists"},
    },
)
async def create_prompt_style(
    payload: PromptStyleCreate,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> PromptStyleResponse:
    """Create a new custom prompt style. Restricted to admins."""
    clean_name = payload.name.strip().lower()
    existing = db.prompt_styles.get_prompt_style(clean_name)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Prompt style '{clean_name}' already exists.",
        )

    user_id = getattr(user, "subject", None) or getattr(user, "client_id", None)

    created_record = db.prompt_styles.upsert_prompt_style(
        name=clean_name,
        description=payload.description,
        style_type=payload.style_type,
        template=payload.template,
        visibility=payload.visibility,
        owner_id=user_id,
        owner_team=payload.owner_team,
        is_system=False,
    )
    return PromptStyleResponse(**created_record)


@router.put(
    "/{name}",
    response_model=PromptStyleResponse,
    responses={
        404: {"description": "Not Found - Prompt style not found"},
    },
)
async def update_prompt_style(
    name: str,
    payload: PromptStyleUpdate,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> PromptStyleResponse:
    """Update an existing custom prompt style. Restricted to admins."""
    style_record = db.prompt_styles.get_prompt_style(name)
    if not style_record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Prompt style '{name}' not found.",
        )

    authorize_prompt_style_access(user, style_record, scope="manage")

    updated_record = db.prompt_styles.upsert_prompt_style(
        name=name,
        description=payload.description
        if payload.description is not None
        else style_record.get("description"),
        style_type=payload.style_type
        if payload.style_type is not None
        else style_record.get("style_type"),
        template=payload.template
        if payload.template is not None
        else style_record.get("template"),
        visibility=payload.visibility
        if payload.visibility is not None
        else style_record.get("visibility"),
        owner_id=style_record.get("owner_id"),
        owner_team=payload.owner_team
        if payload.owner_team is not None
        else style_record.get("owner_team"),
        is_system=bool(style_record.get("is_system")),
    )
    return PromptStyleResponse(**updated_record)


@router.delete(
    "/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        400: {"description": "Bad Request - Failed to delete prompt style"},
        404: {"description": "Not Found - Prompt style not found"},
    },
)
async def delete_prompt_style(
    name: str,
    user: UserContext = Depends(require_role(Role.ADMIN)),
    db: DatabaseManager = Depends(_get_db_manager),
) -> None:
    """Delete a custom prompt style. Restricted to admins."""
    style_record = db.prompt_styles.get_prompt_style(name)
    if not style_record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Prompt style '{name}' not found.",
        )

    authorize_prompt_style_access(user, style_record, scope="manage")

    success = db.prompt_styles.delete_prompt_style(name)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to delete prompt style '{name}'.",
        )

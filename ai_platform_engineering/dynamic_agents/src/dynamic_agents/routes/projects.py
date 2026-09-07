"""Authenticated Project catalog API."""

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.memory_paths import memory_owner_key
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.platform_projects import require_projects_enabled
from dynamic_agents.services.projects import (
    InvalidProjectNameError,
    ProjectAlreadyExistsError,
    create_project,
    list_projects,
)

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)


def _store(mongo: MongoDBService, settings: Settings) -> MongoDBGridFSStore:
    if mongo._db is None:
        raise HTTPException(status_code=503, detail="Project storage is unavailable")
    return MongoDBGridFSStore(
        db=mongo._db,
        bucket_name=settings.memory_gridfs_bucket_name,
        ttl_seconds=0,
    )


@router.get("")
async def get_projects(
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    require_projects_enabled(mongo._db, settings)
    owner = memory_owner_key(user, settings)
    items = [item.as_dict() for item in list_projects(_store(mongo, settings), owner)]
    return {"success": True, "data": {"items": items}}


@router.post("", status_code=201)
async def post_project(
    body: ProjectCreateRequest = Body(...),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    require_projects_enabled(mongo._db, settings)
    owner = memory_owner_key(user, settings)
    try:
        project = create_project(_store(mongo, settings), owner, body.name)
    except InvalidProjectNameError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ProjectAlreadyExistsError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "project_already_exists",
                "message": str(exc),
                "project": exc.project.as_dict(),
            },
        ) from exc
    return {"success": True, "data": {"project": project.as_dict()}}

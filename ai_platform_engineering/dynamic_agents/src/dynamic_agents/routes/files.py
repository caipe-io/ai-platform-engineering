"""Generic filesystem endpoint for Dynamic Agents.

Provides access to files stored in GridFS by an authorized run namespace.

Endpoints:
  GET    /files/list      — list file paths in a namespace
  GET    /files/content   — get content of a single file
  PUT    /files/content   — create or update a file
  DELETE /files/content   — delete a file
  DELETE /files/namespace — delete all files in a namespace
"""

import json
import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from pymongo.database import Database

from dynamic_agents.auth.access import can_access_conversation
from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.auth.authz import (
    current_bearer_principal,
    require_file_resource_permission,
)
from dynamic_agents.config import get_settings
from dynamic_agents.models import ApiResponse
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/files", tags=["files"])


def _get_gridfs_store(db: Database) -> MongoDBGridFSStore:
    """Get a GridFS store instance for the given database."""
    settings = get_settings()
    return MongoDBGridFSStore(db=db, bucket_name=settings.gridfs_bucket_name)


def _parse_namespace(raw: str) -> tuple[str, str, str]:
    """Parse fs_namespace JSON array into a 3-tuple."""
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=400, detail="fs_namespace must be a valid JSON array")

    if not isinstance(parsed, list) or len(parsed) != 3:
        raise HTTPException(status_code=400, detail="fs_namespace must be an array of exactly 3 strings")

    if not all(isinstance(s, str) for s in parsed):
        raise HTTPException(status_code=400, detail="fs_namespace elements must all be strings")

    return (parsed[0], parsed[1], parsed[2])


def _get_db(mongo: MongoDBService) -> Database:
    """Get database or raise 503."""
    if mongo._client is None or mongo._db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    return mongo._db


async def _authorize_namespace(
    namespace: tuple[str, str, str],
    user: UserContext,
    db: Database,
    *,
    write: bool,
) -> None:
    """Bind a file namespace to its stored run and the authenticated caller."""
    resource_id, run_id, marker = namespace
    if marker != "filesystem" or not resource_id or not run_id:
        raise HTTPException(status_code=400, detail="Invalid filesystem namespace")

    conversation = db["conversations"].find_one({"_id": run_id})
    if conversation is not None:
        agent_id = next(
            (
                participant.get("id")
                for participant in conversation.get("participants", [])
                if participant.get("type") == "agent"
            ),
            None,
        )
        if agent_id != resource_id:
            raise HTTPException(status_code=403, detail="File namespace does not match the conversation")
        await require_file_resource_permission("agent", resource_id, "can_use")
        if not can_access_conversation(conversation, user):
            relation = "can_write" if write else "can_read"
            await require_file_resource_permission("conversation", run_id, relation)
        return

    workflow_run = db["workflow_runs"].find_one({"_id": run_id})
    if workflow_run is None or workflow_run.get("workflow_config_id") != resource_id:
        raise HTTPException(status_code=404, detail="File namespace was not found")

    owner = workflow_run.get("owner_subject")
    if owner:
        principal_type, principal_id = current_bearer_principal()
        is_owner = owner.get("type") == principal_type and owner.get("id") == principal_id
        if user.is_admin or is_owner:
            return
        if not write and workflow_run.get("shared_with") == "workspace":
            return
        raise HTTPException(status_code=403, detail="Permission denied")

    relation = "can_write" if write else "can_read"
    await require_file_resource_permission("task", resource_id, relation)


# --- Response models ---


class FilesListResponse(BaseModel):
    """Response for file list."""

    fs_namespace: list[str]
    files: list[str]


class FileContentResponse(BaseModel):
    """Response for file content."""

    fs_namespace: list[str]
    path: str
    content: str


class FilePutRequest(BaseModel):
    """Request body for creating/updating a file."""

    fs_namespace: list[str]
    path: str
    content: str


# --- Endpoints ---


@router.get("/list", response_model=FilesListResponse)
async def list_files(
    fs_namespace: str = Query(
        ..., description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> FilesListResponse:
    """List files in a GridFS namespace."""
    namespace = _parse_namespace(fs_namespace)
    db = _get_db(mongo)
    await _authorize_namespace(namespace, user, db, write=False)

    store = _get_gridfs_store(db)
    items = store.search(namespace, limit=1000)
    file_paths = sorted(item.key for item in items)

    logger.debug(f"Listed {len(file_paths)} files for namespace={namespace}")

    return FilesListResponse(fs_namespace=list(namespace), files=file_paths)


@router.get("/content", response_model=FileContentResponse)
async def get_file_content(
    fs_namespace: str = Query(
        ..., description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    path: str = Query(..., description="File path to retrieve"),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> FileContentResponse:
    """Get content of a single file from GridFS."""
    namespace = _parse_namespace(fs_namespace)
    db = _get_db(mongo)
    await _authorize_namespace(namespace, user, db, write=False)

    store = _get_gridfs_store(db)
    item = store.get(namespace, path)

    if item is None:
        raise HTTPException(status_code=404, detail="File not found")

    value = item.value
    raw_content = value.get("content", "")
    content = "\n".join(raw_content) if isinstance(raw_content, list) else str(raw_content)

    logger.debug(f"Retrieved file {path} for namespace={namespace}")

    return FileContentResponse(fs_namespace=list(namespace), path=path, content=content)


@router.put("/content", response_model=ApiResponse)
async def put_file_content(
    body: FilePutRequest = Body(...),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Create or update a file in GridFS."""
    if len(body.fs_namespace) != 3 or not all(isinstance(s, str) for s in body.fs_namespace):
        raise HTTPException(status_code=400, detail="fs_namespace must be an array of exactly 3 strings")

    namespace = (body.fs_namespace[0], body.fs_namespace[1], body.fs_namespace[2])
    db = _get_db(mongo)
    await _authorize_namespace(namespace, user, db, write=True)

    store = _get_gridfs_store(db)
    store.put(namespace, body.path, {"content": body.content})

    logger.info(f"Put file {body.path} in namespace={namespace}")

    return ApiResponse(success=True, data={"path": body.path})


@router.delete("/content", response_model=ApiResponse)
async def delete_file_content(
    fs_namespace: str = Query(
        ..., description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    path: str = Query(..., description="File path to delete"),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Delete a file from GridFS."""
    namespace = _parse_namespace(fs_namespace)
    db = _get_db(mongo)
    await _authorize_namespace(namespace, user, db, write=True)

    store = _get_gridfs_store(db)
    item = store.get(namespace, path)

    if item is None:
        raise HTTPException(status_code=404, detail="File not found")

    store.delete(namespace, path)

    logger.info(f"Deleted file {path} from namespace={namespace}")

    return ApiResponse(success=True, data={"deleted": path})


@router.delete("/namespace", response_model=ApiResponse)
async def delete_namespace(
    fs_namespace: str = Query(
        ..., description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Delete all files in a GridFS namespace."""
    namespace = _parse_namespace(fs_namespace)
    db = _get_db(mongo)
    await _authorize_namespace(namespace, user, db, write=True)

    store = _get_gridfs_store(db)
    count = store.delete_by_namespace(namespace)

    logger.info(f"Deleted {count} files from namespace={namespace}")

    return ApiResponse(success=True, data={"namespace": list(namespace), "deleted_count": count})

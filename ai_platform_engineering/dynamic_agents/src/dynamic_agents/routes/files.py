"""Generic filesystem endpoint for Dynamic Agents.

Provides access to files stored in GridFS by namespace tuple.
No conversation or agent coupling — callers provide the namespace directly.

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

from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.config import get_settings
from dynamic_agents.models import ApiResponse
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.platform_projects import projects_enabled

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


def _require_namespace_owner(
    namespace: tuple[str, str, str],
    user: UserContext,
    db: Database,
) -> None:
    """Require ownership of the conversation encoded in namespace[1]."""

    conversation = db["conversations"].find_one(
        {"_id": namespace[1]},
        {"owner_id": 1, "owner_subject": 1},
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    owner_subject = str(conversation.get("owner_subject") or "").strip()
    if owner_subject:
        authorized = bool(user.sub and owner_subject == user.sub)
    else:
        # Compatibility for conversations created before owner_subject was
        # persisted. Never let mutable email override a subject mismatch.
        authorized = str(conversation.get("owner_id") or "").casefold() == user.email.casefold()
    if not authorized:
        raise HTTPException(status_code=403, detail="Only the conversation owner can access its files")


def _resolve_conversation_namespace(
    conversation_id: str,
    agent_id: str,
    user: UserContext,
    db: Database,
) -> tuple[str, str, str]:
    """Authorize a conversation and derive its immutable filesystem namespace."""

    conversation = db["conversations"].find_one(
        {"_id": conversation_id},
        {"owner_id": 1, "owner_subject": 1, "participants": 1, "metadata.project_id": 1},
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    owner_subject = str(conversation.get("owner_subject") or "").strip()
    if owner_subject:
        authorized = bool(user.sub and owner_subject == user.sub)
    else:
        authorized = str(conversation.get("owner_id") or "").casefold() == user.email.casefold()
    if not authorized:
        raise HTTPException(status_code=403, detail="Only the conversation owner can access its files")
    participant_ids = {
        str(item.get("id"))
        for item in conversation.get("participants", [])
        if isinstance(item, dict) and item.get("type") == "agent"
    }
    if agent_id not in participant_ids:
        raise HTTPException(status_code=400, detail="Agent is not a participant in this conversation")
    metadata = conversation.get("metadata") if isinstance(conversation.get("metadata"), dict) else {}
    project_id = metadata.get("project_id") if projects_enabled(db, get_settings()) else None
    return (agent_id, str(project_id or conversation_id), "filesystem")


def _request_namespace(
    *,
    db: Database,
    user: UserContext,
    fs_namespace: str | None,
    conversation_id: str | None,
    agent_id: str | None,
) -> tuple[str, str, str]:
    if conversation_id or agent_id:
        if not conversation_id or not agent_id:
            raise HTTPException(status_code=400, detail="conversation_id and agent_id are required together")
        return _resolve_conversation_namespace(conversation_id, agent_id, user, db)
    if fs_namespace is None:
        raise HTTPException(status_code=400, detail="fs_namespace or conversation_id+agent_id is required")
    namespace = _parse_namespace(fs_namespace)
    _require_namespace_owner(namespace, user, db)
    return namespace


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

    fs_namespace: list[str] | None = None
    conversation_id: str | None = None
    agent_id: str | None = None
    path: str
    content: str


# --- Endpoints ---


@router.get("/list", response_model=FilesListResponse)
async def list_files(
    fs_namespace: str | None = Query(
        None, description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    conversation_id: str | None = Query(None),
    agent_id: str | None = Query(None),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> FilesListResponse:
    """List files in a GridFS namespace."""
    db = _get_db(mongo)
    namespace = _request_namespace(
        db=db,
        user=user,
        fs_namespace=fs_namespace,
        conversation_id=conversation_id,
        agent_id=agent_id,
    )

    store = _get_gridfs_store(db)
    items = store.search(namespace, limit=1000)
    file_paths = sorted(item.key for item in items)

    logger.debug(f"Listed {len(file_paths)} files for namespace={namespace}")

    return FilesListResponse(fs_namespace=list(namespace), files=file_paths)


@router.get("/content", response_model=FileContentResponse)
async def get_file_content(
    fs_namespace: str | None = Query(
        None, description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    conversation_id: str | None = Query(None),
    agent_id: str | None = Query(None),
    path: str = Query(..., description="File path to retrieve"),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> FileContentResponse:
    """Get content of a single file from GridFS."""
    db = _get_db(mongo)
    namespace = _request_namespace(
        db=db,
        user=user,
        fs_namespace=fs_namespace,
        conversation_id=conversation_id,
        agent_id=agent_id,
    )

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
    db = _get_db(mongo)
    raw_namespace = json.dumps(body.fs_namespace) if body.fs_namespace is not None else None
    namespace = _request_namespace(
        db=db,
        user=user,
        fs_namespace=raw_namespace,
        conversation_id=body.conversation_id,
        agent_id=body.agent_id,
    )

    store = _get_gridfs_store(db)
    store.put(namespace, body.path, {"content": body.content})

    logger.info(f"Put file {body.path} in namespace={namespace}")

    return ApiResponse(success=True, data={"path": body.path})


@router.delete("/content", response_model=ApiResponse)
async def delete_file_content(
    fs_namespace: str | None = Query(
        None, description='GridFS namespace as JSON array, e.g. ["configId","runId","filesystem"]'
    ),
    conversation_id: str | None = Query(None),
    agent_id: str | None = Query(None),
    path: str = Query(..., description="File path to delete"),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Delete a file from GridFS."""
    db = _get_db(mongo)
    namespace = _request_namespace(
        db=db,
        user=user,
        fs_namespace=fs_namespace,
        conversation_id=conversation_id,
        agent_id=agent_id,
    )

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
    _require_namespace_owner(namespace, user, db)

    store = _get_gridfs_store(db)
    count = store.delete_by_namespace(namespace)

    logger.info(f"Deleted {count} files from namespace={namespace}")

    return ApiResponse(success=True, data={"namespace": list(namespace), "deleted_count": count})

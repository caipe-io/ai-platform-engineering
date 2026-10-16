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

import logging
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, TypeAdapter, ValidationError
from pymongo.database import Database

from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.config import get_settings
from dynamic_agents.models import ApiResponse
from dynamic_agents.services.file_content import MAX_BINARY_FILE_BYTES, decode_file_content, file_data_from_bytes
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/files", tags=["files"])

_NAMESPACE_ADAPTER = TypeAdapter(tuple[str, str, str])


def _get_gridfs_store(db: Database) -> MongoDBGridFSStore:
    """Get a GridFS store instance for the given database."""
    settings = get_settings()
    return MongoDBGridFSStore(db=db, bucket_name=settings.gridfs_bucket_name)


def _parse_namespace(raw: str) -> tuple[str, str, str]:
    """Parse and strictly validate a three-string JSON namespace."""
    try:
        return _NAMESPACE_ADAPTER.validate_json(raw, strict=True)
    except (ValidationError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="fs_namespace must be a JSON array of exactly 3 strings")


def _get_db(mongo: MongoDBService) -> Database:
    """Get database or raise 503."""
    if mongo._client is None or mongo._db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    return mongo._db


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
    encoding: Literal["utf-8", "base64"] = "utf-8"


class FilePutRequest(BaseModel):
    """Request body for creating/updating a file."""

    fs_namespace: list[str]
    path: str
    content: str
    encoding: Literal["utf-8", "base64"] = "utf-8"


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

    store = _get_gridfs_store(db)
    item = store.get(namespace, path)

    if item is None:
        raise HTTPException(status_code=404, detail="File not found")

    value = item.value
    raw_content = value.get("content", "")
    content = "\n".join(raw_content) if isinstance(raw_content, list) else str(raw_content)
    encoding = value.get("encoding", "utf-8")
    if encoding == "base64":
        try:
            decode_file_content(value, maximum=MAX_BINARY_FILE_BYTES)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
    elif encoding != "utf-8":
        raise HTTPException(status_code=409, detail="The file encoding is not supported")

    logger.debug(f"Retrieved file {path} for namespace={namespace}")

    return FileContentResponse(fs_namespace=list(namespace), path=path, content=content, encoding=encoding)


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

    store = _get_gridfs_store(db)
    value = {"content": body.content}
    if body.encoding == "base64":
        try:
            data = decode_file_content(body.model_dump(), maximum=MAX_BINARY_FILE_BYTES)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        value = file_data_from_bytes(data)
    store.put(namespace, body.path, value)

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

    store = _get_gridfs_store(db)
    count = store.delete_by_namespace(namespace)

    logger.info(f"Deleted {count} files from namespace={namespace}")

    return ApiResponse(success=True, data={"namespace": list(namespace), "deleted_count": count})

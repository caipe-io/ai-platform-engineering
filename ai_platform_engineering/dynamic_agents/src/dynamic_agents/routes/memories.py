"""Owner-scoped REST API for deepagents-backed memory files."""

from __future__ import annotations

import hashlib
from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.memory_codec import (
    DuplicateMemoryTitleError,
    MemoryFile,
    MemoryRecord,
    find_title_conflict,
    new_memory_id,
    parse,
    promote_freeform_preamble,
    render,
    utc_timestamp,
)
from dynamic_agents.services.memory_paths import (
    is_memory_path,
    memory_owner_key,
    memory_scope_from_path,
    memory_store_ns,
    seed_content,
)
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.platform_projects import projects_enabled

router = APIRouter(prefix="/memories", tags=["memories"])


class MemoryPutRequest(BaseModel):
    path: str
    text: str
    etag: str | None = None
    overwrite: bool = False
    mounted: bool = True


class MemoryAppendRequest(BaseModel):
    path: str
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    etag: str | None = None

    @field_validator("title", "body")
    @classmethod
    def require_non_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Memory title and body must not be blank")
        return value


class MemoryUpdateRequest(BaseModel):
    path: str
    memory_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    etag: str | None = None

    @field_validator("title", "body")
    @classmethod
    def require_non_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Memory title and body must not be blank")
        return value


def _get_store(mongo: MongoDBService, settings: Settings) -> MongoDBGridFSStore:
    if mongo._db is None:
        raise HTTPException(status_code=503, detail="Memory storage is unavailable")
    return MongoDBGridFSStore(
        db=mongo._db,
        bucket_name=settings.memory_gridfs_bucket_name,
        ttl_seconds=0,
    )


def _storage_key(path: str) -> str:
    if not is_memory_path(path):
        raise HTTPException(status_code=400, detail="Invalid memory path")
    return path.removeprefix("/memories")


def _require_available_scope(path: str, mongo: MongoDBService, settings: Settings) -> None:
    if memory_scope_from_path(path) == "project" and not projects_enabled(mongo._db, settings):
        raise HTTPException(status_code=404, detail="Project memory is not enabled on this platform")


def _public_path(key: str) -> str:
    return f"/memories{key}"


def _etag(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_text(store: MongoDBGridFSStore, namespace: tuple[str, str], key: str) -> str | None:
    item = store.get(namespace, key)
    if item is None:
        return None
    content = item.value.get("content", "")
    return "\n".join(content) if isinstance(content, list) else str(content)


def _write_text(store: MongoDBGridFSStore, namespace: tuple[str, str], key: str, text: str) -> None:
    store.put(namespace, key, {"content": text, "encoding": "utf-8"})


def _serialize_file(path: str, text: str, updated_at: datetime | None, limit: int) -> dict:
    parsed = parse(text, default_scope=memory_scope_from_path(path))
    return {
        "path": path,
        "text": text,
        "etag": _etag(text),
        "scope": memory_scope_from_path(path),
        "metadata": dict(parsed.extra),
        "records": [record.as_dict() for record in parsed.records],
        "preamble": parsed.preamble,
        "char_count": len(text),
        "max_chars": limit,
        "over_budget": len(text) > limit,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def _require_matching_etag(current: str | None, supplied: str | None, overwrite: bool = False) -> None:
    if overwrite or supplied is None:
        return
    if current is None or _etag(current) != supplied:
        raise HTTPException(status_code=409, detail="The agent changed this file while you were editing")


def _raise_duplicate_title(error: DuplicateMemoryTitleError) -> None:
    raise HTTPException(
        status_code=409,
        detail={
            "code": "duplicate_memory_title",
            "message": str(error),
            "existing_memory_id": error.existing_memory_id,
            "title": error.title,
        },
    ) from error


@router.get("")
async def list_memories(
    ids: str | None = Query(None),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    """List every memory file owned by the authenticated subject."""

    store = _get_store(mongo, settings)
    namespace = memory_store_ns(memory_owner_key(user, settings))
    wanted_ids = {value.strip() for value in (ids or "").split(",") if value.strip()}
    files: list[dict] = []
    for item in store.search(namespace, limit=1000):
        path = _public_path(str(item.key))
        if not is_memory_path(path):
            continue
        if memory_scope_from_path(path) == "project" and not projects_enabled(mongo._db, settings):
            continue
        content = item.value.get("content", "")
        text = "\n".join(content) if isinstance(content, list) else str(content)
        serialized = _serialize_file(path, text, item.updated_at, settings.memory_max_file_chars)
        if wanted_ids and not wanted_ids.intersection(
            str(record["memory_id"]) for record in serialized["records"]
        ):
            continue
        files.append(serialized)
    files.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return {"success": True, "data": {"files": files, "max_file_chars": settings.memory_max_file_chars}}


@router.put("")
async def put_memory_file(
    body: MemoryPutRequest = Body(...),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Clear a memory file; non-empty raw source writes are forbidden."""

    key = _storage_key(body.path)
    _require_available_scope(body.path, mongo, settings)
    if body.text.strip():
        raise HTTPException(
            status_code=403,
            detail="Raw AGENTS.md is read-only; use structured memory Add, Edit, or Delete",
        )

    store = _get_store(mongo, settings)
    namespace = memory_store_ns(memory_owner_key(user, settings))
    current = _read_text(store, namespace, key)
    _require_matching_etag(current, body.etag, body.overwrite)

    if memory_scope_from_path(body.path) == "project":
        if current is None:
            raise HTTPException(status_code=404, detail="Project memory file not found")
        existing = parse(current, default_scope="project")
        text = render(MemoryFile(scope="project", extra=dict(existing.extra)))
        _write_text(store, namespace, key, text)
        return {
            "success": True,
            "data": {"file": _serialize_file(body.path, text, None, settings.memory_max_file_chars)},
        }
    if not body.mounted:
        store.delete(namespace, key)
        return {"success": True, "data": {"deleted": body.path}}
    text = seed_content(body.path)
    _write_text(store, namespace, key, text)
    return {
        "success": True,
        "data": {"file": _serialize_file(body.path, text, None, settings.memory_max_file_chars)},
    }


@router.post("")
async def append_memory(
    body: MemoryAppendRequest = Body(...),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Append the common title/body form as a manual record."""

    key = _storage_key(body.path)
    _require_available_scope(body.path, mongo, settings)
    store = _get_store(mongo, settings)
    namespace = memory_store_ns(memory_owner_key(user, settings))
    current = _read_text(store, namespace, key) or seed_content(body.path)
    if memory_scope_from_path(body.path) == "project" and _read_text(store, namespace, key) is None:
        raise HTTPException(status_code=404, detail="Project memory file not found")
    _require_matching_etag(current, body.etag)
    memory_file = parse(current, default_scope=memory_scope_from_path(body.path))
    now = utc_timestamp()
    promote_freeform_preamble(memory_file, source="manual", now=now)
    record = MemoryRecord(
        memory_id=new_memory_id(),
        title=body.title.strip(),
        body=body.body.strip(),
        source="manual",
        created_at=now,
        updated_at=now,
    )
    conflict = find_title_conflict(memory_file.records, record.title)
    if conflict is not None:
        _raise_duplicate_title(DuplicateMemoryTitleError(record.title, conflict.memory_id))
    memory_file.records.append(record)
    text = render(memory_file)
    if len(text) > settings.memory_max_file_chars:
        raise HTTPException(
            status_code=413,
            detail=f"Memory file must be <= {settings.memory_max_file_chars} characters",
        )
    _write_text(store, namespace, key, text)
    return {
        "success": True,
        "data": {
            "memory": record.as_dict(),
            "file": _serialize_file(body.path, text, None, settings.memory_max_file_chars),
        },
    }


@router.patch("")
async def update_memory(
    body: MemoryUpdateRequest = Body(...),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Update one record by stable id without replacing the whole file."""

    key = _storage_key(body.path)
    _require_available_scope(body.path, mongo, settings)
    store = _get_store(mongo, settings)
    namespace = memory_store_ns(memory_owner_key(user, settings))
    current = _read_text(store, namespace, key)
    if current is None:
        raise HTTPException(status_code=404, detail="Memory file not found")
    _require_matching_etag(current, body.etag)

    memory_file = parse(current, default_scope=memory_scope_from_path(body.path))
    record = next((item for item in memory_file.records if item.memory_id == body.memory_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="Memory not found")

    conflict = find_title_conflict(
        memory_file.records,
        body.title,
        exclude_memory_id=record.memory_id,
    )
    if conflict is not None:
        _raise_duplicate_title(DuplicateMemoryTitleError(body.title, conflict.memory_id))

    record.title = body.title.strip()
    record.body = body.body.strip()
    record.updated_at = utc_timestamp()
    text = render(memory_file)
    if len(text) > settings.memory_max_file_chars and len(text) >= len(current):
        raise HTTPException(
            status_code=413,
            detail=f"Memory file must be <= {settings.memory_max_file_chars} characters",
        )
    _write_text(store, namespace, key, text)
    return {
        "success": True,
        "data": {
            "memory": record.as_dict(),
            "file": _serialize_file(body.path, text, None, settings.memory_max_file_chars),
        },
    }


@router.delete("")
async def delete_memory(
    id: str = Query(..., min_length=1),  # noqa: A002 - public API name
    etag: str | None = Query(None),
    path: str | None = Query(None),
    mounted: bool = Query(True),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Delete one record by stable id without exposing the store namespace."""

    store = _get_store(mongo, settings)
    namespace = memory_store_ns(memory_owner_key(user, settings))
    candidates = []
    if path:
        _require_available_scope(path, mongo, settings)
        candidates.append((_storage_key(path), path))
    else:
        candidates.extend(
            (str(item.key), _public_path(str(item.key)))
            for item in store.search(namespace, limit=1000)
        )

    for key, public_path in candidates:
        if not is_memory_path(public_path):
            continue
        if memory_scope_from_path(public_path) == "project" and not projects_enabled(mongo._db, settings):
            continue
        current = _read_text(store, namespace, key)
        if current is None:
            continue
        memory_file = parse(current, default_scope=memory_scope_from_path(public_path))
        if id not in {record.memory_id for record in memory_file.records}:
            continue
        _require_matching_etag(current, etag)
        memory_file.records = [record for record in memory_file.records if record.memory_id != id]
        if not memory_file.records and not mounted and memory_scope_from_path(public_path) != "project":
            store.delete(namespace, key)
            return {"success": True, "data": {"deleted": id, "file_deleted": True}}
        text = render(memory_file)
        _write_text(store, namespace, key, text)
        return {
            "success": True,
            "data": {
                "deleted": id,
                "file": _serialize_file(public_path, text, None, settings.memory_max_file_chars),
            },
        }
    raise HTTPException(status_code=404, detail="Memory not found")

from __future__ import annotations

import csv
import io
import json
import logging
import re
from typing import Any
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from deepeval_eval.api.auth import (
    ResourceType,
    ResourceVisibility,
    UserContext,
    authorize_evaluate,
    authorize_question_set_access,
    get_allowed_resource_ids,
    get_current_user,
    update_resource_visibility,
    write_question_set_ownership,
)
from deepeval_eval.db.db_manager import DatabaseManager
from deepeval_eval.db.question_db_manager import MAX_BATCH_DELETE_ITEMS

logger = logging.getLogger(__name__)

MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB limit
CHUNK_SIZE_BYTES = 64 * 1024  # 64 KB buffer for optimal async IO throughput
JSON_FILE_EXT = ".json"

router = APIRouter(prefix="/question-sets", tags=["Question Sets"])

# ---------------------------------------------------------------------------
# Pydantic DTOs
# ---------------------------------------------------------------------------


class QuestionSetCreate(BaseModel):
    name: str = Field(..., description="Name of the question set")
    description: str | None = Field(
        default=None, description="Description of the question set"
    )
    source_format: str | None = Field(
        default=None, description="Source format (e.g. jsonl, csv)"
    )
    owner_team: str | None = Field(
        default=None, description="Owning team slug for RBAC authorization"
    )
    visibility: str | None = Field(
        default="private", description="Visibility mode: private, team, or public"
    )


class QuestionSetUpdate(BaseModel):
    name: str | None = Field(default=None, description="Updated name of question set")
    description: str | None = Field(default=None, description="Updated description")
    source_format: str | None = Field(default=None, description="Updated source format")


class QuestionSetResponse(BaseModel):
    id: int
    name: str
    description: str | None = None
    source_format: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    question_count: int = 0
    categories: dict[str, int] | None = None


class QuestionSetListResponse(BaseModel):
    items: list[QuestionSetResponse]
    total: int
    page: int
    limit: int
    total_pages: int


class QuestionCreate(BaseModel):
    question_id: str | None = Field(
        default=None, description="Custom question string identifier"
    )
    input: str = Field(..., description="User question / prompt input text")
    expected_output: str | None = Field(
        default=None, description="Expected ground truth answer reference"
    )
    category: str | None = Field(default=None, description="Category / domain tag")
    level: str | None = Field(default=None, description="Difficulty level")
    expected_doc_ids: list[str] = Field(
        default_factory=list, description="Expected source document IDs"
    )
    context: dict[str, Any] | list[Any] | None = Field(
        default=None, description="Context payload"
    )
    extra: dict[str, Any] | None = Field(default=None, description="Extra metadata")


class QuestionUpdate(BaseModel):
    question_id: str | None = None
    input: str | None = None
    expected_output: str | None = None
    category: str | None = None
    level: str | None = None
    expected_doc_ids: list[str] | None = None
    context: dict[str, Any] | list[Any] | None = None
    extra: dict[str, Any] | None = None


class QuestionResponse(BaseModel):
    id: int
    question_set_id: int
    question_id: str | None = None
    input: str
    expected_output: str | None = None
    category: str | None = None
    level: str | None = None
    expected_doc_ids: list[str] = Field(default_factory=list)
    context: Any = None
    extra: Any = None
    created_at: str | None = None
    updated_at: str | None = None


class QuestionListResponse(BaseModel):
    items: list[QuestionResponse]
    total: int
    page: int
    limit: int
    total_pages: int


class BatchDeleteRequest(BaseModel):
    ids: list[int] = Field(
        ...,
        min_length=1,
        max_length=MAX_BATCH_DELETE_ITEMS,
        description="List of integer IDs to delete",
        examples=[[101, 102, 103]],
    )


class BatchDeleteResponse(BaseModel):
    deleted_count: int


# ---------------------------------------------------------------------------
# Helper Ingestion Functions
# ---------------------------------------------------------------------------


async def read_bounded_file(file: UploadFile, max_bytes: int | None = None) -> bytes:
    """Read upload file stream in 64KB chunks up to max_bytes to prevent OOM memory exhaustion."""
    limit = MAX_UPLOAD_SIZE_BYTES if max_bytes is None else max_bytes
    uploaded_size = 0
    chunks: list[bytes] = []

    while chunk := await file.read(CHUNK_SIZE_BYTES):
        uploaded_size += len(chunk)
        if uploaded_size > limit:
            max_mb = limit // (1024 * 1024)
            filename_str = f" '{file.filename}'" if file.filename else ""
            detail_msg = (
                f"Uploaded file{filename_str} exceeds maximum allowed size of {max_mb} MB."
                if max_mb > 0
                else f"Uploaded file{filename_str} exceeds maximum allowed size limit."
            )
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=detail_msg,
            )
        chunks.append(chunk)

    return b"".join(chunks)


def parse_questions_file_content(
    content: bytes, filename: str | None
) -> list[dict[str, Any]]:
    """Parse JSON, JSONL, or CSV bytes into a list of normalized question dicts."""
    filename_lower = (filename or "").lower()
    items: list[dict[str, Any]] = []

    if filename_lower.endswith(".jsonl") or not filename_lower.endswith(
        (JSON_FILE_EXT, ".csv")
    ):
        # Try JSONL parsing line-by-line
        text = content.decode("utf-8", errors="replace")
        for line in text.splitlines():
            line_str = line.strip()
            if not line_str:
                continue
            try:
                item = json.loads(line_str)
                if isinstance(item, dict):
                    items.append(item)
            except json.JSONDecodeError as err:
                logger.warning("Skipping unparseable JSONL line: %s", err)

        if items:
            return items

    if filename_lower.endswith(".csv"):
        text = content.decode("utf-8", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            doc_ids_raw = row.get("expected_doc_ids") or row.get("doc_ids") or ""
            doc_ids: list[str] = []
            if doc_ids_raw:
                if doc_ids_raw.startswith("[") and doc_ids_raw.endswith("]"):
                    try:
                        doc_ids = json.loads(doc_ids_raw)
                    except Exception:
                        doc_ids = [
                            d.strip()
                            for d in doc_ids_raw.strip("[]").split(",")
                            if d.strip()
                        ]
                else:
                    doc_ids = [d.strip() for d in doc_ids_raw.split(",") if d.strip()]

            items.append(
                {
                    "question_id": row.get("question_id"),
                    "input": row.get("input") or row.get("user_input") or "",
                    "expected_output": row.get("expected_output")
                    or row.get("reference")
                    or "",
                    "category": row.get("category"),
                    "level": row.get("level"),
                    "expected_doc_ids": doc_ids,
                }
            )
        return items

    if filename_lower.endswith(JSON_FILE_EXT):
        text = content.decode("utf-8", errors="replace")
        data = json.loads(text)
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
        elif isinstance(data, dict):
            if "questions" in data and isinstance(data["questions"], list):
                return [d for d in data["questions"] if isinstance(d, dict)]
            return [data]

    return items


def get_db_manager() -> DatabaseManager:
    return DatabaseManager()


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------


@router.post(
    "", response_model=QuestionSetResponse, status_code=status.HTTP_201_CREATED
)
async def create_question_set(
    name: str = Form(...),
    description: str | None = Form(default=None),
    source_format: str | None = Form(default=None),
    owner_team: str | None = Form(default=None),
    visibility: str | None = Form(default="private"),
    file: UploadFile | None = File(default=None),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """Create a new question set (blank or initialized via JSONL/CSV file upload)."""
    await authorize_evaluate(user)

    detected_format = source_format
    if file and file.filename:
        if file.filename.endswith(".jsonl"):
            detected_format = detected_format or "jsonl"
        elif file.filename.endswith(".csv"):
            detected_format = detected_format or "csv"
        elif file.filename.endswith(JSON_FILE_EXT):
            detected_format = detected_format or "json"

    qset = db.questions.create_question_set(
        name=name.strip(),
        description=description.strip() if description else None,
        source_format=detected_format,
    )

    if file:
        content = await read_bounded_file(file)
        questions = parse_questions_file_content(content, file.filename)
        if questions:
            db.questions.add_questions(qset["id"], questions)
            qset = db.questions.get_question_set(qset["id"]) or qset

    await write_question_set_ownership(qset["id"], owner_team, visibility, user)
    return qset


@router.get("", response_model=QuestionSetListResponse)
async def list_question_sets(
    page: int = Query(default=1, ge=1, description="Page number"),
    limit: int = Query(default=50, ge=1, le=200, description="Items per page"),
    query: str | None = Query(
        default=None, description="Search term for name or description"
    ),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """List question sets with pagination, search, and ReBAC authorization filtering."""
    allowed_raw = await get_allowed_resource_ids(user, "question_set", "can_read")
    allowed_ids: list[int] | None = None
    if allowed_raw is not None:
        allowed_ids = []
        for raw_id in allowed_raw:
            try:
                allowed_ids.append(int(raw_id))
            except ValueError:
                pass

    return db.questions.list_question_sets(
        page=page, limit=limit, query=query, allowed_ids=allowed_ids
    )


@router.get(
    "/{set_id}",
    response_model=QuestionSetResponse,
    responses={
        404: {"description": "Not Found - Question set not found"},
    },
)
async def get_question_set(
    set_id: int,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """Get question set details and summary stats by ID."""
    await authorize_question_set_access(user, str(set_id), "read")
    qset = db.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )
    return qset


@router.put(
    "/{set_id}",
    response_model=QuestionSetResponse,
    responses={
        404: {"description": "Not Found - Question set not found"},
    },
)
async def update_question_set(
    set_id: int,
    payload: QuestionSetUpdate,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """Update question set metadata."""
    await authorize_question_set_access(user, str(set_id), "manage")
    qset = db.questions.update_question_set(
        set_id=set_id,
        name=payload.name,
        description=payload.description,
        source_format=payload.source_format,
    )
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )
    return qset


@router.delete(
    "/{set_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        404: {"description": "Not Found - Question set not found"},
    },
)
async def delete_question_set(
    set_id: int,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> None:
    """Delete a question set and all its associated questions."""
    await authorize_question_set_access(user, str(set_id), "manage")
    success = db.questions.delete_question_set(set_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )


@router.post(
    "/{set_id}/questions",
    response_model=list[QuestionResponse],
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"description": "Bad Request - Invalid questions data"},
        404: {"description": "Not Found - Question set not found"},
    },
)
async def add_questions_to_set(
    set_id: int,
    payload: list[QuestionCreate] | QuestionCreate,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> list[dict[str, Any]]:
    """Add questions to a set via JSON request body (single question object or list of objects)."""
    await authorize_question_set_access(user, str(set_id), "manage")
    qset = db.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )

    if isinstance(payload, list):
        questions_to_add = [item.model_dump(exclude_unset=True) for item in payload]
    else:
        questions_to_add = [payload.model_dump(exclude_unset=True)]

    if not questions_to_add:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No questions provided in request body.",
        )

    try:
        return db.questions.add_questions(set_id, questions_to_add)
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(val_err),
        )


@router.post(
    "/{set_id}/questions/upload",
    response_model=list[QuestionResponse],
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"description": "Bad Request - Invalid or unparseable uploaded file"},
        404: {"description": "Not Found - Question set not found"},
    },
)
async def upload_questions_file_to_set(
    set_id: int,
    file: UploadFile = File(...),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> list[dict[str, Any]]:
    """Upload new questions to a question set via file upload (.jsonl, .csv, .json)."""
    await authorize_question_set_access(user, str(set_id), "manage")
    qset = db.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )

    content = await read_bounded_file(file)
    questions_to_add = parse_questions_file_content(content, file.filename)

    if not questions_to_add:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not parse valid questions from uploaded file '{file.filename}'.",
        )

    try:
        return db.questions.add_questions(set_id, questions_to_add)
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(val_err),
        )


@router.get(
    "/{set_id}/questions",
    response_model=QuestionListResponse,
    responses={
        404: {"description": "Not Found - Question set not found"},
    },
)
async def list_questions_in_set(
    set_id: int,
    page: int = Query(default=1, ge=1, description="Page number"),
    limit: int = Query(default=50, ge=1, le=200, description="Items per page"),
    category: str | None = Query(default=None, description="Filter by category"),
    level: str | None = Query(default=None, description="Filter by difficulty level"),
    query: str | None = Query(
        default=None,
        description="Global search query across input, expected_output, and question_id",
    ),
    question_id: str | None = Query(
        default=None, description="Filter specifically by exact question_id"
    ),
    question_input: str | None = Query(
        default=None, description="Filter specifically by input text"
    ),
    expected_output: str | None = Query(
        default=None, description="Filter specifically by expected output"
    ),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """List questions in a question set with pagination and filters."""
    await authorize_question_set_access(user, str(set_id), "read")
    qset = db.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )

    return db.questions.list_questions(
        set_id=set_id,
        page=page,
        limit=limit,
        category=category,
        level=level,
        query=query,
        question_id=question_id,
        question_input=question_input,
        expected_output=expected_output,
    )


@router.get(
    "/{set_id}/questions/{id}",
    response_model=QuestionResponse,
    responses={
        404: {"description": "Not Found - Question not found"},
    },
)
async def get_question_by_id(
    set_id: int,
    id: int,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """Get a single question by id."""
    await authorize_question_set_access(user, str(set_id), "read")
    q = db.questions.get_question_by_id(set_id, id)
    if not q:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question id={id} not found in question set {set_id}.",
        )
    return q


@router.put(
    "/{set_id}/questions/{id}",
    response_model=QuestionResponse,
    responses={
        404: {"description": "Not Found - Question not found"},
    },
)
async def update_question_by_id(
    set_id: int,
    id: int,
    payload: QuestionUpdate,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, Any]:
    """Edit a question by id."""
    await authorize_question_set_access(user, str(set_id), "manage")
    updated = db.questions.update_question_by_id(
        set_id, id, payload.model_dump(exclude_unset=True)
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question id={id} not found in question set {set_id}.",
        )
    return updated


@router.delete(
    "/{set_id}/questions/{id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        404: {"description": "Not Found - Question not found"},
    },
)
async def delete_question_by_id(
    set_id: int,
    id: int,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> None:
    """Delete a single question by id."""
    await authorize_question_set_access(user, str(set_id), "manage")
    success = db.questions.delete_question_by_id(set_id, id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question id={id} not found in question set {set_id}.",
        )


@router.post(
    "/{set_id}/questions/batch-delete",
    response_model=BatchDeleteResponse,
    responses={
        400: {"description": "Bad Request - Invalid batch delete request"},
        404: {"description": "Not Found - Question set not found"},
    },
)
async def batch_delete_questions(
    set_id: int,
    payload: BatchDeleteRequest,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> dict[str, int]:
    """Batch delete multiple questions in a set."""
    await authorize_question_set_access(user, str(set_id), "manage")
    qset = db.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )

    try:
        deleted_count = db.questions.batch_delete_questions(set_id, ids=payload.ids)
        return {"deleted_count": deleted_count}
    except ValueError as val_err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(val_err),
        )


@router.get(
    "/{set_id}/export",
    responses={
        404: {"description": "Not Found - Question set not found"},
    },
)
async def export_question_set(
    set_id: int,
    format: str = Query(
        default="jsonl",
        pattern="^(jsonl|csv)$",
        description="Export format: jsonl or csv",
    ),
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> StreamingResponse:
    """Export question set as JSONL or CSV file download."""
    await authorize_question_set_access(user, str(set_id), "read")
    qset = db.questions.get_question_set(set_id)
    if not qset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Question set {set_id} not found.",
        )

    name_clean = (
        re.sub(r"[^\w-]+", "_", qset["name"]).strip("_").lower() or "question_set"
    )
    filename_ascii = f"{name_clean}.{format}"
    filename_encoded = quote(f"{qset['name']}.{format}")
    content_disposition = (
        f'attachment; filename="{filename_ascii}"; '
        f"filename*=UTF-8''{filename_encoded}"
    )

    if format == "csv":

        def generate_csv():
            output = io.StringIO()
            writer = csv.DictWriter(
                output,
                fieldnames=[
                    "question_id",
                    "input",
                    "expected_output",
                    "category",
                    "level",
                    "expected_doc_ids",
                ],
            )
            writer.writeheader()
            yield output.getvalue()

            for q in db.questions.stream_questions(set_id=set_id):
                output.seek(0)
                output.truncate(0)
                writer.writerow(
                    {
                        "question_id": q.get("question_id"),
                        "input": q.get("input"),
                        "expected_output": q.get("expected_output"),
                        "category": q.get("category"),
                        "level": q.get("level"),
                        "expected_doc_ids": json.dumps(q.get("expected_doc_ids") or []),
                    }
                )
                yield output.getvalue()

        return StreamingResponse(
            generate_csv(),
            media_type="text/csv",
            headers={"Content-Disposition": content_disposition},
        )
    else:  # jsonl
        reserved_keys = {
            "question_id",
            "user_input",
            "reference",
            "category",
            "level",
            "expected_doc_ids",
            "context",
        }

        def generate_jsonl():
            for q in db.questions.stream_questions(set_id=set_id):
                row = {
                    "question_id": q.get("question_id"),
                    "user_input": q.get("input"),
                    "reference": q.get("expected_output"),
                    "category": q.get("category"),
                    "level": q.get("level"),
                    "expected_doc_ids": q.get("expected_doc_ids") or [],
                }
                if q.get("context"):
                    row["context"] = q["context"]

                if q.get("extra") and isinstance(q["extra"], dict):
                    for key, val in q["extra"].items():
                        if key not in reserved_keys:
                            row[key] = val
                        else:
                            row[f"extra_{key}"] = val
                yield json.dumps(row) + "\n"

        return StreamingResponse(
            generate_jsonl(),
            media_type="application/x-ndjson",
            headers={"Content-Disposition": content_disposition},
        )


class ChangeQuestionSetVisibilityRequest(BaseModel):
    visibility: ResourceVisibility = Field(
        default=ResourceVisibility.PRIVATE,
        description="Target visibility mode: 'private', 'team', or 'public'",
    )
    owner_team: str | None = Field(
        default=None, description="Optional target owner team slug"
    )


@router.patch(
    "/{set_id}/visibility",
    response_model=QuestionSetResponse,
    summary="Update Question Set Visibility & Ownership",
    responses={
        404: {"description": "Not Found - Question Set not found"},
    },
)
async def update_question_set_visibility(
    set_id: int,
    request: ChangeQuestionSetVisibilityRequest,
    user: UserContext = Depends(get_current_user),
    db: DatabaseManager = Depends(get_db_manager),
) -> QuestionSetResponse:
    """Update visibility ('private', 'team', 'public') and owner team for a Question Set."""
    await authorize_question_set_access(user, str(set_id), "manage")
    qset = db.question_sets.get_question_set(set_id)
    if not qset:
        raise HTTPException(status_code=404, detail=f"Question Set #{set_id} not found")

    await update_resource_visibility(
        ResourceType.QUESTION_SET, set_id, request.visibility, request.owner_team, user
    )
    return QuestionSetResponse.model_validate(qset)

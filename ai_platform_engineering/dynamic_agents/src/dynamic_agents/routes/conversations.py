"""Conversations endpoint for Dynamic Agents.

Provides access to conversation state stored in the LangGraph checkpointer:
interrupt state, files, and clear operations.

Messages are served by the Next.js layer directly from MongoDB.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from pymongo.database import Database

from dynamic_agents.auth.access import can_access_conversation
from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.config import get_settings
from dynamic_agents.models import ApiResponse
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.runtime_cache import get_runtime_cache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _get_gridfs_store(db: Database) -> MongoDBGridFSStore:
    """Get a GridFS store instance for the given database."""
    settings = get_settings()
    return MongoDBGridFSStore(db=db, bucket_name=settings.gridfs_bucket_name)


class InterruptData(BaseModel):
    """Data for a pending HITL interrupt (discriminated by type)."""

    type: str = "form_input"  # "form_input" or "tool_approval"
    interrupt_id: str
    # form_input fields
    prompt: str = ""
    fields: list[dict] = []
    # tool_approval fields (first tool for backwards compat)
    tool_name: str | None = None
    tool_args: dict | None = None
    allowed_decisions: list[str] | None = None
    # multi-tool approval (list of all tools needing approval)
    tool_approvals: list[dict] | None = None


class InterruptStateResponse(BaseModel):
    """Response containing only the HITL interrupt state (no messages)."""

    conversation_id: str
    agent_id: str
    has_pending_interrupt: bool = False
    interrupt_data: InterruptData | None = None


class RewindConversationRequest(BaseModel):
    """Request to fork a conversation before an existing user turn."""

    agent_id: str
    turn_id: str
    message_content: str
    content_occurrence: int = Field(ge=1)


@router.get("/{conversation_id}/interrupt-state", response_model=InterruptStateResponse)
async def get_interrupt_state(
    conversation_id: str,
    agent_id: str = Query(..., description="Dynamic agent ID"),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> InterruptStateResponse:
    """Get HITL interrupt state for a conversation (lightweight, no messages).

    This is a lightweight endpoint that only checks if there's a pending
    human-in-the-loop interrupt. It does NOT fetch messages - use the
    standard /api/chat/conversations/{id}/messages endpoint for that.

    Used by the UI to restore HITL forms after page refresh while loading
    messages from the MongoDB messages collection.
    """
    # 1. Verify agent exists
    agent = mongo.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # 2. Check conversation exists and user has access
    if mongo._client is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    db = mongo._db
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")

    conversations_coll = db["conversations"]
    conversation = conversations_coll.find_one({"_id": conversation_id})

    if not conversation:
        # Conversation doesn't exist yet - no interrupt possible
        return InterruptStateResponse(
            conversation_id=conversation_id,
            agent_id=agent_id,
            has_pending_interrupt=False,
        )

    # 3. Check access
    if not can_access_conversation(conversation, user):
        raise HTTPException(status_code=403, detail="Access denied")

    # 4. Get MCP servers for the agent and its subagents (needed to create runtime)
    mcp_servers = mongo.get_agent_mcp_servers(agent)

    # 5. Create a non-cached, read-only runtime to access the checkpointer.
    #
    # This is a read-only probe: it only needs the durable LangGraph
    # checkpoint to answer "is there a pending interrupt?". Routing it
    # through the shared runtime cache (get_or_create) would key a runtime
    # for this conversation_id and leave it cached for reuse. If MCP server
    # initialization degrades or fails closed at probe time — e.g. a
    # transient connection error, or credentials not yet available in this
    # request's context — the next real chat call on the same conversation
    # reuses that degraded, cached runtime instead of getting a fresh one.
    #
    # `cache.reader()` (not `cache.persistent()`) is required here: a normal
    # runtime's initialize() clears and reseeds the shared GridFS skill-file
    # namespace for StoreBackend agents, which is keyed by
    # (agent_id, session_id, "filesystem") — the same namespace a real,
    # healthy cached chat runtime for this conversation already uses. A
    # `persistent()` runtime would delete those live skill files as a side
    # effect of this probe and only reseed them on success; `reader()` skips
    # that write entirely while still reading the same durable checkpoint.
    cache = get_runtime_cache()
    cache.set_mongo_service(mongo)

    async with cache.reader(
        agent,
        mcp_servers,
        conversation_id,
        user=user,
    ) as runtime:
        # 6. Check for pending interrupt only (no message extraction)
        if not runtime._graph:
            return InterruptStateResponse(
                conversation_id=conversation_id,
                agent_id=agent_id,
                has_pending_interrupt=False,
            )

        interrupt_data = await runtime.has_pending_interrupt(conversation_id)
    has_pending_interrupt = interrupt_data is not None

    logger.debug(
        f"Checked interrupt state for conversation {conversation_id}: has_pending_interrupt={has_pending_interrupt}"
    )

    return InterruptStateResponse(
        conversation_id=conversation_id,
        agent_id=agent_id,
        has_pending_interrupt=has_pending_interrupt,
        interrupt_data=InterruptData(**interrupt_data) if interrupt_data else None,
    )


@router.post("/{conversation_id}/metadata")
async def ensure_conversation_metadata(
    conversation_id: str,
    agent_id: str = Query(..., description="Dynamic agent ID"),
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Ensure conversation metadata exists in the conversations collection.

    This is called when starting a new conversation to create the metadata
    record that makes the conversation appear in the sidebar.

    Uses upsert to avoid duplicates - if the conversation already exists,
    only updated_at is modified.
    """
    # Verify agent exists
    agent = mongo.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Upsert conversation metadata
    if mongo._client is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    db = mongo._db
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")

    conversations_coll = db["conversations"]

    now = datetime.now(timezone.utc)

    result = conversations_coll.update_one(
        {"_id": conversation_id},
        {
            "$setOnInsert": {
                "_id": conversation_id,
                "title": f"Chat with {agent.name}",
                "owner_id": user.email,
                "created_at": now,
                "metadata": {
                    "client_type": "api",
                    "agent_name": agent.name,
                    "total_messages": 0,
                },
                "sharing": {
                    "is_public": False,
                    "shared_with": [],
                    "shared_with_teams": [],
                    "share_link_enabled": False,
                },
                "tags": [],
                "is_archived": False,
                "is_pinned": False,
            },
            "$set": {
                "updated_at": now,
                "agent_id": agent_id,
            },
        },
        upsert=True,
    )

    created = result.upserted_id is not None
    logger.info(
        f"Conversation metadata {'created' if created else 'updated'}: "
        f"conversation_id={conversation_id}, agent_id={agent_id}, user={user.email}"
    )

    return {
        "success": True,
        "conversation_id": conversation_id,
        "created": created,
    }


@router.post("/{conversation_id}/rewind", response_model=ApiResponse)
async def rewind_conversation(
    conversation_id: str,
    request: RewindConversationRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Fork LangGraph state from immediately before the selected user turn."""
    agent = mongo.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if mongo._client is None or mongo._db is None:
        raise HTTPException(status_code=503, detail="Database not connected")

    conversation = mongo._db["conversations"].find_one({"_id": conversation_id})
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not can_access_conversation(conversation, user):
        raise HTTPException(status_code=403, detail="Access denied")

    configured_agent_id = conversation.get("agent_id")
    if not configured_agent_id:
        configured_agent_id = next(
            (
                participant.get("id")
                for participant in conversation.get("participants", [])
                if participant.get("type") == "agent"
            ),
            None,
        )
    if configured_agent_id and configured_agent_id != request.agent_id:
        raise HTTPException(status_code=400, detail="Agent does not match conversation")

    cache = get_runtime_cache()
    cache.set_mongo_service(mongo)
    runtime = await cache.get_or_create(
        agent,
        mongo.get_agent_mcp_servers(agent),
        conversation_id,
        user=user,
    )

    try:
        checkpoint_id = await runtime.rewind_before_turn(
            conversation_id,
            request.turn_id,
            request.message_content,
            request.content_occurrence,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return ApiResponse(
        success=True,
        data={
            "conversation_id": conversation_id,
            "turn_id": request.turn_id,
            "checkpoint_id": checkpoint_id,
        },
    )


# =============================================================================
# Admin Endpoints
# =============================================================================


@router.post("/{conversation_id}/clear", response_model=ApiResponse)
async def clear_conversation_checkpoints(
    conversation_id: str,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Clear checkpoint data for a conversation (admin only).

    This removes all messages from the LangGraph checkpointer collections
    but keeps the conversation metadata record.

    The action is logged for audit purposes.

    Requires admin role (checked via X-User-Context from gateway).
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    if mongo._client is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    db = mongo._db
    if db is None:
        raise HTTPException(status_code=503, detail="Database not connected")

    conversations_coll = db["conversations"]
    settings = get_settings()
    checkpoints_coll = db[settings.checkpoint_collection]
    writes_coll = db[settings.checkpoint_writes_collection]

    # Verify conversation exists
    conversation = conversations_coll.find_one({"_id": conversation_id})
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Delete checkpoint data
    checkpoints_result = checkpoints_coll.delete_many({"thread_id": conversation_id})
    writes_result = writes_coll.delete_many({"thread_id": conversation_id})

    # Delete GridFS files for this conversation
    agent_id = conversation.get("agent_id", "")
    store = _get_gridfs_store(db)
    files_deleted = 0
    if agent_id:
        files_deleted = store.delete_by_namespace((agent_id, conversation_id, "filesystem"))

    # Log the action for audit
    logger.info(
        f"Admin {user.email} cleared conversation {conversation_id}: "
        f"deleted {checkpoints_result.deleted_count} checkpoints, "
        f"{writes_result.deleted_count} writes, {files_deleted} files"
    )

    return ApiResponse(
        success=True,
        data={
            "conversation_id": conversation_id,
            "checkpoints_deleted": checkpoints_result.deleted_count,
            "writes_deleted": writes_result.deleted_count,
            "files_deleted": files_deleted,
        },
    )

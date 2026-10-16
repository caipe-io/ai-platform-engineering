"""Conversations endpoint for Dynamic Agents.

Provides access to conversation state stored in the LangGraph checkpointer:
interrupt state, files, and clear operations.

Messages are served by the Next.js layer directly from MongoDB.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from dynamic_agents.auth.access import can_access_conversation
from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.auth.authz import require_conversation_delete_permission
from dynamic_agents.models import ApiResponse, DynamicAgentConfig
from dynamic_agents.services.agent_execution import AgentExecutionService
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.native_run_repository import NativeRunStorageError
from dynamic_agents.services.runtime_cache import RuntimeCapacityError
from dynamic_agents.services.sandbox_client import SandboxError
from dynamic_agents.services.session_runs import SessionRunBusyError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


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


class ConfirmRewindRequest(RewindConversationRequest):
    checkpoint_id: str = Field(min_length=1)


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

    try:
        interrupt_data = await AgentExecutionService(mongo).interrupt_state(agent, conversation_id, user)
    except RuntimeCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
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


def _authorize_rewind(
    conversation_id: str, agent_id: str, user: UserContext, mongo: MongoDBService,
) -> DynamicAgentConfig:
    """Keep native state mutation and its UI-history acknowledgement identical."""
    agent = mongo.get_agent(agent_id)
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
    if configured_agent_id and configured_agent_id != agent_id:
        raise HTTPException(status_code=400, detail="Agent does not match conversation")
    return agent


@router.post("/{conversation_id}/rewind", response_model=ApiResponse)
async def rewind_conversation(
    conversation_id: str,
    request: RewindConversationRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Restore native state from immediately before the selected user turn."""
    agent = _authorize_rewind(conversation_id, request.agent_id, user, mongo)
    service = AgentExecutionService(mongo)

    try:
        checkpoint_id = await service.rewind(
            agent, conversation_id, user,
            turn_id=request.turn_id, message_content=request.message_content,
            content_occurrence=request.content_occurrence,
        )
    except NativeRunStorageError as exc:
        raise HTTPException(status_code=503, detail="Durable agent state is unavailable. Please retry later.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (RuntimeError, RuntimeCapacityError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return ApiResponse(
        success=True,
        data={
            "conversation_id": conversation_id,
            "turn_id": request.turn_id,
            "checkpoint_id": checkpoint_id,
            "confirmation_required": await service.requires_rewind_confirmation(request.agent_id, conversation_id),
        },
    )


@router.post("/{conversation_id}/rewind/confirm", response_model=ApiResponse)
async def confirm_conversation_rewind(
    conversation_id: str,
    request: ConfirmRewindRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Acknowledge canonical history truncation before sandbox prompts resume."""
    _authorize_rewind(conversation_id, request.agent_id, user, mongo)
    try:
        await AgentExecutionService(mongo).confirm_rewind(
            request.agent_id, conversation_id, user, checkpoint_id=request.checkpoint_id,
            turn_id=request.turn_id, message_content=request.message_content, content_occurrence=request.content_occurrence,
        )
    except NativeRunStorageError as exc:
        raise HTTPException(status_code=503, detail="Durable agent state is unavailable. Please retry later.") from exc
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return ApiResponse(success=True, data={"conversation_id": conversation_id, "checkpoint_id": request.checkpoint_id})


# =============================================================================
# Admin Endpoints
# =============================================================================


@router.post("/{conversation_id}/cleanup", response_model=ApiResponse)
async def cleanup_conversation_runtime(
    conversation_id: str,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> ApiResponse:
    """Delete external execution state before the BFF purges an authorized chat.

    Runtime targets come only from canonical conversation metadata, never from
    caller-provided namespace or agent identifiers. Ordinary clear stays admin-only.
    """
    if mongo._client is None or mongo._db is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    conversation = mongo._db["conversations"].find_one({"_id": conversation_id})
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await require_conversation_delete_permission(conversation_id)
    agent_id = next((item.get("id") for item in conversation.get("participants", [])
                     if item.get("type") == "agent" and item.get("id")), conversation.get("agent_id", ""))
    if not agent_id:
        raise HTTPException(status_code=409, detail="Conversation has no bound agent")
    session_ids = {conversation_id}
    if conversation.get("source") == "autonomous":
        context_id = conversation.get("execution_context_id")
        if not isinstance(context_id, str) or not context_id.strip():
            task_id = conversation.get("task_id") or conversation.get("metadata", {}).get("task_id")
            run = mongo._db[mongo.settings.autonomous_runs_collection].find_one(
                {"task_id": task_id, "execution_context_id": {"$ne": None}}, sort=[("started_at", -1)],
            ) if task_id else None
            context_id = run.get("execution_context_id") if run else None
        if isinstance(context_id, str) and context_id.strip():
            session_ids.add(context_id)
    try:
        for session_id in sorted(session_ids):
            await AgentExecutionService(mongo).clear(agent_id, session_id, permanent=True)
    except SessionRunBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except NativeRunStorageError as exc:
        raise HTTPException(status_code=503, detail="Durable agent state is unavailable. Please retry later.") from exc
    except SandboxError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return ApiResponse(success=True, data={"conversation_id": conversation_id, "session_ids": sorted(session_ids)})


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

    # Verify conversation exists
    conversation = conversations_coll.find_one({"_id": conversation_id})
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Canonical UI records bind the agent through participants. Older native
    # records used agent_id; both must resolve the same checkpoint/journal scope.
    agent_id = next(
        (participant["id"] for participant in conversation.get("participants", [])
         if participant.get("type") == "agent" and participant.get("id")),
        conversation.get("agent_id", ""),
    )
    try:
        result = await AgentExecutionService(mongo).clear(agent_id, conversation_id)
    except SessionRunBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except NativeRunStorageError as exc:
        raise HTTPException(status_code=503, detail="Durable agent state is unavailable. Please retry later.") from exc
    except SandboxError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    # Log the action for audit
    logger.info(
        f"Admin {user.email} cleared conversation {conversation_id}: "
        f"deleted {result.checkpoints_deleted} checkpoints, "
        f"{result.writes_deleted} writes, {result.files_deleted} files"
    )

    return ApiResponse(
        success=True,
        data={
            "conversation_id": conversation_id,
            "checkpoints_deleted": result.checkpoints_deleted,
            "writes_deleted": result.writes_deleted,
            "files_deleted": result.files_deleted,
        },
    )

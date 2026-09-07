"""Chat endpoint for Dynamic Agents with SSE streaming."""

import logging
from contextlib import AsyncExitStack
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.auth.authz import (
    require_agent_use_permission,
    require_autonomous_permission,
)
from dynamic_agents.config import get_settings
from dynamic_agents.log_config import conversation_id_var
from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, InputFile, UserContext
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.llm_clients import LLMConfigError
from dynamic_agents.services.memory_paths import memory_owner_key, validate_project_id
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.platform_projects import projects_enabled
from dynamic_agents.services.projects import get_project
from dynamic_agents.services.runtime_cache import (
    RuntimeCapacityError,
    RuntimeInitError,
    get_runtime_cache,
)
from dynamic_agents.services.stream_encoders import StreamEncoder, get_encoder

logger = logging.getLogger(__name__)


async def _enforce_chat_authz(*, agent_id: str, user_sub: str | None, autonomous: bool) -> None:
    """Authorize a chat call.

    Every caller needs access to the selected agent. Autonomous calls also
    require the user to belong to at least one autonomous-enabled team.
    """
    await require_agent_use_permission(agent_id, delegated_user_sub=user_sub)
    if autonomous:
        await require_autonomous_permission(delegated_user_sub=user_sub)


# Fields that CANNOT be overridden via config_override
_REJECTED_OVERRIDE_FIELDS: set[str] = {
    "ui",
    "name",
    "description",
    "owner_id",
    "visibility",
    "shared_with_teams",
    "enabled",
    "is_system",
    "config_driven",
    "id",
    "created_at",
    "updated_at",
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Deep merge override into base dict. Override values win for scalars/lists.

    For nested dicts, recurse so partial overrides don't clobber sibling keys.
    """
    merged = base.copy()
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def apply_config_override(agent: DynamicAgentConfig, config_override: dict[str, Any]) -> DynamicAgentConfig:
    """Apply config_override to a DynamicAgentConfig, returning a new instance.

    Validates that only allowed fields are overridden and uses deep merge
    to avoid clobbering nested structures (e.g., backend.config).

    Raises:
        HTTPException(400): If rejected fields are present in the override.
        HTTPException(400): If allowed_tools override is not a subset of base.
    """
    rejected = _REJECTED_OVERRIDE_FIELDS & set(config_override.keys())
    if rejected:
        raise HTTPException(
            status_code=400,
            detail=f"config_override contains disallowed fields: {sorted(rejected)}",
        )

    # Validate allowed_tools subset constraint before merging
    if "allowed_tools" in config_override:
        _validate_allowed_tools_subset(agent.allowed_tools, config_override["allowed_tools"])
    _validate_memory_override(agent, config_override)
    _validate_create_project_override(agent, config_override)

    # Convert agent to dict, deep merge, reconstruct
    agent_dict = agent.model_dump(by_alias=True)
    merged = _deep_merge(agent_dict, config_override)
    return DynamicAgentConfig.model_validate(merged)


def _validate_memory_override(agent: DynamicAgentConfig, config_override: dict[str, Any]) -> None:
    """Prevent request overrides from enabling or reconfiguring memory."""

    builtin_override = config_override.get("builtin_tools")
    if not isinstance(builtin_override, dict) or "memory" not in builtin_override:
        return
    memory_override = builtin_override["memory"]
    if not isinstance(memory_override, dict):
        raise HTTPException(status_code=400, detail="config_override memory must be an object")

    base_memory = agent.builtin_tools.memory if agent.builtin_tools else None
    if base_memory is None:
        if set(memory_override) <= {"enabled"} and memory_override.get("enabled") is False:
            return
        raise HTTPException(status_code=400, detail="config_override cannot enable or configure memory")

    base = base_memory.model_dump()
    candidate = _deep_merge(base, memory_override)
    if candidate.get("enabled") and not base.get("enabled"):
        raise HTTPException(status_code=400, detail="config_override cannot enable memory")
    if {key: value for key, value in candidate.items() if key != "enabled"} != {
        key: value for key, value in base.items() if key != "enabled"
    }:
        raise HTTPException(
            status_code=400,
            detail="config_override cannot change memory namespace policy",
        )


def _validate_create_project_override(agent: DynamicAgentConfig, config_override: dict[str, Any]) -> None:
    """Prevent a request override from granting the model Project creation rights."""

    builtin_override = config_override.get("builtin_tools")
    if not isinstance(builtin_override, dict):
        return
    if "projects" in builtin_override:
        raise HTTPException(
            status_code=400,
            detail="config_override builtin_tools.projects was renamed to create_project",
        )
    if "create_project" not in builtin_override:
        return
    create_override = builtin_override["create_project"]
    if not isinstance(create_override, dict):
        raise HTTPException(status_code=400, detail="config_override create_project must be an object")
    base_create = agent.builtin_tools.create_project if agent.builtin_tools else None
    if create_override.get("enabled") is True and not (base_create and base_create.enabled):
        raise HTTPException(status_code=400, detail="config_override cannot allow Project creation")


def _validate_allowed_tools_subset(
    base: dict[str, list[str] | bool],
    override: dict[str, list[str] | bool],
) -> None:
    """Ensure override allowed_tools is a strict subset of base config.

    Rules:
    - Cannot add servers not in base
    - Cannot enable a server that is disabled (False) in base
    - Cannot add tools not in base's tool list (when base has a specific list)
    - Setting False (disable) is always allowed
    - Setting True (all) is allowed if base allows the server

    Raises:
        HTTPException(400): If override violates subset constraint.
    """
    if not isinstance(override, dict):
        return

    for server_id, override_val in override.items():
        if server_id not in base:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"config_override.allowed_tools adds server '{server_id}' which is not configured on the base agent"
                ),
            )

        base_val = base[server_id]

        # Cannot re-enable a server that is explicitly disabled in base
        if base_val is False and override_val is not False:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"config_override.allowed_tools enables server '{server_id}' "
                    f"which is disabled in the base agent config"
                ),
            )

        # Disabling is always fine
        if override_val is False:
            continue

        # "All tools" is fine if base allows the server at all
        if override_val is True:
            continue

        # Override is a specific list — validate each tool
        if isinstance(override_val, list) and isinstance(base_val, list):
            extra = set(override_val) - set(base_val)
            if extra:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"config_override.allowed_tools['{server_id}'] includes tools "
                        f"not in base config: {sorted(extra)}"
                    ),
                )
        # override is list, base is True — any subset is fine (all tools available)


# assisted-by Codex Codex-sonnet-4-6
router = APIRouter(prefix="/chat", tags=["chat"])
GENERIC_AGENT_ERROR = "Agent execution failed. Check server logs for details."


class RestartRuntimeRequest(BaseModel):
    """Request body for restarting agent runtime."""

    agent_id: str
    conversation_id: str


class ResumeStreamRequest(BaseModel):
    """Request body for resuming an interrupted stream."""

    agent_id: str
    conversation_id: str
    resume_data: str  # JSON string with type discriminator (form_input or tool_approval)
    protocol: str = Field("custom", pattern=r"^(custom|agui)$")
    trace_id: str | None = None
    memory_enabled: bool = True
    project_id: str | None = None
    config_override: dict | None = Field(
        None,
        description=(
            "Same config_override used in the original /stream/start call. "
            "Required to reconstruct the runtime with the correct checkpoint "
            "collection if it was evicted from cache. "
            "WARNING: This must exactly match the config_override from /stream/start. "
            "Passing a different override (e.g. different checkpoint_collection or "
            "backend config) will cause the agent to lose conversation context, "
            "since the runtime will be reconstructed against a different checkpoint store."
        ),
    )
    workflow_config_id: str | None = Field(
        None,
        description="Workflow config ID when resuming a workflow step (for delegated agent use).",
    )


def _is_scheduler_invoke(request: ChatRequest) -> bool:
    """Return whether a non-streaming invocation came from the cron runner."""
    if not request.client_context:
        return False
    return request.client_context.model_dump().get("source") == "scheduler"


async def _validate_project(
    project_id: str | None,
    *,
    mongo: MongoDBService,
    user: UserContext,
    conversation_id: str,
) -> bool:
    """Validate Project ownership/platform state and prevent scope mutation."""

    settings = get_settings()
    platform_enabled = projects_enabled(mongo._db, settings)
    if project_id is not None:
        if not platform_enabled:
            raise HTTPException(status_code=400, detail="Projects are not enabled on this platform")
        try:
            validate_project_id(project_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if mongo._db is None:
            raise HTTPException(status_code=503, detail="Project storage is unavailable")
        store = MongoDBGridFSStore(
            db=mongo._db,
            bucket_name=settings.memory_gridfs_bucket_name,
            ttl_seconds=0,
        )
        if get_project(store, memory_owner_key(user, settings), project_id) is None:
            raise HTTPException(status_code=404, detail="Project not found")

    if mongo._db is None:
        return platform_enabled
    conversation = mongo._db["conversations"].find_one(
        {"_id": conversation_id},
        {"metadata.project_id": 1},
    )
    if not isinstance(conversation, dict) or not conversation:
        return platform_enabled
    metadata = conversation.get("metadata")
    stored = metadata.get("project_id") if isinstance(metadata, dict) else None
    if stored != project_id and (stored is not None or project_id is not None):
        raise HTTPException(status_code=409, detail="A conversation's Project is immutable")
    return platform_enabled


async def _collect_invoke_response(
    *,
    runtime,
    request: ChatRequest,
    user: UserContext,
    agent: DynamicAgentConfig,
) -> dict | JSONResponse:
    """Run a non-streaming invocation and return its accumulated response."""
    encoder = get_encoder("custom")

    async for _frame in runtime.stream(
        request.message,
        request.conversation_id,
        user.email,
        request.trace_id,
        encoder,
        files=request.files,
        memory_enabled=request.memory_enabled,
    ):
        pass

    interrupt = await runtime.has_pending_interrupt(request.conversation_id)
    if interrupt:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": (
                    "Agent requires human interaction which is not supported via the invoke endpoint. "
                    "Use the streaming chat endpoint or consider disabling tool approvals "
                    "and the user input tool for this agent."
                ),
                "interrupt_type": interrupt.get("type", "unknown"),
                "agent_id": agent.id,
                "conversation_id": request.conversation_id,
                "trace_id": request.trace_id,
            },
        )

    return {
        "success": True,
        "content": encoder.get_accumulated_content(),
        "thinking": encoder.get_thinking_content() or None,
        "agent_id": agent.id,
        "conversation_id": request.conversation_id,
        "trace_id": request.trace_id,
    }


async def _generate_sse_events(
    agent_config: DynamicAgentConfig,
    mcp_servers: list,
    message: str,
    session_id: str,
    user: UserContext,
    encoder: StreamEncoder,
    trace_id: str | None = None,
    mongo: MongoDBService | None = None,
    client_context: ClientContext | None = None,
    files: list[InputFile] | None = None,
    memory_enabled: bool = True,
    project_id: str | None = None,
    projects_enabled: bool = False,
) -> AsyncGenerator[str, None]:
    """Generate SSE events from agent streaming.

    The encoder handles all protocol-specific formatting. This function
    only orchestrates the runtime lifecycle and error handling.
    """
    # Set conversation context for logging
    conversation_id_var.set(session_id)

    cache = get_runtime_cache()

    # Set MongoDB service for subagent resolution
    if mongo:
        cache.set_mongo_service(mongo)

    try:
        # Get or create runtime with user context
        runtime = await cache.get_or_create(
            agent_config,
            mcp_servers,
            session_id,
            user=user,
            client_context=client_context,
            project_id=project_id,
            projects_enabled=projects_enabled,
        )

        # Stream response with trace_id for Langfuse tracing
        async for frame in runtime.stream(
            message,
            session_id,
            user.email,
            trace_id,
            encoder,
            files=files,
            memory_enabled=memory_enabled,
        ):
            yield frame

    except RuntimeCapacityError as e:
        logger.warning(f"Agent runtime at capacity: {e}")
        for frame in encoder.on_run_error("This agent is at capacity right now. Please try again in a moment."):
            yield frame
    except RuntimeInitError as e:
        # If init failed because of a config problem (no LLM provider/model,
        # invalid provider, missing API key, etc.) we own the message — emit
        # the actionable LLMConfigError text instead of GENERIC_AGENT_ERROR
        # so the client surface (Slack/Webex/UI) can tell the operator what
        # to fix. Anything else falls through to the generic message.
        cause = e.cause
        if isinstance(cause, LLMConfigError):
            logger.warning(
                f"Agent '{agent_config.name}' has no usable LLM config: {cause}"
            )
            for frame in encoder.on_run_error(str(cause)):
                yield frame
        else:
            logger.exception(
                f"Runtime init failed for agent '{agent_config.name}'"
            )
            for frame in encoder.on_run_error(GENERIC_AGENT_ERROR):
                yield frame
    except Exception:
        logger.exception(f"Error streaming from agent '{agent_config.name}'")
        for frame in encoder.on_run_error(GENERIC_AGENT_ERROR):
            yield frame


@router.post("/stream/start")
async def chat_start_stream(
    request: ChatRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> StreamingResponse:
    """Start streaming a chat response from a dynamic agent.

    Uses Server-Sent Events (SSE) for real-time streaming.

    Body field ``protocol`` selects the wire format:
        - "custom" (default): legacy SSE event types
        - "agui": AG-UI protocol

    Events depend on the selected protocol. With protocol=custom:
    - content: Streaming text chunks
    - tool_start: Tool invocation started
    - tool_end: Tool invocation completed
    - input_required: Agent requests user input via form (HITL)
    - warning: Non-fatal issue
    - error: Unrecoverable error
    - done: Streaming complete

    If the agent calls request_user_input, streaming will end with an
    input_required event. Use /stream/resume to continue after user input.
    """
    # Set conversation context for logging
    conversation_id_var.set(request.conversation_id)

    await _enforce_chat_authz(
        agent_id=request.agent_id,
        user_sub=getattr(user, "sub", None),
        autonomous=getattr(request, "autonomous", False),
    )

    # Get agent config after the runtime policy check passes.
    agent = mongo.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Apply config_override if provided (deep merge, validated)
    if request.config_override:
        agent = apply_config_override(agent, request.config_override)

    # Get MCP servers for this agent and its subagents
    mcp_servers = mongo.get_agent_mcp_servers(agent)
    platform_projects_enabled = await _validate_project(
        request.project_id,
        mongo=mongo,
        user=user,
        conversation_id=request.conversation_id,
    )

    logger.info(
        f"[chat] Starting chat request: "
        f"agent='{agent.name}', user={user.email}, "
        f"provider={agent.model.provider}, model={agent.model.id}, "
        f"mcp_servers={len(mcp_servers)}, "
        f"protocol={request.protocol}, "
        f"config_override={request.config_override}, "
        f"trace_id={request.trace_id or 'auto'}"
    )

    encoder = get_encoder(request.protocol)

    return StreamingResponse(
        _generate_sse_events(
            agent_config=agent,
            mcp_servers=mcp_servers,
            message=request.message,
            session_id=request.conversation_id,
            user=user,
            encoder=encoder,
            trace_id=request.trace_id,
            mongo=mongo,
            client_context=request.client_context,
            files=request.files,
            memory_enabled=request.memory_enabled,
            project_id=request.project_id,
            projects_enabled=platform_projects_enabled,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


async def _generate_resume_sse_events(
    agent_config: DynamicAgentConfig,
    mcp_servers: list,
    session_id: str,
    user: UserContext,
    resume_data: str,
    encoder: StreamEncoder,
    trace_id: str | None = None,
    mongo: MongoDBService | None = None,
    memory_enabled: bool = True,
    project_id: str | None = None,
    projects_enabled: bool = False,
) -> AsyncGenerator[str, None]:
    """Generate SSE events from agent resume streaming.

    The encoder handles all protocol-specific formatting.
    """
    # Set conversation context for logging
    conversation_id_var.set(session_id)

    cache = get_runtime_cache()

    # Set MongoDB service for subagent resolution
    if mongo:
        cache.set_mongo_service(mongo)

    try:
        # Get or create runtime with user context
        runtime = await cache.get_or_create(
            agent_config,
            mcp_servers,
            session_id,
            user=user,
            project_id=project_id,
            projects_enabled=projects_enabled,
        )

        # Resume streaming with form data
        async for frame in runtime.resume(
            session_id,
            user.email,
            resume_data,
            trace_id,
            encoder,
            memory_enabled=memory_enabled,
        ):
            yield frame

    except RuntimeCapacityError as e:
        logger.warning(f"Agent runtime at capacity: {e}")
        for frame in encoder.on_run_error("This agent is at capacity right now. Please try again in a moment."):
            yield frame
    except Exception:
        logger.exception(f"Error resuming stream for agent '{agent_config.name}'")
        for frame in encoder.on_run_error(GENERIC_AGENT_ERROR):
            yield frame


@router.post("/stream/resume")
async def chat_resume_stream(
    request: ResumeStreamRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> StreamingResponse:
    """Resume an interrupted stream after user provides input or approval.

    Called after the agent emitted an input_required event. The resume_data
    should be a JSON string with a type discriminator:
    - {"type": "form_input", "values": {...}} for form submissions
    - {"type": "form_input", "dismissed": true} for form dismissals
    - {"type": "tool_approval", "decision": "approve"|"reject"|"edit", ...}

    Body field ``protocol`` selects the wire format:
        - "custom" (default): legacy SSE event types
        - "agui": AG-UI protocol

    Events depend on the selected protocol. See /stream/start for details.
    """
    # Set conversation context for logging
    conversation_id_var.set(request.conversation_id)

    await _enforce_chat_authz(
        agent_id=request.agent_id,
        user_sub=getattr(user, "sub", None),
        autonomous=getattr(request, "autonomous", False),
    )

    # Get agent config after the runtime policy check passes.
    agent = mongo.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Apply config_override if provided (same as /stream/start)
    if request.config_override:
        agent = apply_config_override(agent, request.config_override)

    # Get MCP servers for this agent and its subagents
    mcp_servers = mongo.get_agent_mcp_servers(agent)
    platform_projects_enabled = await _validate_project(
        request.project_id,
        mongo=mongo,
        user=user,
        conversation_id=request.conversation_id,
    )

    logger.info(
        f"[chat] Resuming stream: agent='{agent.name}', user={user.email}, "
        f"protocol={request.protocol}, "
        f"config_override={request.config_override}, "
        f"trace_id={request.trace_id or 'auto'}"
    )

    encoder = get_encoder(request.protocol)

    return StreamingResponse(
        _generate_resume_sse_events(
            agent_config=agent,
            mcp_servers=mcp_servers,
            session_id=request.conversation_id,
            user=user,
            resume_data=request.resume_data,
            encoder=encoder,
            trace_id=request.trace_id,
            mongo=mongo,
            memory_enabled=request.memory_enabled,
            project_id=request.project_id,
            projects_enabled=platform_projects_enabled,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


@router.post("/invoke")
async def chat_invoke(
    request: ChatRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Non-streaming chat invocation (for simple integrations).

    Returns the complete response after processing.
    """
    # Set conversation context for logging
    conversation_id_var.set(request.conversation_id)

    await _enforce_chat_authz(
        agent_id=request.agent_id,
        user_sub=getattr(user, "sub", None),
        autonomous=getattr(request, "autonomous", False),
    )

    # Get agent config after the runtime policy check passes.
    agent = mongo.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Apply config_override if provided (deep merge, validated)
    if request.config_override:
        agent = apply_config_override(agent, request.config_override)

    # Get MCP servers for this agent and its subagents
    mcp_servers = mongo.get_agent_mcp_servers(agent)
    platform_projects_enabled = await _validate_project(
        request.project_id,
        mongo=mongo,
        user=user,
        conversation_id=request.conversation_id,
    )

    settings = get_settings()
    persist_history = settings.invoke_persist_history

    logger.info(
        f"Invoke request: agent={agent.name}, user={user.email}, "
        f"trace_id={request.trace_id or 'auto'}, persist_history={persist_history}"
    )

    cache = get_runtime_cache()
    cache.set_mongo_service(mongo)

    try:
        if _is_scheduler_invoke(request):
            async with cache.persistent(
                agent,
                mcp_servers,
                request.conversation_id,
                user=user,
                client_context=request.client_context,
                project_id=request.project_id,
                projects_enabled=platform_projects_enabled,
            ) as runtime:
                return await _collect_invoke_response(
                    runtime=runtime,
                    request=request,
                    user=user,
                    agent=agent,
                )

        async with AsyncExitStack() as stack:
            if persist_history:
                runtime = await cache.get_or_create(
                    agent,
                    mcp_servers,
                    request.conversation_id,
                    user=user,
                    client_context=request.client_context,
                    project_id=request.project_id,
                    projects_enabled=platform_projects_enabled,
                )
            else:
                runtime = await stack.enter_async_context(
                    cache.ephemeral(
                        agent,
                        mcp_servers,
                        request.conversation_id,
                        user=user,
                        client_context=request.client_context,
                        project_id=request.project_id,
                        projects_enabled=platform_projects_enabled,
                    )
                )

            return await _collect_invoke_response(
                runtime=runtime,
                request=request,
                user=user,
                agent=agent,
            )

    except RuntimeCapacityError as e:
        logger.warning(f"Agent runtime at capacity for invoke: {e}")
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": "This agent is at capacity right now. Please try again in a moment.",
                "agent_id": agent.id,
                "conversation_id": request.conversation_id,
                "trace_id": request.trace_id,
            },
        )
    except Exception:
        logger.exception(f"Error invoking agent '{agent.name}'")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": GENERIC_AGENT_ERROR,
                "agent_id": agent.id,
                "conversation_id": request.conversation_id,
                "trace_id": request.trace_id,
            },
        )


@router.post("/restart-runtime")
async def restart_runtime(
    request: RestartRuntimeRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Restart the agent runtime by invalidating the cache.

    This forces the agent to reconnect to MCP servers on the next message.
    Useful when MCP servers come back online after being unavailable.
    """
    # Set conversation context for logging
    conversation_id_var.set(request.conversation_id)

    # Get agent config to verify it exists (access control is handled by the gateway)
    agent = mongo.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Invalidate the runtime cache
    cache = get_runtime_cache()
    invalidated = await cache.invalidate(request.agent_id, request.conversation_id)

    logger.info(f"Runtime restart requested: agent={agent.name}, user={user.email}, invalidated={invalidated}")

    return {
        "success": True,
        "invalidated": invalidated,
        "agent_id": request.agent_id,
        "conversation_id": request.conversation_id,
    }


class CancelStreamRequest(BaseModel):
    """Request body for cancelling an active stream."""

    agent_id: str
    conversation_id: str


@router.post("/stream/cancel")
async def cancel_stream(
    request: CancelStreamRequest,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Cancel an active streaming request.

    This sets a cancellation flag that causes the stream to exit gracefully
    at the next chunk boundary. The stream will close without emitting
    further events.
    """
    # Set conversation context for logging
    conversation_id_var.set(request.conversation_id)

    logger.info(f"[cancel] Cancel request received: agent={request.agent_id}, user={user.email}")

    # Get agent config to verify it exists (access control is handled by the gateway)
    agent = mongo.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Cancel the stream via the runtime cache
    cache = get_runtime_cache()
    cancelled = cache.cancel_stream(request.agent_id, request.conversation_id)

    logger.info(f"[cancel] Cancel result: agent={agent.name}, user={user.email}, cancelled={cancelled}")

    return {
        "success": True,
        "cancelled": cancelled,
        "agent_id": request.agent_id,
        "conversation_id": request.conversation_id,
    }

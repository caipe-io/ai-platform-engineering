"""Chat endpoint for Dynamic Agents with SSE streaming."""

import logging
from contextlib import aclosing
from typing import Any, AsyncGenerator, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.auth.authz import (
    require_agent_use_permission,
    require_autonomous_permission,
)
from dynamic_agents.log_config import conversation_id_var
from dynamic_agents.models import ChatRequest, ClientContext, DynamicAgentConfig, InputFile, UserContext
from dynamic_agents.services.agent_execution import AgentExecutionService, ExecutionTurn, InvocationResult
from dynamic_agents.services.llm_clients import LLMConfigError
from dynamic_agents.services.model_capabilities import supports_reasoning_effort
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.runtime_cache import (
    RuntimeCapacityError,
    RuntimeInitError,
)
from dynamic_agents.services.session_runs import SessionRunBusyError
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

    # Convert agent to dict, deep merge, reconstruct
    agent_dict = agent.model_dump(by_alias=True)
    merged = _deep_merge(agent_dict, config_override)
    return DynamicAgentConfig.model_validate(merged)


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
    client_context: ClientContext | None = None
    reasoning_effort: Literal["low", "medium", "high", "max"] | None = None
    config_override: dict | None = Field(
        None,
        description=(
            "Overrides are validated as on /stream/start. Bound sessions restore "
            "their last admitted configuration for human-input resume. For unbound "
            "legacy sessions, send the original override so an evicted runtime "
            "reopens the correct checkpoint and filesystem stores."
        ),
    )
    workflow_config_id: str | None = Field(
        None,
        description="Workflow config ID when resuming a workflow step (for delegated agent use).",
    )


def _with_reasoning_effort(
    agent: DynamicAgentConfig,
    requested: Literal["low", "medium", "high", "max"] | None,
) -> DynamicAgentConfig:
    """Apply a validated conversation override without mutating stored config."""
    if requested is None:
        return agent
    if not supports_reasoning_effort(agent.model.id, requested):
        raise HTTPException(
            status_code=400,
            detail=f"Model {agent.model.id!r} does not support configurable reasoning effort",
        )
    return agent.model_copy(
        update={
            "model": agent.model.model_copy(update={"reasoning_effort": requested})
        }
    )


def _invoke_response(result: InvocationResult, request: ChatRequest) -> dict | JSONResponse:
    if result.interrupt:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": (
                    "Agent requires human interaction which is not supported via the invoke endpoint. "
                    "Use the streaming chat endpoint or consider disabling tool approvals "
                    "and the user input tool for this agent."
                ),
                "interrupt_type": result.interrupt.get("type", "unknown"),
                "agent_id": request.agent_id,
                "conversation_id": request.conversation_id,
                "trace_id": request.trace_id,
            },
        )
    return {
        "success": True,
        "content": result.content,
        "thinking": result.thinking,
        "agent_id": request.agent_id,
        "conversation_id": request.conversation_id,
        "trace_id": request.trace_id,
    }


async def _generate_sse_events(
    agent_config: DynamicAgentConfig,
    message: str | None,
    session_id: str,
    user: UserContext,
    encoder: StreamEncoder[str],
    trace_id: str | None = None,
    mongo: MongoDBService | None = None,
    client_context: ClientContext | None = None,
    files: list[InputFile] | None = None,
    turn_id: str | None = None,
    resume_data: str | None = None,
) -> AsyncGenerator[str, None]:
    """Translate execution failures to the caller's selected UI protocol."""
    conversation_id_var.set(session_id)
    turn = ExecutionTurn(
        agent=agent_config, message=message, session_id=session_id, user=user,
        trace_id=trace_id, client_context=client_context, files=files,
        turn_id=turn_id, resume_data=resume_data,
    )
    try:
        async with aclosing(AgentExecutionService(mongo).stream(turn, encoder)) as frames:
            async for frame in frames:
                yield frame

    except (RuntimeCapacityError, SessionRunBusyError) as e:
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
    agent = _with_reasoning_effort(agent, request.reasoning_effort)

    logger.info(
        f"[chat] Starting chat request: "
        f"agent='{agent.name}', user={user.email}, "
        f"provider={agent.model.provider}, model={agent.model.id}, "
        f"protocol={request.protocol}, "
        f"config_override={request.config_override}, "
        f"trace_id={request.trace_id or 'auto'}"
    )

    encoder = get_encoder(request.protocol)

    return StreamingResponse(
        _generate_sse_events(
            agent_config=agent,
            message=request.message,
            session_id=request.conversation_id,
            user=user,
            encoder=encoder,
            trace_id=request.trace_id,
            mongo=mongo,
            client_context=request.client_context,
            files=request.files,
            turn_id=request.turn_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


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
    agent = _with_reasoning_effort(agent, request.reasoning_effort)

    logger.info(
        f"[chat] Resuming stream: agent='{agent.name}', user={user.email}, "
        f"protocol={request.protocol}, "
        f"config_override={request.config_override}, "
        f"trace_id={request.trace_id or 'auto'}"
    )

    encoder = get_encoder(request.protocol)

    return StreamingResponse(
        _generate_sse_events(
            agent_config=agent,
            message=None,
            session_id=request.conversation_id,
            user=user,
            resume_data=request.resume_data,
            encoder=encoder,
            trace_id=request.trace_id,
            mongo=mongo,
            client_context=request.client_context,
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

    agent = _with_reasoning_effort(agent, request.reasoning_effort)

    logger.info(
        f"Invoke request: agent={agent.name}, user={user.email}, trace_id={request.trace_id or 'auto'}"
    )
    try:
        result = await AgentExecutionService(mongo).invoke(ExecutionTurn(
            agent=agent, session_id=request.conversation_id, user=user,
            message=request.message, trace_id=request.trace_id,
            client_context=request.client_context, files=request.files, turn_id=request.turn_id,
        ))
        return _invoke_response(result, request)

    except (RuntimeCapacityError, SessionRunBusyError) as e:
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

    try:
        invalidated = await AgentExecutionService(mongo).restart(request.agent_id, request.conversation_id)
    except (SessionRunBusyError, RuntimeCapacityError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

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

    cancelled = await AgentExecutionService(mongo).cancel(request.agent_id, request.conversation_id)

    logger.info(f"[cancel] Cancel result: agent={agent.name}, user={user.email}, cancelled={cancelled}")

    return {
        "success": True,
        "cancelled": cancelled,
        "agent_id": request.agent_id,
        "conversation_id": request.conversation_id,
    }

"""HTTP client for the dynamic-agents service.

This is the autonomous-agents service's only outbound execution path: every
task carries a ``dynamic_agent_id`` and the scheduler / preflight route
through here so the prompt runs through that custom agent (its tools /
system prompt / model / middleware) on the dynamic-agents runtime.

Notes on the wire contract:

* The dynamic-agents service exposes plain HTTP ``/api/v1/chat/invoke``
  (sync) and ``/api/v1/chat/stream/start`` (SSE).
* It expects a gateway-injected ``X-User-Context`` header carrying the task
  owner's identity. Each scheduled run is system-driven, so we mint that
  header from the task's ``owner_id`` here (per-user attribution + access).
* Preflight is config-level only: the service exposes no read-only agent
  endpoint, so we verify configuration and defer existence / authorization
  to run time (``mongo.get_agent`` + ``require_agent_use_permission`` on the
  ``/chat`` endpoints).
"""

from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any

import httpx

from autonomous_agents.config import get_settings
from autonomous_agents.models import Acknowledgement

logger = logging.getLogger("autonomous_agents")

_service_token_cache: tuple[str, float] | None = None

__all__ = [
    "DynamicAgentsClientError",
    "DynamicAgentsNotConfiguredError",
    "DynamicAgentsAuthorizationRevokedError",
    "DynamicAgentsScheduleRevokedError",
    "invoke_dynamic_agent",
    "invoke_dynamic_agent_streaming",
    "preflight_dynamic_agent",
]


def _is_autonomous_authorization_revoked(status_code: int, body_text: str) -> bool:
    """Return true when DA denies agent use or Autonomous entitlement."""
    if status_code != 403:
        return False
    try:
        payload = json.loads(body_text)
    except (ValueError, TypeError):
        return False
    detail = payload.get("detail") if isinstance(payload, dict) else None
    return isinstance(detail, dict) and detail.get("code") in {
        "agent#use",
        "organization#automate",
        # Backward compatibility during rolling upgrades.
        "agent#schedule",
    }


def _build_prompt_with_context(prompt: str, context: dict[str, Any] | None) -> str:
    """Append a JSON context block to the prompt for webhook/scheduler runs.

    Mirrors the ``Context:\\n{...}`` layout the chat-history publisher and UI
    expect so a webhook-triggered run reads the same on the wire and in chat.
    Returns the prompt unchanged when no context is supplied.
    """
    if not context:
        return prompt
    return f"{prompt}\n\nContext:\n{json.dumps(context, indent=2)}"


class DynamicAgentsClientError(RuntimeError):
    """Raised when the dynamic-agents service refuses or errors a call.

    Surfaced by :func:`invoke_dynamic_agent` so the scheduler's existing
    ``except Exception`` arm records a ``TaskRun`` with ``status=failed``
    and the message becomes the error preview in the UI.
    """


class DynamicAgentsNotConfiguredError(DynamicAgentsClientError):
    """Raised when ``DYNAMIC_AGENTS_URL`` is not set.

    Specialised so callers can render an actionable error rather than a
    generic transport failure: the operator just needs to set the env
    var and restart.
    """


class DynamicAgentsAuthorizationRevokedError(DynamicAgentsClientError):
    """Raised when an unattended run loses agent access or team entitlement."""


# Compatibility for callers importing the pre-entitlement class name.
DynamicAgentsScheduleRevokedError = DynamicAgentsAuthorizationRevokedError


# ----------------------------------------------------------------------
# User context header construction
# ----------------------------------------------------------------------
# The dynamic-agents auth layer trusts whatever the gateway puts in the
# X-User-Context header. For autonomous tasks, we use the task owner's
# email (not a shared system sentinel) so conversations are attributed
# correctly and access control in can_access_conversation() works per-user.
#
# is_admin is explicitly False: the task owner is a real user, not a
# privileged system account. The blanket is_admin=True that this
# replaces caused every autonomous conversation to bypass all access
# checks (IDOR fix).

def _build_user_context_header(owner_email: str, owner_sub: str | None = None) -> str:
    """Build X-User-Context for an autonomous task run using the task owner.

    ``owner_sub`` (the owner's Keycloak subject/UUID) is included when known so
    the dynamic-agents runtime can authorize agent-use as the owner: OpenFGA/CAS
    key subjects by ``sub``, not by email, so ``email`` alone cannot drive the
    per-owner decision. ``email`` still carries attribution for conversation
    ownership.
    """
    payload = {
        "email": owner_email,
        "name": "Autonomous Agent",
        "is_admin": False,
        "is_authorized": True,
    }
    if owner_sub:
        payload["sub"] = owner_sub
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def _task_headers(owner_email: str, owner_sub: str | None = None) -> dict[str, str]:
    """Return HTTP headers for an autonomous task invocation."""
    return {
        "X-User-Context": _build_user_context_header(owner_email, owner_sub),
        "Content-Type": "application/json",
    }


async def _mint_service_bearer_token(timeout: float) -> str | None:
    """Mint a service-to-service token for dynamic-agents, if configured.

    Dynamic-agents can run with ``DA_REQUIRE_BEARER=true``. In that mode the
    legacy trusted ``X-User-Context`` header is not enough; the scheduler must
    authenticate as a service principal and then let downstream ReBAC decide
    whether that principal may use the requested agent.
    """
    global _service_token_cache

    settings = get_settings()
    token_url = settings.dynamic_agents_oauth2_token_url
    client_id = settings.dynamic_agents_oauth2_client_id
    client_secret = settings.dynamic_agents_oauth2_client_secret
    if not token_url or not client_id or not client_secret:
        return None

    now = time.monotonic()
    if _service_token_cache and _service_token_cache[1] > now + 30:
        return _service_token_cache[0]

    form = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    if settings.dynamic_agents_oauth2_scope:
        form["scope"] = settings.dynamic_agents_oauth2_scope

    async with httpx.AsyncClient(timeout=min(timeout, 15.0)) as client:
        response = await client.post(token_url, data=form)
    response.raise_for_status()
    payload = response.json()
    token = payload.get("access_token")
    if not isinstance(token, str) or not token:
        raise DynamicAgentsClientError(
            "Dynamic-agents service-token endpoint returned no access_token."
        )
    expires_in = payload.get("expires_in")
    ttl = float(expires_in) if isinstance(expires_in, (int, float)) else 300.0
    _service_token_cache = (token, now + max(ttl - 30.0, 30.0))
    return token


async def _task_headers_with_auth(
    owner_email: str, timeout: float, owner_sub: str | None = None
) -> dict[str, str]:
    headers = _task_headers(owner_email, owner_sub)
    token = await _mint_service_bearer_token(timeout)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _normalize_base_url(url: str) -> str:
    """Return ``url`` without a trailing slash (joining is then cheap)."""
    return url.rstrip("/")


async def invoke_dynamic_agent(
    *,
    prompt: str,
    task_id: str,
    agent_id: str,
    owner_email: str | None = None,
    owner_sub: str | None = None,
    conversation_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Invoke a dynamic agent synchronously and return (content, events).

    Args:
        prompt: The task prompt -- becomes the ``message`` field on the
            dynamic-agents ``ChatRequest``.
        task_id: Stable autonomous task id; used to derive a deterministic
            conversation id when ``conversation_id`` is not supplied so
            scheduled runs of the same task share session state with the
            interactive chat thread for that task.
        agent_id: Dynamic-agents service agent id (``ChatRequest.agent_id``).
        conversation_id: Optional explicit conversation id (UUID5-derived
            elsewhere). When ``None``, derived from ``task_id``.
        context: Optional webhook/scheduler context appended to the message
            in the same ``Context:\n{...}`` format used by the supervisor
            path. Dynamic agents do not need a supervisor routing directive,
            so the formatter is called with ``agent=None``.
    Returns:
        A 2-tuple ``(content, events)``. ``events`` is intentionally
        always ``[]`` for the sync ``/chat/invoke`` path -- a follow-up
        can swap in ``/chat/stream/start`` parsing for richer chat
        replay parity. The scheduler treats an empty events list the
        same way it treats legacy blocking responses.

    Raises:
        DynamicAgentsNotConfiguredError: when ``DYNAMIC_AGENTS_URL`` is
            unset. Caller should let this surface as the run's
            ``error``.
        DynamicAgentsClientError: on non-2xx response, transport
            failure, or ``success: false`` payload.
    """
    settings = get_settings()
    if not settings.dynamic_agents_url:
        raise DynamicAgentsNotConfiguredError(
            "DYNAMIC_AGENTS_URL is not configured; set it on the autonomous-agents "
            "service (e.g. http://dynamic-agents:8001) so dynamic-agent tasks can "
            "reach the dynamic-agents service."
        )

    if conversation_id is None:
        conversation_id = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"autonomous-task:{task_id}")
        )

    effective_timeout = settings.dynamic_agents_timeout_seconds

    base = _normalize_base_url(settings.dynamic_agents_url)
    # The dynamic-agents service mounts its routers under ``/api/v1``
    # (see dynamic_agents/main.py). Hard-code the prefix here rather
    # than make operators bake it into ``DYNAMIC_AGENTS_URL`` so the
    # env-var stays a plain base URL aligned with all other consumers
    # (UI proxy, slack-bot SSE client).
    url = f"{base}/api/v1/chat/invoke"
    full_prompt = _build_prompt_with_context(prompt, context)
    body = {
        "message": full_prompt,
        "conversation_id": conversation_id,
        "agent_id": agent_id,
        "trace_id": task_id,
        "autonomous": True,
    }

    logger.info(
        "dynamic_agents_client.invoke: task=%s agent=%s url=%s timeout=%.1fs",
        task_id,
        agent_id,
        url,
        effective_timeout,
    )

    _effective_email = owner_email or get_settings().dynamic_agents_system_email
    try:
        async with httpx.AsyncClient(timeout=effective_timeout) as client:
            resp = await client.post(
                url,
                json=body,
                headers=await _task_headers_with_auth(
                    _effective_email, effective_timeout, owner_sub
                ),
            )
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        # Transport failure -- the dynamic-agents service didn't answer.
        # Re-raise as a typed error so the scheduler records the run as
        # failed with a useful message rather than a bare ``fetch
        # failed``.
        raise DynamicAgentsClientError(
            f"dynamic-agents service at {url} did not respond: {exc}"
        ) from exc

    if resp.status_code == 404:
        raise DynamicAgentsClientError(
            f"dynamic-agents service has no agent with id '{agent_id}' "
            f"(HTTP 404 from {url})."
        )
    if _is_autonomous_authorization_revoked(resp.status_code, resp.text):
        raise DynamicAgentsAuthorizationRevokedError(
            f"autonomous access revoked for agent '{agent_id}'"
        )
    if resp.status_code >= 400:
        # Avoid logging response body wholesale -- can contain user data.
        raise DynamicAgentsClientError(
            f"dynamic-agents service returned HTTP {resp.status_code} for agent "
            f"'{agent_id}' on {url}."
        )

    try:
        data = resp.json()
    except ValueError as exc:
        raise DynamicAgentsClientError(
            f"dynamic-agents service returned non-JSON response from {url}: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise DynamicAgentsClientError(
            f"dynamic-agents service returned unexpected payload shape from {url}."
        )

    if data.get("success") is False:
        # The dynamic-agents /chat/invoke route deliberately returns a
        # generic message in this branch (it logs the real exception
        # server-side). Surface that as-is.
        raise DynamicAgentsClientError(
            data.get("error") or "dynamic-agents service reported failure."
        )

    content = data.get("content")
    if not isinstance(content, str):
        # Defensive: spec says ``content`` is always a string when
        # ``success`` is true. Treat anything else as an error rather
        # than coerce silently.
        raise DynamicAgentsClientError(
            "dynamic-agents service returned no string 'content' in response."
        )

    return content, []


# ----------------------------------------------------------------------
# Streaming variant — captures per-step events for chat-thread replay
# ----------------------------------------------------------------------
# Spec #099 / TODO ux-3: the sync ``invoke_dynamic_agent`` above returns
# only the final text and an empty events list, which means the UI's
# autonomous-task chat thread for dynamic-agent runs renders just a
# single bubble (no plan / tools / breakdown). This streaming variant
# closes that gap by:
#
#   1. Calling ``/api/v1/chat/stream/start`` with ``protocol=custom``.
#   2. Parsing the SSE event frames (``event: <type>\ndata: <json>\n\n``).
#   3. Translating each ``tool_start`` / ``tool_end`` / accumulated
#      ``content`` into the supervisor-flavoured A2A ``artifact-update``
#      shape that ``ui/src/lib/replay-timeline.ts`` already understands.
#
# The translation is deliberate -- the UI's replay logic is hard-wired
# to A2A artifact names (``tool_notification_start`` etc), and adding a
# parallel UI path for dynamic-agents events would mean tracking two
# event protocols in two places. By translating on the server side we
# get visual parity for the autonomous chat thread with zero UI
# changes. Live dynamic-agent chats continue to use the native dynamic-
# agents wire format end-to-end, so no behaviour shifts there.
#
# Known limitation accepted: the dynamic-agents ``custom`` SSE protocol
# does NOT emit plan-step events (they don't exist in the underlying
# DeepAgent stream for dynamic agents), so the chat-thread breakdown
# will show "Tool calls" + "Final answer" sections but no separate
# "Plan" section. This matches what live dynamic-agent chats show.


async def _iter_sse_events(response: httpx.Response) -> AsyncIterator[tuple[str, dict]]:
    """Yield ``(event_type, data_dict)`` tuples from an SSE response.

    Wire format (per dynamic-agents ``custom`` SSE encoder):

        event: <type>\\n
        data: <json>\\n
        \\n

    Empty line terminates a frame. Lines that don't match ``event:`` /
    ``data:`` are ignored. Malformed JSON chunks are skipped (partial
    frames are tolerated rather than aborting the stream). Returns the
    event name (defaulting to "message" if the
    sender omitted ``event:``) so the caller can dispatch on it.
    """
    current_event: str | None = None
    async for line in response.aiter_lines():
        if line == "":
            current_event = None
            continue
        if line.startswith("event:"):
            current_event = line[6:].strip()
            continue
        if line.startswith("data:"):
            raw = line[5:].lstrip()
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                # Ignore malformed chunks -- tolerate partial frames.
                continue
            if not isinstance(data, dict):
                continue
            yield (current_event or "message", data)


def _translate_tool_start_to_a2a(
    data: dict,
    tool_name_by_call_id: dict[str, str],
) -> dict:
    """Translate a dynamic-agents ``tool_start`` event into A2A shape.

    Mirrors the supervisor's ``tool_notification_start`` artifact so
    ``buildTimelineSegmentsFromEvents`` (UI replay) can render the
    Tools panel identically. Mutates ``tool_name_by_call_id`` so the
    later ``tool_end`` translation can recover the tool name for the
    description string the UI parses.
    """
    tool_name = str(data.get("tool_name") or "")
    tool_call_id = str(data.get("tool_call_id") or "")
    args = data.get("args") or {}
    if tool_call_id and tool_name:
        tool_name_by_call_id[tool_call_id] = tool_name
    # Render the args into a text part so the UI's "Tool details"
    # affordance has something to show. JSON-stringify with default=str
    # to survive non-JSON-friendly values without raising.
    try:
        args_text = json.dumps(args, indent=2, default=str)
    except (TypeError, ValueError):
        args_text = f"<{len(args)} args (unserialisable)>"
    return {
        "kind": "artifact-update",
        "artifact": {
            "artifactId": tool_call_id,
            "name": "tool_notification_start",
            "description": f"Tool call started: {tool_name}",
            "parts": [{"kind": "text", "text": args_text}],
            "metadata": {
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "source": "dynamic_agents",
            },
        },
    }


def _translate_tool_end_to_a2a(
    data: dict,
    tool_name_by_call_id: dict[str, str],
) -> dict:
    """Translate a dynamic-agents ``tool_end`` event into A2A shape.

    The UI's ``replay-timeline.ts`` matches tool end events back to
    their start by extracting the tool name from the artifact's
    ``description`` field via the regex
    ``/Tool call (?:completed|started):\\s*(.+)/i``. So we have to
    look up the tool name we cached from the matching ``tool_start``
    and put it into the description here -- the dynamic-agents
    ``tool_end`` payload only carries ``tool_call_id``.
    """
    tool_call_id = str(data.get("tool_call_id") or "")
    tool_name = tool_name_by_call_id.get(tool_call_id, "")
    error = data.get("error") or ""
    result = data.get("result") or ""
    body_text = error if error else result
    parts: list[dict[str, Any]] = []
    if isinstance(body_text, str) and body_text:
        parts.append({"kind": "text", "text": body_text})
    return {
        "kind": "artifact-update",
        "artifact": {
            "artifactId": tool_call_id,
            "name": "tool_notification_end",
            "description": f"Tool call completed: {tool_name}",
            "parts": parts,
            "metadata": {
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "error": bool(error),
                "source": "dynamic_agents",
            },
        },
    }


def _emit_final_result_event(text: str) -> dict:
    """Build a synthetic ``final_result`` A2A artifact for the accumulated text.

    The supervisor's streaming path emits ``final_result`` (or
    ``partial_result``) artifacts as the LLM streams its final answer,
    and ``replay-timeline.ts`` keys off ``artifact.name`` to push them
    into the FinalAnswer segment. The dynamic-agents service emits
    ``content`` chunks instead -- we accumulate them and emit a single
    synthetic ``final_result`` at the end so the UI replay renders an
    identical FinalAnswer block.
    """
    return {
        "kind": "artifact-update",
        "artifact": {
            "artifactId": "final_result",
            "name": "final_result",
            "parts": [{"kind": "text", "text": text}],
            "metadata": {"source": "dynamic_agents"},
        },
    }


async def invoke_dynamic_agent_streaming(
    *,
    prompt: str,
    task_id: str,
    agent_id: str,
    owner_email: str | None = None,
    owner_sub: str | None = None,
    conversation_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Invoke a dynamic agent via SSE streaming and return ``(content, events)``.

    Differs from :func:`invoke_dynamic_agent` in:

    * Uses ``/api/v1/chat/stream/start`` (SSE) with ``protocol=custom``
      instead of ``/chat/invoke`` (sync).
    * Parses the SSE stream and translates each per-step event into the
      supervisor-flavoured A2A ``artifact-update`` shape so the
      autonomous-task chat thread renders the Tools / Final-answer
      breakdown identically to supervisor-targeted runs (TODO ux-3).
    * The returned ``events`` list is non-empty (assuming the agent
      actually called any tools or produced any text), and lands on
      ``TaskRun.events`` via the scheduler.

    Errors map to the same ``DynamicAgentsClientError`` /
    ``DynamicAgentsNotConfiguredError`` as the sync variant so the
    scheduler's exception handling is identical.
    """
    settings = get_settings()
    if not settings.dynamic_agents_url:
        raise DynamicAgentsNotConfiguredError(
            "DYNAMIC_AGENTS_URL is not configured; set it on the autonomous-agents "
            "service (e.g. http://dynamic-agents:8001) so dynamic-agent tasks can "
            "reach the dynamic-agents service."
        )

    if conversation_id is None:
        conversation_id = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"autonomous-task:{task_id}")
        )

    effective_timeout = settings.dynamic_agents_timeout_seconds

    base = _normalize_base_url(settings.dynamic_agents_url)
    url = f"{base}/api/v1/chat/stream/start"
    full_prompt = _build_prompt_with_context(prompt, context)
    body = {
        "message": full_prompt,
        "conversation_id": conversation_id,
        "agent_id": agent_id,
        "trace_id": task_id,
        # Pin the wire format. ``custom`` is what we have a translator
        # for; ``agui`` would need its own translation table.
        "protocol": "custom",
        "autonomous": True,
    }

    logger.info(
        "dynamic_agents_client.invoke_streaming: task=%s agent=%s url=%s timeout=%.1fs",
        task_id,
        agent_id,
        url,
        effective_timeout,
    )

    captured_events: list[dict[str, Any]] = []
    accumulated_text = ""
    tool_name_by_call_id: dict[str, str] = {}
    sse_error: str | None = None

    _effective_email = owner_email or get_settings().dynamic_agents_system_email
    headers = {
        **(await _task_headers_with_auth(
            _effective_email, effective_timeout, owner_sub
        )),
        "Accept": "text/event-stream",
    }

    try:
        async with httpx.AsyncClient(timeout=effective_timeout) as client:
            async with client.stream(
                "POST", url, json=body, headers=headers
            ) as response:
                if response.status_code == 404:
                    # Read the body so the connection is properly closed
                    # before we raise.
                    await response.aread()
                    raise DynamicAgentsClientError(
                        f"dynamic-agents service has no agent with id "
                        f"'{agent_id}' (HTTP 404 from {url})."
                    )
                if response.status_code >= 400:
                    await response.aread()
                    if _is_autonomous_authorization_revoked(response.status_code, response.text):
                        raise DynamicAgentsAuthorizationRevokedError(
                            f"autonomous access revoked for agent '{agent_id}'"
                        )
                    raise DynamicAgentsClientError(
                        f"dynamic-agents service returned HTTP "
                        f"{response.status_code} for agent '{agent_id}' on {url}."
                    )

                async for event_type, data in _iter_sse_events(response):
                    if event_type == "content":
                        text = data.get("text", "")
                        if isinstance(text, str):
                            accumulated_text += text
                    elif event_type == "tool_start":
                        captured_events.append(
                            _translate_tool_start_to_a2a(data, tool_name_by_call_id)
                        )
                    elif event_type == "tool_end":
                        captured_events.append(
                            _translate_tool_end_to_a2a(data, tool_name_by_call_id)
                        )
                    elif event_type == "error":
                        sse_error = str(data.get("error") or "Unknown SSE error")
                        # Don't break the loop -- let the upstream send
                        # ``done`` so the connection closes cleanly.
                    elif event_type == "done":
                        break
                    # Ignore: warning, input_required (HITL not supported
                    # in the autonomous-task path; the run can't pause
                    # mid-flight for an operator response).
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise DynamicAgentsClientError(
            f"dynamic-agents service at {url} did not respond: {exc}"
        ) from exc
    except httpx.HTTPStatusError as exc:
        # raise_for_status fallback path (some httpx versions raise
        # HTTPStatusError outside the .stream() context-manager body).
        if exc.response.status_code == 404:
            raise DynamicAgentsClientError(
                f"dynamic-agents service has no agent with id '{agent_id}' "
                f"(HTTP 404 from {url})."
            ) from exc
        raise DynamicAgentsClientError(
            f"dynamic-agents service returned HTTP "
            f"{exc.response.status_code} for agent '{agent_id}' on {url}."
        ) from exc

    if sse_error:
        raise DynamicAgentsClientError(
            f"dynamic-agents service streaming error: {sse_error}"
        )

    if not accumulated_text:
        accumulated_text = "(dynamic agent returned no text content)"

    # Append a synthetic final_result artifact mirroring the supervisor's
    # streaming path, so the UI replay's FinalAnswer segment is populated
    # for dynamic-agent runs the same way it is for supervisor-targeted
    # runs.
    captured_events.append(_emit_final_result_event(accumulated_text))

    logger.info(
        "dynamic_agents_client.invoke_streaming complete: task=%s "
        "events=%d, %d chars of final text",
        task_id,
        len(captured_events),
        len(accumulated_text),
    )
    return accumulated_text, captured_events


async def preflight_dynamic_agent(
    *,
    agent_id: str,
    timeout: float | None = None,
) -> Acknowledgement:
    """Confirm the autonomous service is configured to dispatch ``agent_id``.

    The dynamic-agents service exposes no read-only agent endpoint, so this
    is a configuration-level preflight rather than a live existence probe: it
    verifies ``DYNAMIC_AGENTS_URL`` is set and records the routing target.
    Agent existence and per-user authorization are enforced at run time by
    the dynamic-agents ``/api/v1/chat`` endpoints (``mongo.get_agent`` +
    ``require_agent_use_permission``); a missing or unpermitted agent surfaces
    as a failed run with a clear error. NEVER raises -- every outcome maps to
    an :class:`Acknowledgement` so the caller can persist it unconditionally.

    Args:
        agent_id: Dynamic-agents service agent id.
        timeout: Accepted for call-site compatibility; unused (no network call).
    """
    settings = get_settings()
    if not settings.dynamic_agents_url:
        return Acknowledgement.application_failure(
            "DYNAMIC_AGENTS_URL is not configured on the autonomous-agents "
            "service; dynamic-agent tasks cannot be dispatched until it is set."
        )

    logger.info(
        "dynamic_agents_client.preflight: agent=%s url=%s (config-level)",
        agent_id,
        settings.dynamic_agents_url,
    )

    return Acknowledgement(
        ack_status="ok",
        ack_detail=(
            "Autonomous service is configured to dispatch this task to the "
            "dynamic-agents runtime; agent existence and access are verified "
            "at run time."
        ),
        routed_to=agent_id,
        tools=[],
        available_agents=[],
        credentials_status={},
        dry_run_summary=(
            f"At each scheduled run the prompt will be POSTed to the dynamic-"
            f"agents service /api/v1/chat endpoints as agent '{agent_id}'."
        ),
        ack_at=datetime.now(timezone.utc),
    )

"""Execute registered A2A tasks without an extra model or remote credential copy."""
from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

import httpx
from a2a.client import ClientCallContext
from a2a.client.errors import A2AClientError
from a2a.types import (
    CancelTaskRequest,
    GetTaskRequest,
    Message,
    Part,
    Role,
    SendMessageRequest,
    StreamResponse,
    TaskState,
)
from dynamic_agents.auth.authz import require_agent_use_permission
from dynamic_agents.auth.token_context import current_traceparent, current_user_token
from dynamic_agents.services.remote_agent_tool import _field_is_set, _RemoteOutput, remote_agent_client

from harness_engine.adapters.base import ExecutionUnconfirmedError
from harness_engine.models import CanonicalEventDraft, RunContext, TurnOutcome

_TERMINAL = {TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_CANCELED,
             TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED}
_PAUSED = {TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED}


class A2ARuntime:
    def __init__(self, registry_runtime: Any) -> None:
        self.registry = registry_runtime
        self.active: dict[str, asyncio.Event] = {}

    async def cancel_run(self, run_id: str) -> bool:
        if event := self.active.get(run_id):
            event.set()
            # The producer confirms remote cancellation or drains to a terminal
            # task before the coordinator releases its reservation.
            return True
        return False

    @staticmethod
    def _updates(run_id: str, text: str) -> list[CanonicalEventDraft]:
        value = {"type": "tool_output", "tool_call_id": run_id, "result": text}
        return [
            CanonicalEventDraft(event_type="runtime.event", data={
                "protocol": "agui", "name": "CUSTOM", "payload": {"type": "CUSTOM", "name": "TOOL_OUTPUT", "value": value},
            }),
            CanonicalEventDraft(event_type="runtime.event", data={
                "protocol": "custom", "name": "tool_output", "payload": value,
            }),
        ]

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        identity = context.identity
        registry_id = context.blueprint.harness.options.get("registry_id")
        if (identity is None or identity.subject != context.binding.owner_subject
                or context.blueprint.id != f"a2a-{registry_id}"):
            raise PermissionError("A2A requires the admitted caller and a matching registry identity")
        token_scope = current_user_token.set(identity.bearer.get_secret_value())
        trace_scope = current_traceparent.set(context.turn.traceparent)
        cancellation = asyncio.Event()
        self.active[context.turn.run_id] = cancellation
        dispatched = False
        confirmed = False
        try:
            await require_agent_use_permission(context.blueprint.id, delegated_user_sub=identity.subject)
            await self.registry.initialize()
            entries = await asyncio.to_thread(self.registry.mongo.get_remote_agents_by_ids, [registry_id])
            if not entries:
                raise PermissionError("The A2A registry entry was disabled or removed")
            entry = entries[0]
            settings = self.registry.mongo.settings
            timeout = int(entry.get("timeout_seconds", 120))
            if not 1 <= timeout <= 600:
                raise ValueError("A2A timeout is outside the registry bounds")
            message = context.turn.message
            task_id: str | None = None
            if context.turn.command == "resume":
                pending = context.binding.pending_interrupt or {}
                task_id = pending.get("a2a_task_id")
                message = (context.turn.resume_data or {}).get("values", {}).get("message", "")
                if not isinstance(task_id, str) or not isinstance(message, str) or not message.strip():
                    raise ValueError("Resume requires the saved A2A task and a reply")
            elif context.turn.command != "start" or context.turn.attachments or context.turn.config_override:
                raise ValueError("A2A supports addressed text and saved-task replies only")
            output = _RemoteOutput(settings.remote_a2a_max_output_bytes)
            provider_context = context.binding.provider_session_id
            state: int | None = None
            yield CanonicalEventDraft(event_type="tool.started", data={
                "tool_call_id": context.turn.run_id, "tool_name": "remote_a2a", "arguments": {"message": message},
            })
            async with asyncio.timeout(timeout):
                async with remote_agent_client(
                    endpoint=entry["endpoint"], credential_source=entry.get("credential_source"),
                    caller_token=identity.bearer.get_secret_value(), credential_api_url=settings.credential_api_url,
                    credential_service_audience=settings.credential_service_audience,
                    allowed_http_origins=settings.remote_a2a_allowed_http_origins,
                    timeout_seconds=timeout, streaming=entry.get("streaming") is True,
                    max_response_bytes=settings.remote_a2a_max_response_bytes,
                ) as client:
                    request = SendMessageRequest(message=Message(
                        message_id=context.turn.run_id, context_id=provider_context or "", task_id=task_id or "",
                        role=Role.ROLE_USER, parts=[Part(text=message)],
                    ))
                    call_context = ClientCallContext(timeout=float(timeout))
                    dispatched = True
                    responses = client.send_message(request, context=call_context)
                    # Keep SDK output snapshots in tool events. A2A artifact
                    # replacement must never append duplicate prose to the answer.
                    async with aclosing(responses):
                        exhausted = False
                        cancel_attempted = False
                        while True:
                            if cancellation.is_set() and task_id and not cancel_attempted:
                                cancel_attempted = True
                                try:
                                    task = await client.cancel_task(CancelTaskRequest(id=task_id), context=call_context)
                                    response = StreamResponse(task=task)
                                except (httpx.HTTPError, A2AClientError, RuntimeError, ValueError):
                                    # Cancellation is best effort; drain/poll the task.
                                    response = StreamResponse(task=await client.get_task(GetTaskRequest(id=task_id), context=call_context))
                            elif not exhausted:
                                try:
                                    response = await anext(responses)
                                except StopAsyncIteration:
                                    exhausted = True
                                    continue
                                except (httpx.HTTPError, A2AClientError):
                                    if not task_id:
                                        raise
                                    exhausted = True
                                    continue
                            elif task_id:
                                await asyncio.sleep(0.25)
                                response = StreamResponse(task=await client.get_task(GetTaskRequest(id=task_id), context=call_context))
                            else:
                                raise ExecutionUnconfirmedError("A2A ended without a terminal message or task")
                            item = next((getattr(response, name) for name in ("task", "status_update", "artifact_update", "message")
                                         if _field_is_set(response, name)), None)
                            if item is None:
                                continue
                            if remote_context := getattr(item, "context_id", ""):
                                if provider_context and remote_context != provider_context:
                                    raise ExecutionUnconfirmedError("A2A changed context identity during a task")
                                if not provider_context:
                                    provider_context = remote_context
                                    yield CanonicalEventDraft(event_type="session.updated", data={"provider_session_id": provider_context})
                            if remote_task := (getattr(item, "task_id", "") or (getattr(item, "id", "") if _field_is_set(response, "task") else "")):
                                if task_id and remote_task != task_id:
                                    raise ExecutionUnconfirmedError("A2A changed task identity during execution")
                                task_id = remote_task
                                yield CanonicalEventDraft(event_type="runtime.event", data={
                                    "protocol": "agui", "name": "CUSTOM", "payload": {"type": "CUSTOM", "name": "A2A_TASK", "value": {"task_id": task_id, "context_id": provider_context}},
                                })
                            status = getattr(item, "status", None) if not _field_is_set(response, "artifact_update") else None
                            if status is not None:
                                state = status.state
                                confirmed = state in _TERMINAL or state in _PAUSED
                            if state == TaskState.TASK_STATE_CANCELED:
                                yield TurnOutcome(status="cancelled")
                                return
                            if output.update(response):
                                for event in self._updates(context.turn.run_id, output.text):
                                    yield event
                            if _field_is_set(response, "message") and not task_id:
                                confirmed = True
                                break
                            if state in _TERMINAL or state in _PAUSED:
                                break
            yield CanonicalEventDraft(event_type="tool.completed", data={
                "tool_call_id": context.turn.run_id, "tool_name": "remote_a2a", "result": output.text,
            })
            if state in _PAUSED:
                if cancellation.is_set():
                    raise ExecutionUnconfirmedError("A2A still requires input after Stop")
                yield TurnOutcome(status="paused", interrupt={
                    "interrupt_id": f"a2a-{uuid.uuid4()}", "interrupt_type": "form_input", "a2a_task_id": task_id,
                    "user_input": True, "input_title": "Remote agent needs input",
                    "input_description": output.status_text or "Reply to the remote agent. Manage credentials in Connections; do not enter tokens or passwords here.",
                    "input_fields": [{"field_name": "message", "field_label": "Reply", "field_type": "text", "required": True}],
                }, result={"content": output.text})
            else:
                if output.text:
                    yield CanonicalEventDraft(event_type="content.delta", data={"text": output.text})
                yield TurnOutcome(status="cancelled" if cancellation.is_set() else "completed", result={"content": output.text, "a2a_task_id": task_id})
        except ExecutionUnconfirmedError:
            raise
        except BaseException as exc:
            if dispatched and not confirmed:
                raise ExecutionUnconfirmedError("Remote A2A completion could not be confirmed") from exc
            raise
        finally:
            self.active.pop(context.turn.run_id, None)
            current_user_token.reset(token_scope)
            current_traceparent.reset(trace_scope)

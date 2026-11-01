"""Dispatch SDK execution to a private worker while Engine retains run ownership."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx

from harness_engine.adapters.base import ExecutionUnconfirmedError
from harness_engine.adapters.claude_sdk import ClaudeSDKAdapter
from harness_engine.config import Settings
from harness_engine.models import (
    AdapterEvaluation,
    AgentBlueprint,
    CanonicalEventDraft,
    CapabilityLevel,
    CapabilityResult,
    ExecutionMode,
    HarnessDescriptor,
    HarnessProfile,
    RunContext,
    RunEvent,
    TurnOutcome,
    ValidationIssue,
)
from harness_engine.sessions import EventAssignedProviderSessionManager

logger = logging.getLogger(__name__)


@dataclass
class RemoteAttempt:
    client: httpx.AsyncClient
    cancelled: bool = False
    admitted: bool = False


class RemoteClaudeSDKAdapter:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._profiles = settings.claude_worker_profiles()
        self._template = ClaudeSDKAdapter(settings.model_copy(update={"storage_backend": "memory"}))
        self._transport = transport
        self._active: dict[str, RemoteAttempt] = {}
        self.session_manager = EventAssignedProviderSessionManager(
            "claude_agent_sdk_remote", checkpoint_strategy="adapter_store"
        )

    @property
    def descriptor(self) -> HarnessDescriptor:
        native = CapabilityResult(level=CapabilityLevel.NATIVE)
        return self._template.descriptor.model_copy(
            update={
                "id": "claude_agent_sdk_remote",
                "display_name": "Claude Agent SDK (Remote worker)",
                "execution_mode": ExecutionMode.REMOTE_WORKER,
                "availability": "available" if self._profiles else "misconfigured",
                "profiles": [
                    HarnessProfile(
                        id=alias,
                        harness_id="claude_agent_sdk_remote",
                        display_name=alias,
                        description=profile.description,
                    )
                    for alias, profile in sorted(self._profiles.items())
                ],
                "capabilities": {
                    **self._template.descriptor.capabilities,
                    "thread.persistence": native,
                    "session.cross_replica": native,
                    "tools.broker": CapabilityResult(
                        level=CapabilityLevel.EMULATED
                        if any(p.tools_enabled for p in self._profiles.values())
                        else CapabilityLevel.UNAVAILABLE,
                        explanation="Selected MCP tools retain caller and agent authorization through CAIPE",
                        constraints={"approval_policy": ["never"]},
                    ),
                },
            }
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        result = self._template.evaluate(blueprint)
        profile = self._profiles.get(blueprint.harness.profile_id)
        if blueprint.tools.bindings and profile is not None and not profile.tools_enabled:
            result.issues.append(
                ValidationIssue(
                    path="tools.bindings",
                    capability="tools.broker",
                    level=CapabilityLevel.UNAVAILABLE,
                    severity="error",
                    message="This worker profile does not enable MCP tools",
                )
            )
        return result

    async def _request(self, client: httpx.AsyncClient, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        for attempt in range(3):
            try:
                response = await client.request(method, path, **kwargs)
                if response.status_code >= 500:
                    raise httpx.TransportError("Worker service temporarily unavailable")
                response.raise_for_status()
                payload = response.json()
                if not payload.get("success") or not isinstance(payload.get("data"), dict):
                    raise ValueError("Invalid worker response")
                return payload["data"]
            except httpx.TransportError:
                if attempt == 2:
                    raise ExecutionUnconfirmedError("The worker request could not be confirmed") from None
                await asyncio.sleep(0.1 * 2**attempt)
        raise AssertionError("Unreachable retry state")

    async def cancel_run(self, run_id: str) -> bool:
        attempt = self._active.get(run_id)
        if attempt is None:
            return False
        attempt.cancelled = True
        if attempt.admitted:
            await self._request(attempt.client, "DELETE", f"/api/v1/worker/runs/{run_id}")
        return True

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        profile = self._profiles[context.binding.profile_id]
        headers = {
            "Authorization": f"Bearer {profile.token.get_secret_value()}",
            "X-Harness-Engine-Subject": context.binding.owner_subject,
        }
        if context.identity is not None:
            headers["X-Harness-Caller-Token"] = context.identity.bearer.get_secret_value()
        # Only private operator configuration selects the host and worker profile.
        forwarded = context.model_copy(
            update={
                "blueprint": context.blueprint.model_copy(
                    update={
                        "harness": context.blueprint.harness.model_copy(
                            update={"id": "claude_agent_sdk", "profile_id": profile.profile_id}
                        )
                    }
                ),
                "binding": context.binding.model_copy(
                    update={"harness_id": "claude_agent_sdk", "profile_id": profile.profile_id}
                ),
            }
        )
        run_id = context.turn.run_id
        drained = False
        async with httpx.AsyncClient(
            base_url=profile.url.rstrip("/"),
            headers=headers,
            transport=self._transport,
            timeout=httpx.Timeout(40.0, connect=10.0),
        ) as client:
            attempt = RemoteAttempt(client)
            self._active[run_id] = attempt
            try:
                try:
                    receipt = await self._request(
                        client, "POST", "/api/v1/worker/runs", json=forwarded.model_dump(mode="json")
                    )
                    if receipt.get("run", {}).get("run_id") != run_id:
                        raise ValueError("Worker admission returned a different run identity")
                except httpx.HTTPStatusError as error:
                    # Definitive pre-admission denials did not dispatch a producer.
                    if error.response.status_code in {400, 401, 403, 422}:
                        drained = True
                    raise
                attempt.admitted = True
                if attempt.cancelled:
                    await self._request(client, "DELETE", f"/api/v1/worker/runs/{run_id}")
                cursor = 0
                while True:
                    if attempt.cancelled:
                        await self._request(client, "DELETE", f"/api/v1/worker/runs/{run_id}")
                    page = await self._request(
                        client, "GET", f"/api/v1/worker/runs/{run_id}", params={"after": cursor, "wait": 15}
                    )
                    for raw in page["events"]:
                        event = RunEvent.model_validate(raw)
                        if event.run_id != run_id or event.sequence != cursor + 1:
                            raise ValueError("Worker replay is not contiguous")
                        cursor = event.sequence
                        if event.event_type not in {"run.started", "run.completed", "run.cancelled", "run.failed"}:
                            yield CanonicalEventDraft(event_type=event.event_type, data=event.data)
                    status = page["run"]["status"]
                    if status in {"completed", "failed", "cancelled"} and page["drained"]:
                        drained = True
                        if status == "failed":
                            raise RuntimeError("Remote SDK execution failed")
                        yield TurnOutcome(status="cancelled" if status == "cancelled" else "completed")
                        return
                    if status in {"completed", "failed", "cancelled"}:
                        # Terminal publication precedes reservation release. Yield
                        # while the worker drains its provider and cancellation watcher.
                        await asyncio.sleep(0.025)
            finally:
                self._active.pop(run_id, None)
                if not drained:
                    try:
                        stopped = await self._request(client, "DELETE", f"/api/v1/worker/runs/{run_id}")
                        for _ in range(3):
                            if stopped["drained"]:
                                drained = True
                                break
                            stopped = await self._request(
                                client, "GET", f"/api/v1/worker/runs/{run_id}", params={"wait": 1}
                            )
                    except (httpx.HTTPError, ValueError, KeyError, ExecutionUnconfirmedError) as error:
                        logger.warning(
                            "Worker stop could not be confirmed",
                            extra={
                                "run_id": run_id,
                                "error_type": type(error).__name__,
                            },
                        )
                    if not drained:
                        raise ExecutionUnconfirmedError(
                            "The worker may still be executing; retain the session reservation"
                        )

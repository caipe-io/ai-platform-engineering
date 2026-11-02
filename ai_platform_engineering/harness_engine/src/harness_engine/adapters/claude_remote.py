"""Dispatch SDK execution to a private worker while Engine retains run ownership."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx

from harness_engine.acp_events import EXTENSION
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
    session_id: str
    cancelled: bool = False
    admitted: bool = False


class RemoteClaudeSDKAdapter:
    def __init__(
        self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None, *, claude_acp: bool = False
    ) -> None:
        self._profiles = {
            key: value
            for key, value in settings.claude_worker_profiles().items()
            if not claude_acp or value.runtime == "claude_code_acp"
        }
        self._harness_id = "claude_code_acp" if claude_acp else "claude_agent_sdk_remote"
        self._claude_acp = claude_acp
        self._template = ClaudeSDKAdapter(settings.model_copy(update={"storage_backend": "memory"}))
        self._transport = transport
        self._active: dict[str, RemoteAttempt] = {}
        self.session_manager = EventAssignedProviderSessionManager(
            self._harness_id, checkpoint_strategy="adapter_store"
        )

    @property
    def descriptor(self) -> HarnessDescriptor:
        native = CapabilityResult(level=CapabilityLevel.NATIVE)
        return self._template.descriptor.model_copy(
            update={
                "id": self._harness_id,
                "display_name": "Claude (ACP)" if self._claude_acp else "Claude Agent SDK (Remote worker)",
                "execution_mode": ExecutionMode.REMOTE_WORKER,
                "availability": "available" if self._profiles else "misconfigured",
                "profiles": [
                    HarnessProfile(
                        id=alias,
                        harness_id=self._harness_id,
                        display_name=alias,
                        description=profile.description,
                    )
                    for alias, profile in sorted(self._profiles.items())
                ],
                "capabilities": {
                    **self._template.descriptor.capabilities,
                    "thread.persistence": native,
                    "session.cross_replica": CapabilityResult(
                        level=CapabilityLevel.UNAVAILABLE
                        if any(p.runtime == "claude_code_acp" for p in self._profiles.values())
                        else CapabilityLevel.NATIVE,
                        explanation="Claude Code ACP requires a persistent worker volume; SDK workers share MongoDB transcripts",
                    ),
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

    async def _request(self, client: httpx.AsyncClient, method: str, params: dict[str, Any]) -> dict[str, Any]:
        rpc = {"jsonrpc": "2.0", "method": method, "params": params}
        if method != "session/cancel":
            rpc["id"] = method
        for attempt in range(3):
            try:
                response = await client.post("/acp", json=rpc)
                if response.status_code >= 500:
                    raise httpx.TransportError("Worker service temporarily unavailable")
                response.raise_for_status()
                if response.status_code == 204 and method == "session/cancel":
                    return {}
                payload = response.json()
                if (
                    payload.get("jsonrpc") != "2.0"
                    or payload.get("id") != method
                    or not isinstance(payload.get("result"), dict)
                ):
                    raise ValueError("Invalid ACP worker response")
                return payload["result"]
            except httpx.TransportError:
                if attempt == 2:
                    raise ExecutionUnconfirmedError("The ACP worker request could not be confirmed") from None
                await asyncio.sleep(0.1 * 2**attempt)
        raise AssertionError("Unreachable retry state")

    def _run_params(self, attempt: RemoteAttempt, run_id: str) -> dict[str, Any]:
        return {"sessionId": attempt.session_id, "_meta": {EXTENSION: {"runId": run_id}}}

    async def cancel_run(self, run_id: str) -> bool:
        attempt = self._active.get(run_id)
        if attempt is None:
            return False
        attempt.cancelled = True
        if attempt.admitted:
            try:
                await self._request(attempt.client, "session/cancel", self._run_params(attempt, run_id))
            except httpx.HTTPStatusError as error:
                # Cancellation can race admission. The sender also cancels after
                # reconnecting; absence here never proves the producer drained.
                if error.response.status_code != 404:
                    raise
        return True

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        profile = self._profiles[context.binding.profile_id]
        headers = {
            "Authorization": f"Bearer {profile.token.get_secret_value()}",
            "X-Harness-Engine-Subject": context.binding.owner_subject,
            "ACP-Protocol-Version": "1",
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
        run_id, session_id = context.turn.run_id, context.binding.binding_id
        drained = False
        async with httpx.AsyncClient(
            base_url=profile.url.rstrip("/"),
            headers=headers,
            transport=self._transport,
            timeout=httpx.Timeout(40.0, connect=10.0),
        ) as client:
            attempt = RemoteAttempt(client, session_id)
            self._active[run_id] = attempt
            try:
                initialized = await self._request(
                    client,
                    "initialize",
                    {
                        "protocolVersion": 1,
                        "clientCapabilities": {},
                        "_meta": {EXTENSION: {"transport": "http-ndjson-v1", "durableReplay": True}},
                    },
                )
                if initialized.get("protocolVersion") != 1 or not initialized.get("_meta", {}).get(EXTENSION, {}).get(
                    "durableReplay"
                ):
                    raise ValueError("Worker does not support the durable ACP transport")
                if initialized["_meta"][EXTENSION].get("runtime", "sdk") != profile.runtime:
                    raise ValueError("Worker runtime does not match its operator profile")
                setup = {
                    "cwd": "/workspace",
                    "mcpServers": [],
                    "_meta": {EXTENSION: {"context": forwarded.model_dump(mode="json")}},
                }
                method = "session/resume" if context.binding.provider_session_id else "session/new"
                if method == "session/resume":
                    if "resume" not in initialized.get("agentCapabilities", {}).get("sessionCapabilities", {}):
                        raise ValueError("Worker does not support ACP session resume")
                    setup["sessionId"] = session_id
                await self._request(client, method, setup)
                cursor = 0
                for retry in range(3):
                    params = {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": context.turn.message}],
                        "_meta": {EXTENSION: {"context": forwarded.model_dump(mode="json"), "after": cursor}},
                    }
                    rpc = {"jsonrpc": "2.0", "id": run_id, "method": "session/prompt", "params": params}
                    try:
                        attempt.admitted = True
                        async with client.stream("POST", "/acp", json=rpc) as response:
                            if response.status_code >= 500:
                                raise httpx.TransportError("Worker service temporarily unavailable")
                            if retry == 0 and response.status_code in {400, 401, 403, 422}:
                                drained = True
                            response.raise_for_status()
                            if attempt.cancelled:
                                await self._request(client, "session/cancel", self._run_params(attempt, run_id))
                            async for line in response.aiter_lines():
                                if not line:
                                    continue
                                frame = json.loads(line)
                                if frame.get("jsonrpc") != "2.0":
                                    raise ValueError("Invalid ACP frame")
                                if frame.get("method") in {"session/update", "_caipe/event"}:
                                    notification = frame["params"]
                                    event = RunEvent.model_validate(notification["_meta"][EXTENSION]["event"])
                                    if (
                                        notification["sessionId"] != session_id
                                        or event.run_id != run_id
                                        or event.sequence != cursor + 1
                                    ):
                                        raise ValueError("ACP worker replay is not contiguous")
                                    cursor = event.sequence
                                    if event.event_type not in {
                                        "run.started",
                                        "run.completed",
                                        "run.cancelled",
                                        "run.failed",
                                    }:
                                        yield CanonicalEventDraft(event_type=event.event_type, data=event.data)
                                elif frame.get("id") == run_id and "result" in frame:
                                    final = frame["result"]["_meta"][EXTENSION]
                                    run = final["run"]
                                    if (
                                        run["run_id"] != run_id
                                        or cursor != run["last_sequence"]
                                        or not final["drained"]
                                        or run["status"] not in {"completed", "failed", "cancelled"}
                                    ):
                                        raise ValueError("ACP completion did not confirm the committed event tail")
                                    drained = True
                                    if run["status"] == "failed":
                                        raise RuntimeError("Remote SDK execution failed")
                                    yield TurnOutcome(
                                        status="cancelled" if run["status"] == "cancelled" else "completed"
                                    )
                                    return
                                else:
                                    raise ValueError("Unexpected ACP worker message")
                        raise httpx.TransportError("ACP prompt stream ended before completion")
                    except httpx.TransportError:
                        if retry == 2:
                            raise ExecutionUnconfirmedError("The ACP prompt could not be confirmed") from None
                        await asyncio.sleep(0.1 * 2**retry)
            finally:
                self._active.pop(run_id, None)
                if not drained and not attempt.admitted:
                    # Session setup cannot launch a provider.
                    drained = True
                if not drained:
                    try:
                        params = self._run_params(attempt, run_id)
                        await self._request(client, "session/cancel", params)
                        for _ in range(3):
                            stopped = await self._request(client, "_caipe/run_state", params)
                            drained = bool(stopped["drained"])
                            if drained:
                                break
                            await asyncio.sleep(0.1)
                    except (httpx.HTTPError, ValueError, KeyError, ExecutionUnconfirmedError) as error:
                        logger.warning(
                            "ACP worker stop could not be confirmed",
                            extra={"run_id": run_id, "error_type": type(error).__name__},
                        )
                    if not drained:
                        raise ExecutionUnconfirmedError(
                            "The worker may still be executing; retain the session reservation"
                        )

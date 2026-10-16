"""A sandbox placement of the same admitted CAIPE execution lifecycle."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import AsyncExitStack, aclosing, asynccontextmanager
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig, InputFile
from dynamic_agents.services.harness_acp import HarnessACPDriver
from dynamic_agents.services.harness_checkpoints import CheckpointIdentity, CheckpointManifest, CheckpointStore
from dynamic_agents.services.harness_inputs import HarnessInputs
from dynamic_agents.services.harness_policy import (
    harness_middleware_entries,
    harness_middleware_params,
    harness_model_retry_options,
)
from dynamic_agents.services.harness_workspace import HarnessWorkspaceBridge
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.native_run_coordinator import current_native_execution_run
from dynamic_agents.services.native_run_repository import NativeRunRepository
from dynamic_agents.services.native_state_protocol import STATE_ARCHIVE, STATE_EXCLUDED_PATHS, STATE_FORMAT
from dynamic_agents.services.sandbox_client import (
    SandboxAllocation,
    SandboxClient,
    SandboxError,
    SandboxIdentityChanged,
    SandboxNotFound,
    SandboxProfile,
)
from dynamic_agents.services.session_bindings import (
    adopt_sandbox_checkpoint_profile,
    get_sandbox_binding,
    save_sandbox_binding,
)
from dynamic_agents.services.session_runs import await_session_operation, current_native_session_lease
from dynamic_agents.services.stream_encoders import StreamEncoder
from dynamic_agents.services.stream_encoders.events import RunError, RunFinished, WarningEvent
from dynamic_agents.services.stream_encoders.semantic import SemanticStreamEncoder

logger = logging.getLogger(__name__)


@dataclass
class SandboxRuntime:
    driver: HarnessACPDriver
    run_id: str
    workspace: HarnessWorkspaceBridge
    attachments: bool
    close_connection: Callable[[], Awaitable[None]]
    checkpoint: Callable[[str], Awaitable[CheckpointManifest]]
    warnings: tuple[str, ...] = ()

    async def _preserve_interrupted(self, status: str) -> None:
        async def preserve() -> None:
            async with asyncio.timeout(90):
                await self.close_connection()
                await self.checkpoint(status)
        pending = asyncio.create_task(preserve())
        while not pending.done():
            try:
                await asyncio.shield(pending)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not pending.cancelled() and pending.exception() is not None:
            logger.warning("Interrupted native harness checkpoint failed", extra={"error_type": type(pending.exception()).__name__})

    async def dispatch(self, message: str, encoder: StreamEncoder[str], files: list[InputFile] | None) -> AsyncGenerator[str, None]:
        if files and not self.attachments:
            raise SandboxError("The sandbox profile has not qualified attachments")
        semantic = SemanticStreamEncoder()
        capture_attempted = False
        try:
            for warning in self.warnings:
                for frame in encoder.encode_event(WarningEvent(message=warning)):
                    yield frame
            finished = None
            async with aclosing(self.driver.stream(message, semantic, run_id=self.run_id, files=files)) as events:
                async for event in events:
                    if isinstance(event, RunFinished):
                        finished = event
                        break
                    for frame in encoder.encode_event(event):
                        yield frame
            if finished is None:
                raise SandboxError("The harness did not complete its prompt")
            await self.close_connection()
            for warning in await self.workspace.publish():
                if warning in self.warnings:
                    continue
                for frame in encoder.encode_event(WarningEvent(message=warning)):
                    yield frame
            capture_attempted = True
            try:
                await self.checkpoint("completed")
            except Exception as exc:
                for frame in encoder.encode_event(RunError(
                    message="The harness responded, but CAIPE could not confirm its native checkpoint. This turn has not been acknowledged as durably completed; saved state is retained for recovery.",
                    code="native_state_checkpoint_failed",
                )):
                    yield frame
                raise SandboxError("The native harness checkpoint failed; the turn was not completed") from exc
            for frame in encoder.encode_event(finished):
                yield frame
        except asyncio.CancelledError:
            if not capture_attempted:
                await self._preserve_interrupted("cancelled")
            raise
        except Exception:
            if not capture_attempted:
                await self._preserve_interrupted("interrupted")
            raise


def _checkpoint_identity(agent: DynamicAgentConfig, session_id: str, state: dict[str, Any]) -> CheckpointIdentity:
    return CheckpointIdentity(agent_id=agent.id, session_id=session_id, owner_subject=state["owner_subject"],
        profile_id=state["profile"]["id"], profile_revision=state["profile"]["revision"],
        harness=state["profile"]["harness"], provider_session_id=state["provider_session_id"],
        connection_version=state["connection_version"])


def _restore_descriptors(manifest: CheckpointManifest) -> tuple[dict[str, Any], dict[str, Any]]:
    header = {"type": "header", "format": STATE_FORMAT, "archive": STATE_ARCHIVE, "checkpoint_id": manifest.checkpoint_id,
        "profile_id": manifest.identity.profile_id, "profile_revision": manifest.identity.profile_revision,
        "harness": manifest.identity.harness, "provider_session_id": manifest.identity.provider_session_id,
        "cwd": manifest.metadata.cwd, "sha256": manifest.metadata.sha256, "bytes": manifest.metadata.bytes,
        "excluded_paths": STATE_EXCLUDED_PATHS, "runtime_versions": manifest.metadata.runtime_versions}
    complete = {**header, "type": "complete", "members": manifest.metadata.members, "expanded_bytes": manifest.metadata.expanded_bytes}
    return header, complete


def _workspace_files(prompt: str, skills_files: dict[str, Any], harness: str) -> dict[str, str]:
    files = {"AGENTS.md": prompt, "CLAUDE.md": prompt}
    root = ".claude/skills/" if harness == "claude-code" else ".agents/skills/"
    for path, value in skills_files.items():
        if not path.startswith("/skills/"):
            raise SandboxError("A skill file is outside its approved skill directory")
        relative = path.removeprefix("/skills/")
        if any(part in {"", ".", ".."} for part in relative.split("/")) or "\\" in relative or "\x00" in relative:
            raise SandboxError("A skill file path is invalid")
        content = value.get("content", "") if isinstance(value, dict) else value
        if isinstance(content, list):
            content = "\n".join(content)
        if not isinstance(content, str):
            raise SandboxError("A skill file has an unsupported content type")
        files[root + relative] = content
    return files


def _session_options(agent: DynamicAgentConfig, prompt: str, profile: SandboxProfile) -> dict:
    if profile.harness != "claude-code":
        return {}
    options: dict[str, Any] = {
        "systemPrompt": prompt, "settingSources": ["project"], "allowDangerouslySkipPermissions": False,
    }
    options["env"], _ = harness_model_retry_options(agent)
    # Programmatic settings take precedence over project-controlled settings.
    # Keep the admitted retry budget from drifting after a workspace edit.
    options["settings"] = {"env": dict(options["env"])}
    # Preserve the configured execution bound using the harness's own loop,
    # including the same defaults used when no middleware list was saved.
    call_limit = harness_middleware_params(agent, "model_call_limit")
    if call_limit is not None:
        if call_limit.get("thread_limit") is not None:
            raise SandboxError("Sandbox model-call limits currently support per-run limits; a thread limit requires a supported policy")
        limit = call_limit.get("run_limit")
        if limit is not None:
            if type(limit) is not int or limit <= 0:
                raise SandboxError("Model call run_limit must be a positive integer")
            options["maxTurns"] = limit
    return {"claudeCode": {"options": options}}


@asynccontextmanager
async def sandbox_runtime(
    mongo: MongoDBService, agent: DynamicAgentConfig, session_id: str, settings: Settings,
    *, system_prompt: str, skills_files: dict[str, Any], mcp_servers: list[Any],
    bind_driver: Callable[[HarnessACPDriver], None],
    bind_workspace: Callable[[HarnessWorkspaceBridge], None],
) -> AsyncGenerator[SandboxRuntime, None]:
    run = current_native_execution_run.get()
    lease_id = current_native_session_lease.get()
    if run is None or lease_id is None:
        raise SandboxError("Sandbox execution requires a durable admitted CAIPE run and live session lease")
    client = SandboxClient(settings)
    connection_version = hashlib.sha256(client.base.encode()).hexdigest()
    store = await asyncio.to_thread(CheckpointStore, mongo)
    saved = await await_session_operation(get_sandbox_binding, mongo, agent.id, session_id)
    profiles = await client.profiles()
    profile = next((item for item in profiles if item.id == agent.execution.profile_id), None)
    if profile is None:
        raise SandboxError("The sandbox execution profile is unavailable; choose an admitted profile in a new conversation")
    if not profile.capabilities.get("mcp", False):
        raise SandboxError("The sandbox profile has not qualified CAIPE platform tool access")
    if skills_files and not profile.capabilities.get("skills", False):
        raise SandboxError("The sandbox profile has not qualified the agent's configured skills")
    if saved is not None:
        if saved.get("owner_subject") != run.owner_subject or saved.get("connection_version") != connection_version:
            raise SandboxError("This sandbox is bound to its original caller and connection")
        if saved.get("profile") != profile.model_dump():
            if not saved.get("provider_session_id") or saved.get("checkpoint_phase") not in {None, "adopting"}:
                raise SandboxError("The admitted sandbox profile changed; explicit migration is required")
            saved = await await_session_operation(adopt_sandbox_checkpoint_profile, mongo, agent.id, session_id,
                profile.model_dump(), lease_id)
    state = dict(saved) if saved is not None else {
        "owner_subject": run.owner_subject, "connection_version": connection_version,
        "profile": profile.model_dump(), "allocation": None, "provider_session_id": None,
        "checkpoint_phase": "initial_capture_pending",
    }
    if state.get("provider_session_id") and state.get("checkpoint_phase") is None:
        state = await await_session_operation(adopt_sandbox_checkpoint_profile, mongo, agent.id, session_id,
            profile.model_dump(), lease_id)
    await await_session_operation(save_sandbox_binding, mongo, agent.id, session_id, state)
    identity = _checkpoint_identity(agent, session_id, state) if state.get("provider_session_id") else None
    latest = await store.latest(identity) if identity is not None else None
    if identity is not None and latest is None and state.get("checkpoint_phase") not in {"adopting", "initial_capture_pending"}:
        raise SandboxError("The existing native session has no committed checkpoint; explicit state recovery is required")
    intent = await store.begin_restore(identity, checkpoint_id=latest.checkpoint_id, lease_id=lease_id) if latest is not None else None
    if intent is not None and intent.get("allocation") is not None:
        # A previous worker may have lost the restore receipt. The pending
        # destination is pinned, but not executable until this restore verifies.
        previous_destination = SandboxAllocation.model_validate(intent["allocation"])
        try:
            allocation = await client.restore(previous_destination, profile)
        except (SandboxNotFound, SandboxIdentityChanged):
            allocation = await client.lookup(agent.id, session_id, profile)
            if allocation is None:
                allocation = await client.provision(agent.id, session_id, profile)
            intent = await store.restage_restore_allocation(latest.identity, checkpoint_id=latest.checkpoint_id,
                restore_id=intent["restore_id"], expected_allocation=previous_destination.model_dump(),
                new_allocation=allocation.model_dump(), lease_id=lease_id)
    elif state["allocation"] is None:
        if identity is not None:
            raise SandboxError("The original native session allocation is missing and has no committed checkpoint")
        allocation = await client.provision(agent.id, session_id, profile)
        state["allocation"] = allocation.model_dump()
        await await_session_operation(save_sandbox_binding, mongo, agent.id, session_id, state)
    else:
        try:
            allocation = await client.restore(SandboxAllocation.model_validate(state["allocation"]), profile)
        except (SandboxNotFound, SandboxIdentityChanged):
            if latest is None:
                raise SandboxError("The original native session allocation is missing and has no committed checkpoint") from None
            # Intent predates remote create. A lost provision acknowledgement
            # is recovered by an owner-bound lookup, never transcript replay.
            allocation = await client.lookup(agent.id, session_id, profile)
            if allocation is None:
                allocation = await client.provision(agent.id, session_id, profile)

    async def capture(status: str) -> CheckpointManifest:
        current_identity = _checkpoint_identity(agent, session_id, state)
        checkpoint_id = str(uuid4())
        journal = await await_session_operation(mongo._db["native_acp_execution_runs"].find_one,
            {"run_id": run.run_id, "agent_id": agent.id, "session_id": session_id, "owner_subject": run.owner_subject, "lease_id": lease_id})
        if journal is None:
            raise SandboxError("The native-state capture no longer owns its journal admission")
        async with client.export_state(allocation, profile, checkpoint_id=checkpoint_id,
                provider_session_id=current_identity.provider_session_id) as exported:
            writer = await store.open_writer(current_identity, checkpoint_id=checkpoint_id, lease_id=lease_id, base_metadata={
                "format": STATE_FORMAT, "archive": STATE_ARCHIVE, "cwd": allocation.cwd, "source_allocation_uid": allocation.uid,
                "run_id": run.run_id, "journal_cursor": journal.get("last_sequence", 0), "capture_status": status,
                "runtime_versions": exported.header.get("runtime_versions", {}),
            })
            try:
                async for chunk in exported.chunks():
                    await writer.write(chunk)
                metadata = {key: exported.complete[key] for key in ("sha256", "bytes", "members", "expanded_bytes")}
                return await writer.commit(metadata)
            except BaseException:
                await writer.abort()
                raise

    if identity is not None and latest is None:
        # No new prompt can run until this exact pinned legacy/first session is
        # imported. Failed capture stays pending rather than becoming a fallback.
        latest = await capture("interrupted")
    if latest is not None:
        if allocation.cwd != latest.metadata.cwd:
            raise SandboxError("The replacement workspace does not match its native checkpoint")
        if intent is None:
            intent = await store.begin_restore(latest.identity, checkpoint_id=latest.checkpoint_id, lease_id=lease_id)
        intent = await store.record_restore_allocation(latest.identity, checkpoint_id=latest.checkpoint_id,
            restore_id=intent["restore_id"], allocation=allocation.model_dump(), lease_id=lease_id)
        header, complete = _restore_descriptors(latest)
        await client.restore_state(allocation, profile, header=header, complete=complete,
            chunks=lambda: store.download(latest.identity, latest), restore_id=intent["restore_id"])
        state = await store.replace_allocation(latest.identity, checkpoint_id=latest.checkpoint_id,
            restore_id=intent["restore_id"], allocation=allocation.model_dump(), lease_id=lease_id)
    state = await await_session_operation(get_sandbox_binding, mongo, agent.id, session_id)
    if state is None:
        raise SandboxError("The native session binding disappeared during recovery")
    existing_session_id = state.get("provider_session_id")
    workspace = HarnessWorkspaceBridge(mongo, agent, session_id, client, allocation)
    inputs_files = await workspace.seed_inputs()
    workspace_prompt = system_prompt + (
        "\n\nWorkspace files: your real filesystem is rooted at the approved working directory. "
        "Existing CAIPE logical files are copied under inputs/ with their relative paths retained. "
        "For example, logical /reports/input.txt is available as inputs/reports/input.txt. "
        "Write new output files using workspace-relative paths. Approved text and binary outputs are "
        "published to CAIPE when the turn finishes. Do not place credentials in output files."
    )
    files = _workspace_files(workspace_prompt, skills_files, profile.harness)
    files.update(inputs_files)
    await client.prepare(allocation, files)
    bind_workspace(workspace)
    inputs = HarnessInputs(NativeRunRepository(mongo))

    async def persist_session(provider_session_id: str) -> None:
        state["provider_session_id"] = provider_session_id
        await await_session_operation(save_sandbox_binding, mongo, agent.id, session_id, state)

    async with client.execution(allocation, run.run_id), AsyncExitStack() as connection_stack:
        transport = await connection_stack.enter_async_context(client.acp(allocation))
        driver = HarnessACPDriver(
            transport, agent_name=agent.name, canonical_session_id=session_id,
            persist_session=persist_session, persist_input=lambda pending: inputs.persist(run.run_id, pending),
            wait_for_decision=lambda pending: inputs.wait(run.run_id, pending),
        )
        closed = False

        async def close_connection() -> None:
            nonlocal closed
            if not closed:
                try:
                    await driver.close()
                finally:
                    await connection_stack.aclose()
                closed = True

        bind_driver(driver)
        try:
            await driver.open(allocation.cwd, mcp_servers=mcp_servers, existing_session_id=existing_session_id,
                              session_meta=_session_options(agent, workspace_prompt, profile))
            if not driver.capabilities.get("loadSession"):
                raise SandboxError("The sandbox harness must support loading its durable native session")
            _, policy_warnings = harness_model_retry_options(agent)
            policy_warnings += tuple(workspace.warnings)
            if (harness_middleware_params(agent, "model_call_limit") or {}).get("run_limit") is not None:
                policy_warnings += (
                    "The configured model-call run limit is applied as Claude Code's native maxTurns budget. "
                    "Native harness budget exhaustion stops this turn without acknowledging successful completion; "
                    "CAIPE middleware exit_behavior does not replace that native result.",
                )
            if harness_middleware_params(agent, "tool_retry") is not None:
                policy_warnings += (
                    "Configured tool retries apply to server-admitted read-only or idempotent CAIPE tools. "
                    "CAIPE does not automatically repeat mutations with an uncertain outcome. "
                    "Claude Code controls its own filesystem and shell tool recovery.",
                )
            if harness_middleware_entries(agent, "tool_call_limit"):
                policy_warnings += (
                    "Configured tool-call run limits count admitted CAIPE broker requests, including delegation, "
                    "rather than Claude Code's local filesystem or shell tools. Repeated observers of one request "
                    "reuse its saved result. A continue limit returns a tool error; error/end stops the turn "
                    "without acknowledging successful completion.",
                )
            yield SandboxRuntime(driver, run.run_id, workspace, profile.capabilities.get("attachments", False), close_connection,
                                 capture, policy_warnings)
        finally:
            await close_connection()

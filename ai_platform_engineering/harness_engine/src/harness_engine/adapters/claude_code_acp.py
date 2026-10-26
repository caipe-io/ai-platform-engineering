"""Private Claude Code ACP provider owned by the existing Harness Engine."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack
from typing import Any
from uuid import uuid4

from gridfs import GridFSBucket
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from harness_engine.coding.acp_client import HarnessACPDriver
from harness_engine.coding.admission import ClosedBindingFence, CodingAdmissionError, RunFence
from harness_engine.coding.attachments import CodingAttachments
from harness_engine.coding.authorization import AuthorizedRunCredentials
from harness_engine.coding.config import SandboxSettings, profile_fingerprint, profiles, service_url
from harness_engine.coding.git_http import git_environment
from harness_engine.coding.inputs import CodingInputs, SubmitCodingInput
from harness_engine.coding.resources import platform_resources
from harness_engine.coding.sandbox import (
    SandboxAllocation,
    SandboxClient,
    SandboxError,
    SandboxIdentityChanged,
    SandboxNotFound,
    SandboxProfileReference,
)
from harness_engine.coding.state import ProviderStateError, ProviderStateStore
from harness_engine.coding.workspace import capture_artifacts
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
    ProviderTurnOutcome,
    RenderedPrompt,
    RunContext,
    RunRecord,
    SessionBinding,
    TurnInput,
    ValidationIssue,
)
from harness_engine.repository import RunRepository
from harness_engine.sessions import EventAssignedProviderSessionManager, ProviderSessionManager

HARNESS_ID = "claude_code_acp"
logger = logging.getLogger(__name__)


class ClaudeCodeOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_turns: int = Field(100, ge=1, le=1000)


def _skill_files(files: dict[str, Any]) -> dict[str, str]:
    prepared: dict[str, str] = {}
    for path, value in files.items():
        if not isinstance(path, str) or not path.startswith("/skills/"):
            raise CodingAdmissionError("A skill file is outside its approved skill directory")
        relative = path.removeprefix("/skills/")
        if any(part in {"", ".", ".."} for part in relative.split("/")) or "\\" in relative or "\x00" in relative:
            raise CodingAdmissionError("A skill file path is invalid")
        content = value.get("content", "") if isinstance(value, dict) else value
        if isinstance(content, list):
            content = "\n".join(content)
        if not isinstance(content, str) or len(content.encode()) > 1024 * 1024:
            raise CodingAdmissionError("A skill file has an unsupported content type or size")
        prepared[".claude/skills/" + relative] = content
    return prepared


class ClaudeCodeACPAdapter:
    def __init__(
        self,
        settings: Settings,
        *,
        repository: RunRepository,
        sandbox_factory: Callable[..., SandboxClient] = SandboxClient,
        driver_factory: Callable[..., HarnessACPDriver] = HarnessACPDriver,
    ) -> None:
        self.settings, self.repository = settings, repository
        self._profiles = profiles(settings)
        self._sandbox_factory, self._driver_factory = sandbox_factory, driver_factory
        self._session_manager = EventAssignedProviderSessionManager(HARNESS_ID, checkpoint_strategy="adapter_store")
        self._active: dict[str, HarnessACPDriver] = {}

    def _configured(self) -> bool:
        try:
            for value in (
                self.settings.coding_sandbox_service_url,
                self.settings.coding_platform_url,
                self.settings.coding_resources_url,
                self.settings.coding_tools_public_url,
                self.settings.coding_obo_token_url,
            ):
                service_url(value)
        except ValueError:
            return False
        return (
            self.repository.provider_database is not None
            and bool(self._profiles)
            and bool(self.settings.coding_obo_client_id)
            and bool(self.settings.coding_obo_client_secret)
        )

    @property
    def session_manager(self) -> ProviderSessionManager:
        return self._session_manager

    @property
    def descriptor(self) -> HarnessDescriptor:
        configured = self._configured()
        supported = CapabilityResult(level=CapabilityLevel.NATIVE)
        return HarnessDescriptor(
            id=HARNESS_ID,
            display_name="Claude Code in a private sandbox",
            adapter_version="1.0.0",
            contract_version=2,
            execution_mode=ExecutionMode.SANDBOX_POD,
            availability="available" if configured else "misconfigured",
            certification="experimental",
            profiles=[
                HarnessProfile(
                    id=alias,
                    harness_id=HARNESS_ID,
                    display_name=alias.replace("-", " ").title(),
                    description=profile.description,
                    available=configured,
                    capabilities={
                        "git.smart_http": CapabilityResult(
                            level=CapabilityLevel.EMULATED if profile.git is not None else CapabilityLevel.UNAVAILABLE,
                            explanation="Brokered repository-scoped Git with current user authorization"
                            if profile.git is not None
                            else "No approved Git broker policy is configured",
                        )
                    },
                )
                for alias, profile in sorted(self._profiles.items())
            ],
            options_schema={
                "type": "object",
                "properties": {
                    "max_turns": {
                        "type": "integer",
                        "title": "Maximum turns",
                        "minimum": 1,
                        "maximum": 1000,
                        "default": 100,
                    }
                },
                "additionalProperties": False,
            },
            capabilities={
                "stream.text": supported,
                "stream.reasoning": supported,
                "stream.replay": CapabilityResult(
                    level=CapabilityLevel.EMULATED, explanation="The existing Engine owns the canonical event journal"
                ),
                "thread.persistence": supported,
                "session.cross_replica": supported,
                "sandbox.isolation": supported,
                "sandbox.workspace": supported,
                "human_input": supported,
                "human_input.resume": supported,
                "cancellation": supported,
                "attachments": supported,
                "history.server_owned": supported,
                "tools.broker": supported,
                "tools.platform": supported,
                "knowledge.platform": supported,
                "multi_agent.delegation": supported,
                "skills.files": supported,
                "policy.context_management": CapabilityResult(
                    level=CapabilityLevel.NATIVE,
                    explanation="Claude Code owns context compaction; custom DeepAgents context-editing settings are rejected",
                    constraints={"mode": "provider_native", "custom_sdk_policy": "unsupported"},
                ),
                "files.list": CapabilityResult(
                    level=CapabilityLevel.EMULATED,
                    explanation="Approved artifacts from acknowledged native-state checkpoints",
                ),
                "files.read": CapabilityResult(
                    level=CapabilityLevel.EMULATED,
                    explanation="Approved artifacts from acknowledged native-state checkpoints",
                ),
                "files.write": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Interactive edits require a new admitted harness turn",
                ),
                "files.delete": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="Interactive deletes require a new admitted harness turn",
                ),
                "memory.long_term": CapabilityResult(
                    level=CapabilityLevel.UNAVAILABLE,
                    explanation="A portable long-term memory broker is not configured",
                ),
            },
        )

    def evaluate(self, blueprint: AgentBlueprint) -> AdapterEvaluation:
        issues: list[ValidationIssue] = []
        try:
            options = ClaudeCodeOptions.model_validate(blueprint.harness.options)
        except ValidationError:
            return AdapterEvaluation(
                normalized_options={},
                issues=[
                    ValidationIssue(
                        path="harness.options",
                        capability="options",
                        level=CapabilityLevel.UNSUPPORTED,
                        severity="error",
                        message="Choose a supported Claude Code turn budget",
                    )
                ],
            )
        profile = self._profiles.get(blueprint.harness.profile_id)
        if profile and options.max_turns > profile.max_turns:
            issues.append(
                ValidationIssue(
                    path="harness.options.max_turns",
                    capability="limits",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message="The turn budget exceeds the operator profile",
                )
            )
        if blueprint.model.policy != "harness_default":
            issues.append(
                ValidationIssue(
                    path="model",
                    capability="model.selection",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message="The operator profile owns the Claude Code model",
                )
            )
        if blueprint.prompt.context_sources:
            issues.append(
                ValidationIssue(
                    path="prompt.context_sources",
                    capability="prompt.context_sources",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message="Unresolved prompt context sources are unsupported",
                )
            )
        if blueprint.delegation.max_depth > 1 or blueprint.delegation.max_parallel > 1:
            issues.append(
                ValidationIssue(
                    path="delegation",
                    capability="multi_agent.delegation",
                    level=CapabilityLevel.UNSUPPORTED,
                    severity="error",
                    message="Configured CAIPE specialists run through the serial platform dispatcher",
                )
            )
        return AdapterEvaluation(normalized_options=options.model_dump(), issues=issues)

    async def context(self, run_id: str, subject: str | None = None) -> RunContext:
        database = self.repository.provider_database
        if database is None:
            raise CodingAdmissionError("Canonical provider storage is unavailable")
        run = await self.repository.get_run(run_id)
        if not run or run.harness_id != HARNESS_ID or (subject is not None and run.owner_subject != subject):
            raise CodingAdmissionError("The coding harness run is unavailable")
        version = await self.repository.get_agent_version(run.agent_id, run.agent_version)
        binding = await self.repository.get_session(run.binding_id)
        document = await asyncio.to_thread(database.harness_runs.find_one, {"run_id": run_id})
        if not version or not binding or not document:
            raise CodingAdmissionError("The coding harness binding is unavailable")
        profile = self._profiles.get(binding.profile_id)
        expected = profile_fingerprint(profile) if profile is not None else None
        if expected is None or document.get("_coding_operator_policy_hash") != expected:
            raise CodingAdmissionError("The admitted operator policy changed; explicit migration is required")
        state = await asyncio.to_thread(database.harness_sessions.find_one, {"binding_id": binding.binding_id})
        if (
            state
            and state.get("_provider_state_head")
            and state["_provider_state_head"].get("operator_policy_hash") != expected
        ):
            raise CodingAdmissionError("The retained operator policy changed; explicit migration is required")
        return RunContext(
            blueprint=version.blueprint,
            binding=binding,
            prompt=RenderedPrompt(system=""),
            turn=TurnInput(run_id=run_id, message="", visible_conversation_id=run.visible_conversation_id),
            producer_token=document.get("_producer_id"),
        )

    async def submit_input(self, run_id: str, subject: str, request: SubmitCodingInput) -> tuple[RunRecord, int]:
        context = await self.context(run_id, subject)
        assert self.repository.provider_database is not None
        fence = RunFence(self.repository.provider_database, context)
        # Renew and recheck current use rights before a live answer can release
        # any tool effect. Exact completed retries remain read-only in Inputs.
        current = await self.repository.get_run(run_id)
        if current is not None and current.status in {"running", "awaiting_input"}:
            await AuthorizedRunCredentials(self.settings, fence).token()
        return await CodingInputs(fence).submit(request)

    async def delete_session(self, binding: SessionBinding) -> None:
        database = self.repository.provider_database
        if database is None:
            raise CodingAdmissionError("Canonical provider cleanup is unavailable")
        fence = ClosedBindingFence(database, binding)
        state, _ = await fence.require()
        head = state.get("_provider_state_head")
        if head is not None:
            base = service_url(self.settings.coding_sandbox_service_url)
            if hashlib.sha256(base.encode()).hexdigest() != head.get("connection"):
                raise CodingAdmissionError("Restore the admitted sandbox connection before permanent cleanup")
            credentials = AuthorizedRunCredentials(self.settings, fence)
            client = self._sandbox_factory(
                SandboxSettings(
                    sandbox_service_url=base,
                    sandbox_provision_timeout_seconds=self.settings.coding_sandbox_provision_timeout_seconds,
                ),
                bearer_provider=credentials.token,
            )
            await client.delete(
                SandboxAllocation.model_validate(head["allocation"]),
                SandboxProfileReference.model_validate(head["profile"]),
            )
        await fence.require()
        for name in ("harness_provider_state", "harness_workspace_artifacts"):
            bucket = GridFSBucket(database, bucket_name=name)
            documents = await asyncio.to_thread(
                lambda: list(
                    database[name + ".files"].find(
                        {"metadata.binding_id": binding.binding_id, "metadata.owner_subject": binding.owner_subject},
                        {"_id": 1},
                    )
                )
            )
            for document in documents:
                await fence.require()
                await asyncio.to_thread(bucket.delete, document["_id"])
        bucket = GridFSBucket(database, bucket_name="harness_attachments")
        attachments = await asyncio.to_thread(
            lambda: list(
                database["harness_attachments.files"].find(
                    {
                        "metadata.owner_subject": binding.owner_subject,
                        "metadata.agent_id": binding.agent_id,
                        "metadata.conversation_id": binding.conversation_id,
                    },
                    {"_id": 1},
                )
            )
        )
        for document in attachments:
            await fence.require()
            await asyncio.to_thread(bucket.delete, document["_id"])
        await asyncio.to_thread(
            database.harness_provider_checkpoints.delete_many,
            {"binding_id": binding.binding_id, "owner_subject": binding.owner_subject},
        )

    async def cancel(self, context: RunContext) -> None:
        driver = self._active.get(context.turn.run_id)
        if driver is not None:
            async with asyncio.timeout(10):
                await driver.cancel()

    async def stream(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | ProviderTurnOutcome]:
        database = self.repository.provider_database
        if database is None or not self._configured():
            raise CodingAdmissionError("The selected coding profile is not configured")
        profile_config = self._profiles[context.binding.profile_id]
        fence = RunFence(database, context)
        await fence.require()
        policy_hash = profile_fingerprint(profile_config)
        existing = await asyncio.to_thread(database.harness_runs.find_one, {"run_id": context.turn.run_id})
        if existing and existing.get("_coding_operator_policy_hash") not in (None, policy_hash):
            raise CodingAdmissionError("The admitted operator policy changed")
        pinned = await asyncio.to_thread(
            database.harness_runs.update_one,
            {
                "run_id": context.turn.run_id,
                "_producer_id": context.producer_token,
                "$or": [
                    {"_coding_operator_policy_hash": {"$exists": False}},
                    {"_coding_operator_policy_hash": policy_hash},
                ],
            },
            {"$set": {"_coding_operator_policy_hash": policy_hash}},
        )
        if pinned.matched_count != 1:
            raise CodingAdmissionError("The operator policy no longer owns its admission")
        credentials = AuthorizedRunCredentials(self.settings, fence)
        client = self._sandbox_factory(
            SandboxSettings(
                sandbox_service_url=self.settings.coding_sandbox_service_url or "",
                sandbox_provision_timeout_seconds=self.settings.coding_sandbox_provision_timeout_seconds,
            ),
            bearer_provider=credentials.token,
        )
        remote_profiles = await client.profiles()
        profile = next(
            (
                item
                for item in remote_profiles
                if item.id == profile_config.sandbox_profile_id and item.revision == profile_config.revision
            ),
            None,
        )
        if profile is None or not all(
            profile.capabilities.get(key) is True for key in ("mcp", "skills", "attachments")
        ):
            raise CodingAdmissionError("The pinned coding profile has not qualified the required CAIPE capabilities")
        state_store = ProviderStateStore(
            fence, connection=client.base, profile=profile, operator_profile=profile_config.model_dump(mode="json")
        )
        head = await state_store.head()
        manifest = await state_store.manifest(head) if head is not None else None
        allocation = None
        if head is not None:
            saved = SandboxAllocation.model_validate(head["allocation"])
            try:
                allocation = await client.restore(saved, profile)
            except (SandboxIdentityChanged, SandboxNotFound):
                allocation = await client.lookup(context.binding.agent_id, context.binding.binding_id, profile)
        if allocation is None:
            allocation = await client.provision(context.binding.agent_id, context.binding.binding_id, profile)
        inputs = CodingInputs(fence)
        options = ClaudeCodeOptions.model_validate(context.blueprint.harness.options)

        async def pin(provider_session_id: str) -> None:
            nonlocal head
            head = await state_store.pin_new(allocation, provider_session_id)

        async def capture(outcome: str) -> str:
            nonlocal head
            if head is None:
                raise ProviderStateError("The provider session identity was not acknowledged")
            artifacts = await capture_artifacts(client, allocation, fence)
            async with client.export_state(
                allocation, profile, checkpoint_id=str(uuid4()), provider_session_id=head["provider_session_id"]
            ) as exported:
                head = await state_store.capture(head, allocation, exported, outcome=outcome, artifacts=artifacts)
            return head["checkpoint_id"]

        async with (
            platform_resources(self.settings, fence, credentials) as resources,
            client.execution(allocation, context.turn.run_id),
        ):
            if manifest is not None and head is not None:
                if allocation.cwd != manifest["header"]["cwd"]:
                    raise ProviderStateError("The replacement workspace changed its admitted root")
                head = await state_store.record_restore(head, allocation)
                await client.restore_state(
                    allocation,
                    profile,
                    header=manifest["header"],
                    complete=manifest["complete"],
                    chunks=lambda: state_store.chunks(manifest),
                    restore_id=head["restore"]["id"],
                )
                head = await state_store.restored(head, allocation)
            system_prompt = resources.system_prompt
            if context.turn.context:
                system_prompt += "\n\n<client-system-context>\n" + context.turn.context + "\n</client-system-context>"
            retry = resources.execution_policy.get("model_retry")
            retry_count = retry.get("max_retries", 5) if isinstance(retry, dict) else 0
            if type(retry_count) is not int or retry_count < 0:
                raise CodingAdmissionError("The admitted model retry budget is invalid")
            environment = {"CLAUDE_CODE_MAX_RETRIES": str(retry_count)}
            if retry_count == 0:
                environment["CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES"] = "0"
            model_limit = resources.execution_policy.get("model_call_limit")
            native_turn_limit = model_limit.get("run_limit") if isinstance(model_limit, dict) else None
            if native_turn_limit is not None and (type(native_turn_limit) is not int or native_turn_limit <= 0):
                raise CodingAdmissionError("The admitted model turn budget is invalid")
            max_turns = min(options.max_turns, profile_config.max_turns, native_turn_limit or profile_config.max_turns)
            session_options: dict[str, Any] = {
                "systemPrompt": system_prompt,
                "settingSources": ["project"],
                "allowDangerouslySkipPermissions": False,
                "permissionMode": profile_config.permission_mode,
                "maxTurns": max_turns,
            }
            if profile_config.git is not None:
                environment.update(
                    git_environment(
                        self.settings.coding_tools_public_url or "", context.turn.run_id, resources.run_capability
                    )
                )
                session_options["systemPrompt"] += (
                    "\n\nUse HTTPS GitHub remotes for Git. Git credentials are provided by CAIPE's run-scoped broker; do not alter its URL rewrite or credential helper. The operator repository and branch policies apply to every fetch and push."
                )
            session_options["env"] = environment
            session_options["settings"] = {"env": dict(environment)}
            if profile_config.model:
                session_options["model"] = profile_config.model
            meta = {"claudeCode": {"options": session_options}}
            await client.prepare(allocation, _skill_files(resources.files))
            if head is None:
                # Native identity and an initial quiescent checkpoint precede
                # the first accepted prompt. Lost caches never become empty chat.
                async with client.acp(allocation) as transport:
                    initial = self._driver_factory(
                        transport,
                        agent_name=context.blueprint.name,
                        canonical_session_id=context.binding.conversation_id,
                        persist_session=pin,
                        persist_input=inputs.persist,
                        wait_for_decision=inputs.wait,
                    )
                    try:
                        async with asyncio.timeout(30):
                            await initial.open(allocation.cwd, resources.mcp_servers, session_meta=meta)
                    finally:
                        await initial.close()
                await capture("interrupted")
            assert head is not None
            try:
                async with AsyncExitStack() as stack:
                    transport = await stack.enter_async_context(client.acp(allocation))
                    driver = self._driver_factory(
                        transport,
                        agent_name=context.blueprint.name,
                        canonical_session_id=context.binding.conversation_id,
                        persist_session=pin,
                        persist_input=inputs.persist,
                        wait_for_decision=inputs.wait,
                    )
                    self._active[context.turn.run_id] = driver
                    stack.push_async_callback(driver.close)
                    async with asyncio.timeout(30):
                        await driver.open(
                            allocation.cwd,
                            resources.mcp_servers,
                            existing_session_id=head["provider_session_id"],
                            session_meta=meta,
                        )
                    yield CanonicalEventDraft(
                        event_type="session.updated", data={"provider_session_id": driver.session_id}
                    )
                    await resources.start(driver)
                    attachments = await CodingAttachments(database).resolve(fence, context.turn.attachments)
                    outcome: ProviderTurnOutcome | None = None
                    try:
                        try:
                            async with asyncio.timeout(context.blueprint.limits.max_run_seconds):
                                async for event in driver.stream(
                                    context.turn.message, run_id=context.turn.run_id, files=attachments
                                ):
                                    if isinstance(event, ProviderTurnOutcome):
                                        outcome = event
                                    else:
                                        yield event
                        except TimeoutError:
                            outcome = ProviderTurnOutcome(status="interrupted")
                    finally:
                        self._active.pop(context.turn.run_id, None)
            except BaseException:
                await resources.close()
                if resources.unsettled:
                    raise

                async def preserve_interrupted() -> None:
                    async with asyncio.timeout(90):
                        await capture("interrupted")

                preservation = asyncio.create_task(preserve_interrupted())
                while not preservation.done():
                    try:
                        await asyncio.shield(preservation)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break
                if preservation.cancelled() or preservation.exception() is not None:
                    logger.warning(
                        "Interrupted coding state remains unacknowledged", extra={"run_id": context.turn.run_id}
                    )
                raise
            await resources.close()
            if resources.unsettled:
                raise CodingAdmissionError(
                    "A platform effect has an unacknowledged outcome; the binding requires reconciliation"
                )
            if outcome is None:
                raise SandboxError("The coding harness did not acknowledge a stopped-turn outcome")
            # Close ACP/process locks first; state capture and publication must
            # succeed before the Engine may acknowledge durable completion.
            checkpoint = await capture(outcome.status)
            yield outcome.model_copy(update={"checkpoint": checkpoint})

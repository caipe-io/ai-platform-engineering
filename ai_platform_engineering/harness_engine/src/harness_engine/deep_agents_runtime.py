"""Reuse the Dynamic Agents package without starting its HTTP application."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from dynamic_agents.auth.authz import require_agent_use_permission
from dynamic_agents.auth.token_context import current_traceparent, current_user_token
from dynamic_agents.models import ClientContext, DynamicAgentConfig, DynamicAgentConfigBase, InputFile, UserContext
from dynamic_agents.routes.chat import apply_config_override
from dynamic_agents.services.app_context_prompt import app_context_scope
from dynamic_agents.services.execution import RuntimeEvent, execute_turn
from dynamic_agents.services.execution_lease import reserve_native_thread
from dynamic_agents.services.mongo import MongoDBService, _strip_nulls
from dynamic_agents.services.runtime_cache import AgentRuntimeCache

from harness_engine.models import AgentBlueprint, CanonicalEventDraft, RunContext, TurnOutcome, utc_now


class DeepAgentsRuntime:
    """One shared configuration reader/cache; caller credentials are scoped per run."""

    def __init__(self) -> None:
        self.mongo = MongoDBService()
        self.cache = AgentRuntimeCache(mongo_service=self.mongo)
        self.active: dict[str, Any] = {}
        self._ready = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        async with self._lock:
            if self._ready:
                return
            if not await asyncio.to_thread(self.mongo.connect):
                raise RuntimeError("Deep Agents configuration database is unavailable")
            self.cache.start()
            self._ready = True

    async def close(self) -> None:
        await self.cache.stop()
        self.mongo.disconnect()

    @staticmethod
    def normalize_options(options: dict[str, Any]) -> dict[str, Any]:
        if set(options) != {"runtime"} or not isinstance(options["runtime"], dict):
            raise ValueError("Deep Agents requires its validated runtime configuration")
        allowed = DynamicAgentConfigBase.model_fields
        if set(options["runtime"]) - set(allowed):
            raise ValueError("Unknown Deep Agents configuration field")
        config = DynamicAgentConfigBase.model_validate(_strip_nulls(options["runtime"]))
        return {"runtime": config.model_dump(mode="json")}

    async def snapshot(self, agent_id: str) -> AgentBlueprint:
        await self.initialize()
        agent = await asyncio.to_thread(self.mongo.get_agent, agent_id)
        if agent is None or not agent.enabled:
            raise ValueError("Deep Agents configuration is unavailable")
        config = {
            key: value
            for key, value in agent.model_dump(mode="json").items()
            if key in DynamicAgentConfigBase.model_fields
        }
        return AgentBlueprint.model_validate(
            {
                "id": agent.id,
                "name": agent.name,
                "description": agent.description or "",
                "harness": {"id": "dynamic_agents", "profile_id": "existing", "options": {"runtime": config}},
                "prompt": {"system": agent.system_prompt},
                "model": {"policy": "configured", "id": agent.model.id, "provider": agent.model.provider},
                "delegation": {"agents": [child.agent_id for child in agent.subagents]},
            }
        )

    async def cancel_run(self, run_id: str) -> bool:
        runtime = self.active.get(run_id)
        if runtime is None:
            return False
        runtime.cancel()
        return True

    async def restart_session(self, binding: Any) -> None:
        await self.initialize()
        # All replicas include this generation in their next cache key. No
        # checkpoint, pending approval or file is deleted by a reconnect.
        result = await asyncio.to_thread(
            self.mongo._db.execution_thread_leases.update_one,
            {"_id": binding.native_state_key, "active_run": None},
            {"$inc": {"cache_generation": 1}},
            upsert=True,
        )
        if not result.acknowledged:
            raise RuntimeError("Runtime reconnect was not acknowledged")

    async def execute(self, context: RunContext) -> AsyncIterator[CanonicalEventDraft | TurnOutcome]:
        await self.initialize()
        identity = context.identity
        if identity is None or identity.subject != context.binding.owner_subject:
            raise PermissionError("Deep Agents requires the admitted caller's delegated identity")
        bearer = identity.bearer.get_secret_value()
        token_scope = current_user_token.set(bearer)
        trace_scope = current_traceparent.set(context.turn.traceparent)
        try:
            # Reuse the existing CAS adapter. The BFF also checks conversation
            # write before admission; its service credential is never a tool credential.
            await require_agent_use_permission(context.blueprint.id, delegated_user_sub=identity.subject)
            current = await asyncio.to_thread(self.mongo.get_agent, context.blueprint.id)
            if current is None or not current.enabled:
                raise PermissionError("Agent is disabled or unavailable")
            snapshot = self.normalize_options(context.blueprint.harness.options)["runtime"]
            config = DynamicAgentConfig.model_validate(
                {
                    **snapshot,
                    "_id": current.id,
                    "owner_id": current.owner_id,
                    "system_prompt": context.prompt.system,
                    "created_at": current.created_at,
                    "updated_at": current.updated_at,
                    "model": {
                        **snapshot["model"],
                        "id": context.blueprint.model.id,
                        "provider": context.blueprint.model.provider,
                    },
                }
            )
            if context.turn.config_override:
                # The same validator constrains per-turn model/reasoning overrides
                # and prevents a caller from widening the saved tool grants.
                config = apply_config_override(config, context.turn.config_override)
            for child in config.subagents:
                await require_agent_use_permission(child.agent_id, delegated_user_sub=identity.subject)
                child_record = await asyncio.to_thread(self.mongo._db.dynamic_agents.find_one, {"_id": child.agent_id})
                if not child_record or (child_record.get("execution_harness_id") or "dynamic_agents") != "dynamic_agents":
                    raise PermissionError("Native subagents require an authorized Deep Agents configuration")
            user = UserContext(
                **{
                    **identity.user_context,
                    "email": identity.email or identity.subject,
                    "sub": identity.subject,
                    "access_token": bearer,
                }
            )
            client_context = (
                ClientContext.model_validate(context.turn.client_context) if context.turn.client_context else None
            )
            servers = await asyncio.to_thread(self.mongo.get_agent_mcp_servers, config)
            native_id = context.binding.provider_session_id
            if not native_id:
                raise ValueError("Deep Agents binding has no native thread")
            async with reserve_native_thread(
                self.mongo._db,
                config,
                native_id,
                context.turn.run_id,
                owner="harness_engine",
                adopt=context.turn.command == "reconcile" or context.binding.last_run_id is None,
                handoff_to=context.turn.handoff_owner,
            ):
                lease = await asyncio.to_thread(
                    self.mongo._db.execution_thread_leases.find_one, {"_id": context.binding.native_state_key}
                )
                cache_scope = hashlib.sha256(
                    json.dumps(
                        [
                            identity.subject,
                            identity.principal_type,
                            bearer,
                            context.binding.agent_version,
                            context.turn.client_context,
                            context.turn.config_override,
                            lease.get("cache_generation", 0) if lease else 0,
                        ],
                        sort_keys=True,
                    ).encode()
                ).hexdigest()
                runtime = await self.cache.get_or_create(
                    config, servers, native_id, user=user, client_context=client_context, cache_scope=cache_scope
                )
                files: list[InputFile] = []
                for reference in context.turn.attachments:
                    stored = await asyncio.to_thread(
                        self.mongo._db.harness_attachment_blobs.find_one,
                        {
                            "_id": reference.id,
                            "owner_subject": identity.subject,
                            "agent_id": config.id,
                            "conversation_id": context.binding.conversation_id,
                            "expires_at": {"$gt": utc_now()},
                        },
                    )
                    if stored is None:
                        raise PermissionError("Attachment is unavailable to this conversation")
                    files.append(InputFile.model_validate(stored["file"]))
                self.active[context.turn.run_id] = runtime
                if context.turn.command == "rewind":
                    target = context.turn.rewind_data or {}
                    checkpoint_id = await runtime.rewind_before_turn(
                        native_id, context.turn.turn_id, target["message_content"], target["content_occurrence"]
                    )
                    yield TurnOutcome(status="completed", result={"content": "", "checkpoint_id": checkpoint_id})
                    return
                # A legacy checkpoint may already be paused before Engine adoption.
                pending = await runtime.has_pending_interrupt(native_id, strict=True)
                if context.turn.command == "reconcile":
                    if pending:
                        yield TurnOutcome(
                            status="paused", interrupt={**pending, "interrupt_type": pending.get("type", "form_input")}
                        )
                    else:
                        yield TurnOutcome(status="completed", result={"content": ""})
                    return
                if context.turn.command == "start" and pending:
                    yield TurnOutcome(
                        status="paused", interrupt={**pending, "interrupt_type": pending.get("type", "form_input")}
                    )
                    return
                if context.turn.command == "resume":
                    expected = context.binding.pending_interrupt or {}
                    if not pending or pending["interrupt_id"] != expected.get("interrupt_id"):
                        raise ValueError("Native checkpoint no longer matches the admitted interrupt")
                resume_data = json.dumps(context.turn.resume_data) if context.turn.command == "resume" else None
                with app_context_scope(config.app_context_prompt, context.turn.client_context):
                    async with aclosing(
                        execute_turn(
                            runtime,
                            session_id=native_id,
                            user_id=user.email,
                            message=context.turn.message,
                            resume_data=resume_data,
                            trace_id=context.turn.traceparent,
                            files=files,
                            turn_id=context.turn.turn_id,
                        )
                    ) as events:
                        async for event in events:
                            if isinstance(event, RuntimeEvent):
                                yield CanonicalEventDraft(
                                    event_type="runtime.event",
                                    data={
                                        "protocol": event.protocol,
                                        "name": event.name,
                                        "payload": event.data,
                                    },
                                )
                            else:
                                persisted = await runtime.has_pending_interrupt(native_id, strict=True)
                                if persisted:
                                    yield TurnOutcome(
                                        status="paused",
                                        interrupt={**persisted, "interrupt_type": persisted.get("type", "form_input")},
                                    )
                                else:
                                    yield TurnOutcome(
                                        status=event.status, interrupt=event.interrupt, result=event.result
                                    )
        finally:
            self.active.pop(context.turn.run_id, None)
            current_user_token.reset(token_scope)
            current_traceparent.reset(trace_scope)

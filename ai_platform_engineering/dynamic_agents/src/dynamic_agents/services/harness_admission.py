"""Authorize existing logical artifacts before exposing them to a harness."""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar

from dynamic_agents.auth.authz import current_subject_reference
from dynamic_agents.config import Settings
from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxError
from dynamic_agents.services.session_runs import await_session_operation

InlineHarnessAdmission = Callable[[DynamicAgentConfig | None, str], Awaitable[None]]
inline_harness_admission: ContextVar[InlineHarnessAdmission | None] = ContextVar("inline_harness_admission", default=None)


async def require_inline_harness_admission(agent: DynamicAgentConfig | None, agent_id: str) -> None:
    """Qualify the exact inline definition only for an external child call.

    Ordinary native execution has no callback. The external child service
    installs its policy while holding the child session lease; a missing or
    changed inline agent must fail before tools or a model are constructed.
    """
    if admission := inline_harness_admission.get():
        await admission(agent, agent_id)


async def require_harness_workspace(
    mongo: MongoDBService, agent: DynamicAgentConfig, session_id: str, settings: Settings,
) -> tuple[str, str | None, str]:
    namespace = resolve_runtime_storage(agent, session_id, settings).fs_namespace
    if namespace == (agent.id, session_id, "filesystem"):
        return namespace
    # A client-supplied filesystem namespace is never authority. Only the
    # canonical workflow engine can bind a running step to shared run files.
    subject = current_subject_reference()
    if mongo._db is None or not subject or namespace[2] != "filesystem":
        raise SandboxError("A shared workspace requires an admitted workflow execution")
    run = await await_session_operation(mongo._db["workflow_runs"].find_one, {"_id": namespace[1]})
    kind, identifier = subject.split(":", 1)
    if (run is None or run.get("workflow_config_id") != namespace[0]
            or run.get("owner_subject") != {"type": kind, "id": identifier}
            or run.get("status") not in {"running", "waiting_for_input"}):
        raise SandboxError("The shared workflow workspace is not admitted for this caller")
    step = next((step for step in run.get("steps", []) if (
        step.get("agent_id") == agent.id and step.get("status") in {"running", "waiting_for_input"}
        and session_id == f"wf-{namespace[1]}-s{step.get('index')}-a{step.get('attempts')}"
    )), None)
    if step is None:
        raise SandboxError("The agent execution is not the current admitted workflow step")
    # Interactive conversation IDs are server-generated; a workflow namespace
    # must never alias an interactive conversation.
    conversation = await await_session_operation(mongo._db["conversations"].find_one, {"_id": namespace[1]}, {"_id": 1})
    if conversation is not None:
        raise SandboxError("A workflow artifact namespace cannot alias a conversation")
    return namespace

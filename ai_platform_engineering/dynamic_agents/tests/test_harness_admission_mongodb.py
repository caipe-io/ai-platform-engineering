"""Existing workflow artifacts require the real current run and caller."""

from types import SimpleNamespace

import pytest
from deepagents.backends.utils import create_file_data

from dynamic_agents.models import AgentBackend, AgentBackendConfig, AgentExecutionConfig
from dynamic_agents.services import harness_admission
from dynamic_agents.services.harness_admission import require_harness_workspace
from dynamic_agents.services.harness_workspace import HarnessWorkspaceBridge
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxClient, SandboxError
from tests.test_native_acp_mongodb import native_database as native_database


def workflow(state: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> tuple:
    namespace = ("example-workflow", "example-run", "filesystem")
    state.session_id = "wf-example-run-s0-a1"
    state.agent = state.agent.model_copy(update={
        "execution": AgentExecutionConfig(kind="sandbox", profile_id="primary"),
        "backend": AgentBackend(type="store", config=AgentBackendConfig(fs_namespace=list(namespace))),
    })
    monkeypatch.setattr(harness_admission, "current_subject_reference", lambda: "user:owner")
    state.db["workflow_runs"].insert_one({
        "_id": namespace[1], "workflow_config_id": namespace[0], "status": "running",
        "owner_subject": {"type": "user", "id": "owner"},
        "steps": [{"index": 0, "agent_id": state.agent.id, "status": "running", "attempts": 1}],
    })
    return namespace


async def test_admitted_shared_workflow_inputs_and_outputs_use_existing_canonical_store(native_database, monkeypatch):
    state = native_database
    namespace = workflow(state, monkeypatch)
    assert await require_harness_workspace(state.mongo, state.agent, state.session_id, state.settings) == namespace
    allocation = SandboxAllocation(id="primary", uid="generation", namespace="primary",
        conversation_id=SandboxClient.conversation_reference(state.agent.id, state.session_id),
        profile_id="primary", revision="v1", cwd="/workspace", state="Ready")
    bridge = HarnessWorkspaceBridge(state.mongo, state.agent, state.session_id, None, allocation)
    bridge.store.put(namespace, "/steps/0/input.txt", create_file_data("Prior step output"))
    assert await bridge.seed_inputs() == {"inputs/steps/0/input.txt": "Prior step output"}
    # Retrying the workflow invalidates the original step's admission.
    state.db["workflow_runs"].update_one({"_id": namespace[1]}, {"$set": {"steps.0.attempts": 2}})
    with pytest.raises(SandboxError, match="current admitted workflow step"):
        await bridge.seed_inputs()


@pytest.mark.parametrize("change", ["owner", "workflow", "step-agent", "attempt", "finished", "alias", "missing"])
async def test_client_namespace_cannot_substitute_another_run_or_conversation(native_database, monkeypatch, change):
    state = native_database
    namespace = workflow(state, monkeypatch)
    updates = {
        "owner": {"owner_subject.id": "other"}, "workflow": {"workflow_config_id": "other"},
        "step-agent": {"steps.0.agent_id": "other"}, "attempt": {"steps.0.attempts": 2},
        "finished": {"status": "completed"},
    }
    if change in updates:
        state.db["workflow_runs"].update_one({"_id": namespace[1]}, {"$set": updates[change]})
    elif change == "alias":
        state.db["conversations"].insert_one({"_id": namespace[1]})
    elif change == "missing":
        state.db["workflow_runs"].delete_many({})
    with pytest.raises(SandboxError):
        await require_harness_workspace(state.mongo, state.agent, state.session_id, state.settings)

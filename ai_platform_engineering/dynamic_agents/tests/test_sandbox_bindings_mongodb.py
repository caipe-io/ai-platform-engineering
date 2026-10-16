"""Runtime changes preserve executable native state and external references."""

from copy import deepcopy

import pytest

from dynamic_agents.models import AgentExecutionConfig
from dynamic_agents.services.session_bindings import (
    SessionBindingError,
    get_native_binding,
    get_sandbox_binding,
    resolve_native_binding,
    save_sandbox_binding,
)
from tests.test_native_acp_mongodb import native_database as native_database


def _sandbox(agent):
    return agent.model_copy(update={"execution": AgentExecutionConfig(kind="sandbox", profile_id="example-harness")}, deep=True)


def test_existing_native_binding_remains_native_after_definition_switch(native_database):
    state = native_database
    original = resolve_native_binding(state.mongo, state.agent, state.session_id)
    updated = resolve_native_binding(state.mongo, _sandbox(state.agent), state.session_id)
    assert updated.execution.kind == "native"
    assert updated.backend == original.backend
    assert get_native_binding(state.mongo, state.agent.id, state.session_id).execution.kind == "native"


def test_legacy_native_checkpoint_without_acp_binding_is_never_replaced_by_a_sandbox(native_database):
    state = native_database
    state.db["example_checkpoints"].insert_one({"thread_id": state.session_id, "checkpoint": {"example": "original-state"}})
    updated = resolve_native_binding(state.mongo, _sandbox(state.agent), state.session_id)
    assert updated.execution.kind == "native"
    assert state.db["example_checkpoints"].find_one({"thread_id": state.session_id})["checkpoint"] == {"example": "original-state"}


def test_new_conversation_can_use_sandbox_while_original_stays_native(native_database):
    state = native_database
    resolve_native_binding(state.mongo, state.agent, state.session_id)
    sandbox = resolve_native_binding(state.mongo, _sandbox(state.agent), "new-conversation")
    assert sandbox.execution.kind == "sandbox"
    assert get_native_binding(state.mongo, state.agent.id, state.session_id).execution.kind == "native"
    retained = resolve_native_binding(state.mongo, state.agent, "new-conversation")
    assert retained.execution.kind == "sandbox"  # Placement never changes during an ordinary turn.


@pytest.mark.parametrize("field", ["allocation", "profile", "owner_subject", "connection_version", "provider_session_id"])
def test_admitted_environment_and_provider_identity_cannot_be_silently_rebound(native_database, field):
    state = native_database
    resolve_native_binding(state.mongo, _sandbox(state.agent), state.session_id)
    binding = {"allocation": {"id": "example-sandbox", "uid": "example-uid"}, "profile": {"id": "example-harness", "revision": "1"},
               "owner_subject": "user:example-owner", "connection_version": "original-connection", "provider_session_id": "original-provider-session"}
    save_sandbox_binding(state.mongo, state.agent.id, state.session_id, binding)
    changed = deepcopy(binding)
    changed[field] = {"id": "other"} if isinstance(binding[field], dict) else "other"
    with pytest.raises(SessionBindingError):
        save_sandbox_binding(state.mongo, state.agent.id, state.session_id, changed)
    assert get_sandbox_binding(state.mongo, state.agent.id, state.session_id) == binding

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for MongoDBService.get_agent null-field handling.

Regression test for: DynamicAgentConfig(**doc) receiving explicit None
for fields stored as null in MongoDB, which bypassed pydantic
default_factory and raised ValidationError.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services.mongo import MongoDBService


def _make_service() -> MongoDBService:
    service = MongoDBService.__new__(MongoDBService)
    service.settings = MagicMock()
    service._db = MagicMock()
    return service


def _mock_find_one(service: MongoDBService, doc: dict):
    collection = MagicMock()
    collection.find_one.return_value = doc
    service._get_agents_collection = MagicMock(return_value=collection)


def _minimal_doc(**overrides) -> dict:
    base = {
        "_id": "test-agent",
        "id": "test-agent",
        "name": "Test Agent",
        "model": {"provider": "aws-bedrock", "id": "anthropic.claude-3-sonnet"},
        "system_prompt": "You are a test agent.",
        "owner_id": "system",
    }
    base.update(overrides)
    return base


def test_get_agent_with_null_interrupt_on_does_not_raise():
    """Existing MongoDB docs with interrupt_on: null must not raise ValidationError."""
    service = _make_service()
    _mock_find_one(service, _minimal_doc(interrupt_on=None))

    agent = service.get_agent("test-agent")

    assert agent is not None
    assert isinstance(agent, DynamicAgentConfig)


def test_get_agent_with_null_interrupt_on_applies_default():
    """interrupt_on: null should resolve to the field's default_factory value."""
    service = _make_service()
    _mock_find_one(service, _minimal_doc(interrupt_on=None))

    agent = service.get_agent("test-agent")

    assert agent.interrupt_on == {"builtin": {"request_user_input": True}}


def test_get_agent_with_explicit_interrupt_on_preserved():
    """Explicit interrupt_on values stored in MongoDB are not stripped."""
    custom = {"builtin": {"request_user_input": False}}
    service = _make_service()
    _mock_find_one(service, _minimal_doc(interrupt_on=custom))

    agent = service.get_agent("test-agent")

    assert agent.interrupt_on == custom


def test_get_agent_with_other_null_fields_applies_defaults():
    """Other nullable fields (e.g. features, ui) with null also get defaults applied."""
    service = _make_service()
    _mock_find_one(service, _minimal_doc(features=None, ui=None))

    agent = service.get_agent("test-agent")

    assert agent is not None
    assert isinstance(agent, DynamicAgentConfig)


def test_get_agent_returns_none_when_not_found():
    service = _make_service()
    _mock_find_one(service, None)

    assert service.get_agent("missing-agent") is None

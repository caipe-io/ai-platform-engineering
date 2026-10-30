"""Tests for app-requested structured dashboard responses."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.middleware import get_middleware_definitions
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder
from dynamic_agents.services.structured_response import (
    StructuredResponseError,
    StructuredResponseFormat,
    build_structured_response_instruction,
    create_submit_structured_response_tool,
    extract_response_format,
)


def _response_format() -> StructuredResponseFormat:
    return StructuredResponseFormat(
        schema_id="example_project.dashboard.v1",
        schema={
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}},
        },
    )


def test_structured_response_format_is_extracted_from_client_context() -> None:
    response_format = extract_response_format(
        {
            "response_format": {
                "type": "json_schema",
                "schema_id": "example_project.dashboard.v1",
                "schema": {"type": "object", "required": ["summary"]},
            }
        }
    )

    assert response_format is not None
    assert response_format.schema_id == "example_project.dashboard.v1"
    assert response_format.required == ["summary"]


def test_submit_structured_response_validates_and_captures_payload() -> None:
    captured: list[dict] = []
    submit = create_submit_structured_response_tool(_response_format(), captured.append)

    accepted = submit.invoke({"payload": {"summary": "Healthy"}})
    rejected = submit.invoke({"payload": {"summary": 42}})

    assert accepted["accepted"] is True
    assert accepted["schema_id"] == "example_project.dashboard.v1"
    assert captured == [{"summary": "Healthy"}]
    assert rejected["accepted"] is False
    assert "not of type" in rejected["error"]


def test_structured_response_is_registered_and_emitted_as_sse() -> None:
    definitions = {item["key"]: item for item in get_middleware_definitions()}
    assert definitions["structured_response"]["enabled_by_default"] is False
    assert definitions["structured_response"]["param_schema"]["allowed_schema_ids"] == "string"

    frame = CustomStreamEncoder().on_structured_output(
        {"summary": "Healthy"}, "example_project.dashboard.v1"
    )[0]
    payload = json.loads(next(line[6:] for line in frame.splitlines() if line.startswith("data: ")))
    assert payload == {
        "payload": {"summary": "Healthy"},
        "schema_id": "example_project.dashboard.v1",
    }


@pytest.mark.parametrize("value,accepted", [("Healthy", True), (None, True), (42, False)])
def test_nullable_union_accepts_only_conforming_values(value: object, accepted: bool) -> None:
    captured: list[dict] = []
    response_format = StructuredResponseFormat(None, {
        "type": "object", "required": ["summary"],
        "properties": {"summary": {"type": ["string", "null"]}},
    })
    submit = create_submit_structured_response_tool(response_format, captured.append)
    assert submit.invoke({"payload": {"summary": value}})["accepted"] is accepted
    assert captured == ([{"summary": value}] if accepted else [])


@pytest.mark.parametrize("payload", [
    {"summary": None, "meta": {"id": "example"}, "items": [1]},
    {"summary": "Healthy", "meta": {}, "items": [1]},
    {"summary": "Healthy", "meta": {"id": "example"}, "items": ["wrong"]},
    {"summary": "Healthy", "meta": {"id": "example"}, "items": [True]},
    {"summary": "Healthy", "meta": {"id": "example"}, "items": [1], "unexpected": True},
])
def test_nested_validation_rejects_then_accepts_corrected_submission(payload: dict) -> None:
    captured: list[dict] = []
    response_format = StructuredResponseFormat(None, {
        "type": "object", "required": ["summary", "meta", "items"], "additionalProperties": False,
        "properties": {
            "summary": {"type": "string"},
            "meta": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
            "items": {"type": "array", "items": {"type": "integer"}},
        },
    })
    submit = create_submit_structured_response_tool(response_format, captured.append)
    assert submit.invoke({"payload": payload})["accepted"] is False
    assert captured == []
    corrected = {"summary": "Healthy", "meta": {"id": "example"}, "items": [1]}
    assert submit.invoke({"payload": corrected})["accepted"] is True
    assert captured == [corrected]


@pytest.mark.parametrize("schema", [
    {"type": "object", "properties": {"summary": {"type": ["string", "invalid"]}}},
    {"type": "array"},
    {"$ref": "#/$defs/result", "$defs": {"result": {"type": "array"}}},
    {"type": "object", "$ref": "#/$defs/result", "$defs": {"result": {"type": "array"}}},
    {"type": "object", "$dynamicRef": "#result"},
    {"type": "object", "$recursiveRef": "#"},
    {"type": "object", "$schema": "https://schema.example.test/unsupported"},
    {"type": "object", "properties": {"summary": {"$ref": "https://schema.example.test/value"}}},
    {"type": "object", "$defs": {"value": {"$dynamicRef": "https://schema.example.test/value"}}},
])
def test_invalid_or_external_schemas_are_rejected_before_execution(schema: dict) -> None:
    with pytest.raises(StructuredResponseError):
        extract_response_format({"response_format": {"type": "json_schema", "schema": schema}})


@pytest.mark.parametrize("dialect", [5, True, None, [], {}])
def test_schema_dialect_must_be_a_string(dialect: object) -> None:
    with pytest.raises(StructuredResponseError, match=r"\$schema must be a string"):
        extract_response_format({"response_format": {
            "type": "json_schema", "schema": {"type": "object", "$schema": dialect},
        }})


def test_local_schema_references_are_validated_and_missing_references_rejected() -> None:
    response_format = StructuredResponseFormat(None, {
        "type": "object", "$defs": {"value": {"type": "integer", "minimum": 1}},
        "properties": {"value": {"$ref": "#/$defs/value"}},
    })
    submit = create_submit_structured_response_tool(response_format, Mock())
    assert submit.invoke({"payload": {"value": 1}})["accepted"] is True
    assert submit.invoke({"payload": {"value": 0}})["accepted"] is False
    broken = create_submit_structured_response_tool(
        StructuredResponseFormat(None, {"properties": {"value": {"$ref": "#/$defs/missing"}}}), Mock()
    )
    assert broken.invoke({"payload": {"value": 1}})["accepted"] is False


@pytest.mark.parametrize("enabled,context,expected", [
    (False, {"response_format": {"type": "json_schema", "schema": "invalid"}}, False),
    (True, None, False),
    (True, {"response_format": {"type": "json_schema", "schema": {"type": "object"}}}, True),
])
def test_opt_in_gate_preserves_default_requests(enabled: bool, context: dict | None, expected: bool) -> None:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(features=SimpleNamespace(middleware=[
        SimpleNamespace(type="structured_response", enabled=enabled, params={}),
    ]))
    assert (runtime._get_allowed_structured_response_format(context) is not None) is expected


def test_schema_allowlist_and_root_tool_injection_do_not_reparse_subagents() -> None:
    runtime = AgentRuntime.__new__(AgentRuntime)
    runtime.config = SimpleNamespace(id="example-agent", name="Example", builtin_tools=None, features=SimpleNamespace(middleware=[
        SimpleNamespace(type="structured_response", enabled=True, params={"allowed_schema_ids": "example.allowed"}),
    ]))
    context = {"response_format": {"type": "json_schema", "schema_id": "example.denied", "schema": {"type": "object"}}}
    assert runtime._get_allowed_structured_response_format(context) is None
    context["response_format"]["schema_id"] = "example.allowed"
    response_format = runtime._get_allowed_structured_response_format(context)
    assert response_format is not None
    runtime._get_allowed_structured_response_format = Mock(side_effect=AssertionError("must not reparse"))
    assert [tool.name for tool in runtime._build_builtin_tools(response_format=response_format)] == ["submit_structured_response"]
    # Even the same ID/config passed explicitly denotes a subagent, not the root.
    assert runtime._build_builtin_tools(agent_config=runtime.config, response_format=response_format) == []


def test_removed_toggle_and_schema_compatible_prompt() -> None:
    definition = next(item for item in get_middleware_definitions() if item["key"] == "structured_response")
    assert "require_tool_submission" not in definition["default_params"]
    assert "require_tool_submission" not in definition["param_schema"]
    instruction = build_structured_response_instruction(_response_format())
    assert "only when the schema permits" in instruction
    assert "correct it and resubmit" in instruction

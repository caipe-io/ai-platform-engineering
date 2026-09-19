"""Tests for app-requested structured dashboard responses."""

from __future__ import annotations

import json

from dynamic_agents.services.middleware import get_middleware_definitions
from dynamic_agents.services.stream_encoders.custom_sse import CustomStreamEncoder
from dynamic_agents.services.structured_response import (
    StructuredResponseFormat,
    create_submit_structured_response_tool,
    extract_response_format,
)


def _response_format() -> StructuredResponseFormat:
    return StructuredResponseFormat(
        schema_id="jira_project.dashboard.v1",
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
                "schema_id": "jira_project.dashboard.v1",
                "schema": {"type": "object", "required": ["summary"]},
            }
        }
    )

    assert response_format is not None
    assert response_format.schema_id == "jira_project.dashboard.v1"
    assert response_format.required == ["summary"]


def test_submit_structured_response_validates_and_captures_payload() -> None:
    captured: list[dict] = []
    submit = create_submit_structured_response_tool(_response_format(), captured.append)

    accepted = submit.invoke({"payload": {"summary": "Healthy"}})
    rejected = submit.invoke({"payload": {"summary": 42}})

    assert accepted["accepted"] is True
    assert accepted["schema_id"] == "jira_project.dashboard.v1"
    assert captured == [{"summary": "Healthy"}]
    assert rejected["accepted"] is False
    assert "must be a string" in rejected["error"]


def test_structured_response_is_registered_and_emitted_as_sse() -> None:
    definitions = {item["key"]: item for item in get_middleware_definitions()}
    assert definitions["structured_response"]["enabled_by_default"] is False
    assert definitions["structured_response"]["param_schema"]["allowed_schema_ids"] == "string"

    frame = CustomStreamEncoder().on_structured_output(
        {"summary": "Healthy"}, "jira_project.dashboard.v1"
    )[0]
    payload = json.loads(next(line[6:] for line in frame.splitlines() if line.startswith("data: ")))
    assert payload == {
        "payload": {"summary": "Healthy"},
        "schema_id": "jira_project.dashboard.v1",
    }

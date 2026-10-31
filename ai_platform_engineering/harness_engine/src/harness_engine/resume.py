"""Validate human responses against the exact persisted interrupt."""

from __future__ import annotations

from typing import Any

from harness_engine.repository import RunAdmissionError


def validate_resume_response(pending: dict[str, Any], response: dict[str, Any]) -> None:
    kind = pending.get("interrupt_type", pending.get("type", "form_input"))
    if response.get("type", "form_input") != kind:
        raise RunAdmissionError("Response type does not match the pending interrupt")
    if kind == "form_input":
        if response.get("dismissed") is True:
            return
        values = response.get("values")
        fields = pending.get("fields", [])
        if not isinstance(values, dict) or set(values) - {field["field_name"] for field in fields}:
            raise RunAdmissionError("Form response contains unknown fields")
        for field in fields:
            value = values.get(field["field_name"])
            if field.get("required") and value in (None, "", []):
                raise RunAdmissionError("A required form field is missing")
        return
    if kind != "tool_approval":
        raise RunAdmissionError("Unsupported interrupt type")
    tools = pending.get("tool_approvals") or [
        {
            "tool_name": pending.get("tool_name"),
            "allowed_decisions": pending.get("allowed_decisions"),
        }
    ]
    decisions = response.get("decisions")
    if decisions is None:
        if response.get("decision") == "edit" and len(tools) != 1:
            raise RunAdmissionError("Batched tools require individual edit decisions")
        decisions = [response] * len(tools)
    if not isinstance(decisions, list) or len(decisions) != len(tools):
        raise RunAdmissionError("Approval count does not match the pending tools")
    for tool, decision in zip(tools, decisions, strict=True):
        if not isinstance(decision, dict) or decision.get("decision") not in (
            tool.get("allowed_decisions") or ["approve", "reject", "edit"]
        ):
            raise RunAdmissionError("Approval decision is not allowed for this tool")
        if decision["decision"] == "edit":
            if (
                not isinstance(decision.get("edited_args"), dict)
                or decision.get("tool_name", tool["tool_name"]) != tool["tool_name"]
            ):
                raise RunAdmissionError("An edit must retain the approved tool identity and provide arguments")

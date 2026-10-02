"""Structured response support for app-driven agent invocations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from langchain_core.tools import tool

_JSON_TYPE_NAMES = {
    "object": dict,
    "array": list,
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
}


@dataclass(frozen=True)
class StructuredResponseFormat:
    """Normalized structured response request from client context."""

    schema_id: str | None
    schema: dict[str, Any]

    @property
    def required(self) -> list[str]:
        required = self.schema.get("required")
        return [str(field) for field in required] if isinstance(required, list) else []


def extract_response_format(client_context: dict[str, Any] | None) -> StructuredResponseFormat | None:
    """Return a normalized structured response format from client context."""
    if not client_context:
        return None

    raw = client_context.get("response_format")
    if not isinstance(raw, dict) or raw.get("type") != "json_schema":
        return None

    schema = raw.get("schema")
    if not isinstance(schema, dict) or schema.get("type") not in (None, "object"):
        return None

    schema_id = raw.get("schema_id")
    return StructuredResponseFormat(
        schema_id=str(schema_id) if schema_id else None,
        schema=schema,
    )


def _validate_payload(payload: Any, response_format: StructuredResponseFormat) -> str | None:
    if not isinstance(payload, dict):
        return "structured response payload must be a JSON object"

    for field in response_format.required:
        if field not in payload:
            return f"structured response payload is missing required field '{field}'"

    properties = response_format.schema.get("properties")
    if not isinstance(properties, dict):
        return None

    for field, rules in properties.items():
        if field not in payload or payload[field] is None or not isinstance(rules, dict):
            continue
        expected_type = rules.get("type")
        expected_python_type = _JSON_TYPE_NAMES.get(expected_type)
        if expected_python_type is None:
            continue
        value = payload[field]
        if expected_type == "number" and isinstance(value, bool):
            return f"structured response field '{field}' must be a number"
        if expected_type == "integer" and isinstance(value, bool):
            return f"structured response field '{field}' must be an integer"
        if not isinstance(value, expected_python_type):
            return f"structured response field '{field}' must be a {expected_type}"

    return None


def create_submit_structured_response_tool(
    response_format: StructuredResponseFormat,
    on_submit: Callable[[dict[str, Any]], None],
):
    """Create a final-answer tool that captures validated structured output."""

    @tool
    def submit_structured_response(payload: dict[str, Any], thought: str = "") -> dict[str, Any]:
        """Submit the final structured response for the calling app UI.

        The payload must be a JSON object matching the requested response schema.
        """
        error = _validate_payload(payload, response_format)
        if error:
            return {
                "accepted": False,
                "schema_id": response_format.schema_id,
                "error": error,
            }

        on_submit(payload)
        return {
            "accepted": True,
            "schema_id": response_format.schema_id,
        }

    return submit_structured_response


def build_structured_response_instruction(response_format: StructuredResponseFormat) -> str:
    """Build concise system instructions for the structured-response tool."""
    schema_id = response_format.schema_id or "client-provided-schema"
    return (
        "\n\nStructured response requirement:\n"
        f"- The client requested schema `{schema_id}`.\n"
        "- Before your final prose response, call `submit_structured_response` exactly once.\n"
        "- The `payload` argument must be a JSON object that satisfies this schema:\n"
        f"{response_format.schema}\n"
        "- Do not invent values. Use null or an empty list only when data is unavailable."
    )

"""Validated structured responses carried by each invocation's event stream."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Callable

from jsonschema import Draft202012Validator, SchemaError
from jsonschema.protocols import Validator
from jsonschema.validators import validator_for
from langchain_core.tools import BaseTool, tool
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

STRUCTURED_OUTPUT_EVENT = "structured_output"


class StructuredResponseError(ValueError):
    """The caller requested an invalid or unsupported structured response schema."""


@dataclass(frozen=True)
class StructuredResponseFormat:
    """Validated object schema, compiled once for a runtime configuration."""

    schema_id: str | None
    schema: dict[str, Any]
    _validator: Validator = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        schema = deepcopy(self.schema)
        if not isinstance(schema, dict) or schema.get("type") not in (None, "object"):
            raise StructuredResponseError("Structured response schema must describe a JSON object.")
        if any(keyword in schema for keyword in ("$ref", "$dynamicRef", "$recursiveRef")):
            raise StructuredResponseError("Structured response schemas cannot use a reference at the root.")
        if "$schema" in schema and not isinstance(schema["$schema"], str):
            raise StructuredResponseError("Structured response schema $schema must be a string.")
        validator_class = validator_for(schema, default=None) if "$schema" in schema else Draft202012Validator
        if validator_class is None:
            raise StructuredResponseError("Unsupported structured response JSON Schema dialect.")
        try:
            validator_class.check_schema(schema)
        except SchemaError as exc:
            raise StructuredResponseError(f"Invalid structured response schema: {exc.message}") from exc

        resources = [Resource.from_contents(schema, default_specification=DRAFT202012)]
        while resources:
            resource = resources.pop()
            if isinstance(resource.contents, dict):
                for keyword in ("$ref", "$dynamicRef", "$recursiveRef"):
                    reference = resource.contents.get(keyword)
                    if isinstance(reference, str) and not reference.startswith("#"):
                        raise StructuredResponseError("Structured response schemas support only local references.")
            resources.extend(resource.subresources())
        object.__setattr__(self, "schema", schema)
        # An explicit empty registry prevents reference resolution from fetching URLs.
        object.__setattr__(self, "_validator", validator_class(schema, registry=Registry()))

    @property
    def required(self) -> list[str]:
        return self.schema.get("required", [])


def extract_response_format(client_context: dict[str, Any] | None) -> StructuredResponseFormat | None:
    """Read an optional JSON Schema request; reject malformed active requests."""
    if not client_context:
        return None
    raw = client_context.get("response_format")
    if not isinstance(raw, dict) or raw.get("type") != "json_schema":
        return None
    schema = raw.get("schema")
    if not isinstance(schema, dict):
        raise StructuredResponseError("Structured response schema must be a JSON object.")
    schema_id = raw.get("schema_id")
    return StructuredResponseFormat(schema_id=str(schema_id) if schema_id else None, schema=schema)


def _validate_payload(payload: Any, response_format: StructuredResponseFormat) -> str | None:
    if not isinstance(payload, dict):
        return "structured response payload must be a JSON object"
    try:
        error = next(response_format._validator.iter_errors(payload), None)
    except Unresolvable:
        return "structured response schema contains an unresolved local reference"
    if error is not None:
        path = ".".join(str(part) for part in error.absolute_path) or "payload"
        return f"structured response {path}: {error.message}"
    return None


def create_submit_structured_response_tool(
    response_format: StructuredResponseFormat,
    on_submit: Callable[[dict[str, Any]], None],
) -> BaseTool:
    """Create a tool that publishes only responses satisfying the whole schema."""

    @tool
    def submit_structured_response(payload: dict[str, Any], thought: str = "") -> dict[str, Any]:
        """Submit the final structured response for the calling app UI.

        The payload must be a JSON object matching the requested response schema.
        """
        error = _validate_payload(payload, response_format)
        if error:
            return {"accepted": False, "schema_id": response_format.schema_id, "error": error}
        on_submit(deepcopy(payload))
        return {"accepted": True, "schema_id": response_format.schema_id}

    return submit_structured_response


def build_structured_response_instruction(response_format: StructuredResponseFormat) -> str:
    """Ask for a submission without authorizing schema-incompatible placeholders."""
    schema_id = response_format.schema_id or "client-provided-schema"
    return (
        "\n\nStructured response requirement:\n"
        f"- The client requested schema `{schema_id}`.\n"
        "- Before your final prose response, call `submit_structured_response`.\n"
        "- If a submission is rejected, correct it and resubmit before continuing.\n"
        "- The `payload` argument must be a JSON object that satisfies this schema:\n"
        f"{response_format.schema}\n"
        "- Do not invent values. Use null or an empty list only when the schema permits it.\n"
        "- If required data is unavailable, explain the limitation instead of submitting invalid data."
    )

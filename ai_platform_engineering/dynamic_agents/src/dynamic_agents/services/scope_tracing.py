"""Scope callbacks capture model/tool metadata, never prompts or tool payloads."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from agent_telemetry import current_scope_run
from langchain_core.callbacks import BaseCallbackHandler


class ScopeCallbackHandler(BaseCallbackHandler):
    # Keep callbacks in the execution context that owns the Scope session.
    run_inline = True

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None:
            params = kwargs.get("invocation_params") or {}
            model = str(params.get("model") or params.get("model_name") or params.get("model_id") or "unknown")
            run.start(str(run_id), model, "chat", {"gen_ai.request.model": model})

    def on_llm_start(self, serialized: dict[str, Any], prompts: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self.on_chat_model_start(serialized, None, run_id=run_id, **kwargs)

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None:
            attrs: dict[str, int] = {}
            output = response.llm_output or {}
            usage = output.get("token_usage") or output.get("usage") or {}
            generations = response.generations
            if generations and generations[0]:
                usage = getattr(getattr(generations[0][0], "message", None), "usage_metadata", None) or usage
            for target, keys in {
                "input_tokens": ("input_tokens", "prompt_tokens"),
                "output_tokens": ("output_tokens", "completion_tokens"),
                "total_tokens": ("total_tokens",),
            }.items():
                value = next((usage[key] for key in keys if key in usage), None)
                if isinstance(value, int):
                    attrs[f"gen_ai.usage.{target}"] = value
            run.end(str(run_id), attributes=attrs)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None:
            run.end(str(run_id), error=True)

    def on_tool_start(self, serialized: dict[str, Any], input_str: str, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None and not run.canonical_tools:
            run.start(str(run_id), str(serialized.get("name") or "tool"), "tool")

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None and not run.canonical_tools:
            run.end(str(run_id), error=getattr(output, "status", None) == "error")

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None and not run.canonical_tools:
            run.end(str(run_id), error=True)

"""Scope metadata callbacks with optional, restricted protocol skill evidence."""

from __future__ import annotations

import json
import os
import re
from typing import Any
from uuid import UUID

from agent_telemetry import current_scope_run
from langchain_core.callbacks import BaseCallbackHandler


class ScopeCallbackHandler(BaseCallbackHandler):
    # Keep callbacks in the execution context that owns the Scope session.
    run_inline = True

    def __init__(self) -> None:
        self._parents: dict[str, str | None] = {}
        self._delegates: set[str] = set()
        self._protocol_paths: dict[str, str] = {}

    def _protocol_catalog(self, messages: Any) -> dict[str, str]:
        """Export only protocol names and their advertised skill paths, never descriptions."""
        if os.getenv("SCOPE_PROTOCOL_EVIDENCE_ENABLED", "false").lower() != "true":
            return {}
        names: list[str] = []
        for batch in messages if isinstance(messages, list) else []:
            for message in batch if isinstance(batch, list) else []:
                if getattr(message, "type", None) != "system":
                    continue
                content = getattr(message, "content", "")
                if not isinstance(content, str):
                    continue
                lines = content.splitlines()
                for index, line in enumerate(lines):
                    match = re.fullmatch(r"\s*[-*]\s*\*\*((?:l9-)?(?:accord|concord)-(?:initiator|receiver))\*\*:.*", line)
                    if not match:
                        continue
                    name = match.group(1)
                    names.append(f"- **{name}**:")
                    for following in lines[index + 1:index + 4]:
                        path_match = re.fullmatch(r"\s*-> Read `(/skills/[A-Za-z0-9_./-]{1,512}/SKILL\.md)` for full instructions", following)
                        if path_match and ".." not in path_match.group(1).split("/"):
                            path = path_match.group(1)
                            self._protocol_paths[path] = name
                            names.append(f"  -> Read `{path}` for full instructions")
        return {"gen_ai.prompt.0.role": "system", "gen_ai.prompt.0.content": "\n".join(dict.fromkeys(names))} if names else {}

    def _protocol_arguments(self, name: str, inputs: Any) -> dict[str, str]:
        if os.getenv("SCOPE_PROTOCOL_EVIDENCE_ENABLED", "false").lower() != "true" or not isinstance(inputs, dict):
            return {}
        selected: dict[str, str] = {}
        if name == "read_file" and isinstance(inputs.get("file_path"), str) and inputs["file_path"] in self._protocol_paths:
            selected = {"file_path": inputs["file_path"]}
        elif name in {"activate_skill", "run_skill_script"}:
            field = "name" if name == "activate_skill" else "skill"
            candidate = inputs.get(field)
            if isinstance(candidate, str) and re.fullmatch(r"(?:l9-)?(?:accord|concord)-(?:initiator|receiver)", candidate):
                selected = {field: candidate}
        return {"ioa_observe.entity.input": json.dumps(selected)} if selected else {}

    def _parent_delegate(self, run_id: UUID, parent_run_id: UUID | None) -> str | None:
        key = str(run_id)
        parent = str(parent_run_id) if parent_run_id else None
        self._parents[key] = parent
        seen: set[str] = set()
        while parent is not None and parent not in seen:
            if parent in self._delegates:
                return parent
            seen.add(parent)
            parent = self._parents.get(parent)
        return None

    def on_chain_start(self, serialized: Any, inputs: Any, *, run_id: UUID,
                       parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        # Remember identifiers only; chain inputs can contain private content.
        self._parent_delegate(run_id, parent_run_id)

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None:
            parent = self._parent_delegate(run_id, kwargs.get("parent_run_id"))
            params = kwargs.get("invocation_params") or {}
            model = str(params.get("model") or params.get("model_name") or params.get("model_id") or "unknown")
            run.start(str(run_id), model, "chat", {"gen_ai.request.model": model, **self._protocol_catalog(messages)}, parent_key=parent)

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
            parent = self._parent_delegate(run_id, kwargs.get("parent_run_id"))
            name = str(serialized.get("name") or "tool")
            delegate = None
            if name == "task":
                try:
                    # LangChain passes dict tool arguments separately; input_str
                    # is their Python representation, not necessarily JSON.
                    inputs = kwargs.get("inputs")
                    if not isinstance(inputs, dict):
                        inputs = json.loads(input_str)
                    candidate = inputs.get("subagent_type") if isinstance(inputs, dict) else None
                    if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", candidate):
                        delegate = candidate
                except (TypeError, ValueError):
                    pass
            if delegate:
                self._delegates.add(str(run_id))
            run.start(str(run_id), delegate or name, "agent" if delegate else "tool",
                      self._protocol_arguments(name, kwargs.get("inputs")), parent_key=parent)

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None and not run.canonical_tools:
            run.end(str(run_id), error=getattr(output, "status", None) == "error")

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        if (run := current_scope_run()) is not None and not run.canonical_tools:
            run.end(str(run_id), error=True)

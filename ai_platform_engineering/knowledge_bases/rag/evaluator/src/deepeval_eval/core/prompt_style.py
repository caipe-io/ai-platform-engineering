from __future__ import annotations

import json
import os
import string
from collections.abc import Callable
from pathlib import Path
from typing import Any


class SafeFormatter(string.Formatter):
    """Formatter that prevents Python object attribute access and unsafe macro evaluation."""

    def get_field(self, field_name: str, args: Any, kwargs: Any) -> tuple[Any, str]:
        first_key = field_name.split(".")[0].split("[")[0]
        if first_key in kwargs:
            return kwargs[first_key], first_key
        raise KeyError(field_name)


_SAFE_FORMATTER = SafeFormatter()


def safe_format_template(template: str, **kwargs: Any) -> str:
    """Safely format a template string using key-value args, ignoring attribute access attempts."""
    clean_kwargs = {k: str(v) for k, v in kwargs.items()}
    try:
        return _SAFE_FORMATTER.vformat(template, (), clean_kwargs)
    except KeyError as exc:
        missing_key = str(exc).strip("'\"")
        clean_kwargs[missing_key] = f"{{{missing_key}}}"
        try:
            return _SAFE_FORMATTER.vformat(template, (), clean_kwargs)
        except Exception:
            return template


# String type alias for backward-compatible type annotations
PromptStyle = str

DEFAULT_PROMPT_STYLE: str = "generation"

# Built-in system prompt template strings
BUILTIN_PROMPT_TEMPLATES: dict[str, str] = {
    "generation": (
        "Answer the question using only the context below. "
        "If the context is not enough, say that the answer is not in the provided context.\n\n"
        "Question:\n{question}\n\n"
        "Context:\n{context}\n\n"
        "Answer:"
    ),
    "short": (
        "Answer the question using only the context below. Keep the answer short. "
        "If the context is not enough, say that the answer is not in the provided context.\n\n"
        "Question:\n{question}\n\n"
        "Context:\n{context}\n\n"
        "Answer:"
    ),
    "agentic_generation": (
        "Answer the following question using available search tools. "
        "Base your answer only on the information retrieved from search. "
        "If the retrieved results are insufficient, state that the answer is not found.\n\n"
        "Question:\n{question}"
    ),
    "agentic_short": (
        "Answer the user query concisely using available search tools. "
        "Base your answer strictly on the search results. "
        "If the retrieved information is insufficient, state that the answer is not found.\n\n"
        "Question:\n{question}"
    ),
}

# Registry mapping style keys to prompt templates or callable builders
_PROMPT_REGISTRY: dict[str, str | Callable[..., str]] = dict(BUILTIN_PROMPT_TEMPLATES)


def register_prompt_style(
    style_name: str,
    template_or_builder: str | Callable[..., str],
) -> None:
    """Register a new prompt style or overwrite an existing prompt style."""
    key = str(style_name).strip().lower()
    _PROMPT_REGISTRY[key] = template_or_builder


def load_prompt_styles_from_config(config_path: str | Path) -> dict[str, str]:
    """Load prompt style templates from a JSON or YAML configuration file."""
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Prompt style config file not found: {path}")

    content = path.read_text(encoding="utf-8")
    data: dict[str, Any] = {}

    if path.suffix in (".yaml", ".yml"):
        try:
            import yaml

            data = yaml.safe_load(content) or {}
        except ImportError:
            raise RuntimeError("PyYAML is required to load YAML config files")
    else:
        data = json.loads(content)

    styles = data.get("prompt_styles", data)
    loaded: dict[str, str] = {}
    if isinstance(styles, dict):
        for name, template in styles.items():
            if isinstance(template, str):
                register_prompt_style(name, template)
                loaded[name] = template

    return loaded


def build_agentic_prompt(
    style: str | None,
    question: str,
    prompt_args: dict[str, Any] | None = None,
    db_manager: Any | None = None,
) -> str:
    """Build a pre-retrieval agent query/instruction string for Agentic RAG mode."""
    if not style:
        return question

    style_key = str(style).strip().lower()

    builder_or_template = _PROMPT_REGISTRY.get(style_key)

    if builder_or_template is None and db_manager is not None:
        try:
            record = db_manager.prompt_styles.get_prompt_style(style_key)
            if record:
                builder_or_template = record.get("template")
        except Exception:
            pass

    if builder_or_template is None:
        return question

    merged_args = {"question": question, "tool_name": "search tools"}
    if prompt_args:
        merged_args.update(prompt_args)
    merged_args["question"] = question

    if callable(builder_or_template):
        try:
            return (
                builder_or_template(question, **prompt_args)
                if prompt_args
                else builder_or_template(question)
            )
        except TypeError:
            return builder_or_template(question)

    return safe_format_template(builder_or_template, **merged_args)


def build_prompt(
    style: str | None,
    question: str,
    contexts: list[str],
    config_path: str | Path | None = None,
    prompt_args: dict[str, Any] | None = None,
    db_manager: Any | None = None,
) -> str:
    """Build a prompt string given a prompt style string, question, context list, and optional extra args."""
    if config_path:
        load_prompt_styles_from_config(config_path)
    elif os.environ.get("PROMPT_STYLES_CONFIG"):
        config_env = os.environ["PROMPT_STYLES_CONFIG"]
        if Path(config_env).exists():
            load_prompt_styles_from_config(config_env)

    if style is None:
        style_key = DEFAULT_PROMPT_STYLE
    else:
        style_key = str(style).strip().lower()

    builder_or_template = _PROMPT_REGISTRY.get(style_key)

    if builder_or_template is None and db_manager is not None:
        try:
            record = db_manager.prompt_styles.get_prompt_style(style_key)
            if record:
                builder_or_template = record.get("template")
        except Exception:
            pass

    if builder_or_template is None:
        valid_styles = list(_PROMPT_REGISTRY.keys())
        raise ValueError(
            f"Unknown prompt style: '{style}'. Available styles: {valid_styles}"
        )

    context_block = "\n\n".join(
        f"[{idx + 1}] {text}" for idx, text in enumerate(contexts)
    )

    if callable(builder_or_template):
        try:
            return (
                builder_or_template(question, contexts, **prompt_args)
                if prompt_args
                else builder_or_template(question, contexts)
            )
        except TypeError:
            return builder_or_template(question, contexts)

    merged_args = {
        "question": question,
        "context": context_block,
        "contexts": context_block,
        "tool_name": "search tools",
    }
    if prompt_args:
        merged_args.update(prompt_args)
    merged_args["question"] = question
    merged_args["context"] = context_block
    merged_args["contexts"] = context_block

    return safe_format_template(builder_or_template, **merged_args)


def make_generation_prompt(question: str, contexts: list[str]) -> str:
    """Backward compatibility wrapper for standard generation prompt."""
    return build_prompt("generation", question, contexts)


def make_short_answer_prompt(question: str, contexts: list[str]) -> str:
    """Backward compatibility wrapper for short answer prompt."""
    return build_prompt("short", question, contexts)

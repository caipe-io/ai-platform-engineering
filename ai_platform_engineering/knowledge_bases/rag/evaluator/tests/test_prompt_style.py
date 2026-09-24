from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.core.prompt_style import (
    DEFAULT_PROMPT_STYLE,
    build_agentic_prompt,
    build_prompt,
    load_prompt_styles_from_config,
    register_prompt_style,
    safe_format_template,
)


def test_default_prompt_style_constant() -> None:
    assert DEFAULT_PROMPT_STYLE == "generation"


def test_build_prompt_default_and_builtin_returns_formatted_string() -> None:
    """Verify build_prompt returns correctly formatted string for builtin prompt styles."""
    question = "What is capital of France?"
    contexts = ["Paris is the capital of France."]

    prompt_default = build_prompt(None, question, contexts)
    assert "Answer the question using only the context below" in prompt_default
    assert question in prompt_default

    prompt_gen = build_prompt("generation", question, contexts)
    assert prompt_gen == prompt_default

    prompt_short = build_prompt("short", question, contexts)
    assert "Keep the answer short" in prompt_short
    assert "HotpotQA" not in prompt_short


def test_build_agentic_prompt_returns_formatted_or_raw_string() -> None:
    """Verify build_agentic_prompt formats question or returns raw question when unstyled."""
    question = "What are the rate limits?"

    # None / empty style -> return question as-is without prompt wrapper
    assert build_agentic_prompt(None, question) == question
    assert build_agentic_prompt("", question) == question

    # Builtin agentic generation
    res_gen = build_agentic_prompt("agentic_generation", question)
    assert "Base your answer only on the information retrieved from search" in res_gen
    assert question in res_gen

    # Builtin agentic short
    res_short = build_agentic_prompt("agentic_short", question)
    assert "Answer the user query concisely using available search tools" in res_short
    assert question in res_short


def test_safe_format_template_security_and_injection_prevention() -> None:
    """Verify safe_format_template prevents Python attribute access / macro injection attacks."""
    # Attribute access attempt like {question.__globals__} or {question.__class__}
    template_macro = "System: {question.__class__} - {question}"
    result = safe_format_template(template_macro, question="Test Question")
    # Should safely substitute or ignore attribute navigation, avoiding internal object leaks
    assert "class 'str'" not in result

    # Missing keys in template
    template_missing = "Hello {name}, your role is {role}."
    res_missing = safe_format_template(template_missing, name="Alice")
    assert "Alice" in res_missing
    assert "{role}" in res_missing


def test_register_prompt_style_custom_template_registers_successfully() -> None:
    """Verify register_prompt_style adds custom template to style registry."""
    register_prompt_style("custom_style", "Summary of {question}:\n{context}")
    result = build_prompt(
        "custom_style", "Explain quantum computing", ["Qubits superpose."]
    )
    assert "Summary of Explain quantum computing:" in result
    assert "[1] Qubits superpose." in result


def test_load_prompt_styles_from_json_file_loads_templates(tmp_path: Path) -> None:
    """Verify load_prompt_styles_from_config parses custom styles from JSON file."""
    config_file = tmp_path / "prompts.json"
    config_data = {
        "prompt_styles": {
            "json_style": "JSON context: {context} -> question: {question}"
        }
    }
    config_file.write_text(json.dumps(config_data), encoding="utf-8")

    loaded = load_prompt_styles_from_config(config_file)
    assert "json_style" in loaded

    prompt = build_prompt("json_style", "Why sky blue?", ["Rayleigh scattering."])
    assert "JSON context: [1] Rayleigh scattering. -> question: Why sky blue?" in prompt


def test_load_prompt_styles_from_yaml_file_loads_templates(tmp_path: Path) -> None:
    """Verify load_prompt_styles_from_config parses custom styles from YAML file."""
    config_file = tmp_path / "prompts.yaml"
    config_data = """
prompt_styles:
  yaml_style: "YAML context: {context} Question: {question}"
"""
    config_file.write_text(config_data, encoding="utf-8")

    loaded = load_prompt_styles_from_config(config_file)
    assert "yaml_style" in loaded

    prompt = build_prompt("yaml_style", "Test Q", ["Test C"])
    assert "YAML context: [1] Test C Question: Test Q" in prompt


def test_build_prompt_unknown_style_raises_value_error() -> None:
    """Verify build_prompt raises ValueError when given unregistered style name."""
    with pytest.raises(ValueError, match="Unknown prompt style"):
        build_prompt("non_existent", "Question?", ["Context"])


def test_load_prompt_styles_missing_file_raises_file_not_found_error() -> None:
    """Verify load_prompt_styles_from_config raises FileNotFoundError for missing path."""
    with pytest.raises(FileNotFoundError):
        load_prompt_styles_from_config("non_existent_file.json")


def test_safe_format_template_secondary_exception_returns_raw_template() -> None:
    """Verify safe_format_template returns raw template when secondary format throws unexpected error."""

    with patch(
        "deepeval_eval.core.prompt_style._SAFE_FORMATTER.vformat",
        side_effect=[KeyError("missing"), ValueError("malformed")],
    ):
        result = safe_format_template(
            "Template with {missing} and malformed syntax", key="val"
        )
        assert result == "Template with {missing} and malformed syntax"


def test_load_prompt_styles_yaml_missing_module_raises_runtime_error(
    tmp_path: Path, monkeypatch
) -> None:
    """Verify load_prompt_styles_from_config raises RuntimeError if yaml module is missing."""
    import builtins

    config_file = tmp_path / "test.yaml"
    config_file.write_text("prompt_styles:\n  style1: 'test'", encoding="utf-8")

    real_import = builtins.__import__

    def mock_import(name, *args, **kwargs):
        if name == "yaml":
            raise ImportError("No module named yaml")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", mock_import)
    with pytest.raises(
        RuntimeError, match="PyYAML is required to load YAML config files"
    ):
        load_prompt_styles_from_config(config_file)


def test_load_prompt_styles_non_dict_or_non_string_values_handled_gracefully(
    tmp_path: Path,
) -> None:
    """Verify load_prompt_styles_from_config ignores non-string templates and non-dict root structures."""
    config_file = tmp_path / "invalid_entries.json"
    config_file.write_text(
        json.dumps({"prompt_styles": {"valid": "Q: {question}", "invalid_int": 12345}}),
        encoding="utf-8",
    )

    loaded = load_prompt_styles_from_config(config_file)
    assert "valid" in loaded
    assert "invalid_int" not in loaded

    # Prompt styles is None or not a dict
    config_none = tmp_path / "none_styles.json"
    config_none.write_text(json.dumps({"prompt_styles": None}), encoding="utf-8")
    loaded_none = load_prompt_styles_from_config(config_none)
    assert loaded_none == {}


def test_build_agentic_prompt_db_manager_lookup_success() -> None:
    """Verify build_agentic_prompt loads style template from db_manager when not in memory registry."""
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "template": "DB Agentic: {question} with {tool_name}"
    }

    prompt = build_agentic_prompt(
        "db_dynamic_agentic_style", "How does caching work?", db_manager=mock_db
    )
    assert prompt == "DB Agentic: How does caching work? with search tools"
    mock_db.prompt_styles.get_prompt_style.assert_called_with(
        "db_dynamic_agentic_style"
    )


def test_build_agentic_prompt_db_manager_exception_fallback() -> None:
    """Verify build_agentic_prompt gracefully falls back to raw question if db_manager raises exception."""
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.side_effect = RuntimeError(
        "DB connection lost"
    )

    prompt = build_agentic_prompt(
        "db_agentic_error_style", "How does rollback work?", db_manager=mock_db
    )
    assert prompt == "How does rollback work?"


def test_build_agentic_prompt_callable_builder_with_args_and_type_error_fallback() -> (
    None
):
    """Verify build_agentic_prompt handles callable builders and catches TypeError when extra args are rejected."""

    # Callable supporting kwargs
    def builder_with_kwargs(q: str, **kwargs) -> str:
        return f"Agentic Q: {q}, Custom Arg: {kwargs.get('custom_arg')}"

    register_prompt_style("agentic_callable_kwargs", builder_with_kwargs)
    res = build_agentic_prompt(
        "agentic_callable_kwargs",
        "Sample query",
        prompt_args={"custom_arg": "custom_val"},
    )
    assert res == "Agentic Q: Sample query, Custom Arg: custom_val"

    # Callable without kwargs (takes single argument)
    def builder_single_arg(q: str) -> str:
        return f"Single: {q}"

    register_prompt_style("agentic_callable_single", builder_single_arg)
    # Passing prompt_args triggers TypeError which falls back to builder_single_arg(question)
    res_fallback = build_agentic_prompt(
        "agentic_callable_single", "Sample query", prompt_args={"extra": "ignored"}
    )
    assert res_fallback == "Single: Sample query"

    # Calling without prompt_args
    res_no_args = build_agentic_prompt("agentic_callable_single", "Sample query")
    assert res_no_args == "Single: Sample query"


def test_build_prompt_with_config_path_and_env_var(tmp_path: Path, monkeypatch) -> None:
    """Verify build_prompt loads config from config_path or PROMPT_STYLES_CONFIG environment variable."""
    cfg_file = tmp_path / "env_prompts.json"
    cfg_file.write_text(
        json.dumps(
            {
                "prompt_styles": {
                    "env_style": "Env template: {question}\nContext:\n{context}"
                }
            }
        ),
        encoding="utf-8",
    )

    # via config_path parameter
    res1 = build_prompt(
        "env_style",
        "What is RAG?",
        ["RAG is retrieval augmented generation."],
        config_path=cfg_file,
    )
    assert "Env template: What is RAG?" in res1

    # via PROMPT_STYLES_CONFIG environment variable
    monkeypatch.setenv("PROMPT_STYLES_CONFIG", str(cfg_file))
    res2 = build_prompt(
        "env_style", "What is RAG?", ["RAG is retrieval augmented generation."]
    )
    assert "Env template: What is RAG?" in res2


def test_build_prompt_db_manager_lookup_success_and_exception() -> None:
    """Verify build_prompt resolves template from db_manager and handles db exceptions."""
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = {
        "template": "DB Standard: {question}\n{context}"
    }

    res = build_prompt(
        "db_custom_prompt_style", "Query?", ["Context snippet"], db_manager=mock_db
    )
    assert "DB Standard: Query?" in res
    assert "[1] Context snippet" in res

    # DB exception fallback to ValueError (unknown prompt style)
    mock_db_err = MagicMock()
    mock_db_err.prompt_styles.get_prompt_style.side_effect = Exception("DB error")
    with pytest.raises(ValueError, match="Unknown prompt style: 'db_unknown_style'"):
        build_prompt(
            "db_unknown_style", "Query?", ["Context snippet"], db_manager=mock_db_err
        )


def test_build_prompt_callable_builder_with_args_and_type_error_fallback() -> None:
    """Verify build_prompt executes callable builders and handles TypeError fallback."""

    def multi_arg_builder(q: str, ctxs: list[str], **kwargs) -> str:
        return f"Prompt Q={q}, CtxCount={len(ctxs)}, Extra={kwargs.get('extra')}"

    register_prompt_style("prompt_callable_kwargs", multi_arg_builder)
    res = build_prompt(
        "prompt_callable_kwargs", "Q1", ["C1", "C2"], prompt_args={"extra": "foo"}
    )
    assert res == "Prompt Q=Q1, CtxCount=2, Extra=foo"

    def two_arg_builder(q: str, ctxs: list[str]) -> str:
        return f"Simple Q={q}, Ctxs={ctxs}"

    register_prompt_style("prompt_callable_two_args", two_arg_builder)
    res_type_error_fallback = build_prompt(
        "prompt_callable_two_args", "Q2", ["C1"], prompt_args={"unexpected": "bar"}
    )
    assert res_type_error_fallback == "Simple Q=Q2, Ctxs=['C1']"

    res_no_prompt_args = build_prompt("prompt_callable_two_args", "Q3", ["C1"])
    assert res_no_prompt_args == "Simple Q=Q3, Ctxs=['C1']"


def test_build_prompt_with_custom_prompt_args_merge() -> None:
    """Verify build_prompt merges custom prompt_args into template parameters."""
    register_prompt_style(
        "custom_args_style", "Q: {question} Context: {context} Extra: {custom_tag}"
    )
    res = build_prompt(
        "custom_args_style",
        "What is AI?",
        ["AI is artificial intelligence."],
        prompt_args={"custom_tag": "tag123"},
    )
    assert "Extra: tag123" in res


def test_make_generation_prompt_and_short_answer_prompt_wrappers() -> None:
    """Verify make_generation_prompt and make_short_answer_prompt backward-compatibility helpers."""
    from deepeval_eval.core.prompt_style import (
        make_generation_prompt,
        make_short_answer_prompt,
    )

    q = "What is Python?"
    ctx = ["Python is a programming language."]

    gen_res = make_generation_prompt(q, ctx)
    assert "Answer the question using only the context below." in gen_res
    assert q in gen_res

    short_res = make_short_answer_prompt(q, ctx)
    assert "Keep the answer short." in short_res
    assert q in short_res


def test_build_agentic_prompt_db_manager_returns_none_record() -> None:
    """Verify build_agentic_prompt returns question when db_manager returns None for style."""
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    res = build_agentic_prompt(
        "non_existent_db_style", "Raw question?", db_manager=mock_db
    )
    assert res == "Raw question?"


def test_build_prompt_env_var_nonexistent_file_path(monkeypatch) -> None:
    """Verify build_prompt ignores PROMPT_STYLES_CONFIG when file path does not exist."""
    monkeypatch.setenv("PROMPT_STYLES_CONFIG", "/non/existent/path/to/prompts.yaml")
    res = build_prompt("generation", "What is AI?", ["AI context"])
    assert "What is AI?" in res


def test_build_prompt_db_manager_returns_none_record() -> None:
    """Verify build_prompt raises ValueError when db_manager returns None record for style."""
    mock_db = MagicMock()
    mock_db.prompt_styles.get_prompt_style.return_value = None
    with pytest.raises(ValueError, match="Unknown prompt style"):
        build_prompt("unregistered_db_style", "Query?", ["Context"], db_manager=mock_db)

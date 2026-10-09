from __future__ import annotations

import argparse
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from deepeval_eval.clients.rag import RagQueryResult
from deepeval_eval.engine.deepeval_evaluator import (
    _build_config_args,
    _build_rag_client,
    _run_eval,
)
from deepeval_eval.engine.deepeval_evaluator import (
    build_parser as build_evaluator_parser,
)


def test_build_config_args_positive(tmp_path: Path) -> None:
    args = argparse.Namespace(
        env_file=tmp_path / ".env",
        llm_api_key="secret",
        top_k=3,
        agentic=True,
        _private="hidden",
    )
    res = _build_config_args(args)
    assert "llm_api_key" not in res
    assert "_private" not in res
    assert res["top_k"] == 3
    assert res["agentic"] is True


def test_build_config_args_negative() -> None:
    args = argparse.Namespace(llm_api_key=None, auth_token=None)
    res = _build_config_args(args)
    assert res == {}


def test_build_rag_client_positive(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CAIPE_BASE_URL", "http://localhost:8080")

    # Oracle RAG client
    args_oracle = argparse.Namespace(oracle_retrieval=True, agentic=False)
    client1 = _build_rag_client(args_oracle)
    assert client1.__class__.__name__ == "OracleRagClient"

    # Agentic RAG client
    args_agentic = argparse.Namespace(
        precompute=False,
        agentic=True,
        agent_url="http://localhost:8000",
        results_dir=tmp_path,
        fail_on_error=False,
    )
    with patch("deepeval_eval.engine.agentic_rag.AgenticRetriever"):
        client2 = _build_rag_client(args_agentic)
        assert client2.__class__.__name__ == "AgenticRagAdapter"

    # Standard CAIPE RAG client
    args_std = argparse.Namespace(precompute=False, agentic=False)
    client3 = _build_rag_client(args_std)
    assert client3.__class__.__name__ == "SearchRagClient"


def test_build_parsers_positive() -> None:
    p1 = build_evaluator_parser()
    assert p1 is not None


def test_run_eval_positive(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_ENDPOINT", "http://localhost")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("OPENAI_MODEL_NAME", "m")

    questions_file = tmp_path / "questions.jsonl"
    questions_file.write_text(
        '{"question_id": "q1", "user_input": "What is X?", "reference": "X is Y", "expected_doc_ids": ["doc1"]}\n'
    )

    args = argparse.Namespace(
        results_dir=tmp_path / "results",
        llm_base_url="http://localhost",
        llm_api_key="k",
        llm_model="m",
        datasource_id="ds1",
        dataset_name="enterprise",
        questions_file=questions_file,
        max_items=1,
        limit_per_category=None,
        question_ids=None,
        question_indices=None,
        top_k=3,
        answer_mode="ground_truth",
        max_context_chars=1000,
        precompute=False,
        agentic=False,
    )

    mock_rag = MagicMock()
    mock_rag.query.return_value = RagQueryResult(
        answer="X is Y",
        contexts=["Context text"],
        sources=[{"document_id": "doc1"}],
        retrieved_doc_ids=["doc1"],
        latency_sec=0.1,
    )

    with (
        patch(
            "deepeval_eval.engine.deepeval_evaluator._build_rag_client",
            return_value=mock_rag,
        ),
        patch("deepeval_eval.engine.deepeval_evaluator.build_metrics", return_value=[]),
    ):
        _run_eval(args)

    results_dir = tmp_path / "results"
    assert results_dir.exists()


def test_deepeval_evaluator_prompt_config_cli(tmp_path: Path) -> None:
    parser = build_evaluator_parser()
    prompt_cfg = tmp_path / "custom_prompts.yaml"
    prompt_cfg.write_text(
        "prompt_styles:\n  my_style: 'Q: {question} C: {context}'\n", encoding="utf-8"
    )

    args = parser.parse_args(
        [
            "eval",
            "--prompt-style",
            "my_style",
            "--prompt-config",
            str(prompt_cfg),
        ]
    )
    assert args.prompt_style == "my_style"
    assert args.prompt_config == prompt_cfg


def test_environ_get_present_and_default_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify _environ_get returns env var if present or fallback default."""
    from deepeval_eval.engine.deepeval_evaluator import _environ_get

    monkeypatch.setenv("TEST_EVAL_ENV_KEY", "custom_val")
    assert _environ_get("TEST_EVAL_ENV_KEY", "fallback") == "custom_val"

    monkeypatch.delenv("TEST_EVAL_ENV_KEY", raising=False)
    assert _environ_get("TEST_EVAL_ENV_KEY", "fallback") == "fallback"


def test_write_results_delegation(tmp_path: Path) -> None:
    """Verify _write_results delegates to write_evaluation_results."""
    from deepeval_eval.engine.deepeval_evaluator import _write_results

    with patch(
        "deepeval_eval.engine.deepeval_evaluator.write_evaluation_results"
    ) as mock_write:
        _write_results(tmp_path, "prefix", [], 1.5, {"k": "v"})
        mock_write.assert_called_once_with(
            results_dir=tmp_path,
            prefix="prefix",
            results=[],
            evaluation_time=1.5,
            config_args={"k": "v"},
        )


def test_build_config_args_custom_object_serialized_as_string() -> None:
    """Verify _build_config_args stringifies arbitrary complex custom objects."""

    class CustomObj:
        def __str__(self) -> str:
            return "custom_repr"

    args = argparse.Namespace(custom_field=CustomObj(), normal_field="val")
    res = _build_config_args(args)
    assert res["custom_field"] == "custom_repr"
    assert res["normal_field"] == "val"


def test_run_eval_with_extra_filters_and_invalid_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Verify _run_eval parses valid extra_filters JSON string and gracefully handles malformed JSON."""
    monkeypatch.setenv("OPENAI_ENDPOINT", "http://localhost")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("OPENAI_MODEL_NAME", "m")

    # Valid JSON string
    args_valid = argparse.Namespace(
        results_dir=tmp_path / "res1",
        dataset_name="enterprise",
        extra_filters='{"category": "finance"}',
        max_items=1,
    )
    with (
        patch("deepeval_eval.engine.deepeval_evaluator._build_rag_client"),
        patch("deepeval_eval.engine.deepeval_evaluator.run_evaluation") as mock_eval,
    ):
        _run_eval(args_valid)
        assert mock_eval.call_args[0][0].extra_filters == {"category": "finance"}

    # Malformed JSON string
    args_invalid = argparse.Namespace(
        results_dir=tmp_path / "res2",
        dataset_name="enterprise",
        extra_filters="{invalid json}",
        max_items=1,
    )
    with (
        patch("deepeval_eval.engine.deepeval_evaluator._build_rag_client"),
        patch("deepeval_eval.engine.deepeval_evaluator.run_evaluation") as mock_eval,
    ):
        _run_eval(args_invalid)
        assert mock_eval.call_args[0][0].extra_filters == {}


def test_run_eval_dynamic_tool_flow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Verify _run_eval initializes DynamicMCPToolManager when dynamic_tool is enabled."""
    monkeypatch.setenv("OPENAI_ENDPOINT", "http://localhost")
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("OPENAI_MODEL_NAME", "m")

    args = argparse.Namespace(
        results_dir=tmp_path / "res3",
        dataset_name="enterprise",
        dynamic_tool=True,
        datasource_id="ds_dynamic_1",
        semantic_weight=0.7,
        tool_description="Dynamic test tool",
        agentic=True,
    )

    mock_tool_mgr = MagicMock()
    mock_tool_mgr.tool_id = "ephemeral_tool_99"
    mock_tool_mgr.__enter__.return_value = mock_tool_mgr

    with (
        patch(
            "deepeval_eval.clients.mcp_tool_manager.DynamicMCPToolManager",
            return_value=mock_tool_mgr,
        ),
        patch("deepeval_eval.clients.search_rag.build_search_rag_client"),
        patch("deepeval_eval.engine.deepeval_evaluator._build_rag_client"),
        patch("deepeval_eval.engine.deepeval_evaluator.run_evaluation") as mock_eval,
    ):
        _run_eval(args)
        assert mock_eval.called
        config_passed = mock_eval.call_args[0][0]
        assert config_passed.search_tool_name == "ephemeral_tool_99"
        mock_tool_mgr.__enter__.assert_called_once()
        mock_tool_mgr.__exit__.assert_called_once()


def test_run_eval_quality_gate_error_exits_with_code_1(tmp_path: Path) -> None:
    """Verify _run_eval catches QualityGateError and exits with code 1."""
    from deepeval_eval.engine.eval_engine import QualityGateError

    args = argparse.Namespace(
        results_dir=tmp_path / "res4",
        dataset_name="enterprise",
    )

    with (
        patch("deepeval_eval.engine.deepeval_evaluator._build_rag_client"),
        patch(
            "deepeval_eval.engine.deepeval_evaluator.run_evaluation",
            side_effect=QualityGateError("Threshold breached"),
        ),
        patch("sys.exit") as mock_exit,
        patch("sys.stderr.write") as mock_err,
    ):
        _run_eval(args)
        mock_err.assert_called_once()
        assert "Quality gate error: Threshold breached" in mock_err.call_args[0][0]
        mock_exit.assert_called_once_with(1)


def test_main_cli_entry_point(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify main() parses CLI args and invokes subcommand func."""
    from deepeval_eval.engine.deepeval_evaluator import main

    test_argv = [
        "deepeval-eval",
        "eval",
        "--dataset-name",
        "enterprise",
        "--max-items",
        "2",
    ]
    monkeypatch.setattr("sys.argv", test_argv)

    with patch("deepeval_eval.engine.deepeval_evaluator._run_eval") as mock_run_eval:
        main()
        mock_run_eval.assert_called_once()
        args = mock_run_eval.call_args[0][0]
        assert args.dataset_name == "enterprise"
        assert args.max_items == 2


def test_run_eval_dynamic_tool_sets_agentic_settings_search_tool() -> None:
    import argparse
    from unittest.mock import MagicMock, patch

    from deepeval_eval.engine.deepeval_evaluator import _run_eval

    args = argparse.Namespace(
        dataset_name="enterprise",
        dynamic_tool=True,
        semantic_weight=0.6,
        extra_filters='{"doc_type": "markdown"}',
        tool_description="Custom test tool",
        datasource_id="ds_custom",
    )

    mock_mgr = MagicMock()
    mock_mgr.tool_id = "dynamic_tool_123"
    mock_mgr.__enter__.return_value = mock_mgr

    with (
        patch("deepeval_eval.clients.search_rag.build_search_rag_client"),
        patch(
            "deepeval_eval.clients.mcp_tool_manager.DynamicMCPToolManager",
            return_value=mock_mgr,
        ),
        patch("deepeval_eval.engine.deepeval_evaluator._build_rag_client"),
        patch("deepeval_eval.engine.deepeval_evaluator.run_evaluation") as mock_eval,
    ):
        _run_eval(args)
        assert mock_eval.call_count == 1
        cfg = mock_eval.call_args[0][0]
        assert cfg.search_tool_name == "dynamic_tool_123"
        assert cfg.agentic_settings.search_tool_name == "dynamic_tool_123"


def test_evaluator_parser_metrics_and_metric_set_arguments() -> None:
    parser = build_evaluator_parser()
    args = parser.parse_args(
        ["eval", "--metrics", "faithfulness,mrr", "--metric-set", "rag_core"]
    )
    assert args.metrics == "faithfulness,mrr"
    assert args.metric_set == "rag_core"


def test_run_eval_list_metrics_flag_prints_and_returns_without_eval(capsys) -> None:
    args = argparse.Namespace(list_metrics=True)
    with patch("deepeval_eval.engine.deepeval_evaluator.run_evaluation") as mock_eval:
        _run_eval(args)
        mock_eval.assert_not_called()
    captured = capsys.readouterr()
    assert "Available DeepEval & Custom Metrics" in captured.out
    assert "faithfulness" in captured.out


def test_run_eval_parses_comma_separated_metrics_into_list() -> None:
    args = argparse.Namespace(
        dataset_name="enterprise",
        metrics="faithfulness, answer_relevancy, mrr",
        metric_set="rag_core",
    )
    with (
        patch("deepeval_eval.engine.deepeval_evaluator._build_rag_client"),
        patch("deepeval_eval.engine.deepeval_evaluator.run_evaluation") as mock_eval,
    ):
        _run_eval(args)
        mock_eval.assert_called_once()
        cfg = mock_eval.call_args[0][0]
        assert cfg.metrics == ["faithfulness", "answer_relevancy", "mrr"]
        assert cfg.metric_set == "rag_core"

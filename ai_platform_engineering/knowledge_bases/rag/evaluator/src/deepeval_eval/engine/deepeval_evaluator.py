from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from deepeval_eval.core.config import (
    DEFAULT_CACHE_DIR,
    DEFAULT_DATA_DIR,
    DEFAULT_GATE_CONFIG,
    DEFAULT_RESULTS_DIR,
    EvalConfig,
)
from deepeval_eval.engine.eval_engine import (
    QualityGateError,
    _build_rag_client,
    run_evaluation,
)
from deepeval_eval.engine.metrics import build_metrics as build_metrics
from deepeval_eval.sinks import write_evaluation_results


def _environ_get(key: str, default: str | None = None) -> str | None:
    """Read from os.environ with a fallback default."""
    return os.environ.get(key) or default


def _write_results(
    results_dir: Path,
    prefix: str,
    results: list[dict[str, Any]],
    evaluation_time: float,
    config_args: dict[str, Any],
) -> None:
    """Delegates to write_evaluation_results in sinks for dynamic metric aggregation."""
    write_evaluation_results(
        results_dir=results_dir,
        prefix=prefix,
        results=results,
        evaluation_time=evaluation_time,
        config_args=config_args,
    )


def _add_eval_args(parser: argparse.ArgumentParser) -> None:
    """Add common eval arguments to an existing subparser."""
    parser.add_argument(
        "--datasource-id", default=None, help="The target CAIPE datasource"
    )
    parser.add_argument(
        "--rag-url",
        default=None,
        help="Target CAIPE RAG server URL (default: RAG_URL env var or http://localhost:9446)",
    )
    parser.add_argument(
        "--search-tool-name",
        default=None,
        help="Target MCP search tool name (default: knowledge-base_search)",
    )
    parser.add_argument(
        "--fetch-tool-name",
        default=None,
        help="Target MCP fetch document tool name (default: knowledge-base_fetch_document)",
    )
    parser.add_argument("--questions-file", type=Path, default=None)
    parser.add_argument(
        "--question-set-id",
        type=int,
        default=None,
        help="Question Set ID to load evaluation questions from Question Manager",
    )
    parser.add_argument(
        "--prompt-style",
        default=None,
        help="Prompt style for answer generation (e.g. 'generation', 'short', or custom style name)",
    )
    parser.add_argument(
        "--prompt-config",
        type=Path,
        default=None,
        help="Path to custom prompt style configuration file (JSON/YAML)",
    )
    parser.add_argument(
        "--metric-set",
        default=None,
        help="Name of a pre-configured metric set bundle (e.g. 'rag_core', 'retrieval_fast')",
    )
    parser.add_argument(
        "--metrics",
        default=None,
        help="Comma-separated list of metric names to evaluate (e.g. 'faithfulness,answer_relevancy,mrr')",
    )
    parser.add_argument(
        "--list-metrics",
        action="store_true",
        help="List all available built-in metrics, custom metrics, and metric sets, then exit",
    )
    parser.add_argument("--max-items", type=int, default=None)
    parser.add_argument("--limit-per-category", type=int, default=None)
    parser.add_argument(
        "--top-k", type=int, default=3, help="Number of documents to retrieve"
    )
    parser.add_argument("--max-context-chars", type=int, default=12000)
    parser.add_argument("--llm-base-url", default=None)
    parser.add_argument("--llm-api-key", default=None)
    parser.add_argument("--llm-model", default=None)
    parser.add_argument(
        "--agentic",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Route queries through CAIPE dynamic agents streaming endpoint (default: True, use --no-agentic for direct RAG search)",
    )
    parser.add_argument(
        "--trace-log",
        action="store_true",
        help="Save detailed agentic stream and query trace logs to disk",
    )
    parser.add_argument(
        "--agent-id",
        default=None,
        help="CAIPE agent ID for agentic eval (defaults to CAIPE_AGENT_ID env var or hello-world)",
    )
    parser.add_argument(
        "--agent-url",
        dest="agent_url",
        default="http://localhost:8000",
        help="CAIPE dynamic-agents / supervisor URL for agentic eval",
    )
    parser.add_argument(
        "--fail-on-error",
        action="store_true",
        help="Fail loudly if a query evaluation fails after retries",
    )
    parser.add_argument(
        "--oracle-retrieval",
        action="store_true",
        help="Enable oracle retrieval (querying CAIPE search using question + reference)",
    )
    parser.add_argument(
        "--oracle-testing",
        action="store_true",
        help="Shortcut to enable oracle_retrieval and ground_truth answer mode",
    )
    parser.add_argument(
        "--gate",
        action="store_true",
        help="Apply the quality gate after evaluation and exit non-zero if it fails.",
    )
    parser.add_argument(
        "--gate-config",
        type=Path,
        default=DEFAULT_GATE_CONFIG,
        help="Path to quality gate threshold YAML config",
    )
    parser.add_argument(
        "--dynamic-tool",
        action="store_true",
        help="Provision an ephemeral MCP custom search tool for this run and delete it after",
    )
    parser.add_argument(
        "--semantic-weight",
        type=float,
        default=0.5,
        help="Semantic (dense) weight for hybrid search (0.0–1.0; keyword = 1 - semantic_weight)",
    )
    parser.add_argument(
        "--extra-filters",
        type=str,
        default=None,
        help='JSON string of extra metadata filters (e.g. \'{"document_type": "pdf"}\')',
    )
    parser.add_argument(
        "--tool-description",
        type=str,
        default=None,
        help="Optional description for the ephemeral MCP custom tool",
    )


def _build_config_args(args: argparse.Namespace) -> dict[str, Any]:
    """Serialize args into a JSON-serializable dict (hiding secrets)."""
    config = {}
    for k, v in vars(args).items():
        if (
            v is None
            or k in ("llm_api_key", "auth_token")
            or callable(v)
            or k.startswith("_")
        ):
            continue
        if isinstance(v, Path):
            config[k] = str(v)
        elif isinstance(v, (str, int, float, bool, list, dict)):
            config[k] = v
        else:
            config[k] = str(v)
    return config


def _run_eval(args: argparse.Namespace) -> None:
    """CLI handler that builds an EvalConfig and dispatches to eval_engine.run_evaluation."""
    if getattr(args, "list_metrics", False):
        from deepeval_eval.engine.metrics import list_builtin_metric_metadata

        print("\n=== Available DeepEval & Custom Metrics ===")
        for item in list_builtin_metric_metadata():
            print(
                f"  - {item['name']:<25} [{item['metric_type']}] (default threshold: {item['default_threshold']})"
            )
            print(f"    {item['description']}")

        print("\n=== Standard Metric Sets ===")
        print("  - all_default     : All 12 baseline DeepEval metrics")
        print(
            "  - rag_core        : Faithfulness, Answer Relevancy, Answer Correctness, Context Precision/Recall"
        )
        print(
            "  - retrieval_fast  : MRR, nDCG@k, Retrieval Recall, Retrieval Precision, Normalized Exact Match\n"
        )
        return

    ds_name = (
        getattr(args, "dataset_name", None)
        or getattr(args, "dataset", None)
        or getattr(args, "benchmark", "enterprise")
    )

    parsed_extra_filters: dict[str, Any] = {}
    raw_extra_filters = getattr(args, "extra_filters", None)
    if raw_extra_filters:
        try:
            parsed_extra_filters = (
                json.loads(raw_extra_filters)
                if isinstance(raw_extra_filters, str)
                else raw_extra_filters
            )
        except Exception:
            pass

    metrics_list: list[str] | None = None
    raw_metrics = getattr(args, "metrics", None)
    if raw_metrics:
        metrics_list = [m.strip() for m in raw_metrics.split(",") if m.strip()]

    config = EvalConfig(
        dataset_name=ds_name,
        answer_mode=getattr(args, "answer_mode", "generate"),
        datasource_id=getattr(args, "datasource_id", None),
        rag_url=getattr(args, "rag_url", None),
        search_tool_name=getattr(args, "search_tool_name", None),
        fetch_tool_name=getattr(args, "fetch_tool_name", None),
        data_dir=getattr(args, "data_dir", DEFAULT_DATA_DIR),
        questions_file=getattr(args, "questions_file", None),
        question_set_id=getattr(args, "question_set_id", None),
        prompt_style=getattr(args, "prompt_style", None),
        prompt_config=getattr(args, "prompt_config", None),
        metric_set=getattr(args, "metric_set", None),
        metrics=metrics_list,
        max_items=getattr(args, "max_items", None),
        limit_per_category=getattr(args, "limit_per_category", None),
        top_k=getattr(args, "top_k", 3),
        max_context_chars=getattr(args, "max_context_chars", 12000),
        llm_base_url=getattr(args, "llm_base_url", None),
        llm_api_key=getattr(args, "llm_api_key", None),
        llm_model=getattr(args, "llm_model", None),
        agentic=getattr(args, "agentic", True),
        trace_log=getattr(args, "trace_log", False),
        agent_id=getattr(args, "agent_id", None),
        agent_url=getattr(args, "agent_url", getattr(args, "agent_api_url", None)),
        fail_on_error=getattr(args, "fail_on_error", False),
        oracle_retrieval=getattr(args, "oracle_retrieval", False),
        oracle_testing=getattr(args, "oracle_testing", False),
        gate=getattr(args, "gate", False),
        gate_config=getattr(args, "gate_config", DEFAULT_GATE_CONFIG),
        results_dir=getattr(args, "results_dir", DEFAULT_RESULTS_DIR),
        question_ids=getattr(args, "question_ids", None),
        question_indices=getattr(args, "question_indices", None),
        dynamic_tool=getattr(args, "dynamic_tool", False),
        semantic_weight=getattr(args, "semantic_weight", 0.5),
        extra_filters=parsed_extra_filters,
        tool_description=getattr(args, "tool_description", None),
    )

    ctx: Any = contextlib.nullcontext()
    if config.dynamic_tool:
        from deepeval_eval.clients.mcp_tool_manager import DynamicMCPToolManager
        from deepeval_eval.clients.search_rag import build_search_rag_client

        crud_rag_client = build_search_rag_client(config.caipe)
        run_id = config.run_id or f"cli-{int(time.time())}"
        tool_mgr = DynamicMCPToolManager(
            rag_client=crud_rag_client,
            run_id=run_id,
            datasource_ids=[config.datasource_id] if config.datasource_id else [],
            semantic_weight=config.semantic_weight,
            extra_filters=config.extra_filters,
            description=config.tool_description or "",
        )
        config.search_tool_name = tool_mgr.tool_id
        if hasattr(config, "agentic_settings") and config.agentic_settings:
            config.agentic_settings.search_tool_name = tool_mgr.tool_id
        ctx = tool_mgr

    try:
        with ctx:
            rag_client = _build_rag_client(config)
            run_evaluation(config, rag_client=rag_client)
    except QualityGateError as err:
        import sys

        sys.stderr.write(f"Quality gate error: {err}\n")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Subcommand dispatch
# ---------------------------------------------------------------------------


def _eval_subcommand(args: argparse.Namespace) -> None:
    """Dispatch to the unified evaluation loop."""
    _run_eval(args)


# ---------------------------------------------------------------------------
# Build parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="DeepEval evaluation pipeline supporting arbitrary datasets",
    )
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)

    subparsers = parser.add_subparsers(dest="command", required=True)

    # ---- eval subcommand ----
    eval_parser = subparsers.add_parser("eval", help="Run DeepEval evaluation")
    eval_parser.add_argument(
        "--dataset-name",
        "--dataset",
        "--benchmark",
        dest="dataset_name",
        default="enterprise",
        help="Dataset name to evaluate against (default: enterprise)",
    )
    eval_parser.add_argument(
        "--answer-mode",
        choices=["generate", "ground_truth"],
        default="generate",
        help="ground_truth uses benchmark ground-truth answer; generate synthesizes answers via LLM (default: generate)",
    )
    _add_eval_args(eval_parser)
    eval_parser.set_defaults(func=_eval_subcommand)

    return parser


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

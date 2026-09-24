from __future__ import annotations

import inspect
import logging
import time
from collections.abc import Sequence
from typing import Any

from deepeval.metrics import GEval

from deepeval_eval.api.telemetry import trace_evaluation_span
from deepeval_eval.clients.llm import DeepEvalJudge, OpenAICompatibleClient
from deepeval_eval.core.config import (
    EvalConfig,
    ensure_dirs,
)
from deepeval_eval.core.io_utils import sanitize_path
from deepeval_eval.datasets.loader import BaseDataLoader, FileDataLoader
from deepeval_eval.engine.metrics import doc_id_scores
from deepeval_eval.sinks import (
    FileResultSink,
    PostgresResultSink,
    ResultSink,
    write_evaluation_results,
)

logger = logging.getLogger(__name__)


class QualityGateError(RuntimeError):
    """Raised when evaluation results fail quality gate thresholds."""

    pass


def _build_rag_client(config: Any, db_manager: Any | None = None) -> Any:
    """Factory function to build RAG client using explicit settings injection."""
    from deepeval_eval.clients.search_rag import build_search_rag_client

    prompt_args = getattr(config, "prompt_args", None)
    user_subject = getattr(config, "submitter_subject", None) or getattr(
        config, "user_subject", None
    )
    user_token = getattr(config, "user_token", None) or getattr(
        config, "obo_token", None
    )

    if getattr(config, "oracle_retrieval", False):
        from deepeval_eval.clients.oracle import OracleRagClient

        caipe_settings = getattr(config, "caipe", None)
        caipe_client = build_search_rag_client(
            caipe_settings=caipe_settings
            if hasattr(caipe_settings, "model_dump")
            else None,
            user_subject=user_subject,
            user_token=user_token,
        )
        return OracleRagClient(caipe_client)
    elif getattr(config, "agentic", False):
        from deepeval_eval.clients.rag import AgenticRagAdapter

        agentic_settings = getattr(config, "agentic_settings", None)
        return AgenticRagAdapter(
            agentic_settings=agentic_settings
            if hasattr(agentic_settings, "model_dump")
            else None,
            results_dir=getattr(config, "results_dir", None),
            agent_url=getattr(config, "agent_url", None),
            fail_on_error=getattr(config, "fail_on_error", False),
            datasource_id=getattr(config, "datasource_id", None),
            agent_id=getattr(config, "agent_id", None),
            trace_log=getattr(config, "trace_log", False),
            db_manager=db_manager,
            prompt_args=prompt_args,
            search_tool_name=getattr(config, "search_tool_name", None),
            fetch_tool_name=getattr(config, "fetch_tool_name", None),
            user_subject=user_subject,
            user_token=user_token,
        )
    else:
        caipe_settings = getattr(config, "caipe", None)
        client = build_search_rag_client(
            caipe_settings=caipe_settings
            if hasattr(caipe_settings, "model_dump")
            else None,
            user_subject=user_subject,
            user_token=user_token,
        )
        if db_manager is not None:
            client.db_manager = db_manager
        if prompt_args is not None:
            client.prompt_args = prompt_args
        return client


def run_evaluation(
    config: EvalConfig,
    data_loader: BaseDataLoader | None = None,
    rag_client: Any | None = None,
    metrics: list[Any] | None = None,
    sinks: Sequence[ResultSink] | None = None,
) -> list[dict[str, Any]]:
    """Execute evaluation run according to EvalConfig settings."""
    config_dict = (
        config.to_config_args()
        if hasattr(config, "to_config_args")
        else getattr(config, "__dict__", None)
    )
    span = trace_evaluation_span(
        getattr(config, "dataset_name", "enterprise"), config_dict
    )
    with span:
        ensure_dirs(config.results_dir)
        if config.prompt_config:
            from deepeval_eval.core.prompt_style import load_prompt_styles_from_config

            load_prompt_styles_from_config(config.prompt_config)

    llm_client = OpenAICompatibleClient(llm_settings=config.llm)
    if metrics is None:
        judge = DeepEvalJudge(client=llm_client).model
        from deepeval_eval.engine.metrics import build_metrics_from_config

        db_mgr_metrics = None
        if hasattr(config, "db") and config.db and config.db.postgres_host:
            from deepeval_eval.db.db_manager import DatabaseManager

            db_mgr_metrics = DatabaseManager(db_settings=config.db)

        metric_names = getattr(config, "metrics", None)
        metric_set = getattr(config, "metric_set", None)
        metrics = build_metrics_from_config(
            metric_names=metric_names,
            metric_set_name=metric_set,
            judge_model=judge,
            db=db_mgr_metrics,
        )

    from deepeval.test_case import LLMTestCase

    datasource_id = config.datasource_id
    dataset_name = config.dataset_name

    if data_loader is None:
        if config.question_set_id is not None:
            # Deferred import to avoid triggering PostgreSQL connection initialization
            # when running standard file-based evaluations.
            from deepeval_eval.datasets.loader import QuestionSetDataLoader
            from deepeval_eval.db.db_manager import DatabaseManager

            db_mgr = DatabaseManager(db_settings=config.db)
            data_loader = QuestionSetDataLoader(
                question_set_id=config.question_set_id,
                db_manager=db_mgr,
            )
        else:
            data_loader = FileDataLoader(
                questions_file=config.questions_file,
                dataset_name=dataset_name,
                data_dir=config.data_dir,
            )

    combine_with_level = (
        config.combine_with_level
        if config.combine_with_level is not None
        else (dataset_name == "hotpotqa")
    )

    rows = data_loader.load(
        max_items=config.max_items,
        limit_per_category=config.limit_per_category,
        combine_with_level=combine_with_level,
    )

    if config.question_ids:
        target_ids = {qid.strip() for qid in config.question_ids.split(",")}
        rows = [row for row in rows if str(row.get("question_id")) in target_ids]

    if config.question_indices:
        indices = set()
        for part in config.question_indices.split(","):
            part = part.strip()
            if "-" in part:
                try:
                    start_str, end_str = part.split("-", 1)
                    start = int(start_str.strip())
                    end = int(end_str.strip())
                    for i in range(start, end + 1):
                        if 1 <= i <= len(rows):
                            indices.add(i)
                except ValueError:
                    pass
            else:
                try:
                    i = int(part)
                    if 1 <= i <= len(rows):
                        indices.add(i)
                except ValueError:
                    pass
        rows = [rows[i - 1] for i in sorted(indices) if 1 <= i <= len(rows)]

    if rag_client is None:
        rag_client = _build_rag_client(config)

    results: list[dict[str, Any]] = []
    start_eval_time = time.time()

    metric_accepts_indicator: dict[int, bool] = {}
    for metric in metrics:
        try:
            sig = inspect.signature(metric.measure)
            metric_accepts_indicator[id(metric)] = (
                "_show_indicator" in sig.parameters
                or any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values())
            )
        except Exception:
            metric_accepts_indicator[id(metric)] = False

    for idx, row in enumerate(rows, start=1):
        question = (
            row.get("user_input") or row.get("input") or row.get("question") or ""
        )
        reference = row.get("reference") or row.get("expected_output") or ""
        logger.info(f"Evaluating {idx}/{len(rows)}")

        llm_client.reset_tokens()

        query_res = rag_client.query(
            question=question,
            reference=reference,
            datasource_id=datasource_id,
            top_k=config.top_k,
            answer_mode=config.answer_mode,
            dataset_name=dataset_name,
            experiment_name=config.experiment_name,
            run_id=config.run_id,
            log_file_prefix=config.log_file_prefix,
            prompt_style=config.prompt_style,
            prompt_args=getattr(config, "prompt_args", None),
            llm_client=llm_client,
            max_context_chars=config.max_context_chars,
        )

        answer = query_res.answer
        trimmed_contexts = query_res.contexts
        sources = query_res.sources
        current_retrieved_ids = query_res.retrieved_doc_ids or row.get(
            "retrieved_doc_ids", []
        )

        test_case = LLMTestCase(
            input=question,
            actual_output=answer,
            expected_output=reference,
            retrieval_context=trimmed_contexts,
            context=row.get("context") or [],
            metadata={
                "retrieved_doc_ids": current_retrieved_ids,
                "expected_doc_ids": row.get("expected_doc_ids", []),
                "top_k": config.top_k,
            },
        )

        show_indicator = getattr(config, "show_indicator", False)
        metric_results: dict[str, dict[str, Any]] = {}
        for metric in metrics:
            metric_name = (
                getattr(metric, "name", None)
                if isinstance(metric, GEval)
                else metric.__class__.__name__
            ) or metric.__class__.__name__
            logger.debug(
                f"[eval_engine] Executing metric '{metric_name}' for question {idx}/{len(rows)}"
            )
            try:
                if metric_accepts_indicator.get(id(metric), False):
                    metric.measure(test_case, _show_indicator=show_indicator)
                else:
                    metric.measure(test_case)
                reason = getattr(metric, "reason", None)
                if reason is None:
                    get_reason_fn = getattr(metric, "get_reason", None)
                    if callable(get_reason_fn):
                        try:
                            reason = get_reason_fn()
                        except Exception:
                            reason = None
                metric_results[metric_name] = {
                    "score": metric.score,
                    "success": metric.is_successful(),
                    "reason": reason,
                }
            except Exception as exc:
                logger.warning(
                    f"Metric '{metric_name}' failed for row {idx}/{len(rows)}: {exc}"
                )
                if config.fail_on_error:
                    raise exc
                metric_results[metric_name] = {
                    "score": None,
                    "success": False,
                    "reason": f"metric failed: {exc}",
                }

        recall_score = metric_results.get("RetrievalRecallMetric", {}).get("score")
        precision_score = metric_results.get("RetrievalPrecisionMetric", {}).get(
            "score"
        )
        if recall_score is None or precision_score is None:
            fallback_recall, fallback_precision = doc_id_scores(
                sources, list(row.get("expected_doc_ids") or [])
            )
            doc_recall = recall_score if recall_score is not None else fallback_recall
            doc_precision = (
                precision_score if precision_score is not None else fallback_precision
            )
        else:
            doc_recall = recall_score
            doc_precision = precision_score

        results.append(
            {
                "question_id": row.get("question_id"),
                "dataset_name": dataset_name,
                "benchmark": dataset_name,
                "category": row.get("category"),
                "level": row.get("level"),
                "answer_mode": config.answer_mode,
                "user_input": question,
                "actual_input": (
                    str(getattr(query_res, "actual_input", ""))
                    if isinstance(getattr(query_res, "actual_input", None), str)
                    and getattr(query_res, "actual_input", "").strip() != ""
                    else question
                ),
                "reference": reference,
                "actual_output": answer,
                "context": row.get("context"),
                "retrieved_contexts": trimmed_contexts,
                "expected_doc_ids": row.get("expected_doc_ids") or [],
                "retrieved_doc_ids": current_retrieved_ids,
                "doc_id_recall": doc_recall,
                "doc_id_precision": doc_precision,
                "metrics": metric_results,
                "input_tokens": query_res.input_tokens,
                "output_tokens": query_res.output_tokens,
                "total_tokens": query_res.total_tokens,
                "evaluator_prompt_tokens": llm_client.input_tokens,
                "evaluator_completion_tokens": llm_client.output_tokens,
                "evaluator_total_tokens": llm_client.total_tokens,
                "latency": query_res.latency_sec,
                "log_file": sanitize_path(query_res.log_file),
            }
        )

    eval_time = time.time() - start_eval_time
    config_args = config.to_config_args()
    config_args["datasource"] = dataset_name

    if sinks is None:
        resolved_sinks: list[ResultSink] = [FileResultSink()]
        try:
            resolved_sinks.append(PostgresResultSink(db_settings=config.db))
        except Exception as exc:
            logger.warning(f"Skipping PostgresResultSink initialization: {exc}")
    else:
        resolved_sinks = list(sinks)

    write_evaluation_results(
        results_dir=config.results_dir,
        prefix=config.log_file_prefix,
        results=results,
        evaluation_time=eval_time,
        config_args=config_args,
        sinks=resolved_sinks,
    )

    if config.gate:
        from deepeval_eval.engine.gate import run_gate_on_results

        passed = run_gate_on_results(
            results,
            config.gate_config,
            config.results_dir,
            run_id=config.run_id,
        )
        if not passed:
            raise QualityGateError("Evaluation results failed quality gate thresholds.")

    return results

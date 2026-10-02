from __future__ import annotations

import csv
import json
import logging
import time
from pathlib import Path
from typing import Any

from deepeval_eval.core.io_utils import sanitize_path
from deepeval_eval.engine.metrics import get_metric_column_name
from deepeval_eval.sinks.metrics_aggregator import (
    calculate_latency_percentiles,
    categorize_failure_causes,
    compute_all_metric_averages,
    discover_all_metrics,
)

logger = logging.getLogger(__name__)


class FileResultSink:
    """Saves evaluation results to JSON, CSV, and summary JSON files with dynamic metric aggregation."""

    def save(
        self,
        results_dir: Path,
        prefix: str,
        results: list[dict[str, Any]],
        evaluation_time: float,
        config_args: dict[str, Any],
    ) -> None:
        results_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        json_path = results_dir / f"{prefix}_{timestamp}.json"
        csv_path = results_dir / f"{prefix}_{timestamp}.csv"
        summary_json_path = results_dir / f"{prefix}_{timestamp}_summary.json"

        latencies = [r.get("latency", 0.0) for r in results]
        p50_latency, p95_latency = calculate_latency_percentiles(latencies)

        total_tokens_sum = sum(r.get("total_tokens", 0) for r in results)

        # Dynamic metric discovery and unified score averages
        all_metric_averages = compute_all_metric_averages(results)

        # Categorize failure causes
        failure_counts = categorize_failure_causes(results)

        evaluator_prompt_tokens = sum(
            r.get("evaluator_prompt_tokens") or r.get("evaluator_input_tokens") or 0
            for r in results
        )
        evaluator_completion_tokens = sum(
            r.get("evaluator_completion_tokens")
            or r.get("evaluator_output_tokens")
            or 0
            for r in results
        )
        evaluator_total_tokens = evaluator_prompt_tokens + evaluator_completion_tokens

        # Console Summary
        datasource = config_args.get("datasource", "unknown")
        print("\n--- RUN CONFIGURATION ---")
        print(f"datasource: {datasource}")
        for k, v in config_args.items():
            print(f"{k}: {v}")

        print("\n--- OPERATIONAL BEHAVIOR ---")
        print("RAG Pipeline:")
        print(f"  P50 Latency: {p50_latency:.2f}s")
        print(f"  P95 Latency: {p95_latency:.2f}s")
        print(f"  Total Tokens: {total_tokens_sum}")
        print("\nDeepEval Evaluator:")
        print(f"  Evaluation Time: {evaluation_time:.2f}s")
        print(f"  Prompt Tokens: {evaluator_prompt_tokens}")
        print(f"  Completion Tokens: {evaluator_completion_tokens}")
        print(f"  Total Evaluator Tokens: {evaluator_total_tokens}")

        print("\n--- QUALITY METRICS AVERAGE ---")
        for metric_name, score in all_metric_averages.items():
            print(f"Average {metric_name}: {score:.2f}")

        print("\n--- FAILURE CAUSE ANALYSIS ---")
        for cause, count in failure_counts.items():
            print(f"{cause:<20} {count}")

        # Write JSON results
        json_path.write_text(
            json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        serializable_config = {}
        for k, v in config_args.items():
            if k.startswith("_") or k in ("llm_api_key", "auth_token"):
                continue
            try:
                json.dumps(v)
                serializable_config[k] = v
            except (TypeError, OverflowError):
                serializable_config[k] = str(v)

        summary_data: dict[str, Any] = {
            "experiment_name": csv_path.stem,
            "datasource": datasource,
            "config_args": serializable_config,
            "p50_latency": p50_latency,
            "p95_latency": p95_latency,
            "total_tokens": total_tokens_sum,
            "metrics": all_metric_averages,
            "deepeval_evaluator_usage": {
                "evaluation_time_seconds": evaluation_time,
                "prompt_tokens": evaluator_prompt_tokens,
                "completion_tokens": evaluator_completion_tokens,
                "total_tokens": evaluator_total_tokens,
            },
        }
        summary_json_path.write_text(
            json.dumps(summary_data, indent=4, ensure_ascii=False), encoding="utf-8"
        )

        # Write CSV results
        csv_content = format_results_as_csv(
            results=results,
            evaluation_time=evaluation_time,
            datasource=datasource,
        )
        csv_path.write_text(csv_content, encoding="utf-8")

        print(
            f"Wrote results:\n    {json_path}\n    {csv_path}\n    {summary_json_path}"
        )


def format_results_as_csv(
    results: list[dict[str, Any]],
    evaluation_time: float = 0.0,
    datasource: str = "enterprise",
) -> str:
    """Format evaluation results list into CSV string representation."""
    import io

    output = io.StringIO()

    n = len(results)
    latencies = [r.get("latency", 0.0) for r in results if r.get("latency") is not None]
    total_tokens_sum = sum(r.get("total_tokens", 0) for r in results)

    discovered_metrics = discover_all_metrics(results)
    all_metric_averages = compute_all_metric_averages(results)

    metric_score_cols = [get_metric_column_name(m) for m in discovered_metrics]
    metric_reason_cols = [
        f"{get_metric_column_name(m)}_reason" for m in discovered_metrics
    ]

    evaluator_prompt_tokens = sum(r.get("evaluator_input_tokens", 0) for r in results)
    evaluator_completion_tokens = sum(
        r.get("evaluator_output_tokens", 0) for r in results
    )
    evaluator_total_tokens = evaluator_prompt_tokens + evaluator_completion_tokens

    csv_columns = (
        [
            "question_id",
            "benchmark",
            "category",
            "level",
            "answer_mode",
            "question",
            "user_input",
            "reference",
            "expected_doc_ids",
            "response",
            "retrieved_contexts",
            "retrieved_doc_ids",
            "latency",
            "latency_ms",
            "total_tokens",
            "log_file",
        ]
        + metric_score_cols
        + metric_reason_cols
        + [
            "failure_cause",
            "retrieval_recall",
            "retrieval_precision",
            "evaluator_evaluation_time_seconds",
            "evaluator_prompt_tokens",
            "evaluator_completion_tokens",
            "evaluator_total_tokens",
        ]
    )

    writer = csv.writer(output)
    writer.writerow(csv_columns)
    for r in results:
        metrics_dict = r.get("metrics", {})
        retrieved_contexts_str = json.dumps(r.get("retrieved_contexts") or [])
        expected_doc_ids_str = ";".join(
            str(x) for x in (r.get("expected_doc_ids") or [])
        )
        retrieved_doc_ids_str = ";".join(
            str(x) for x in (r.get("retrieved_doc_ids") or [])
        )
        scores = [metrics_dict.get(m, {}).get("score") for m in discovered_metrics]
        reasons = [metrics_dict.get(m, {}).get("reason") for m in discovered_metrics]
        raw_latency = r.get("latency")
        latency_val = float(raw_latency) if raw_latency is not None else None
        latency_ms_val = r.get("latency_ms")
        if latency_ms_val is None:
            latency_ms_val = latency_val * 1000.0 if latency_val is not None else 0.0

        writer.writerow(
            [
                r.get("question_id"),
                r.get("benchmark", datasource),
                r.get("category"),
                r.get("level"),
                r.get("answer_mode"),
                r.get("question"),
                r.get("user_input"),
                r.get("reference"),
                expected_doc_ids_str,
                r.get("actual_output") or r.get("response"),
                retrieved_contexts_str,
                retrieved_doc_ids_str,
                latency_val,
                latency_ms_val,
                r.get("total_tokens"),
                r.get("log_file"),
                *scores,
                *reasons,
                r.get("failure_cause"),
                r.get("doc_id_recall"),
                r.get("doc_id_precision"),
                evaluation_time,
                r.get("evaluator_input_tokens"),
                r.get("evaluator_output_tokens"),
                r.get("evaluator_total_tokens"),
            ]
        )

    # Summary row
    summary_row = dict.fromkeys(csv_columns, "")
    summary_row["question"] = "AVERAGE_METRICS"
    summary_row["latency"] = sum(latencies) / n if n else 0.0
    summary_row["latency_ms"] = (sum(latencies) / n if n else 0.0) * 1000.0
    summary_row["total_tokens"] = total_tokens_sum / n if n else 0.0
    for metric_name, score in all_metric_averages.items():
        if metric_name in summary_row:
            summary_row[metric_name] = score

    summary_row["failure_cause"] = "N/A"
    summary_row["evaluator_evaluation_time_seconds"] = evaluation_time
    summary_row["evaluator_prompt_tokens"] = evaluator_prompt_tokens
    summary_row["evaluator_completion_tokens"] = evaluator_completion_tokens
    summary_row["evaluator_total_tokens"] = evaluator_total_tokens
    writer.writerow([summary_row[col] for col in csv_columns])

    return output.getvalue()


class FileLogSink:
    """Handles trace log file path resolution and writing for agentic evaluation runs."""

    @staticmethod
    def _is_uuid(s: str) -> bool:
        """Return True if s looks like a UUID (36 chars, 4 hyphens)."""
        return len(s) == 36 and s.count("-") == 4

    def resolve_prefix(
        self,
        log_file_prefix: str | None = None,
        datasource_id: str | None = None,
    ) -> str:
        """Resolve log file prefix using clean fallback sequence."""
        if log_file_prefix:
            return log_file_prefix
        if datasource_id:
            return (
                datasource_id
                if datasource_id.startswith("deepeval_")
                else f"deepeval_{datasource_id}"
            )
        return "deepeval"

    def make_stream_log_path(
        self,
        log_dir: Path,
        prefix: str | None = None,
        run_id: str | None = None,
        datasource_id: str | None = None,
    ) -> Path:
        """Build SSE stream trace log path and ensure the directory exists.

        Filename pattern:
          - If run_id is set and is NOT a UUID: ``{run_id}_agent_trace.log`` (or ``{run_id}`` if it already ends in .log)
          - Otherwise: ``{prefix}_{YYYYMMDD-HHMMSS}_agent_trace.log``
        """
        log_dir.mkdir(parents=True, exist_ok=True)
        resolved_prefix = self.resolve_prefix(prefix, datasource_id)
        if run_id and not self._is_uuid(run_id):
            safe_run = sanitize_path(run_id) or "default"
            filename = (
                safe_run if safe_run.endswith(".log") else f"{safe_run}_agent_trace.log"
            )
        else:
            filename = (
                f"{resolved_prefix}_{time.strftime('%Y%m%d-%H%M%S')}_agent_trace.log"
            )
        return log_dir / filename

    def open_stream_log(
        self,
        log_dir: Path,
        prefix: str | None = None,
        run_id: str | None = None,
        datasource_id: str | None = None,
    ) -> tuple[Path, Any | None]:
        """Create stream log path and open file handle for writing."""
        path = self.make_stream_log_path(log_dir, prefix, run_id, datasource_id)
        try:
            handle = path.open("w", encoding="utf-8")
            logger.info("Capturing agentic stream log to %s", path)
            return path, handle
        except Exception:
            logger.exception("Failed to open agentic stream log file %s", path)
            return path, None

    def write_stream_line(self, log_file: Any, line: str) -> None:
        """Format and append a raw SSE stream line to an open trace log file."""
        if line.startswith("event: "):
            log_file.write(f"\n[{line}]\n")
        elif line.startswith("data: "):
            data_str = line[6:].strip()
            try:
                data_json = json.loads(data_str)
                log_file.write(json.dumps(data_json, indent=2) + "\n")
            except Exception:
                log_file.write(line + "\n")
        else:
            log_file.write(line + "\n")
        log_file.flush()

    def make_query_trace_path(
        self,
        log_dir: Path,
        run_id: str,
        prefix: str | None = None,
        datasource_id: str | None = None,
    ) -> Path:
        """Build structural query trace JSON path and ensure the directory exists.

        Filename pattern:
          - If run_id is set and is NOT a UUID: ``{safe_run_id}_query_trace.json``
          - Otherwise: ``{prefix}_{YYYYMMDD-HHMMSS}_query_trace.json``
        """
        log_dir.mkdir(parents=True, exist_ok=True)
        resolved_prefix = self.resolve_prefix(prefix, datasource_id)
        if run_id and not self._is_uuid(run_id):
            safe_run_id = sanitize_path(run_id) or "default"
            filename = (
                safe_run_id
                if safe_run_id.endswith(".json")
                else f"{safe_run_id}_query_trace.json"
            )
        else:
            filename = (
                f"{resolved_prefix}_{time.strftime('%Y%m%d-%H%M%S')}_query_trace.json"
            )
        return log_dir / filename

    def write_query_trace(
        self,
        log_dir: Path,
        run_id: str,
        question: str,
        result: dict[str, Any] | None,
        traces: list[Any],
    ) -> Path:
        """Write structural query trace JSON. Returns the path written.

        ``traces`` is a list of ``TraceEvent`` objects (must have .event_type,
        .component, .data, .timestamp attributes).
        """
        path = self.make_query_trace_path(log_dir, run_id)
        try:
            path.write_text(
                json.dumps(
                    {
                        "question": question,
                        "result": result,
                        "traces": [
                            {
                                "event_type": t.event_type,
                                "component": t.component,
                                "data": t.data,
                                "timestamp": t.timestamp.isoformat(),
                            }
                            for t in traces
                        ],
                    },
                    indent=2,
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except Exception:
            logger.exception("Failed to write query trace log %s", path)
        return path

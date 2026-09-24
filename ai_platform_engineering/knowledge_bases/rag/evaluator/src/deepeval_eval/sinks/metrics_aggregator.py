from __future__ import annotations

import math
from typing import Any


def discover_all_metrics(results: list[dict[str, Any]]) -> list[str]:
    """Dynamically discover all metric class names present across all result records."""
    metrics_set: set[str] = set()
    for r in results:
        for m_name in (r.get("metrics") or {}).keys():
            metrics_set.add(m_name)
    return sorted(metrics_set)


def compute_metric_averages(
    results: list[dict[str, Any]], metric_names: list[str]
) -> dict[str, float]:
    """Compute average score for each metric across records where the score is non-None."""
    averages: dict[str, float] = {}
    for m_name in metric_names:
        vals = [
            r.get("metrics", {}).get(m_name, {}).get("score")
            for r in results
            if r.get("metrics", {}).get(m_name, {}).get("score") is not None
        ]
        averages[m_name] = (sum(vals) / len(vals)) if vals else 0.0
    return averages


def compute_all_metric_averages(results: list[dict[str, Any]]) -> dict[str, float]:
    """Compute average scores for all evaluator and retrieval metrics."""
    from deepeval_eval.engine.metrics import get_metric_column_name

    discovered = discover_all_metrics(results)
    evaluator_averages = compute_metric_averages(results, discovered)

    all_averages = {
        get_metric_column_name(m_name): score
        for m_name, score in evaluator_averages.items()
    }

    n = len(results)
    all_averages["retrieval_recall"] = (
        sum(r.get("doc_id_recall") or 0.0 for r in results) / n if n else 0.0
    )
    all_averages["retrieval_precision"] = (
        sum(r.get("doc_id_precision") or 0.0 for r in results) / n if n else 0.0
    )

    return all_averages


def calculate_latency_percentiles(latencies: list[float]) -> tuple[float, float]:
    """Calculate P50 and P95 latency metrics from a list of latencies."""
    if not latencies:
        return 0.0, 0.0
    latencies_sorted = sorted(latencies)
    p50_latency = latencies_sorted[len(latencies_sorted) // 2]
    p95_index = max(
        0,
        min(
            len(latencies_sorted) - 1,
            int(math.ceil((len(latencies_sorted) * 95) / 100)) - 1,
        ),
    )
    p95_latency = latencies_sorted[p95_index]
    return p50_latency, p95_latency


def categorize_failure_causes(results: list[dict[str, Any]]) -> dict[str, int]:
    """Categorize failure causes for each result item and return aggregate counts."""
    failure_counts: dict[str, int] = {}
    for r in results:
        fc = "none"
        faith = r.get("metrics", {}).get("FaithfulnessMetric", {}).get("score")
        ctx_recall = r.get("metrics", {}).get("ContextualRecallMetric", {}).get("score")
        ans_rel = r.get("metrics", {}).get("AnswerRelevancyMetric", {}).get("score")
        if faith is not None and faith < 0.5:
            fc = "hallucination"
        elif ctx_recall is not None and ctx_recall < 0.5:
            fc = "poor_retrieval"
        elif ans_rel is not None and ans_rel < 0.5:
            fc = "incorrect_generation"
        r["failure_cause"] = fc
        failure_counts[fc] = failure_counts.get(fc, 0) + 1
    return failure_counts

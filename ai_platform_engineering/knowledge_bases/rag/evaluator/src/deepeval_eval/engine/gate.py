from __future__ import annotations

import argparse
import json
import logging
import os
import statistics
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from deepeval_eval.core.config import (
    DEFAULT_DATA_DIR,
    DEFAULT_RESULTS_DIR,
    PROJECT_ROOT,
)

logger = logging.getLogger(__name__)

METRIC_KEY_TO_CLASS = {
    "answer_relevancy": "AnswerRelevancyMetric",
    "faithfulness": "FaithfulnessMetric",
    "contextual_relevancy": "ContextualRelevancyMetric",
    "contextual_precision": "ContextualPrecisionMetric",
    "contextual_recall": "ContextualRecallMetric",
}


def resolve_metric_class_name(key: str) -> str:
    """Resolve a config metric key to its DeepEval metric class name."""
    if key in METRIC_KEY_TO_CLASS:
        return METRIC_KEY_TO_CLASS[key]
    # Fallback: convert snake_case to PascalCaseMetric (e.g., answer_correctness -> AnswerCorrectnessMetric)
    pascal = "".join(word.capitalize() for word in key.split("_"))
    return pascal if pascal.endswith("Metric") else f"{pascal}Metric"


DEFAULT_THRESHOLDS: dict[str, Any] = {
    "metrics": {
        "answer_relevancy": {"mean": 0.70, "pass_rate": 0.90, "severity": "soft"},
        "faithfulness": {"mean": 0.80, "pass_rate": 0.90, "severity": "soft"},
        "contextual_relevancy": {"mean": 0.60, "severity": "soft"},
        "contextual_precision": {"mean": 0.60, "severity": "soft"},
        "contextual_recall": {"mean": 0.60, "severity": "soft"},
    },
    "retrieval": {
        "doc_id_recall": {"mean": 0.60, "severity": "soft"},
        "doc_id_precision": {"mean": 0.50, "severity": "soft"},
    },
    "error_tolerance": 0.10,
}

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "gate_thresholds.yaml"


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def validate_safe_path(user_path: str | Path | None) -> Path | None:
    """Validate that specified file path resides strictly within approved sandbox directories."""
    if not user_path:
        return None
    path_obj = Path(user_path).expanduser().resolve()
    allowed_roots = [
        Path(tempfile.gettempdir()).resolve(),
        Path.cwd().resolve(),
        PROJECT_ROOT.resolve(),
        DEFAULT_DATA_DIR.resolve(),
        DEFAULT_RESULTS_DIR.resolve(),
        (DEFAULT_DATA_DIR.parent / "evals").resolve(),
    ]
    is_safe = any(
        path_obj == root or root in path_obj.parents for root in allowed_roots
    )
    if not is_safe:
        raise ValueError(
            f"Access to file path '{user_path}' is restricted: path is outside allowed sandbox directories."
        )
    return path_obj


def load_thresholds(path: Path) -> dict[str, Any]:
    """Load a gate config from disk. YAML if PyYAML is available, else JSON."""
    safe_path = validate_safe_path(path)
    if safe_path is None:
        raise ValueError("Invalid gate config file path.")
    text = safe_path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
    except ModuleNotFoundError:
        if path.suffix.lower() in (".yaml", ".yml"):
            raise RuntimeError(
                f"PyYAML is required to parse YAML configuration files ({path.name}). "
                "Please install PyYAML or provide a valid JSON configuration file."
            )
        logger.warning(
            "PyYAML not available; falling back to parsing gate thresholds as JSON."
        )
        data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(
            f"Gate config must be a mapping, got {type(data).__name__}: {path}"
        )
    return data


def resolve_gate_config(
    config_or_path: Path | str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve quality gate thresholds using in-source defaults with optional file or dict overrides.

    If a dictionary is provided, it is returned directly.
    If a Path or path string is provided and the file exists, it is loaded.
    If None (or a non-existent default file path) is provided, ``DEFAULT_THRESHOLDS`` is used.
    """
    if config_or_path is None:
        return DEFAULT_THRESHOLDS
    if isinstance(config_or_path, dict):
        return config_or_path

    path = Path(config_or_path)
    if path.is_file():
        return load_thresholds(path)

    is_default_path = (
        path.name == "gate_thresholds.yaml"
        or path.resolve() == DEFAULT_CONFIG_PATH.resolve()
    )
    if not is_default_path:
        raise FileNotFoundError(f"Gate config file not found: {path}")

    logger.info(
        f"Default gate config file not found at {path}; using in-source DEFAULT_THRESHOLDS."
    )
    return DEFAULT_THRESHOLDS


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


@dataclass
class MetricAggregate:
    key: str
    mean: float | None
    pass_rate: float | None
    error_rate: float
    n: int  # records where this metric was present
    n_scored: int  # records where it produced a numeric score


@dataclass
class RetrievalAggregate:
    key: str
    mean: float | None
    n: int


@dataclass
class Violation:
    scope: str  # 'metric' | 'retrieval' | 'infra'
    name: str
    criterion: str  # 'mean' | 'pass_rate' | 'max' | ...
    value: float | None
    threshold: float
    severity: str  # 'hard' | 'soft'


@dataclass
class GateReport:
    metric_aggs: dict[str, MetricAggregate | None] = field(default_factory=dict)
    retrieval_aggs: dict[str, RetrievalAggregate] = field(default_factory=dict)
    overall_error_rate: float = 0.0
    n_cases: int = 0
    violations: list[Violation] = field(default_factory=list)
    run_id: str | None = None
    timestamp: datetime | str | None = None

    @property
    def hard_violations(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == "hard"]

    @property
    def soft_violations(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == "soft"]

    @property
    def passed(self) -> bool:
        return not self.hard_violations


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def aggregate_metric(
    results: list[dict[str, Any]], class_name: str, key: str
) -> MetricAggregate | None:
    scores: list[float] = []
    successes = 0
    errors = 0
    present = 0
    for row in results:
        entry = (row.get("metrics") or {}).get(class_name)
        if entry is None:
            continue
        present += 1
        score = entry.get("score")
        if score is None:
            errors += 1
            continue
        scores.append(float(score))
        if entry.get("success"):
            successes += 1
    if present == 0:
        return None
    return MetricAggregate(
        key=key,
        mean=_mean(scores),
        pass_rate=(successes / len(scores)) if scores else None,
        error_rate=(errors / present) if present else 0.0,
        n=present,
        n_scored=len(scores),
    )


def aggregate_retrieval(results: list[dict[str, Any]], key: str) -> RetrievalAggregate:
    values = [float(row[key]) for row in results if row.get(key) is not None]
    return RetrievalAggregate(key=key, mean=_mean(values), n=len(values))


def _overall_error_rate(results: list[dict[str, Any]]) -> float:
    total = 0
    errored = 0
    for row in results:
        for entry in (row.get("metrics") or {}).values():
            total += 1
            if entry.get("score") is None:
                errored += 1
    return (errored / total) if total else 0.0


# ---------------------------------------------------------------------------
# Gate evaluation
# ---------------------------------------------------------------------------


def evaluate_gate(
    results: list[dict[str, Any]],
    config: dict[str, Any],
    run_id: str | None = None,
    timestamp: datetime | str | None = None,
) -> GateReport:
    report = GateReport(
        n_cases=len(results),
        run_id=run_id,
        timestamp=timestamp or datetime.now().astimezone(),
    )

    # No test cases at all is itself a hard failure: an empty run must never be mistaken for a passing run.
    if not results:
        report.violations.append(Violation("infra", "no_results", "min", 0, 1, "hard"))
        return report

    for key, thr in (config.get("metrics") or {}).items():
        class_name = resolve_metric_class_name(key)
        agg = aggregate_metric(results, class_name, key)
        report.metric_aggs[key] = agg
        if agg is None:
            continue  # metric absent from this run; nothing to judge
        severity = str(thr.get("severity", "hard"))
        if "mean" in thr:
            if agg.mean is None or agg.mean < thr["mean"]:
                report.violations.append(
                    Violation("metric", key, "mean", agg.mean, thr["mean"], severity)
                )
        if "pass_rate" in thr:
            if agg.pass_rate is None or agg.pass_rate < thr["pass_rate"]:
                report.violations.append(
                    Violation(
                        "metric",
                        key,
                        "pass_rate",
                        agg.pass_rate,
                        thr["pass_rate"],
                        severity,
                    )
                )

    for key, thr in (config.get("retrieval") or {}).items():
        agg = aggregate_retrieval(results, key)
        report.retrieval_aggs[key] = agg
        severity = str(thr.get("severity", "hard"))
        if "mean" in thr:
            if agg.mean is None or agg.mean < thr["mean"]:
                report.violations.append(
                    Violation("retrieval", key, "mean", agg.mean, thr["mean"], severity)
                )

    report.overall_error_rate = _overall_error_rate(results)
    tolerance = config.get("error_tolerance")
    if tolerance is not None and report.overall_error_rate > tolerance:
        report.violations.append(
            Violation(
                "infra",
                "error_rate",
                "max",
                report.overall_error_rate,
                float(tolerance),
                "hard",
            )
        )

    return report


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _fmt(value: float | None) -> str:
    return f"{value:.3f}" if isinstance(value, (int, float)) else "–"


def render_markdown(report: GateReport) -> str:
    status = "✅ PASSED" if report.passed else "❌ FAILED"
    lines = [f"## DeepEval Quality Gate — {status}", ""]

    metadata_parts: list[str] = []
    if report.run_id:
        metadata_parts.append(f"**Run ID:** `{report.run_id}`")
    if report.timestamp:
        if isinstance(report.timestamp, datetime):
            ts_str = report.timestamp.strftime("%Y-%m-%d %H:%M:%S")
        else:
            ts_str = str(report.timestamp)
        metadata_parts.append(f"**Date/Time:** `{ts_str}`")

    if metadata_parts:
        lines.append(" · ".join(metadata_parts))
        lines.append("")

    lines.append(
        f"Evaluated **{report.n_cases}** test cases · "
        f"metric error rate **{report.overall_error_rate:.1%}**"
    )
    lines.append("")

    violated = {(v.scope, v.name, v.criterion): v for v in report.violations}

    lines.append("| Metric | Mean | Pass rate | Errors | Result |")
    lines.append("|---|---|---|---|---|")
    for key, agg in report.metric_aggs.items():
        if agg is None:
            lines.append(f"| {key} | – | – | – | ⏭️ absent |")
            continue
        result = _row_result(key, "metric", ("mean", "pass_rate"), violated)
        lines.append(
            f"| {key} | {_fmt(agg.mean)} | {_fmt(agg.pass_rate)} | "
            f"{agg.error_rate:.0%} | {result} |"
        )
    for key, agg in report.retrieval_aggs.items():
        result = _row_result(key, "retrieval", ("mean",), violated)
        lines.append(f"| {key} | {_fmt(agg.mean)} | – | – | {result} |")

    if report.violations:
        lines.append("")
        lines.append("### Threshold violations")
        for v in report.violations:
            emoji = "❌" if v.severity == "hard" else "⚠️"
            op = ">" if v.criterion == "max" else "<"
            lines.append(
                f"- {emoji} **{v.name}** {v.criterion} = {_fmt(v.value)} "
                f"{op} {_fmt(v.threshold)} ({v.severity})"
            )

    hard = len(report.hard_violations)
    soft = len(report.soft_violations)
    lines.append("")
    if report.passed:
        lines.append(
            f"No hard violations{f' ({soft} soft warning(s))' if soft else ''} → gate passed."
        )
    else:
        lines.append(f"{hard} hard violation(s) → **build failed**.")
    return "\n".join(lines) + "\n"


def _row_result(
    name: str, scope: str, criteria: tuple[str, ...], violated: dict
) -> str:
    hits = [
        violated[(scope, name, c)] for c in criteria if (scope, name, c) in violated
    ]
    if not hits:
        return "✅"
    if any(v.severity == "hard" for v in hits):
        return "❌ hard"
    return "⚠️ soft"


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def run_gate_on_results(
    results: list[dict[str, Any]],
    config_path: Path | str | dict[str, Any] | None = None,
    summary_dir: Path | None = None,
    run_id: str | None = None,
    timestamp: datetime | str | None = None,
) -> bool:
    """Evaluate the gate on in-memory results. Returns True if it passed.

    Prints the summary, and also writes ``eval_gate_result_summary_<timestamp>.md``
    and ``eval_gate_result_summary_latest.md`` (into ``summary_dir`` if given,
    else the current directory) so CI can surface it. When running under GitHub
    Actions, appends the summary to the job summary too.
    """
    now = timestamp if isinstance(timestamp, datetime) else datetime.now().astimezone()
    config = resolve_gate_config(config_path)
    report = evaluate_gate(results, config, run_id=run_id, timestamp=now)
    summary = render_markdown(report)
    print(summary)

    out_dir = summary_dir or Path.cwd()
    ts_file_str = now.strftime("%Y%m%d_%H%M%S")
    dated_path = out_dir / f"eval_gate_result_summary_{ts_file_str}.md"
    latest_path = out_dir / "eval_gate_result_summary_latest.md"

    for summary_path in (dated_path, latest_path):
        try:
            summary_path.write_text(summary, encoding="utf-8")
        except OSError as err:
            logger.warning(f"Could not write gate summary to {summary_path}: {err}")

    gh_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if gh_summary:
        try:
            with open(gh_summary, "a", encoding="utf-8") as handle:
                handle.write(summary)
        except OSError as err:
            logger.warning(f"Could not write to GITHUB_STEP_SUMMARY: {err}")

    return report.passed


def _load_results_file(path: Path) -> list[dict[str, Any]]:
    safe_path = validate_safe_path(path)
    if safe_path is None:
        raise ValueError("Invalid results file path.")
    data = json.loads(safe_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Results file must contain a JSON array: {path}")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Apply a DeepEval quality gate to a results file."
    )
    parser.add_argument(
        "--results", type=Path, required=True, help="Path to a results JSON file."
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Gate threshold config file (YAML/JSON). If omitted or file not found, uses in-source defaults.",
    )
    parser.add_argument(
        "--summary-dir", type=Path, default=None, help="Where to write gate_summary.md."
    )
    parser.add_argument(
        "--run-id",
        type=str,
        default=None,
        help="Optional evaluation Run ID to include in report.",
    )
    args = parser.parse_args(argv)

    results = _load_results_file(args.results)
    passed = run_gate_on_results(
        results,
        args.config,
        args.summary_dir,
        run_id=args.run_id,
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

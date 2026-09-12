from pathlib import Path

import pytest

from deepeval_eval.engine.gate import (
    evaluate_gate,
    load_thresholds,
    render_markdown,
    resolve_metric_class_name,
)


def _metric(score, success=None):
    if score is None:
        return {"score": None, "success": False, "reason": "metric failed: boom"}
    if success is None:
        success = score >= 0.5
    return {"score": score, "success": success, "reason": "ok"}


def _record(ar=0.9, fa=0.9, cr=0.8, cp=0.75, cre=0.7, dr=0.8, dp=0.6):
    return {
        "question_id": "q",
        "doc_id_recall": dr,
        "doc_id_precision": dp,
        "metrics": {
            "AnswerRelevancyMetric": _metric(ar),
            "FaithfulnessMetric": _metric(fa),
            "ContextualRelevancyMetric": _metric(cr),
            "ContextualPrecisionMetric": _metric(cp),
            "ContextualRecallMetric": _metric(cre),
        },
    }


HARD_CONFIG = {
    "metrics": {
        "answer_relevancy": {"mean": 0.70, "severity": "hard"},
        "faithfulness": {"mean": 0.80, "pass_rate": 0.90, "severity": "hard"},
    },
    "retrieval": {"doc_id_recall": {"mean": 0.60, "severity": "hard"}},
    "error_tolerance": 0.10,
}


def test_passes_when_all_above_threshold():
    report = evaluate_gate([_record() for _ in range(5)], HARD_CONFIG)
    assert report.passed
    assert report.hard_violations == []


def test_hard_mean_violation_fails():
    report = evaluate_gate([_record(fa=0.4) for _ in range(5)], HARD_CONFIG)
    assert not report.passed
    names = {v.name for v in report.hard_violations}
    assert "faithfulness" in names


def test_soft_violation_does_not_fail():
    config = {"metrics": {"faithfulness": {"mean": 0.80, "severity": "soft"}}}
    report = evaluate_gate([_record(fa=0.4) for _ in range(3)], config)
    assert report.passed
    assert len(report.soft_violations) == 1


def test_error_rate_over_tolerance_fails():
    # Faithfulness errors on every record → 20% overall error rate > 10% tolerance.
    report = evaluate_gate([_record(fa=None) for _ in range(5)], HARD_CONFIG)
    assert not report.passed
    assert any(v.name == "error_rate" for v in report.hard_violations)


def test_empty_results_is_hard_failure():
    report = evaluate_gate([], HARD_CONFIG)
    assert not report.passed
    assert any(v.name == "no_results" for v in report.hard_violations)


def test_absent_metric_is_skipped_not_failed():
    # Config references a metric that never appears in the records.
    records = [{"metrics": {}, "doc_id_recall": 0.9} for _ in range(3)]
    config = {"metrics": {"answer_relevancy": {"mean": 0.7, "severity": "hard"}}}
    report = evaluate_gate(records, config)
    assert report.passed
    assert report.metric_aggs["answer_relevancy"] is None


def test_render_markdown_reflects_status():
    passed = render_markdown(evaluate_gate([_record() for _ in range(3)], HARD_CONFIG))
    assert "PASSED" in passed
    failed = render_markdown(
        evaluate_gate([_record(fa=0.3) for _ in range(3)], HARD_CONFIG)
    )
    assert "FAILED" in failed


def test_render_markdown_includes_run_id_and_timestamp():
    from datetime import UTC, datetime

    ts = datetime(2026, 8, 19, 12, 30, 45, tzinfo=UTC)
    report = evaluate_gate(
        [_record() for _ in range(3)],
        HARD_CONFIG,
        run_id="run-exp-12345",
        timestamp=ts,
    )
    markdown = render_markdown(report)
    assert "run-exp-12345" in markdown
    assert "2026-08-19 12:30:45" in markdown


def test_resolve_metric_class_name():
    assert resolve_metric_class_name("answer_relevancy") == "AnswerRelevancyMetric"
    assert resolve_metric_class_name("answer_correctness") == "AnswerCorrectnessMetric"
    assert resolve_metric_class_name("custom_eval") == "CustomEvalMetric"


def test_load_thresholds_json_and_validation(tmp_path):
    import json

    import pytest

    from deepeval_eval.engine.gate import load_thresholds

    json_file = tmp_path / "thresholds.json"
    json_file.write_text(json.dumps({"error_tolerance": 0.05}), encoding="utf-8")
    data = load_thresholds(json_file)
    assert data["error_tolerance"] == 0.05

    bad_file = tmp_path / "invalid.json"
    bad_file.write_text("12345", encoding="utf-8")
    with pytest.raises(ValueError, match="Gate config must be a mapping"):
        load_thresholds(bad_file)


def test_load_thresholds_missing_pyyaml_yaml_file_raises_runtime_error(
    tmp_path, monkeypatch
):
    import sys

    # Simulate PyYAML not being installed
    monkeypatch.setitem(sys.modules, "yaml", None)

    yaml_file = tmp_path / "thresholds.yaml"
    yaml_file.write_text("error_tolerance: 0.1\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="PyYAML is required to parse YAML"):
        load_thresholds(yaml_file)


def test_load_thresholds_missing_pyyaml_json_file_parses_json(tmp_path, monkeypatch):
    import sys

    # Simulate PyYAML not being installed
    monkeypatch.setitem(sys.modules, "yaml", None)

    json_file = tmp_path / "thresholds.json"
    json_file.write_text('{"error_tolerance": 0.15}', encoding="utf-8")

    data = load_thresholds(json_file)
    assert data["error_tolerance"] == 0.15


def test_resolve_gate_config_default_filename_missing_returns_default_thresholds():
    from deepeval_eval.engine.gate import DEFAULT_THRESHOLDS, resolve_gate_config

    # Relative default filename when file does not exist
    assert resolve_gate_config("gate_thresholds.yaml") == DEFAULT_THRESHOLDS


def test_resolve_gate_config(tmp_path):
    from deepeval_eval.engine.gate import DEFAULT_THRESHOLDS, resolve_gate_config

    # None -> returns in-source default
    assert resolve_gate_config(None) == DEFAULT_THRESHOLDS

    # dict -> returns dict directly
    custom_dict = {"error_tolerance": 0.05}
    assert resolve_gate_config(custom_dict) == custom_dict

    # Existing file -> loads file
    json_file = tmp_path / "custom.json"
    json_file.write_text('{"error_tolerance": 0.02}', encoding="utf-8")
    assert resolve_gate_config(json_file)["error_tolerance"] == 0.02

    # Non-existent non-default path -> raises FileNotFoundError
    with pytest.raises(FileNotFoundError):
        resolve_gate_config(tmp_path / "non_existent.yaml")


def test_run_gate_on_results_without_config_file(tmp_path):
    from deepeval_eval.engine.gate import run_gate_on_results

    results = [_record() for _ in range(2)]
    summary_dir = tmp_path / "summary"
    summary_dir.mkdir()

    passed = run_gate_on_results(
        results,
        config_path=None,
        summary_dir=summary_dir,
        run_id="test-run-123",
    )
    assert passed
    assert (summary_dir / "eval_gate_result_summary_latest.md").exists()
    content = (summary_dir / "eval_gate_result_summary_latest.md").read_text(
        encoding="utf-8"
    )
    assert "test-run-123" in content
    assert len(list(summary_dir.glob("eval_gate_result_summary_*.md"))) >= 2


def test_run_gate_on_results_and_main(tmp_path, monkeypatch):
    import json

    from deepeval_eval.engine.gate import main, run_gate_on_results

    config_path = tmp_path / "config.yaml"
    config_path.write_text("error_tolerance: 0.1\n", encoding="utf-8")

    results = [_record() for _ in range(2)]
    summary_dir = tmp_path / "summary"
    summary_dir.mkdir()

    gh_step = tmp_path / "github_step_summary.txt"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(gh_step))

    passed = run_gate_on_results(results, config_path, summary_dir)
    assert passed
    assert (summary_dir / "eval_gate_result_summary_latest.md").exists()
    assert gh_step.exists()

    results_file = tmp_path / "results.json"
    results_file.write_text(json.dumps(results), encoding="utf-8")

    exit_code = main(
        [
            "--results",
            str(results_file),
            "--config",
            str(config_path),
            "--summary-dir",
            str(summary_dir),
            "--run-id",
            "cli-run-999",
        ]
    )
    assert exit_code == 0
    # Also test main with no --config flag provided
    exit_code_default = main(
        ["--results", str(results_file), "--summary-dir", str(summary_dir)]
    )
    assert exit_code_default == 0


def test_validate_safe_path_valid_paths_resolved(tmp_path):
    from deepeval_eval.engine.gate import validate_safe_path

    # Path inside tmp_path / temp dir
    temp_file = tmp_path / "valid_test.json"
    assert validate_safe_path(temp_file) == temp_file.resolve()

    # None returns None
    assert validate_safe_path(None) is None


def test_validate_safe_path_unauthorized_path_raises_value_error():
    from deepeval_eval.engine.gate import validate_safe_path

    with pytest.raises(ValueError, match="Access to file path .* is restricted"):
        validate_safe_path("/etc/passwd")

    with pytest.raises(ValueError, match="Access to file path .* is restricted"):
        validate_safe_path("/var/log/system.log")


def test_load_thresholds_unauthorized_path_raises_value_error():
    from deepeval_eval.engine.gate import load_thresholds

    with pytest.raises(ValueError, match="Access to file path .* is restricted"):
        load_thresholds(Path("/etc/shadow"))


def test_load_results_file_unauthorized_path_raises_value_error():
    from deepeval_eval.engine.gate import _load_results_file

    with pytest.raises(ValueError, match="Access to file path .* is restricted"):
        _load_results_file(Path("/etc/hosts"))


def test_load_results_file_invalid_json_type_raises_value_error(tmp_path: Path) -> None:
    from deepeval_eval.engine.gate import _load_results_file

    file_p = tmp_path / "results_dict.json"
    file_p.write_text('{"key": "not a list"}', encoding="utf-8")
    with pytest.raises(ValueError, match="Results file must contain a JSON array"):
        _load_results_file(file_p)


def test_render_markdown_with_absent_metrics_and_violations() -> None:
    from deepeval_eval.engine.gate import (
        GateReport,
        RetrievalAggregate,
        Violation,
        render_markdown,
    )

    report = GateReport(
        n_cases=1,
        overall_error_rate=0.0,
        metric_aggs={"answer_relevancy": None},
        retrieval_aggs={
            "doc_id_recall": RetrievalAggregate(key="doc_id_recall", mean=0.4, n=1)
        },
        violations=[
            Violation(
                scope="retrieval",
                name="doc_id_recall",
                criterion="mean",
                value=0.4,
                threshold=0.6,
                severity="soft",
            )
        ],
        timestamp="2026-08-21 12:00:00",
    )
    md = render_markdown(report)
    assert "absent" in md
    assert "doc_id_recall" in md
    assert "soft warning" in md


def test_run_gate_on_results_file_write_error_handling(
    tmp_path: Path, monkeypatch
) -> None:
    from deepeval_eval.engine.gate import run_gate_on_results

    # Summary dir points to an un-writable path to trigger OSError catch
    unwritable = tmp_path / "non_existent_subdir" / "cannot_write"
    results = [_record() for _ in range(1)]

    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(unwritable))
    # Should not raise exception even if write fails
    passed = run_gate_on_results(results, config_path=None, summary_dir=unwritable)
    assert isinstance(passed, bool)

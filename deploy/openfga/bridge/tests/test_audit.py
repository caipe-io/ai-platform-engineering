"""Unit tests for the OpenFGA bridge's allow-decision rollup aggregation."""

import importlib.util
from pathlib import Path


def _load_audit_module():
    module_path = Path(__file__).resolve().parents[1] / "audit.py"
    spec = importlib.util.spec_from_file_location("openfga_bridge_audit_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _decision(module, **overrides):
    kwargs = {
        "subject": "user-1",
        "outcome": "allow",
        "reason_code": "OK",
        "correlation_id": "req-1",
        "action": "mcp#can_call",
        "component": "agent_gateway",
        "resource_ref": "user:user-1 can_call mcp_gateway:list",
        "pdp": "openfga",
        "source": "openfga_authz_bridge",
        "subject_ref": "user:user-1",
    }
    kwargs.update(overrides)
    return module.log_authz_decision(**kwargs)


def test_allow_decisions_are_not_posted_immediately(monkeypatch):
    module = _load_audit_module()
    posted = []
    monkeypatch.setattr(module, "_post_to_audit_service", lambda event: posted.append(event))

    _decision(module)

    assert posted == []


def test_deny_decisions_are_still_posted_immediately(monkeypatch):
    module = _load_audit_module()
    posted = []
    monkeypatch.setattr(module, "_post_to_audit_service", lambda event: posted.append(event))

    _decision(module, outcome="deny", reason_code="DENY_NO_CAPABILITY")

    assert len(posted) == 1
    assert posted[0]["outcome"] == "deny"
    assert posted[0]["reason_code"] == "DENY_NO_CAPABILITY"


def test_repeated_allows_collapse_into_one_rollup_row_on_flush(monkeypatch):
    module = _load_audit_module()
    posted = []
    monkeypatch.setattr(module, "_post_to_audit_service", lambda event: posted.append(event))

    for _ in range(5):
        _decision(module, correlation_id="per-request-id-is-not-the-rollup-key")

    assert posted == [], "allows must not be posted before a flush"
    module.flush_allow_rollups()

    assert len(posted) == 1
    assert posted[0]["outcome"] == "allow"
    assert posted[0]["reason_code"] == "OK"
    assert posted[0]["count"] == 5
    assert posted[0]["subject_ref"] == "user:user-1"
    # The rollup summarizes many requests; it must not masquerade as one.
    assert posted[0]["correlation_id"].startswith("rollup:")


def test_distinct_subjects_produce_distinct_rollup_rows(monkeypatch):
    module = _load_audit_module()
    posted = []
    monkeypatch.setattr(module, "_post_to_audit_service", lambda event: posted.append(event))

    _decision(module, subject="user-1", subject_ref="user:user-1")
    _decision(module, subject="user-2", subject_ref="user:user-2")
    module.flush_allow_rollups()

    assert len(posted) == 2
    counts_by_subject_ref = {event["subject_ref"]: event["count"] for event in posted}
    assert counts_by_subject_ref == {"user:user-1": 1, "user:user-2": 1}


def test_flush_clears_state_so_next_flush_only_reports_new_activity(monkeypatch):
    module = _load_audit_module()
    posted = []
    monkeypatch.setattr(module, "_post_to_audit_service", lambda event: posted.append(event))

    _decision(module)
    module.flush_allow_rollups()
    _decision(module)
    module.flush_allow_rollups()

    assert [event["count"] for event in posted] == [1, 1]


def test_start_allow_rollup_flusher_is_idempotent(monkeypatch):
    module = _load_audit_module()
    calls = []
    monkeypatch.setattr(module, "_schedule_next_flush", lambda: calls.append(1))

    module.start_allow_rollup_flusher()
    module.start_allow_rollup_flusher()

    assert calls == [1]


def test_start_allow_rollup_flusher_noop_when_full_fidelity(monkeypatch):
    module = _load_audit_module()
    monkeypatch.setattr(module, "FULL_FIDELITY_ALLOWS", True)
    calls = []
    monkeypatch.setattr(module, "_schedule_next_flush", lambda: calls.append(1))

    module.start_allow_rollup_flusher()

    assert calls == []


def test_full_fidelity_env_var_disables_aggregation(monkeypatch):
    module = _load_audit_module()
    monkeypatch.setattr(module, "FULL_FIDELITY_ALLOWS", True)
    posted = []
    monkeypatch.setattr(module, "_post_to_audit_service", lambda event: posted.append(event))

    _decision(module)
    _decision(module)

    assert len(posted) == 2
    assert all(event["outcome"] == "allow" for event in posted)
    module.flush_allow_rollups()
    assert len(posted) == 2, "nothing should have been pending to flush"

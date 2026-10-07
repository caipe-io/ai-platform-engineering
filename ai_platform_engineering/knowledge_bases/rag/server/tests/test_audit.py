"""Tests for the RAG server's allow-rollup audit aggregation.

One user question can fan out into several RAG tool calls (search, then a
handful of get_full_doc calls), each its own allowed OpenFGA decision.
record_allow buffers these per subject; flush_allow_rollups must emit one
event per subject listing every distinct resource touched, not one row per
decision.
"""

from __future__ import annotations

from server import audit


def teardown_function() -> None:
    # Module-level rollup state persists across tests in this file.
    audit._rollup_by_subject.clear()


def test_repeated_identical_allows_collapse_with_a_count(monkeypatch) -> None:
    posted: list[dict] = []
    monkeypatch.setattr(audit, "_post_to_audit_service", lambda event: posted.append(event))

    for _ in range(3):
        audit.record_allow(
            subject="alice-sub",
            subject_ref="user:alice-sub",
            relation="can_read",
            object_type="data_source",
            object_id="primary",
        )
    audit.flush_allow_rollups()

    assert len(posted) == 1
    event = posted[0]
    assert event["outcome"] == "allow"
    assert event["count"] == 3
    assert event["resources"] == [
        {"action": "data_source#can_read", "resource_ref": "data_source:primary", "count": 3}
    ]


def test_one_question_fanning_into_several_resources_is_one_event(monkeypatch) -> None:
    posted: list[dict] = []
    monkeypatch.setattr(audit, "_post_to_audit_service", lambda event: posted.append(event))

    # "what is SCS?" -> search, then get_full_doc on each of three hits.
    audit.record_allow(
        subject="alice-sub", subject_ref="user:alice-sub",
        relation="can_search", object_type="organization", object_id="caipe",
    )
    for doc_id in ("doc-a", "doc-b", "doc-c"):
        audit.record_allow(
            subject="alice-sub", subject_ref="user:alice-sub",
            relation="can_read", object_type="data_source", object_id=doc_id,
        )
    audit.flush_allow_rollups()

    assert len(posted) == 1
    event = posted[0]
    assert event["subject_ref"] == "user:alice-sub"
    assert event["count"] == 4
    resource_refs = {r["resource_ref"] for r in event["resources"]}
    assert resource_refs == {
        "organization:caipe",
        "data_source:doc-a",
        "data_source:doc-b",
        "data_source:doc-c",
    }
    # Listed, not scattered across separate rows — a reviewer sees one event.
    assert "data_source:doc-a" in event["resource_ref"]
    assert "data_source:doc-b" in event["resource_ref"]


def test_distinct_subjects_produce_distinct_rollup_rows(monkeypatch) -> None:
    posted: list[dict] = []
    monkeypatch.setattr(audit, "_post_to_audit_service", lambda event: posted.append(event))

    audit.record_allow(
        subject="alice-sub", subject_ref="user:alice-sub",
        relation="can_read", object_type="data_source", object_id="primary",
    )
    audit.record_allow(
        subject="bob-sub", subject_ref="user:bob-sub",
        relation="can_read", object_type="data_source", object_id="primary",
    )
    audit.flush_allow_rollups()

    assert len(posted) == 2
    subject_refs = {event["subject_ref"] for event in posted}
    assert subject_refs == {"user:alice-sub", "user:bob-sub"}


def test_flush_clears_state_so_a_second_flush_reports_only_new_activity(monkeypatch) -> None:
    posted: list[dict] = []
    monkeypatch.setattr(audit, "_post_to_audit_service", lambda event: posted.append(event))

    audit.record_allow(
        subject="alice-sub", subject_ref="user:alice-sub",
        relation="can_read", object_type="data_source", object_id="primary",
    )
    audit.flush_allow_rollups()
    audit.flush_allow_rollups()

    assert len(posted) == 1


def test_correlation_id_marks_the_row_as_a_rollup_not_one_request(monkeypatch) -> None:
    posted: list[dict] = []
    monkeypatch.setattr(audit, "_post_to_audit_service", lambda event: posted.append(event))

    audit.record_allow(
        subject="alice-sub", subject_ref="user:alice-sub",
        relation="can_read", object_type="data_source", object_id="primary",
    )
    audit.flush_allow_rollups()

    assert posted[0]["correlation_id"].startswith("rollup:")

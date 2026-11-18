"""Contracts for a private-data-safe archive-read benchmark."""

from __future__ import annotations

import io
import json
from urllib.error import HTTPError, URLError

import pytest

from ai_platform_engineering.audit_service import benchmark_reads as probe


class Response(io.BytesIO):
    status = 200


@pytest.mark.parametrize("url", ["file:///tmp/audit", "https://user:secret@example.test", "https://example.test/path", "https://example.test?token=secret"])
def test_rejects_non_service_origins(url: str) -> None:
    with pytest.raises(ValueError):
        probe.benchmark_read(url, hours=1)


def test_emits_only_counts_not_events_or_origins(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def open_response(url: str, *, timeout: float) -> Response:
        calls.append(url)
        assert timeout == 35
        return Response(json.dumps({"records": [{"subject_ref": "private-subject", "token": "private-token"}], "total": 1, "truncated": False}).encode())

    monkeypatch.setattr(probe, "urlopen", open_response)
    result = probe.benchmark_read("http://example.test", hours=24)
    assert result["within_dashboard_budget"] is True
    assert result["records"] == result["total"] == 1
    assert "private" not in json.dumps(result)
    assert "example.test" not in json.dumps(result)
    assert "reason_code=OK_LOCAL_AGENT_CONTEXT" in calls[0]
    assert "limit=10000" in calls[0]


@pytest.mark.parametrize("payload", [{"records": [], "total": 20, "truncated": True}, {"records": [], "total": 1}, {"records": []}, {"error": "private diagnostic"}])
def test_does_not_certify_partial_or_invalid_counts(monkeypatch: pytest.MonkeyPatch, payload: dict) -> None:
    monkeypatch.setattr(probe, "urlopen", lambda *args, **kwargs: Response(json.dumps(payload).encode()))
    assert probe.benchmark_read("http://example.test", hours=1)["within_dashboard_budget"] is False


@pytest.mark.parametrize("error", [TimeoutError(), URLError(TimeoutError()), HTTPError("http://example.test", 504, "private diagnostic", {}, io.BytesIO(b"private body"))])
def test_failed_reads_have_no_success_credit_or_private_diagnostics(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    def fail(*args: object, **kwargs: object) -> Response:
        raise error

    monkeypatch.setattr(probe, "urlopen", fail)
    result = probe.benchmark_read("http://example.test", hours=24)
    assert result["within_dashboard_budget"] is False
    assert "private" not in json.dumps(result)


def test_slow_complete_read_exceeds_dashboard_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = iter([0.0, 5.001])
    monkeypatch.setattr(probe.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(probe, "urlopen", lambda *args, **kwargs: Response(b'{"records": [], "total": 0}'))
    assert probe.benchmark_read("http://example.test", hours=1)["within_dashboard_budget"] is False

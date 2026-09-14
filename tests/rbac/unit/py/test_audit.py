"""Spec 102 T027 — unit tests for `audit.log_authz_decision`.

Covers:
  - successful audit-service write           → event batch posted
  - audit-service write failure              → does NOT raise (FR-007)
  - invalid `reason`                         → silently dropped (defensive)
  - decision document validates against the JSON schema in
    `tests/rbac/contracts/audit-event.schema.json`
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from ai_platform_engineering.utils.auth import audit


_REPO_ROOT = Path(__file__).resolve().parents[4]
_SCHEMA_PATH = (
    _REPO_ROOT
    / "tests/rbac/contracts/audit-event.schema.json"
)


def _call_log(**overrides: Any) -> None:
    kwargs: dict[str, Any] = {
        "user_id": "alice-sub",
        "resource": "admin_ui",
        "scope": "view",
        "allowed": True,
        "reason": "OK",
        "service": "ui",
        "user_email": "alice@example.com",
        "route": "GET /api/admin/users",
        "request_id": "req-123",
        "pdp": "keycloak",
    }
    kwargs.update(overrides)
    audit.log_authz_decision(**kwargs)


def test_successful_write_posts_service_event(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIT_LOG_BACKEND", "service")
    monkeypatch.setenv("AUDIT_SERVICE_URL", "http://audit-service:8010")
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client

    with patch("httpx.Client", return_value=mock_client):
        _call_log()

    mock_client.post.assert_called_once()
    url, = mock_client.post.call_args.args
    payload = mock_client.post.call_args.kwargs["json"]
    captured = payload["events"][0]

    assert url == "http://audit-service:8010/v1/audit/events"
    assert captured["userId"] == "alice-sub"
    assert captured["userEmail"] == "alice@example.com"
    assert captured["resource"] == "admin_ui"
    assert captured["scope"] == "view"
    assert captured["allowed"] is True
    assert captured["reason"] == "OK"
    assert captured["source"] == "ui"
    assert captured["service"] == "ui"
    assert captured["route"] == "GET /api/admin/users"
    assert captured["requestId"] == "req-123"
    assert captured["pdp"] == "keycloak"
    assert captured["type"] == "auth"
    assert captured["tenant_id"] == "default"
    assert captured["subject_hash"].startswith("sha256:")
    assert captured["action"] == "admin_ui#view"
    assert captured["outcome"] == "allow"
    assert captured["correlation_id"] == "req-123"
    assert "ts" in captured
    mock_client.post.return_value.raise_for_status.assert_called_once()


def test_service_failure_does_not_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIT_LOG_BACKEND", "service")
    monkeypatch.setenv("AUDIT_SERVICE_URL", "http://audit-service:8010")
    mock_client = MagicMock()
    mock_client.__enter__.return_value = mock_client
    mock_client.post.side_effect = RuntimeError("audit-service down")

    with patch("httpx.Client", return_value=mock_client):
        _call_log(
            user_id="bob-sub",
            resource="rag",
            scope="retrieve",
            allowed=False,
            reason="DENY_NO_CAPABILITY",
            service="rag_server",
            user_email=None,
            route=None,
            request_id=None,
            pdp=None,
        )


def test_invalid_reason_is_silently_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIT_SERVICE_URL", "http://audit-service:8010")

    with patch("httpx.Client") as mock_client_cls:
        _call_log(reason="GIBBERISH")

    mock_client_cls.assert_not_called()


def test_document_validates_against_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sanity check that the legacy-compatible payload still matches the contract schema."""
    pytest.importorskip("jsonschema")
    import json
    import jsonschema  # type: ignore[import-untyped]

    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    monkeypatch.setenv("AUDIT_SERVICE_URL", "http://audit-service:8010")

    captured: dict[str, Any] = {}

    with patch.object(audit, "_write_service_event", side_effect=lambda doc: captured.update(doc)):
        _call_log()

    if isinstance(captured.get("ts"), datetime):
        captured["ts"] = captured["ts"].isoformat().replace("+00:00", "Z")

    jsonschema.validate(instance=captured, schema=schema)

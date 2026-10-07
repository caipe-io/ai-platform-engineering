# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for the Python audit-service backend."""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from unittest import mock

import pytest


def _make_event(**overrides):
    base = {
        "ts": datetime(2026, 6, 18, 12, 0, 0, tzinfo=timezone.utc).isoformat(),
        "type": "auth",
        "tenant_id": "default",
        "subject_hash": "sha256:abc",
        "action": "admin_ui#view",
        "outcome": "allow",
        "correlation_id": "corr-001",
        "source": "webui_backend",
    }
    base.update(overrides)
    return base


class TestServiceBackend:
    def test_flushes_to_audit_service_on_batch_size(self):
        from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

        with mock.patch("httpx.Client") as mock_client_cls:
            mock_client = mock.MagicMock()
            mock_client.__enter__.return_value = mock_client
            mock_client_cls.return_value = mock_client

            backend = ServiceBackend(
                service_url="http://audit-service:8010/",
                flush_interval=9999,
                flush_batch_size=2,
            )
            backend.write(_make_event())
            mock_client.post.assert_not_called()

            backend.write(_make_event(action="admin_ui#export"))

            mock_client.post.assert_called_once_with(
                "http://audit-service:8010/v1/audit/events",
                json={"events": [mock.ANY, mock.ANY]},
            )
            mock_client.post.return_value.raise_for_status.assert_called_once()

    def test_service_error_is_caught_and_does_not_raise(self):
        from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

        with mock.patch("httpx.Client") as mock_client_cls:
            mock_client = mock.MagicMock()
            mock_client.__enter__.return_value = mock_client
            mock_client.post.side_effect = RuntimeError("network down")
            mock_client_cls.return_value = mock_client

            backend = ServiceBackend("http://audit-service:8010", flush_interval=9999, flush_batch_size=1)
            backend.write(_make_event())


class TestAuditBackendFactory:
    @pytest.fixture(autouse=True)
    def reset_singleton(self, monkeypatch):
        from ai_platform_engineering.utils import audit_backend as module

        monkeypatch.setattr(module, "_backend", None)
        yield
        monkeypatch.setattr(module, "_backend", None)

    def test_default_backend_is_service(self, monkeypatch):
        from ai_platform_engineering.utils.audit_backend import _create_backend
        from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

        monkeypatch.delenv("AUDIT_LOG_BACKEND", raising=False)
        monkeypatch.delenv("AUDIT_SERVICE_URL", raising=False)
        with mock.patch.object(ServiceBackend, "_schedule_flush"):
            backend = _create_backend()

        assert isinstance(backend, ServiceBackend)
        assert backend._service_url == "http://audit-service:8010"

    def test_service_backend_uses_custom_runtime_settings(self, monkeypatch):
        from ai_platform_engineering.utils.audit_backend import _create_backend
        from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

        monkeypatch.setenv("AUDIT_LOG_BACKEND", "service")
        monkeypatch.setenv("AUDIT_SERVICE_URL", "http://audit:9000")
        monkeypatch.setenv("AUDIT_SERVICE_FLUSH_INTERVAL_SECONDS", "0.25")
        monkeypatch.setenv("AUDIT_SERVICE_FLUSH_BATCH_SIZE", "25")

        with mock.patch.object(ServiceBackend, "_schedule_flush"):
            backend = _create_backend()

        assert isinstance(backend, ServiceBackend)
        assert backend._service_url == "http://audit:9000"
        assert backend._flush_interval == 0.25
        assert backend._flush_batch_size == 25

    def test_storage_backends_become_noop(self, monkeypatch):
        from ai_platform_engineering.utils.audit_backend import NoopAuditBackend, _create_backend

        monkeypatch.setenv("AUDIT_LOG_BACKEND", "s3")

        backend = _create_backend()

        assert isinstance(backend, NoopAuditBackend)
        backend.write(_make_event())

    def test_off_backend_becomes_noop(self, monkeypatch):
        from ai_platform_engineering.utils.audit_backend import NoopAuditBackend, _create_backend

        monkeypatch.setenv("AUDIT_LOG_BACKEND", "off")

        backend = _create_backend()

        assert isinstance(backend, NoopAuditBackend)
        backend.write(_make_event())

    def test_get_audit_backend_singleton(self, monkeypatch):
        from ai_platform_engineering.utils.audit_backend import get_audit_backend
        from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

        monkeypatch.delenv("AUDIT_LOG_BACKEND", raising=False)
        with mock.patch.object(ServiceBackend, "_schedule_flush"):
            first = get_audit_backend()
            second = get_audit_backend()

        assert first is second

    def test_get_audit_backend_thread_safe(self, monkeypatch):
        from ai_platform_engineering.utils.audit_backend import get_audit_backend
        from ai_platform_engineering.utils.audit_backends.service_backend import ServiceBackend

        monkeypatch.delenv("AUDIT_LOG_BACKEND", raising=False)
        results: list = []
        errors: list = []

        def _call():
            try:
                results.append(get_audit_backend())
            except Exception as exc:  # pragma: no cover - failure path assertion below
                errors.append(exc)

        with mock.patch.object(ServiceBackend, "_schedule_flush"):
            threads = [threading.Thread(target=_call) for _ in range(20)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        assert not errors
        assert len(results) == 20
        assert all(backend is results[0] for backend in results)

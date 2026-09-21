"""Tests for ``Settings`` validation (dynamic-agents timeouts + CORS safety)."""

import pydantic
import pytest

from autonomous_agents.config import Settings


def test_minimum_schedule_interval_defaults_to_thirty_minutes() -> None:
    assert Settings().minimum_schedule_interval_seconds == 1800


def test_minimum_schedule_interval_is_configurable_and_positive() -> None:
    assert Settings(minimum_schedule_interval_seconds=600).minimum_schedule_interval_seconds == 600
    with pytest.raises(pydantic.ValidationError):
        Settings(minimum_schedule_interval_seconds=0)


def test_webhook_overload_limits_are_configurable_and_positive() -> None:
    settings = Settings(
        webhook_max_payload_bytes=2048,
        webhook_max_pending_per_task=30,
        webhook_max_pending_per_owner=120,
        webhook_max_pending_global=600,
        webhook_max_pending_payload_bytes_global=4096,
        webhook_max_concurrent_per_owner=12,
        webhook_max_concurrent_global=60,
    )
    assert settings.webhook_max_payload_bytes == 2048
    assert settings.webhook_max_pending_per_task == 30
    assert settings.webhook_max_pending_per_owner == 120
    assert settings.webhook_max_pending_global == 600
    assert settings.webhook_max_pending_payload_bytes_global == 4096
    assert settings.webhook_max_concurrent_per_owner == 12
    assert settings.webhook_max_concurrent_global == 60

    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_payload_bytes=0)
    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_pending_per_task=0)
    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_pending_per_owner=0)
    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_pending_global=0)
    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_pending_payload_bytes_global=0)
    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_concurrent_per_owner=0)
    with pytest.raises(pydantic.ValidationError):
        Settings(webhook_max_concurrent_global=0)


class TestDynamicAgentsTimeoutSettings:
    """Defaults and bounds for the dynamic-agents timeout fields."""

    def test_timeout_defaults_are_sensible(self):
        """Defaults match the documented production values."""
        s = Settings()
        assert s.dynamic_agents_timeout_seconds == 300.0
        assert s.dynamic_agents_preflight_timeout_seconds == 10.0

    def test_timeouts_must_be_positive(self):
        """Dynamic-agents timeouts must be strictly positive."""
        for bad in (0, -1, -0.5):
            with pytest.raises(pydantic.ValidationError):
                Settings(dynamic_agents_timeout_seconds=bad)
            with pytest.raises(pydantic.ValidationError):
                Settings(dynamic_agents_preflight_timeout_seconds=bad)

    def test_timeouts_reject_inf_and_nan(self):
        """``inf`` / ``-inf`` / ``nan`` are rejected on the timeouts."""
        for bad in (float("inf"), float("-inf"), float("nan")):
            with pytest.raises(pydantic.ValidationError):
                Settings(dynamic_agents_timeout_seconds=bad)
            with pytest.raises(pydantic.ValidationError):
                Settings(dynamic_agents_preflight_timeout_seconds=bad)


class TestCorsOrigins:
    """``cors_origins`` parsing and wildcard rejection."""

    def test_cors_origins_default_is_empty(self):
        """No origins by default; production must opt in explicitly."""
        assert Settings().cors_origins == []

    def test_cors_origins_accepts_explicit_list(self):
        """A list of origins is stored verbatim."""
        s = Settings(cors_origins=["http://localhost:3000", "https://app.example.com"])
        assert s.cors_origins == ["http://localhost:3000", "https://app.example.com"]

    def test_cors_origins_parses_comma_separated_string(self):
        """Comma-separated env strings are split into a list."""
        s = Settings(cors_origins="http://localhost:3000, https://app.example.com")
        assert s.cors_origins == ["http://localhost:3000", "https://app.example.com"]

    def test_cors_origins_rejects_wildcard_alone(self):
        """``*`` is rejected (incompatible with ``allow_credentials=True``)."""
        with pytest.raises(pydantic.ValidationError):
            Settings(cors_origins=["*"])

    def test_cors_origins_rejects_wildcard_in_mixed_list(self):
        """Even one ``*`` in a mixed list is rejected."""
        with pytest.raises(pydantic.ValidationError):
            Settings(cors_origins=["http://localhost:3000", "*"])

    def test_cors_origins_empty_env_string_does_not_crash(self, monkeypatch):
        """``CORS_ORIGINS=`` is treated as ``no origins``, not a parse error."""
        monkeypatch.setenv("CORS_ORIGINS", "")
        s = Settings()
        assert s.cors_origins == []

    def test_cors_origins_json_array_in_raw_string(self):
        """``cors_origins_raw`` accepts a JSON array."""
        s = Settings(cors_origins_raw='["http://localhost:3000"]')
        assert s.cors_origins == ["http://localhost:3000"]

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the vendored ``dynamic_agents.services.scan_gate`` module.

The vendored copy exists because the dynamic-agents Docker image
ships only the ``dynamic_agents`` package — not the shared
``ai_platform_engineering.skills_middleware.scan_gate`` source-of-
truth. The cross-package import that lived inline in
``services/skills.py::_load_agent_skills`` raised ``ModuleNotFoundError``
at runtime, was caught by a broad ``except`` and silently returned
``[]``, and made every dynamic agent's virtual filesystem appear
empty to the LLM ("the filesystem appears to be empty or
inaccessible").

Two responsibilities for this test file:

  1. Pin the policy table on the vendored side so a copy-paste edit
     can't silently weaken the security invariant. These mirror the
     suite in ``skills_middleware/tests/test_scan_gate.py``.

  2. Detect drift. The vendored module is supposed to be a verbatim
     copy of the source-of-truth one (sans the wrapper docstring).
     A test compares the function bodies and the ``__all__`` surface
     of the two modules so a single-sided edit fails CI loudly.
"""

from __future__ import annotations

import inspect

import pytest

from dynamic_agents.services import scan_gate


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("SKILL_SCANNER_GATE", raising=False)
    monkeypatch.delenv("ADMIN_SCAN_OVERRIDE_ENABLED", raising=False)


# -- Policy table (mirrors skills_middleware/tests/test_scan_gate.py) -------


class TestGetScanGate:
    def test_default_is_warn(self):
        assert scan_gate.get_scan_gate() == "warn"

    def test_unknown_value_falls_back(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "yolo")
        assert scan_gate.get_scan_gate() == "warn"

    @pytest.mark.parametrize("value", ["strict", "warn", "off"])
    def test_known_values(self, monkeypatch, value):
        monkeypatch.setenv("SKILL_SCANNER_GATE", value)
        assert scan_gate.get_scan_gate() == value


class TestIsAdminOverrideEnabled:
    def test_default_is_enabled(self):
        assert scan_gate.is_admin_override_enabled() is True

    @pytest.mark.parametrize("value", ["false", "FALSE", "0", "no", "off"])
    def test_falsy_values_disable(self, monkeypatch, value):
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", value)
        assert scan_gate.is_admin_override_enabled() is False


class TestIsStatusBlocked:
    def test_flagged_blocked_without_override(self, monkeypatch):
        for gate in ("strict", "warn", "off"):
            monkeypatch.setenv("SKILL_SCANNER_GATE", gate)
            assert scan_gate.is_status_blocked("flagged") is True

    def test_passed_always_allowed(self, monkeypatch):
        for gate in ("strict", "warn", "off"):
            monkeypatch.setenv("SKILL_SCANNER_GATE", gate)
            assert scan_gate.is_status_blocked("passed") is False

    def test_unscanned_blocked_only_under_strict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.is_status_blocked("unscanned") is True
        assert scan_gate.is_status_blocked(None) is True
        assert scan_gate.is_status_blocked("") is True
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        assert scan_gate.is_status_blocked("unscanned") is False
        assert scan_gate.is_status_blocked(None) is False


class TestIsStatusBlockedWithOverride:
    """Mirror of the shared suite for the override behaviour.

    The vendored module is byte-identical to the source-of-truth (the
    drift test below enforces it), but we re-pin the policy here so
    that if pytest is run only in the dynamic-agents container — where
    the source-of-truth module is absent and the drift test self-skips
    — the override invariant is still verified end-to-end on the
    runtime path that actually serves skills to dynamic agents.
    """

    def test_flagged_with_override_allowed_under_warn(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        assert scan_gate.is_status_blocked(
            "flagged", has_override=True
        ) is False

    def test_flagged_with_override_blocked_under_strict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", "true")
        assert scan_gate.is_status_blocked(
            "flagged", has_override=True
        ) is True

    def test_flagged_with_override_blocked_when_feature_off(
        self, monkeypatch
    ):
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", "false")
        for gate in ("warn", "off"):
            monkeypatch.setenv("SKILL_SCANNER_GATE", gate)
            assert scan_gate.is_status_blocked(
                "flagged", has_override=True
            ) is True


class TestIsSkillBlocked:
    def test_reads_status_and_override_from_dict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        # Without override → blocked.
        assert scan_gate.is_skill_blocked(
            {"scan_status": "flagged"}
        ) is True
        # With override sub-doc → allowed.
        assert scan_gate.is_skill_blocked(
            {
                "scan_status": "flagged",
                "scan_override": {"set_by": "admin@example.com"},
            }
        ) is False


class TestMongoScanFilter:
    def test_strict_allows_only_passed(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.mongo_scan_filter() == {
            "scan_status": {"$in": ["passed"]}
        }

    def test_warn_with_override_off_blocks_all_flagged(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", "false")
        assert scan_gate.mongo_scan_filter() == {
            "scan_status": {"$ne": "flagged"}
        }

    def test_warn_with_override_on_allows_flagged_with_override(
        self, monkeypatch
    ):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        assert scan_gate.mongo_scan_filter() == {
            "$or": [
                {"scan_status": {"$ne": "flagged"}},
                {
                    "scan_status": "flagged",
                    "scan_override": {"$exists": True},
                },
            ]
        }


# -- Drift detection: vendored copy ↔ source-of-truth -----------------------


class TestVendorDriftAgainstSourceOfTruth:
    """Fail loudly when the vendored module diverges from the source.

    The dev monorepo ships both modules side-by-side, so this test
    runs in CI without needing the dynamic-agents container. If
    pytest is run inside the container (where ``ai_platform_engineering``
    isn't installed), the test self-skips — there's nothing to compare
    against, but the policy-table tests above still pin behaviour.
    """

    @pytest.fixture
    def source_of_truth(self):
        try:
            from ai_platform_engineering.skills_middleware import (  # type: ignore[import-not-found]
                scan_gate as upstream,
            )
        except ModuleNotFoundError:
            pytest.skip(
                "skills_middleware not on PYTHONPATH (likely running "
                "inside the dynamic-agents container) — drift check "
                "is dev-monorepo / CI-only"
            )
        return upstream

    def test_public_api_matches(self, source_of_truth):
        assert sorted(scan_gate.__all__) == sorted(source_of_truth.__all__)

    def test_function_bodies_identical(self, source_of_truth):
        # Compare the executable source of every public function. Any
        # logic edit (including a re-ordered if-arm) on one side
        # without the other fails this test loudly so we don't ship
        # a divergent runtime gate.
        for name in scan_gate.__all__:
            ours = inspect.getsource(getattr(scan_gate, name))
            theirs = inspect.getsource(getattr(source_of_truth, name))
            assert ours == theirs, (
                f"{name}() drifted between dynamic_agents/services/"
                f"scan_gate.py and skills_middleware/scan_gate.py — "
                "the policy must stay byte-identical between the two "
                "copies. Re-vendor by copying the source-of-truth "
                "function bodies into the vendored module."
            )

    def test_default_gate_constant_matches(self, source_of_truth):
        assert scan_gate._DEFAULT_GATE == source_of_truth._DEFAULT_GATE

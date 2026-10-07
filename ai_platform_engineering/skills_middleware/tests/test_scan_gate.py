# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by cursor (composer-2-fast)
"""Unit tests for the shared skill scan-gating policy.

Pins the policy table for both axes:

  * ``scan_status`` ∈ {passed, flagged, unscanned, missing}
  * ``has_override`` ∈ {True, False}
  * ``SKILL_SCANNER_GATE`` ∈ {strict, warn, off}
  * ``ADMIN_SCAN_OVERRIDE_ENABLED`` ∈ {on, off}

The runtime invariant the gate protects: a skill the security
scanner has marked unsafe is never served to the supervisor catalog
or to dynamic agents, EXCEPT when an admin has stamped a
``scan_override`` sub-doc AND the override feature is enabled AND
we're not in strict mode.

The override is now read from a separate field, NOT from a magic
``scan_status="admin_overridden"`` value. The earlier design
overloaded ``scan_status`` and was removed because every scanner
write path (rescan, scan-all, hub auto-scan after recrawl) would
blindly overwrite the synthetic value with whatever the scanner
returned and silently nuke the override. These tests pin the new
two-field contract so the bug can't regress.
"""

from __future__ import annotations

import pytest

from ai_platform_engineering.skills_middleware import scan_gate


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("SKILL_SCANNER_GATE", raising=False)
    # Tests start from the documented default (override-on); tests
    # that need the feature off set the env explicitly via monkeypatch.
    monkeypatch.delenv("ADMIN_SCAN_OVERRIDE_ENABLED", raising=False)


class TestGetScanGate:
    def test_default_is_warn(self):
        # Warn-by-default keeps the feature working in deployments
        # without the optional skill-scanner sidecar (the common
        # case): unscanned skills still load, but ``flagged`` is
        # rejected unless overridden. Strict is opt-in via env.
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
        # Override is on by default — matches the UI default. Operators
        # who want regulated behaviour flip the env to "false".
        assert scan_gate.is_admin_override_enabled() is True

    @pytest.mark.parametrize("value", ["false", "FALSE", "0", "no", "off"])
    def test_falsy_values_disable(self, monkeypatch, value):
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", value)
        assert scan_gate.is_admin_override_enabled() is False

    @pytest.mark.parametrize("value", ["true", "TRUE", "1", "yes", "on", ""])
    def test_truthy_or_unknown_values_enable(self, monkeypatch, value):
        # Permissive parsing: any non-explicit-false string keeps the
        # feature on, so an accidental typo doesn't silently disable
        # the admin escape hatch.
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", value)
        assert scan_gate.is_admin_override_enabled() is True


class TestIsStatusBlockedWithoutOverride:
    """The base policy table when no admin override is in play."""

    def test_flagged_blocked_under_strict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.is_status_blocked("flagged") is True

    def test_flagged_blocked_under_warn(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        assert scan_gate.is_status_blocked("flagged") is True

    def test_flagged_blocked_under_off(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "off")
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
    """The override row of the policy table — the load-bearing change."""

    def test_flagged_with_override_allowed_under_warn(self, monkeypatch):
        # The whole point of the redesign: a flagged skill that
        # carries an admin override loads under the default (warn)
        # gate when the override feature is on.
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        assert scan_gate.is_status_blocked(
            "flagged", has_override=True
        ) is False

    def test_flagged_with_override_allowed_under_off(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "off")
        assert scan_gate.is_status_blocked(
            "flagged", has_override=True
        ) is False

    def test_flagged_with_override_blocked_under_strict(self, monkeypatch):
        # Strict means "I trust only the scanner." Overrides are
        # intentionally ignored — the regulated-environment escape
        # hatch must remain. Toggling ADMIN_SCAN_OVERRIDE_ENABLED
        # cannot weaken strict in either direction.
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        for override_env in ("true", "false"):
            monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", override_env)
            assert scan_gate.is_status_blocked(
                "flagged", has_override=True
            ) is True

    def test_flagged_with_override_blocked_when_feature_off(
        self, monkeypatch
    ):
        # Operator turned the feature off ⇒ the override field is
        # ignored and a flagged row stays blocked regardless of gate
        # (except strict, which would block it anyway).
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", "false")
        for gate in ("warn", "off"):
            monkeypatch.setenv("SKILL_SCANNER_GATE", gate)
            assert scan_gate.is_status_blocked(
                "flagged", has_override=True
            ) is True, (
                f"override-off under gate={gate} should block flagged"
            )

    def test_override_does_not_affect_unscanned_status(self, monkeypatch):
        # An override only rescues "flagged". An unscanned skill with
        # an override is still subject to the unscanned policy
        # (allowed under warn/off, blocked under strict). Pinning
        # this prevents a future tweak from quietly making the
        # override field a global "treat as passed" hammer.
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.is_status_blocked(
            "unscanned", has_override=True
        ) is True
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        assert scan_gate.is_status_blocked(
            "unscanned", has_override=True
        ) is False

    def test_override_does_not_affect_passed_status(self, monkeypatch):
        # Passed is always allowed; override is a no-op there.
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.is_status_blocked(
            "passed", has_override=True
        ) is False


class TestIsSkillBlocked:
    """Convenience wrapper that reads both fields from a dict."""

    def test_reads_status_from_dict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.is_skill_blocked({"scan_status": "flagged"}) is True
        assert scan_gate.is_skill_blocked({"scan_status": "passed"}) is False
        # Missing field under strict ⇒ blocked.
        assert scan_gate.is_skill_blocked({}) is True

    def test_reads_override_from_dict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        # Truthy sub-doc value → override active.
        assert scan_gate.is_skill_blocked(
            {
                "scan_status": "flagged",
                "scan_override": {"set_by": "admin@example.com"},
            }
        ) is False
        # Empty sub-doc / missing field → no override.
        assert scan_gate.is_skill_blocked(
            {"scan_status": "flagged"}
        ) is True
        assert scan_gate.is_skill_blocked(
            {"scan_status": "flagged", "scan_override": None}
        ) is True
        assert scan_gate.is_skill_blocked(
            {"scan_status": "flagged", "scan_override": {}}
        ) is True

    def test_override_field_ignored_under_strict(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        # Even with an override, strict blocks flagged.
        assert scan_gate.is_skill_blocked(
            {
                "scan_status": "flagged",
                "scan_override": {"set_by": "admin@example.com"},
            }
        ) is True

    def test_override_ignored_when_feature_off(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", "false")
        assert scan_gate.is_skill_blocked(
            {
                "scan_status": "flagged",
                "scan_override": {"set_by": "admin@example.com"},
            }
        ) is True


class TestMongoScanFilter:
    def test_strict_allows_only_passed(self, monkeypatch):
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        assert scan_gate.mongo_scan_filter() == {
            "scan_status": {"$in": ["passed"]}
        }

    def test_strict_unaffected_by_override_flag(self, monkeypatch):
        # Strict = passed-only, regardless of the override feature.
        # Pins the rule that no env combination can weaken strict.
        monkeypatch.setenv("SKILL_SCANNER_GATE", "strict")
        for override_state in ("true", "false"):
            monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", override_state)
            assert scan_gate.mongo_scan_filter() == {
                "scan_status": {"$in": ["passed"]}
            }

    def test_warn_with_override_off_blocks_all_flagged(self, monkeypatch):
        # Override feature off ⇒ predicate excludes all flagged docs
        # unconditionally. Keeps the predicate in sync with
        # ``is_status_blocked`` so callers using only the Mongo
        # predicate can't accidentally serve overridden skills when
        # the feature is disabled.
        monkeypatch.setenv("SKILL_SCANNER_GATE", "warn")
        monkeypatch.setenv("ADMIN_SCAN_OVERRIDE_ENABLED", "false")
        assert scan_gate.mongo_scan_filter() == {
            "scan_status": {"$ne": "flagged"}
        }

    def test_warn_with_override_on_allows_flagged_with_override(
        self, monkeypatch
    ):
        # The default path: predicate matches anything that isn't
        # flagged, plus flagged docs that carry an ``scan_override``
        # sub-doc. ``$exists: true`` matches any present field
        # (including ``null``), but the override route always writes
        # a non-null sub-doc so this maps to "set vs cleared"
        # cleanly.
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


class TestDefaultGateAllowsUnscannedSkills:
    """Regression test for the dynamic-agents 'skill failed to load'
    bug: with ``SKILL_SCANNER_GATE`` unset and no scanner deployed,
    every skill in agent_skills/hub_skills has ``scan_status`` either
    missing or ``"unscanned"``. The default gate must let those rows
    through; otherwise the picker shows skills that the runtime then
    refuses to load.
    """

    def test_python_check_allows_unscanned_under_default(self):
        for status in (None, "", "unscanned", "passed"):
            assert scan_gate.is_status_blocked(status) is False, (
                f"default gate should allow status={status!r}"
            )

    def test_python_check_still_blocks_flagged_under_default(self):
        # The flagged invariant must survive the default change:
        # warn-by-default does NOT mean we serve flagged content
        # without an explicit admin override.
        assert scan_gate.is_status_blocked("flagged") is True
        assert scan_gate.is_skill_blocked({"scan_status": "flagged"}) is True

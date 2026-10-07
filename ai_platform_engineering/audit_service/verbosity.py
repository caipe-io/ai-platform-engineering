"""Audit log verbosity presets — controls which event types are ingested.

# assisted-by claude code claude-sonnet-4-6
"""

from __future__ import annotations

# Empty frozenset means "allow all types" (no filter applied).
PRESET_TYPES: dict[str, frozenset[str]] = {
    "minimal": frozenset({"cas_grant", "cas_reconcile"}),
    "standard": frozenset(
        {"auth", "cas_grant", "cas_reconcile", "cas_decision", "credential_action", "openfga_rebac"}
    ),
    "verbose": frozenset(),
    "il2": frozenset({"auth", "cas_grant", "cas_decision", "credential_action"}),
    "il5": frozenset(),
    "soc2": frozenset({"auth", "cas_grant", "cas_decision", "credential_action", "agent_delegation"}),
}

PRESET_LABELS: dict[str, str] = {
    "minimal": "Minimal — policy changes only",
    "standard": "Standard — policy + access decisions + auth",
    "verbose": "Verbose — all event types",
    "il2": "IL2 — DoD Impact Level 2",
    "il5": "IL5 — DoD Impact Level 5 (all events)",
    "soc2": "SOC 2 — SOC 2 Type II compliance",
}

PRESET_DESCRIPTIONS: dict[str, str] = {
    "minimal": "Records cas_grant and cas_reconcile only. Lowest volume; captures policy changes.",
    "standard": "Records policy changes, access decisions, credential ops, and auth events.",
    "verbose": "Records all event types. Equivalent to the historic default.",
    "il2": "Captures auth, policy changes, access decisions, and credential actions per IL2.",
    "il5": "Full audit trail required for high-sensitivity IL5 environments.",
    "soc2": "Captures auth, policy changes, access decisions, credentials, and agent delegation for SOC 2.",
}


def allowed_types(verbosity: str) -> frozenset[str]:
    """Return the allowed event types for a preset. Empty means allow all."""
    return PRESET_TYPES.get(verbosity.strip().lower(), frozenset())


def is_event_allowed(event_type: str | None, verbosity: str) -> bool:
    """Return True if this event type passes the verbosity filter."""
    types = allowed_types(verbosity)
    if not types:
        return True
    return (event_type or "") in types


def filter_records(records: list[dict], verbosity: str) -> list[dict]:
    """Drop records whose event type is not in the verbosity allowlist."""
    types = allowed_types(verbosity)
    if not types:
        return records
    return [r for r in records if r.get("type") in types]

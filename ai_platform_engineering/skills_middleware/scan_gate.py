# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Skill scan gating policy.

Centralizes the rule for which skills are allowed to be served to the
skill catalog and to dynamic agents. Used by every loader path
(``load_default_skills``, ``load_agent_skills``, hub fetcher,
``dynamic_agents.services.skills.load_skills``) so the policy
can't drift between callers.

Policy
------
* ``scan_status == "flagged"`` is blocked **unless** the doc carries
  an ``scan_override`` sub-doc (set by an admin via the per-skill
  override route, with set_by/set_at/reason for audit). The override
  is the admin's "I trust this skill even though the scanner doesn't"
  assertion; both this policy and the Node-side ``applyRunnableGate``
  honour it iff ``ADMIN_SCAN_OVERRIDE_ENABLED`` is on (default). Set
  the env to ``false`` to remove the escape hatch entirely — overrides
  are then ignored and ``flagged`` is unconditional.
* ``scan_status == "unscanned"`` (and missing-status legacy rows)
  are blocked only under ``SKILL_SCANNER_GATE=strict``. The default
  is ``"warn"`` so deployments without the optional skill-scanner
  service still load skills; operators who run the scanner can flip
  to strict to refuse anything the scanner hasn't explicitly cleared.
* Anything else (``"passed"`` etc.) is allowed.

Why warn is the default
-----------------------
The skill-scanner is an optional sidecar (``SKILL_SCANNER_URL`` lives
in the UI tier). When it's absent, every skill is created with
``scan_status: "unscanned"`` (or no field at all for legacy/imported
rows). Strict-by-default in that environment makes every catalog
entry invisible to the runtime even though the picker can still see
them — i.e. "skill failed to load" with no obvious cause. Warn-by-
default makes the feature work out of the box and still gives
security-conscious operators a single env flip to lock down.

Why this lives in its own module
--------------------------------
Each loader needs the same decision but used to encode it ad-hoc with
inline ``$ne`` queries. Centralizing it means:

1. Adding a new ``"quarantined"`` status later only requires editing
   one function.
2. Tests can pin the policy table without booting Mongo.
3. Both Mongo query predicates (``mongo_scan_filter``) and Python-side
   dict checks (``is_skill_blocked``) share the same source of truth.

Why the override is a separate field
------------------------------------
The previous implementation set ``scan_status = "admin_overridden"``
to encode the override. That collided with every scanner write path:
any rescan (per-skill, scan-all, hub auto-scan after recrawl) would
blindly write ``scan_status = "flagged"`` again and silently nuke
the override. Splitting the signals means:

* ``scan_status`` always reflects the latest scanner verdict
  (passed/flagged/unscanned). Scan routes can keep writing it
  without coordinating with the override layer.
* ``scan_override`` (audit sub-doc with set_by/set_at/reason) is
  the single source of truth for "admin allowed this". Override
  routes set/clear this field only.
* The gate combines them: a flagged skill with an override is
  runnable; without one, blocked.

Strict mode and overrides
-------------------------
Under ``SKILL_SCANNER_GATE=strict`` the only allowed status is
``"passed"``. A flagged skill is therefore blocked in strict mode
regardless of whether an admin override exists — strict means "I
trust only the scanner's clean verdict." This is the escape hatch
for regulated environments: setting strict ignores admin assertions,
by design.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# Default is "warn": flagged skills are blocked (unless an override
# is present), but unscanned/missing-status rows are allowed so
# deployments without the optional skill-scanner sidecar still
# function. Operators who run the scanner can opt into "strict" to
# refuse anything not explicitly cleared.
#
# History: this briefly defaulted to "strict", which silently broke
# every dynamic-agent skill in deployments without SKILL_SCANNER_URL
# configured ("N skill(s) failed to load"). The value-of-strict trade
# was a fresh deploy excluding unscanned content; the cost-of-strict
# was the feature being broken by default. Cost won.
_DEFAULT_GATE = "warn"


def get_scan_gate() -> str:
    """Return the active scanner gate (`strict` / `warn` / `off`)."""
    raw = os.getenv("SKILL_SCANNER_GATE", _DEFAULT_GATE).strip().lower()
    if raw not in {"strict", "warn", "off"}:
        logger.warning(
            "Unrecognized SKILL_SCANNER_GATE=%r; falling back to %r",
            raw,
            _DEFAULT_GATE,
        )
        return _DEFAULT_GATE
    return raw


def is_admin_override_enabled() -> bool:
    """Whether an admin ``scan_override`` rescues a flagged skill.

    Defaults to True so the admin override feature is on by default
    (matches the UI default in the Skills admin panel). Operators in
    regulated environments can flip ``ADMIN_SCAN_OVERRIDE_ENABLED=false``
    to remove the escape hatch entirely — the override sub-doc is
    then ignored and ``flagged`` becomes unconditional regardless of
    the scanner gate.
    """
    raw = os.getenv("ADMIN_SCAN_OVERRIDE_ENABLED", "true").strip().lower()
    return raw not in {"false", "0", "no", "off"}


def is_status_blocked(
    scan_status: str | None,
    *,
    has_override: bool = False,
) -> bool:
    """Decide whether a skill with the given status/override is blocked.

    Args:
        scan_status: The latest scanner verdict on the doc.
        has_override: Whether the doc carries an ``scan_override``
            sub-doc set by an admin. When True and the override
            feature is enabled, ``flagged`` rows are allowed.

    ``flagged`` is allowed iff (a) the doc has an admin override
    AND (b) the override feature is on AND (c) we're not in strict
    mode (strict means "scanner-clean only" and ignores overrides).
    ``unscanned`` (or missing status) is blocked only under strict.
    Everything else is allowed.

    The ``has_override`` keyword is positional-keyword on purpose so
    callers can't accidentally pass it as a positional arg and shift
    the meaning of an existing call site silently.
    """
    if scan_status == "flagged":
        if get_scan_gate() == "strict":
            # Strict trusts only the scanner verdict — overrides ignored.
            return True
        if has_override and is_admin_override_enabled():
            return False
        return True
    if scan_status in (None, "", "unscanned"):
        return get_scan_gate() == "strict"
    return False


def is_skill_blocked(skill: dict[str, Any]) -> bool:
    """Convenience over ``is_status_blocked`` for skill dicts.

    Reads both ``scan_status`` and the presence of ``scan_override``
    from the doc so callers don't have to remember to pass them
    separately. A truthy ``scan_override`` (any non-empty value)
    counts as an active override; the audit metadata inside the
    sub-doc isn't validated here — it's set by a single trusted
    writer (the override route) and consumed for display elsewhere.
    """
    has_override = bool(skill.get("scan_override"))
    return is_status_blocked(
        skill.get("scan_status"),
        has_override=has_override,
    )


def mongo_scan_filter() -> dict[str, Any]:
    """Mongo predicate that matches skills *not* blocked by scan policy.

    Returns a fragment intended to be merged into a larger ``find`` /
    ``$and`` query, e.g.::

        query = {"$and": [user_filter, mongo_scan_filter()]}

    Behaviour by gate:

    * ``strict``: only ``scan_status == "passed"`` matches; overrides
      are intentionally ignored (regulated-env mode).
    * ``warn`` / ``off`` with overrides enabled (default): match
      anything except ``flagged``, plus flagged docs that carry an
      ``scan_override`` sub-doc (the admin escape hatch).
    * ``warn`` / ``off`` with ``ADMIN_SCAN_OVERRIDE_ENABLED=false``:
      block all flagged docs unconditionally; override sub-doc is
      ignored — keeps the predicate in sync with ``is_status_blocked``
      so callers that use the predicate alone can't accidentally
      serve overridden skills when the feature is disabled.
    """
    if get_scan_gate() == "strict":
        return {"scan_status": {"$in": ["passed"]}}

    if not is_admin_override_enabled():
        # Override feature off: flagged is unconditional.
        return {"scan_status": {"$ne": "flagged"}}

    # Default path: allow non-flagged OR (flagged AND has override).
    # ``$exists: true`` matches any present field including ``null``;
    # the override route always writes a non-null sub-doc and the
    # DELETE handler ``$unset``s it, so this maps cleanly to "set vs
    # cleared" without needing to inspect the sub-doc shape.
    return {
        "$or": [
            {"scan_status": {"$ne": "flagged"}},
            {"scan_status": "flagged", "scan_override": {"$exists": True}},
        ]
    }


__all__ = [
    "get_scan_gate",
    "is_admin_override_enabled",
    "is_status_blocked",
    "is_skill_blocked",
    "mongo_scan_filter",
]

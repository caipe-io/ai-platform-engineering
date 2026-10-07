# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Skill scan gating policy — vendored copy for the dynamic-agents service.

WHY THIS FILE EXISTS
====================
This is a verbatim copy of
``ai_platform_engineering/skills_middleware/scan_gate.py``.

The ``dynamic-agents`` service ships as a standalone Docker image that
contains *only* the ``dynamic_agents`` package (see ``/app`` in the
container — there is no ``ai_platform_engineering/`` parent). Lazy
imports such as::

    from ai_platform_engineering.skills_middleware.scan_gate import (
        is_skill_blocked, mongo_scan_filter,
    )

…work fine in the dev monorepo (where both packages live on PYTHONPATH)
but raise ``ModuleNotFoundError`` inside the container. Until that day,
the broken import was caught by ``except Exception`` in
``services/skills.py::load_skills``, which silently returned ``[]`` for
every skill set — making every dynamic agent's ``SkillsMiddleware`` /
``StateBackend`` virtual filesystem appear empty to the LLM ("the
filesystem appears to be empty or inaccessible"). The UI worked fine
because it lives in the same Python process as ``skills_middleware``
itself.

So we vendor the policy module into the dynamic-agents package. The
file is small and the policy is stable; cost-of-duplication is low,
cost-of-broken-runtime is high.

KEEPING THE TWO COPIES IN SYNC
==============================
If you add a status (e.g. ``"quarantined"``) or change the default
gate, you MUST update both files:

    * ai_platform_engineering/skills_middleware/scan_gate.py  (source of truth)
    * ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/scan_gate.py  (this file)

The unit test ``tests/test_scan_gate_vendored.py`` pins both the policy
table on this side AND that the public API surface (function names +
signatures) hasn't drifted from the source-of-truth module — so a
single-sided change will fail CI.

POLICY (matches the source-of-truth file)
=========================================
* ``scan_status == "flagged"`` is blocked **unless** the doc carries
  an ``scan_override`` sub-doc (set by an admin via the per-skill
  override route, with set_by/set_at/reason for audit). The override
  is the admin's "I trust this skill even though the scanner doesn't"
  assertion; both this policy and the Node-side ``applyRunnableGate``
  honour it iff ``ADMIN_SCAN_OVERRIDE_ENABLED`` is on (default). Set
  the env to ``false`` to remove the escape hatch entirely.
* ``scan_status == "unscanned"`` (and missing-status legacy rows)
  are blocked only under ``SKILL_SCANNER_GATE=strict``. The default
  is ``"warn"`` so deployments without the optional skill-scanner
  service still load skills; operators who run the scanner can flip
  to strict to refuse anything the scanner hasn't explicitly cleared.
* Anything else (``"passed"`` etc.) is allowed.
* The override is a separate sub-doc, NOT a magic
  ``scan_status="admin_overridden"`` value. That earlier design
  collided with every scanner write path: any rescan would blindly
  overwrite ``scan_status="flagged"`` and silently nuke the override.
  Splitting the signals lets scan routes write status freely and
  keeps the override stable.
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

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Smoke tests for the unlinked-prompt path in app.py.

Spec 103's original FR-007 mandated an actionable HMAC-signed linking URL
for unlinked users. That interactive link mechanism was removed as a
security hole: the redemption route had no ownership check, so anyone
holding a valid signed link could bind an arbitrary Slack user id to their
own Keycloak session. ``app.py`` now always passes ``linking_url_fn=None``
to ``apply_unlinked_fallback``, so unlinked users get a "contact your
admin" message instead of a link.

The full app.py middleware is gnarly to import in isolation (it pulls in
Slack Bolt, Mongo, etc.). Rather than exercising the whole stack, this
test pins the *string content* of the prompt by reading the source and
asserting on the literal text — that's enough to catch any future
regression that re-introduces the dead-end copy or the HMAC-link
mechanism.
"""

from __future__ import annotations

import pathlib


_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"
_ANON_FALLBACK_PY = pathlib.Path(__file__).resolve().parents[1] / "utils" / "unlinked_fallback.py"


def test_dead_end_message_is_no_longer_the_default() -> None:
    """The exact bad copy from the original FR-007 ("could not be
    automatically linked. Make sure your Slack email matches your
    enterprise account") MUST NOT appear anywhere in app.py."""
    src = _APP_PY.read_text(encoding="utf-8")
    assert "could not be automatically linked" not in src
    assert "Make sure your Slack email matches your enterprise account" not in src


def test_no_interactive_link_generation_in_app() -> None:
    """The HMAC-signed interactive linking URL generator was removed as a
    security hole — app.py must not reference it or its force-link flag."""
    src = _APP_PY.read_text(encoding="utf-8")
    assert "generate_linking_url" not in src
    assert "SLACK_FORCE_LINK" not in src


def test_no_more_blanket_contact_admin_message_in_default_path() -> None:
    """The fall-through message that shipped when JIT was disabled used
    to be ``contact your admin`` with no other instruction. The new copy
    should only mention "contact your admin" once, inside the last-resort
    else branch (now the only branch, since ``linking_url_fn`` is always
    ``None``)."""
    # The prompt copy lives in unlinked_fallback.py after extraction.
    src = _ANON_FALLBACK_PY.read_text(encoding="utf-8")
    # We expect "contact your admin" to appear at most once, inside the
    # last-resort else branch.
    occurrences = src.count("contact your admin")
    assert occurrences <= 1, (
        f"Too many 'contact your admin' messages ({occurrences}) — verify "
        "we didn't re-introduce the dead-end path."
    )

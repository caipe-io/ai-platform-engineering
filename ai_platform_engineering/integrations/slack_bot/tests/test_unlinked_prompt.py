# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Security invariants for the unlinked-account fallback prompt.

Slack identity resolution uses email matching and optional JIT provisioning.
Routes must not offer bearer-style identity-link URLs because possession of a
link does not prove ownership of the target Slack identity.
"""

from __future__ import annotations

import pathlib


_SLACK_BOT_DIR = pathlib.Path(__file__).resolve().parents[1]
_APP_PY = _SLACK_BOT_DIR / "app.py"
_AUTHORIZATION_PY = _SLACK_BOT_DIR / "authorization.py"
_PERSONAL_ROUTING_PY = _SLACK_BOT_DIR / "personal_routing.py"
_ANON_FALLBACK_PY = _SLACK_BOT_DIR / "utils" / "unlinked_fallback.py"


def test_dead_end_message_is_no_longer_the_default() -> None:
    """The fallback avoids guidance that email matching alone can fix."""
    src = _ANON_FALLBACK_PY.read_text(encoding="utf-8")
    assert "could not be automatically linked" not in src
    assert "Make sure your Slack email matches your enterprise account" not in src


def test_routes_do_not_generate_interactive_link() -> None:
    """The composition root and extracted route owners avoid HMAC links."""
    route_src = "".join(
        path.read_text(encoding="utf-8")
        for path in (_APP_PY, _AUTHORIZATION_PY, _PERSONAL_ROUTING_PY)
    )
    assert "generate_linking_url" not in route_src
    assert "SLACK_FORCE_LINK" not in route_src
    assert "should_preauth_prompt" not in route_src


def test_authorization_disables_link_url_fallback() -> None:
    """Unlinked users receive minimum access or administrator guidance."""
    src = _AUTHORIZATION_PY.read_text(encoding="utf-8")
    assert "linking_url_fn=None" in src


def test_no_more_blanket_contact_admin_message_in_default_path() -> None:
    """Administrator guidance appears only in explicit fallback copy."""
    src = _ANON_FALLBACK_PY.read_text(encoding="utf-8")
    occurrences = src.count("contact your admin")
    assert occurrences <= 1

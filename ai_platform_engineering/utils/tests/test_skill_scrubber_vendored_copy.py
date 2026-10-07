# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Pin the vendored ``dynamic_agents`` copy to the source-of-truth.

The dynamic-agents container ships as its own deploy unit and does
not depend on the ``ai_platform_engineering`` package, so we keep a
byte-for-byte vendored copy of the scrubber under
``ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/skill_scrubber.py``.

If they drift, traces from one of the two services will leak skill
content while the other doesn't — exactly the kind of silent
regression we want CI to catch.

The vendored copy carries an extra ``VENDORED COPY`` header block;
compare module bodies starting after that header to ignore it.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SOT_PATH = REPO_ROOT / "ai_platform_engineering/utils/tracing/skill_scrubber.py"
VENDORED_PATH = (
    REPO_ROOT
    / "ai_platform_engineering/dynamic_agents/src/dynamic_agents/services/skill_scrubber.py"
)

# Marker line that immediately precedes the module docstring in
# both files. We compare everything from this line forward so the
# vendored ``VENDORED COPY`` header doesn't trip us up.
_BODY_START_MARKER = '"""Operator-content scrubber for OpenTelemetry spans.'


def _body_after_marker(text: str) -> str:
    idx = text.find(_BODY_START_MARKER)
    assert idx != -1, "expected scrubber module to start with known docstring marker"
    return text[idx:]


def test_vendored_scrubber_body_matches_source_of_truth() -> None:
    sot = _body_after_marker(SOT_PATH.read_text())
    vendored = _body_after_marker(VENDORED_PATH.read_text())
    assert sot == vendored, (
        "Vendored scrubber drift detected.\n"
        f"  source:   {SOT_PATH}\n"
        f"  vendored: {VENDORED_PATH}\n"
        "Re-sync with:\n"
        f"  cp {SOT_PATH} {VENDORED_PATH}\n"
        "and re-add the VENDORED COPY header."
    )


def test_vendored_scrubber_carries_vendor_marker() -> None:
    """The vendored file must announce itself so future maintainers
    know to edit the source-of-truth instead."""
    text = VENDORED_PATH.read_text()
    assert "VENDORED COPY" in text, "vendored copy lost its provenance header"
    assert (
        "ai_platform_engineering/utils/tracing/skill_scrubber.py" in text
    ), "vendored header lost its source-of-truth pointer"

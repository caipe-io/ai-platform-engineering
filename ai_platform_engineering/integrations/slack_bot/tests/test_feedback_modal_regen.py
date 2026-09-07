# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the opt-in "regenerate a response" checkbox in the feedback modal.

Feedback is always recorded; the bot only regenerates when the user ticks the
off-by-default checkbox. `regenerate_requested` reads that choice from the
modal's submitted state.
"""

from ai_platform_engineering.integrations.slack_bot.utils.scoring import (
    regenerate_requested,
)


def _values(regen_selected: bool) -> dict:
  """Modal state.values with the regen checkbox ticked or not."""
  options = [{"value": "regenerate"}] if regen_selected else []
  return {
    "correction_input": {"correction_text": {"value": "It was wrong"}},
    "regen_input": {"regen": {"selected_options": options}},
  }


def test_unchecked_does_not_regenerate():
  """Default (box not ticked) must not regenerate."""
  assert regenerate_requested(_values(regen_selected=False)) is False


def test_checked_regenerates():
  """Ticking the box opts in to regeneration."""
  assert regenerate_requested(_values(regen_selected=True)) is True

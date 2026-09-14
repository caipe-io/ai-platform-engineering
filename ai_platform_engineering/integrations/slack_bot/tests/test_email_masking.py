# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the slack-bot email masking helper.

The mask shape is part of the spec (FR-010). Anyone who changes it must
update the spec and SIEM rules that key off this format — these tests
exist so that change is conscious, not accidental.
"""

from __future__ import annotations

from ai_platform_engineering.integrations.slack_bot.utils.email_masking import (
    mask_email,
)


def test_typical_email_keeps_three_chars_and_domain() -> None:
    assert mask_email("alice@corp.com") == "ali***@corp.com"


def test_short_local_part_is_fully_masked() -> None:
    assert mask_email("a@corp.com") == "***@corp.com"
    assert mask_email("ab@corp.com") == "***@corp.com"
    assert mask_email("abc@corp.com") == "***@corp.com"


def test_local_part_exactly_four_keeps_three() -> None:
    assert mask_email("abcd@corp.com") == "abc***@corp.com"


def test_no_at_sign_returns_bare_mask() -> None:
    assert mask_email("malformed-no-at") == "***"


def test_empty_or_none_returns_bare_mask() -> None:
    assert mask_email("") == "***"
    assert mask_email(None) == "***"


def test_at_with_no_domain_returns_bare_mask() -> None:
    assert mask_email("alice@") == "***"


def test_at_with_no_local_returns_bare_mask() -> None:
    assert mask_email("@corp.com") == "***"

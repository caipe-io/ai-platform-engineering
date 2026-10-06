# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Tool input validation tests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from models import ListItemsInput, PageInput


def test_page_size_is_bounded() -> None:
    with pytest.raises(ValidationError):
        PageInput(limit=101)


def test_list_field_names_are_deduplicated() -> None:
    args = ListItemsInput(list_id="11111111-1111-1111-1111-111111111111", field_names=["Title", "Title", "Status"])

    assert args.field_names == ["Title", "Status"]


def test_odata_expression_is_rejected_as_field_name() -> None:
    with pytest.raises(ValidationError, match="internal column names"):
        ListItemsInput(list_id="11111111-1111-1111-1111-111111111111", field_names=["Title),items($expand=fields"])

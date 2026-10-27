"""Tests for strict GridFS namespace parsing."""

import pytest
from fastapi import HTTPException

from dynamic_agents.routes.files import _parse_namespace


def test_parse_namespace_accepts_exactly_three_strings() -> None:
    assert _parse_namespace('["primary", "example", "filesystem"]') == (
        "primary",
        "example",
        "filesystem",
    )


@pytest.mark.parametrize(
    "raw",
    [
        '["primary", {"$ne": null}, "filesystem"]',
        '["primary", 42, "filesystem"]',
        '["primary", "filesystem"]',
        '"primary"',
        "not-json",
    ],
)
def test_parse_namespace_rejects_non_string_or_wrong_shape_values(raw: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        _parse_namespace(raw)

    assert exc_info.value.status_code == 400

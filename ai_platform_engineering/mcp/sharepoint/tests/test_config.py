# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Configuration validation tests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from models import SharePointConfig


def test_site_url_is_normalized() -> None:
    config = SharePointConfig(
        tenant_id="00000000-0000-0000-0000-000000000000",
        client_id="11111111-1111-1111-1111-111111111111",
        client_secret="test-secret",
        site_url="https://example.sharepoint.com/sites/example/?source=test#section",
    )

    assert config.site_url == "https://example.sharepoint.com/sites/example"
    assert "test-secret" not in repr(config)


@pytest.mark.parametrize(
    "site_url",
    [
        "http://example.sharepoint.com/sites/example",
        "https://example.com/sites/example",
        "https://example.sharepoint.com/personal/example",
        "https://user@example.sharepoint.com/sites/example",
        "https://example.sharepoint.com/sites/../other",
    ],
)
def test_invalid_site_urls_are_rejected(site_url: str) -> None:
    with pytest.raises(ValidationError):
        SharePointConfig(
            tenant_id="00000000-0000-0000-0000-000000000000",
            client_id="11111111-1111-1111-1111-111111111111",
            client_secret="test-secret",
            site_url=site_url,
        )


def test_from_env_reports_missing_names_without_values(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "SHAREPOINT_TENANT_ID",
        "SHAREPOINT_CLIENT_ID",
        "SHAREPOINT_CLIENT_SECRET",
        "SHAREPOINT_SITE_URL",
    ):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(ValueError, match="SHAREPOINT_CLIENT_SECRET") as exc_info:
        SharePointConfig.from_env()

    assert "test-secret" not in str(exc_info.value)

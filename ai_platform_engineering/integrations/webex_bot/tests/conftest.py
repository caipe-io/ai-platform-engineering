# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Shared fixtures for Webex bot tests."""

from __future__ import annotations

import json

import pytest


@pytest.fixture(autouse=True)
def _configured_webex_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Policy namespace comes from deployment env, not webhook payloads."""
    monkeypatch.setenv("WEBEX_WORKSPACE_ALIAS", "CAIPE-WEBEX")
    monkeypatch.delenv("WEBEX_WORKSPACE_ID", raising=False)
    monkeypatch.setenv(
        "WEBEX_INTEGRATION_BOTS_JSON",
        json.dumps(
            [
                {
                    "id": "primary",
                    "name": "Primary",
                    "tokenEnv": "PRIMARY_TOKEN",
                    "spaces": {"accessMode": "allowlist"},
                    "directMessages": {"accessMode": "allowlist"},
                },
                {
                    "id": "secondary",
                    "name": "Secondary",
                    "tokenEnv": "SECONDARY_TOKEN",
                    "spaces": {"accessMode": "allowlist"},
                    "directMessages": {"accessMode": "allowlist"},
                },
            ]
        ),
    )

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for Webex bot process bootstrap."""

from __future__ import annotations

from unittest.mock import patch

from ai_platform_engineering.integrations.webex_bot.main import bootstrap_webex_bot_runtime, main


def test_bootstrap_skips_admin_api_when_disabled(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_ADMIN_API_ENABLED", "false")
    monkeypatch.delenv("WEBEX_INTEGRATION_BOT_ACCESS_TOKEN", raising=False)

    with patch(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_admin_api.start_webex_admin_api_server"
    ) as start_mock:
        bootstrap_webex_bot_runtime()

    start_mock.assert_not_called()


def test_bootstrap_starts_admin_api_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_ADMIN_API_ENABLED", "true")
    monkeypatch.delenv("WEBEX_INTEGRATION_BOT_ACCESS_TOKEN", raising=False)

    with patch(
        "ai_platform_engineering.integrations.webex_bot.utils.webex_admin_api.start_webex_admin_api_server",
        return_value=object(),
    ) as start_mock:
        bootstrap_webex_bot_runtime()

    start_mock.assert_called_once()


def test_bootstrap_starts_webex_wdm_transport_when_token_configured(monkeypatch) -> None:
    monkeypatch.setenv("WEBEX_ADMIN_API_ENABLED", "false")
    monkeypatch.setenv("WEBEX_INTEGRATION_BOT_ACCESS_TOKEN", "test-token")

    with patch(
        "ai_platform_engineering.integrations.webex_bot.webex_wdm.start_webex_wdm_listeners",
        return_value=[object()],
    ) as start_wdm:
        bootstrap_webex_bot_runtime()

    start_wdm.assert_called_once()


def test_main_keeps_process_alive_after_bootstrap() -> None:
    with (
        patch("ai_platform_engineering.integrations.webex_bot.main.bootstrap_webex_bot_runtime") as bootstrap,
        patch("ai_platform_engineering.integrations.webex_bot.main.run_until_stopped") as wait,
    ):
        main()

    bootstrap.assert_called_once()
    wait.assert_called_once()

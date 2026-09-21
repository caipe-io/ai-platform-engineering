# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for verify_thread_exists — prevents posting to main channel when parent message is deleted."""

from unittest.mock import Mock

from ai_platform_engineering.integrations.slack_bot.utils.utils import verify_thread_exists


class TestVerifyThreadExists:

    def test_existing_message_passes(self):
        client = Mock()
        client.conversations_replies.return_value = {
            "messages": [{"ts": "111.222", "text": "hi"}],
        }
        assert verify_thread_exists(client, "C123", "111.222") is True

    def test_deleted_message_blocked(self):
        client = Mock()
        client.conversations_replies.side_effect = Exception("thread_not_found")
        assert verify_thread_exists(client, "C123", "111.222") is False

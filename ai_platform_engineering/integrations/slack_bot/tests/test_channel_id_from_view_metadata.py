# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Regression test: RBAC channel resolution must handle view_submission bodies.

A view_submission (modal submit) body carries no top-level channel field —
Slack Bolt only gives us body["view"]["private_metadata"], which our feedback
modal encodes as "channel_id|thread_ts|message_ts|agent_id|feedback_type".

Before this fix, `_rbac_enrich_context` and `rbac_global_middleware` each
extracted channel_id via a fallback chain that had no knowledge of
view.private_metadata, so submitting the feedback modal always resolved
channel_id=None. With SLACK_RBAC_ENABLED=true, `resolve_channel_team(None)`
then fails to find a mapping and the request is hard-denied before `next()`
is ever called — the modal submit handler never runs, with no error or trace
visible to the user (just a middleware-level RBAC deny log line).
"""

from __future__ import annotations

import importlib
import pathlib
import sys

import pytest

_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"
_APP_DIR = _APP_PY.parent
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))


class _HealthResponse:
    ok = True
    status_code = 200
    text = "ok"


def _load_slack_app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(_APP_DIR))
    monkeypatch.setenv("SLACK_INTEGRATION_BOT_TOKEN", "xoxb-test-token")
    monkeypatch.setenv("CAIPE_API_URL", "http://localhost:3000")
    monkeypatch.setenv("CAIPE_CONNECT_RETRIES", "1")
    monkeypatch.setenv("SLACK_RBAC_ENABLED", "false")
    monkeypatch.setenv("SLACK_INTEGRATION_ENABLE_AUTH", "false")
    monkeypatch.setattr(
        "slack_sdk.web.client.WebClient.auth_test",
        lambda _self, **_kwargs: {"ok": True, "user_id": "UBOT"},
    )
    monkeypatch.setattr("requests.get", lambda *_args, **_kwargs: _HealthResponse())

    for module_name in ("app", "utils.config", "utils.config_models"):
        sys.modules.pop(module_name, None)

    return importlib.import_module("app")


class TestChannelIdFromViewMetadata:
    def test_extracts_channel_id_from_private_metadata(self, monkeypatch: pytest.MonkeyPatch) -> None:
        app_module = _load_slack_app(monkeypatch)
        body = {
            "user": {"id": "U555"},
            "team": {"id": "T1"},
            "view": {"private_metadata": "C123|1700000000.000100|1700000000.000200|agent-xyz|other"},
        }
        assert app_module._channel_id_from_view_metadata(body) == "C123"

    def test_returns_none_when_no_view(self, monkeypatch: pytest.MonkeyPatch) -> None:
        app_module = _load_slack_app(monkeypatch)
        assert app_module._channel_id_from_view_metadata({}) is None

    def test_returns_none_when_private_metadata_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        app_module = _load_slack_app(monkeypatch)
        body = {"view": {"private_metadata": ""}}
        assert app_module._channel_id_from_view_metadata(body) is None

    def test_block_actions_body_still_resolved_by_earlier_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Sanity check: a normal block_actions body (with body["channel"])
        never needs the view_submission fallback — it's just unused here."""
        app_module = _load_slack_app(monkeypatch)
        body = {"channel": {"id": "C999"}, "view": {}}
        assert app_module._channel_id_from_view_metadata(body) is None

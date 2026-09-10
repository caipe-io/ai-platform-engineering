# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Regression tests: feedback/retry/escalation button and modal handlers must
bind the per-request OBO token before calling into `sse_client`.

`_resolve_conversation_id` (and anything else routed through `sse_client`)
picks its bearer token from a ContextVar that `_bind_obo_for_handler` sets
from the Bolt `context` dict. `handle_mention` / `_route_to_agent` /
`handle_dm_message` already call `_bind_obo_for_handler(context)` on entry,
but the feedback/retry/escalation/delete button handlers and the feedback
modal's view-submission handler did not — they never declared `context` in
their signature at all, so `sse_client` silently fell back to the bot's
service-account token instead of the invoking user's OBO token. Because Bolt
dispatches action acks on a plain `ThreadPoolExecutor` (which does not clone
contextvars per task), a handler could also intermittently inherit a stale
OBO token left on a reused worker thread by an unrelated request — this is
why the resulting `agent#use` PDP denials looked flaky rather than
deterministic.
"""

from __future__ import annotations

import importlib
import pathlib
import sys
from unittest.mock import MagicMock

import pytest

_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"
_APP_DIR = _APP_PY.parent
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))


class _HealthResponse:
    ok = True
    status_code = 200
    text = "ok"


class _Client:
    def __init__(self) -> None:
        self.ephemeral_posts: list[dict[str, object]] = []

    def auth_test(self) -> dict[str, str]:
        return {"user_id": "UBOT"}

    def chat_postEphemeral(self, **kwargs: object) -> None:
        self.ephemeral_posts.append(kwargs)

    def chat_postMessage(self, **kwargs: object) -> None:
        pass

    def chat_delete(self, **kwargs: object) -> None:
        pass

    def reactions_add(self, **kwargs: object) -> None:
        pass


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

    app_module = importlib.import_module("app")

    monkeypatch.setattr(app_module, "submit_feedback_score", MagicMock(return_value=True))
    monkeypatch.setattr(app_module, "_resolve_conversation_id", MagicMock(return_value="conv-123"))
    return app_module


def _action_body(action_id: str, *, channel_id="C123", thread_ts="1700000000.000100", message_ts="1700000000.000200", value_suffix="") -> dict:
    value = f"{channel_id}|{thread_ts}|{message_ts}{value_suffix}"
    return {
        "user": {"id": "U555"},
        "channel": {"id": channel_id},
        "message": {"ts": message_ts, "thread_ts": thread_ts},
        "actions": [{"action_id": action_id, "value": value}],
    }


class TestFeedbackFamilyBindsOboToken:
    """Each handler must call `_bind_obo_for_handler(context)` on entry."""

    @pytest.mark.parametrize(
        "action_id,handler_name",
        [
            ("caipe_feedback", "handle_caipe_feedback"),
            ("caipe_retry", "handle_caipe_retry"),
            ("caipe_escalation_get_help", "handle_escalation_get_help"),
            ("caipe_delete_message", "handle_delete_message"),
        ],
    )
    def test_action_handler_binds_obo(self, monkeypatch: pytest.MonkeyPatch, action_id, handler_name) -> None:
        app_module = _load_slack_app(monkeypatch)
        monkeypatch.setattr(app_module, "_resolve_escalation", lambda *_a, **_k: None)

        bind_obo = MagicMock()
        monkeypatch.setattr(app_module, "_bind_obo_for_handler", bind_obo)

        client = _Client()
        body = _action_body(action_id, value_suffix="||agent-xyz")
        sentinel_context = {"obo_token": "user-obo-token"}

        handler = getattr(app_module, handler_name)
        handler(ack=MagicMock(), body=body, client=client, context=sentinel_context)

        bind_obo.assert_called_once_with(sentinel_context)

    def test_feedback_modal_submission_binds_obo(self, monkeypatch: pytest.MonkeyPatch) -> None:
        app_module = _load_slack_app(monkeypatch)

        bind_obo = MagicMock()
        monkeypatch.setattr(app_module, "_bind_obo_for_handler", bind_obo)

        client = _Client()
        body = {"user": {"id": "U555"}, "team": {"id": "T1"}}
        view = {
            "private_metadata": "C123|1700000000.000100|1700000000.000200|agent-xyz|other",
            "state": {"values": {"correction_input": {"correction_text": {"value": ""}}, "regen_input": {"regen": {"selected_options": []}}}},
        }
        sentinel_context = {"obo_token": "user-obo-token"}

        app_module.handle_feedback_modal_submission(ack=MagicMock(), body=body, client=client, view=view, context=sentinel_context)

        bind_obo.assert_called_once_with(sentinel_context)

    def test_action_handler_defaults_context_to_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Bolt omits `context` entirely for some dispatch paths — the
        handler must not blow up with a missing required argument."""
        app_module = _load_slack_app(monkeypatch)
        monkeypatch.setattr(app_module, "_resolve_escalation", lambda *_a, **_k: None)

        bind_obo = MagicMock()
        monkeypatch.setattr(app_module, "_bind_obo_for_handler", bind_obo)

        client = _Client()
        body = _action_body("caipe_feedback", value_suffix="||agent-xyz")

        app_module.handle_caipe_feedback(ack=MagicMock(), body=body, client=client)

        bind_obo.assert_called_once_with(None)

"""Slack runtime response policy tests."""

from __future__ import annotations

import importlib
import logging
import pathlib
import sys

import pytest

_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"
_APP_DIR = _APP_PY.parent
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

_POLICY = importlib.import_module("utils.slack_runtime_policy")
should_post_route_miss_notice = _POLICY.should_post_route_miss_notice


class _Logger:
    def debug(self, *_args: object, **_kwargs: object) -> None:
        pass

    def info(self, *_args: object, **_kwargs: object) -> None:
        pass

    def warning(self, *_args: object, **_kwargs: object) -> None:
        pass

    def error(self, *_args: object, **_kwargs: object) -> None:
        pass


class _HealthResponse:
    ok = True
    status_code = 200
    text = "ok"


class _Client:
    def __init__(self) -> None:
        self.ephemeral_posts: list[dict[str, object]] = []
        self.channel_posts: list[dict[str, object]] = []

    def auth_test(self) -> dict[str, str]:
        return {"user_id": "UBOT"}

    def chat_postEphemeral(self, **kwargs: object) -> None:
        self.ephemeral_posts.append(kwargs)

    def chat_postMessage(self, **kwargs: object) -> None:
        self.channel_posts.append(kwargs)


def _load_slack_app(
    monkeypatch: pytest.MonkeyPatch,
    *,
    rbac_enabled: bool = False,
):
    monkeypatch.syspath_prepend(str(_APP_DIR))
    monkeypatch.setenv("SLACK_INTEGRATION_BOT_TOKEN", "xoxb-test-token")
    monkeypatch.setenv("CAIPE_API_URL", "http://localhost:3000")
    monkeypatch.setenv("CAIPE_CONNECT_RETRIES", "1")
    monkeypatch.setenv("SLACK_RBAC_ENABLED", "true" if rbac_enabled else "false")
    monkeypatch.setenv("SLACK_INTEGRATION_ENABLE_AUTH", "false")
    monkeypatch.setattr(
        "slack_sdk.web.client.WebClient.auth_test",
        lambda _self, **_kwargs: {"ok": True, "user_id": "UBOT"},
    )
    monkeypatch.setattr("requests.get", lambda *_args, **_kwargs: _HealthResponse())

    for module_name in ("app", "utils.config", "utils.config_models"):
        sys.modules.pop(module_name, None)

    return importlib.import_module("app")


def test_route_miss_notice_requires_explicit_invocation() -> None:
    assert should_post_route_miss_notice(explicit_invocation=True) is True
    assert should_post_route_miss_notice(explicit_invocation=False) is False


def test_deduplicated_event_returns_200(monkeypatch: pytest.MonkeyPatch) -> None:
    """Second delivery of the same event_id must short-circuit with 200.

    Without the 200, Slack keeps retrying the envelope which produces the
    "middleware skipped calling next()" warning storm we hit in dev.
    """
    app_module = _load_slack_app(monkeypatch)
    from slack_bolt.response import BoltResponse

    payload = {
        "event_id": "E-dupe-test",
        "event": {"type": "message", "channel": "C1", "user": "U1"},
    }
    next_calls = 0

    def next_handler() -> None:
        nonlocal next_calls
        next_calls += 1

    # First delivery — RBAC is disabled in this test (SLACK_RBAC_ENABLED=false),
    # so the middleware just calls next() and lets the chain proceed.
    first = app_module.rbac_global_middleware(payload, {}, next_handler, _Logger())
    assert next_calls == 1
    assert first is None  # next() returned, no short-circuit response

    calls_before_duplicate = next_calls

    # Second delivery of the same event_id — must NOT advance the chain and
    # must return BoltResponse(200) so Slack stops retrying.
    second = app_module.rbac_global_middleware(payload, {}, next_handler, _Logger())
    assert next_calls == calls_before_duplicate, "duplicate event must not re-invoke handlers"
    assert isinstance(second, BoltResponse)
    assert second.status == 200


def test_rbac_deny_logs_warning_and_returns_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A denied request must log a warning, post nothing, and return 200.

    When ``_rbac_enrich_context`` returns a ``("deny", <reason>)`` tuple the
    middleware must:

      1. NOT call ``next()`` — denied requests don't reach listeners.
      2. NOT post the denial back to Slack (neither ephemeral nor channel).
         Posting is noisy and leaks RBAC config details; the denial is
         surfaced only in the slack-bot logs.
      3. Log the denial at WARNING level so it's visible in the logs (the
         only artifact, now that we don't post it back).
      4. Return ``BoltResponse(200)`` so Slack doesn't retry the envelope up
         to 4 times (which also produced bolt-python's "middleware skipped
         calling next()" warning).
    """
    app_module = _load_slack_app(monkeypatch, rbac_enabled=True)
    from slack_bolt.response import BoltResponse

    async def _fake_enrich(body, slack_user_id, context, *, require_mapping=True):
        return ("deny", "You don't have access to any agents in this channel.")

    monkeypatch.setattr(app_module, "_rbac_enrich_context", _fake_enrich)

    client = _Client()
    context: dict[str, object] = {"client": client}

    class _CapturingLogger(_Logger):
        def __init__(self) -> None:
            self.info_calls: list[tuple[str, tuple[object, ...]]] = []
            self.warning_calls: list[tuple[str, tuple[object, ...]]] = []

        def info(self, msg: object, *args: object, **_kwargs: object) -> None:
            self.info_calls.append((str(msg), args))

        def warning(self, msg: object, *args: object, **_kwargs: object) -> None:
            self.warning_calls.append((str(msg), args))

    log = _CapturingLogger()
    next_called = False

    def next_handler() -> None:
        nonlocal next_called
        next_called = True

    result = app_module.rbac_global_middleware(
        {
            "event_id": "E-deny-cicd",
            "event": {
                "type": "message",
                "channel": "C0B6F5VRK6V",
                "user": "U0B67AHR0RZ",
                "ts": "1779865939.844779",
                "text": "how can you help?",
            },
        },
        context,
        next_handler,
        log,
    )

    # 1. Downstream handlers must NOT run when access is denied.
    assert next_called is False, "denied requests must not reach listeners"

    # 2. The denial must NOT be posted to Slack at all — neither ephemeral nor
    #    channel-wide. Denials are surfaced only in the slack-bot logs (posting
    #    is noisy and leaks RBAC config details).
    assert client.ephemeral_posts == [], (
        f"denials must not be posted to Slack; got ephemeral {client.ephemeral_posts!r}"
    )
    assert client.channel_posts == [], (
        f"denials must not be posted to Slack; got channel {client.channel_posts!r}"
    )

    # 3. Deny path must log at WARNING level so denials are visible in slack-bot
    #    logs (the only artifact now that we don't post the denial back).
    deny_logs = [
        call for call in log.warning_calls
        if "RBAC denied" in call[0]
    ]
    assert deny_logs, (
        f"deny path must log 'RBAC denied ...' at WARNING; got warning calls: "
        f"{log.warning_calls!r}"
    )

    # 4. Return BoltResponse(200) so Slack does not retry the envelope.
    assert isinstance(result, BoltResponse)
    assert result.status == 200


def test_bot_message_subtype_still_mints_unlinked_sa_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bot/workflow message (subtype=bot_message, bot_id set) must reach the
    bot_id branch and get an unlinked SA obo_token — not be swallowed by the
    system-message skip list before that branch runs.

    Slack tags every bot-authored message with subtype="bot_message". If that
    subtype were included in the early skip list, the middleware would call
    next() and return without ever setting context["obo_token"], and
    downstream OpenFGA channel-grant checks would always deny with
    reason=pdp_unavailable for bot/workflow senders.
    """
    app_module = _load_slack_app(monkeypatch, rbac_enabled=True)

    async def _fake_mint() -> str:
        return "unlinked-sa-token"

    monkeypatch.setattr(app_module, "_mint_unlinked_obo_token", _fake_mint)

    context: dict[str, object] = {}
    next_called = False

    def next_handler() -> None:
        nonlocal next_called
        next_called = True

    result = app_module.rbac_global_middleware(
        {
            "event_id": "E-bot-workflow",
            "event": {
                "type": "app_mention",
                "subtype": "bot_message",
                "channel": "C0B84HHUNQ4",
                "bot_id": "BWORKFLOW1",
                "ts": "1700000000.000100",
                "text": "run the workflow",
            },
        },
        context,
        next_handler,
        _Logger(),
    )

    assert result is None, "bot message must not be short-circuited"
    assert next_called is True
    assert context.get("obo_token") == "unlinked-sa-token"
    assert context.get("is_bot") is True
    assert context.get("unlinked_fallback") is True


def test_missing_unlinked_token_uses_stdlib_log_formatting(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    app_module = _load_slack_app(monkeypatch, rbac_enabled=True)

    async def _missing_token() -> None:
        return None

    monkeypatch.setattr(app_module, "_mint_unlinked_obo_token", _missing_token)
    monkeypatch.setattr(
        app_module.utils,
        "get_bot_info_by_id",
        lambda _bot_id: (None, "UBOT"),
    )
    logger = logging.getLogger("slack-bot-middleware-test")

    with caplog.at_level(logging.WARNING, logger=logger.name):
        result = app_module.rbac_global_middleware(
            {
                "event_id": "E-bot-without-unlinked-token",
                "event": {
                    "type": "app_mention",
                    "subtype": "bot_message",
                    "channel": "C123",
                    "bot_id": "B123",
                    "ts": "1700000000.000200",
                },
            },
            {},
            lambda: None,
            logger,
        )

    assert result is app_module._HANDLED_200
    assert "no unlinked SA available" in caplog.text


def test_route_miss_notice_does_not_call_slack_for_ambient_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_module = _load_slack_app(monkeypatch)
    client = _Client()

    app_module._post_route_miss_notice(
        client,
        "C123",
        "U123",
        "route miss diagnostic",
        explicit_invocation=False,
    )

    assert client.ephemeral_posts == []
    assert client.channel_posts == []


def test_route_miss_notice_posts_for_explicit_invocations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_module = _load_slack_app(monkeypatch)
    client = _Client()

    app_module._post_route_miss_notice(
        client,
        "C123",
        "U123",
        "route miss diagnostic",
        explicit_invocation=True,
    )

    assert client.ephemeral_posts == [
        {"channel": "C123", "user": "U123", "text": "route miss diagnostic"}
    ]
    assert client.channel_posts == []

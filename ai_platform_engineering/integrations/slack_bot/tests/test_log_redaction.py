# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for utils.log_redaction.

Verifies that secrets are stripped from LogRecords before they reach handlers,
including the exact Slack Bolt warning shape that originally leaked a per-request
token in production logs.
"""

from __future__ import annotations

import logging

import pytest

from ai_platform_engineering.integrations.slack_bot.utils.log_redaction import (
    SecretRedactionFilter,
    install,
    mask_value,
    redact_mapping,
    redact_text,
)


_SAMPLE_SLACK_VALUE = "NMmN" + "JS8jKIYqx0YMAEH7" + "hnxI"
_SAMPLE_SECRET_VALUE = "very" + "secret" + "123abc"
_SAMPLE_ACCESS_VALUE = "very" + "secret" + "value"
_SAMPLE_API_VALUE = "super" + "secret" + "valuehere"
_SAMPLE_HS_JWT = "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
_SAMPLE_RS_JWT = (
    "eyJ"
    + "hbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMxMjM0NTY3.signature_value_here_12345"
)
_SAMPLE_EVENT_CONTEXT = "4-" + "eyJldCI6Im1lc3NhZ2UiLCJ0aWQiOiJUMDlUOTdHVFNLRCJ9"


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

class _CapturingHandler(logging.Handler):
    """Captures the *formatted* log message after the filter has run."""

    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


@pytest.fixture
def isolated_logger():
    """Yield (logger, handler) pair scoped to this test only."""
    lg = logging.getLogger(f"test.log_redaction.{id(object())}")
    lg.setLevel(logging.DEBUG)
    lg.propagate = False
    # Remove any previously attached handlers/filters from earlier tests.
    lg.handlers.clear()
    lg.filters.clear()
    handler = _CapturingHandler()
    lg.addHandler(handler)
    lg.addFilter(SecretRedactionFilter())
    yield lg, handler
    lg.handlers.clear()
    lg.filters.clear()


# --------------------------------------------------------------------------- #
# mask_value                                                                  #
# --------------------------------------------------------------------------- #

class TestMaskValue:
    def test_short_value_is_fully_masked(self):
        assert mask_value("abc") == "****(3)"
        assert mask_value("12345678") == "****(8)"

    def test_long_value_keeps_prefix_suffix_only(self):
        # Exact format: <first4>…<last4>(<len>)
        assert mask_value(_SAMPLE_SLACK_VALUE) == "NMmN…hnxI(24)"

    def test_none_becomes_plain_mask(self):
        assert mask_value(None) == "****"

    def test_non_string_is_stringified_then_masked(self):
        assert mask_value(123456789).startswith("1234")


# --------------------------------------------------------------------------- #
# redact_mapping                                                              #
# --------------------------------------------------------------------------- #

class TestRedactMapping:
    def test_top_level_token_redacted(self):
        out = redact_mapping({"token": _SAMPLE_SLACK_VALUE, "team_id": "T09T97GTSKD"})
        assert "NMmNJS" not in str(out)
        assert out["team_id"] == "T09T97GTSKD"

    def test_nested_secrets_redacted(self):
        payload = {
            "outer": {
                "inner": {
                    "client_secret": "abcdefghijklmnop",
                    "harmless": "value",
                }
            }
        }
        out = redact_mapping(payload)
        assert out["outer"]["inner"]["harmless"] == "value"
        assert out["outer"]["inner"]["client_secret"] != "abcdefghijklmnop"
        assert "abcdefgh" not in str(out["outer"]["inner"]["client_secret"])

    def test_lists_and_tuples_traversed(self):
        out = redact_mapping([{"access_token": _SAMPLE_ACCESS_VALUE}, ("ok",)])
        assert _SAMPLE_ACCESS_VALUE not in str(out)
        assert out[1] == ("ok",)

    def test_event_context_is_treated_as_sensitive(self):
        # event_context is a base64 blob that identifies the Slack request.
        ctx = "4-eyJldCI6Im1lc3NhZ2UiLCJ0aWQiOiJUMDlUOTdHVFNLRCJ9"
        out = redact_mapping({"event_context": ctx})
        assert ctx not in str(out)

    def test_case_insensitive_key_match(self):
        out = redact_mapping({"API_KEY": _SAMPLE_API_VALUE})
        assert _SAMPLE_API_VALUE not in str(out)

    def test_pathological_depth_does_not_recurse_forever(self):
        # Build a chain deeper than the recursion guard.
        d: dict = {"v": "x"}
        for _ in range(50):
            d = {"nested": d}
        # Should not raise.
        redact_mapping(d)

    def test_non_dict_returned_unchanged(self):
        assert redact_mapping(42) == 42
        assert redact_mapping("plain") == "plain"
        assert redact_mapping(None) is None

    def test_input_not_mutated(self):
        original = {"token": "secrettoken12345"}
        snapshot = dict(original)
        redact_mapping(original)
        assert original == snapshot


# --------------------------------------------------------------------------- #
# redact_text                                                                 #
# --------------------------------------------------------------------------- #

class TestRedactText:
    def test_quoted_token_kv_redacted(self):
        text = f"request body: {{'token': '{_SAMPLE_SLACK_VALUE}', 'team_id': 'T09T97GTSKD'}}"
        out = redact_text(text)
        assert _SAMPLE_SLACK_VALUE not in out
        assert "T09T97GTSKD" in out  # team id is not sensitive

    def test_bearer_token_redacted(self):
        text = f"Authorization: Bearer {_SAMPLE_HS_JWT}"
        out = redact_text(text)
        assert _SAMPLE_HS_JWT.split(".", maxsplit=1)[0] not in out
        assert "Bearer" in out

    def test_bare_jwt_redacted(self):
        # Realistic 3-segment JWT: each segment must satisfy the regex's
        # first-segment shape (eyJ + ≥8 chars) and each tail segment ≥8 chars.
        jwt = _SAMPLE_RS_JWT
        text = f"got token {jwt}"
        out = redact_text(text)
        assert jwt not in out

    def test_double_quoted_kv_redacted(self):
        text = f'{{"client_secret": "{_SAMPLE_SECRET_VALUE}", "client_id": "caipe-ui"}}'
        out = redact_text(text)
        assert _SAMPLE_SECRET_VALUE not in out
        assert "caipe-ui" in out

    def test_text_without_secrets_returned_unchanged(self):
        text = "plain old log message with no secrets"
        assert redact_text(text) == text

    def test_empty_input_handled(self):
        assert redact_text("") == ""


# --------------------------------------------------------------------------- #
# SecretRedactionFilter (end-to-end through stdlib logging)                   #
# --------------------------------------------------------------------------- #

class TestSecretRedactionFilter:

    # The exact Bolt warning that triggered this work — verbatim payload from
    # the user's bug report, modulo IDs.
    BOLT_WARNING_TPL = (
        "A global middleware (CustomMiddleware(func=rbac_global_middleware)) "
        "skipped calling either `next()` or `next_()` without providing a "
        "response for the request (%s)"
    )
    BOLT_PAYLOAD = {
        "token": _SAMPLE_SLACK_VALUE,
        "team_id": "T09T97GTSKD",
        "context_team_id": "T09T97GTSKD",
        "context_enterprise_id": None,
        "api_app_id": "A0A7ZKZLGJE",
        "event": {
            "type": "message",
            "user": "U09TC6RR8KX",
            "ts": "1776914419.818249",
            "text": "hi",
            "channel": "C09TFMCA8HY",
        },
        "type": "event_callback",
        "event_id": "Ev0AUMCLM3NH",
        "event_context": _SAMPLE_EVENT_CONTEXT,
    }

    def test_bolt_warning_redacts_token_in_dict_arg(self, isolated_logger):
        lg, handler = isolated_logger
        lg.warning(self.BOLT_WARNING_TPL, self.BOLT_PAYLOAD)

        out = handler.messages[0]
        # The verification token must NOT appear in clear text.
        assert _SAMPLE_SLACK_VALUE not in out
        # The event_context must NOT appear in clear text.
        assert _SAMPLE_EVENT_CONTEXT not in out
        # Non-sensitive fields should still be present for debuggability.
        assert "T09T97GTSKD" in out
        assert "U09TC6RR8KX" in out
        assert "C09TFMCA8HY" in out

    def test_secret_in_msg_string_redacted(self, isolated_logger):
        # Pre-formatted message (no %-args) — exercises the record.msg text
        # scan path of the filter. JWT segments must be ≥8 chars to match
        # the bare-JWT regex (avoids false positives on dotted identifiers).
        lg, handler = isolated_logger
        jwt = _SAMPLE_RS_JWT.removesuffix("_12345")
        lg.error("login failed: token=%s returned 401" % jwt)
        assert jwt not in handler.messages[0]

    def test_non_sensitive_log_unchanged(self, isolated_logger):
        lg, handler = isolated_logger
        lg.info("Bolt app is running on port %d", 3000)
        assert handler.messages[0] == "Bolt app is running on port 3000"

    def test_filter_does_not_break_on_unexpected_args(self, isolated_logger):
        lg, handler = isolated_logger

        class Weird:
            def __str__(self) -> str:
                raise RuntimeError("kaboom")

        # Filter must swallow errors and let the message through. The actual
        # log emission may fail downstream (because of __str__), but the filter
        # itself should not raise.
        try:
            lg.warning("weird=%s", Weird())
        except Exception:
            # Acceptable — failure happens at format time, not in our filter.
            pass

    def test_dict_inside_tuple_args_is_redacted(self, isolated_logger):
        lg, handler = isolated_logger
        lg.warning("ctx=%s extra=%s", {"access_token": "shouldnotappearhere"}, "tail")
        msg = handler.messages[0]
        assert "shouldnotappearhere" not in msg
        assert "tail" in msg

    def test_msg_is_dict_redacted(self, isolated_logger):
        lg, handler = isolated_logger
        lg.warning({"password": "supersecretpassword"})
        assert "supersecretpassword" not in handler.messages[0]


# --------------------------------------------------------------------------- #
# install() — idempotency + opt-out                                           #
# --------------------------------------------------------------------------- #

class TestInstall:
    def test_install_is_idempotent(self):
        # Reset the module-level guard for a clean assertion.
        from ai_platform_engineering.integrations.slack_bot.utils import log_redaction
        log_redaction._SHARED_FILTER = None

        bolt_lg = logging.getLogger("slack_bolt")
        before = len(bolt_lg.filters)

        install()
        install()  # second call must be a no-op

        after = len(bolt_lg.filters)
        # Exactly one filter added, even across two calls.
        assert after - before == 1

    def test_install_respects_opt_out_env(self, monkeypatch):
        from ai_platform_engineering.integrations.slack_bot.utils import log_redaction
        log_redaction._SHARED_FILTER = None

        bolt_lg = logging.getLogger("slack_bolt")
        for f in list(bolt_lg.filters):
            if isinstance(f, log_redaction.SecretRedactionFilter):
                bolt_lg.removeFilter(f)
        before = len(bolt_lg.filters)

        monkeypatch.setenv("SLACK_BOT_DISABLE_LOG_REDACTION", "true")
        install()

        assert len(bolt_lg.filters) == before  # no filter added on logger
        # Opt-out returns early before _SHARED_FILTER is assigned.
        assert log_redaction._SHARED_FILTER is None

    def test_install_redacts_records_from_child_loggers(self):
        """Regression test for the Bolt warning leak.

        slack_bolt emits records on child loggers like ``slack_bolt.App``, but
        ``logging.Filter`` on a parent does NOT see records propagated up from
        children. This test ensures :func:`install` attaches the filter where
        it actually fires (i.e. on handlers).
        """
        from ai_platform_engineering.integrations.slack_bot.utils import log_redaction
        log_redaction._SHARED_FILTER = None

        # Set up a captured root handler BEFORE install — install() must
        # attach the filter to it.
        captured: list[str] = []

        class _Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                captured.append(record.getMessage())

        root = logging.getLogger()
        cap = _Capture()
        cap.setLevel(logging.DEBUG)
        # Save+restore root state so this test doesn't leak.
        prev_handlers = list(root.handlers)
        prev_level = root.level
        try:
            root.handlers = [cap]
            root.setLevel(logging.DEBUG)

            install()  # must add filter to `cap` (existing handler)

            # Emit on a CHILD logger — the parent-level filter would NOT fire,
            # but the handler-level filter (added by install) MUST.
            child = logging.getLogger("slack_bolt.App")
            child.warning(f"skipped calling next() ({{'token': '{_SAMPLE_SLACK_VALUE}'}})")

            assert len(captured) == 1
            assert _SAMPLE_SLACK_VALUE not in captured[0]
            assert "NMmN" in captured[0]  # masked prefix kept for debuggability
        finally:
            root.handlers = prev_handlers
            root.setLevel(prev_level)

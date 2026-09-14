# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Logging redaction filter for the Slack bot.

Slack Bolt and several auxiliary libraries occasionally log full request/response
payloads (e.g. when a middleware skips ``next()`` without a response, or when an
HTTP client logs the request body at DEBUG). Those payloads contain values we
must never persist:

* Slack request ``token`` (verification token)
* OAuth bearer tokens / refresh tokens
* Keycloak ``client_secret`` and ``code`` parameters
* Keys that look like secrets by name (``*_secret``, ``*_token``, ``api_key`` …)

This module installs a single :class:`logging.Filter` on the root logger that
mutates each :class:`~logging.LogRecord` in place, replacing matching values
with a short ``****`` masked form that preserves only the first/last few
characters for debuggability.

The filter is intentionally **defensive**: any error inside the filter is
swallowed so that a bug in redaction never silences a real log message.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Iterable

# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #

# Substring match (case-insensitive) on dict keys treated as sensitive.
_SENSITIVE_KEY_SUBSTRINGS: tuple[str, ...] = (
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "authorization",
    "auth_header",
    "client_secret",
    "refresh_token",
    "access_token",
    "id_token",
    "private_key",
    "session",
    "cookie",
    "csrf",
    "code_verifier",
    "code_challenge",
    "signing_secret",
)

# Slack-specific keys that are not strictly secret but identify a request and
# should not appear in third-party telemetry. ``token`` is the per-request
# verification token sent by Slack.
_SLACK_REQUEST_KEYS: tuple[str, ...] = (
    "token",
    "event_context",
)

# Regexes for inline patterns inside formatted messages (e.g. when a payload
# is rendered as a single string before being passed to ``logger.warning``).
_BEARER_RE = re.compile(r"(Bearer\s+)([A-Za-z0-9._\-]{8,})", re.IGNORECASE)
_JWT_RE = re.compile(r"\b(eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})\b")
# Inline key/value examples use either single or double quotes.
_QUOTED_KV_RE = re.compile(
    r"""(['"])(?P<key>token|client_secret|access_token|refresh_token|id_token|"""
    r"""password|secret|api_key|signing_secret|event_context)\1"""
    r"""(\s*:\s*)(?P<q>['"])(?P<val>[^'"]{4,})(?P=q)""",
    re.IGNORECASE,
)

_MASK = "****"


# --------------------------------------------------------------------------- #
# Public helpers                                                              #
# --------------------------------------------------------------------------- #

def mask_value(value: Any) -> str:
    """Return a redacted representation of *value* preserving a short prefix/suffix.

    Examples:
        >>> mask_value("redaction-sample-value")
        'reda…alue(22)'
        >>> mask_value("xoxb-abc")
        '****(8)'
        >>> mask_value(None)
        '****'
    """
    if value is None:
        return _MASK
    s = value if isinstance(value, str) else str(value)
    n = len(s)
    if n <= 8:
        return f"{_MASK}({n})"
    return f"{s[:4]}…{s[-4:]}({n})"


def _is_sensitive_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    k = key.lower()
    if k in _SLACK_REQUEST_KEYS:
        return True
    return any(sub in k for sub in _SENSITIVE_KEY_SUBSTRINGS)


def redact_mapping(obj: Any, *, _depth: int = 0) -> Any:
    """Recursively redact sensitive values in dicts / lists / tuples.

    Returns a new structure (does not mutate the input). Bounded recursion
    depth (16) protects against pathological payloads.
    """
    if _depth > 16:
        return obj
    if isinstance(obj, dict):
        out: dict[Any, Any] = {}
        for k, v in obj.items():
            if _is_sensitive_key(k):
                out[k] = mask_value(v)
            else:
                out[k] = redact_mapping(v, _depth=_depth + 1)
        return out
    if isinstance(obj, (list, tuple)):
        red = [redact_mapping(v, _depth=_depth + 1) for v in obj]
        return type(obj)(red) if isinstance(obj, tuple) else red
    return obj


def redact_text(text: str) -> str:
    """Redact secret-like patterns inside a free-form string.

    Handles:
    * ``Authorization: Bearer <token>``
    * Bare JWTs (``eyJ…``)
    * ``"token": "value"`` style quoted KV pairs (single or double quoted)
    """
    if not text:
        return text

    def _kv_sub(m: "re.Match[str]") -> str:
        return f"{m.group(1)}{m.group('key')}{m.group(1)}{m.group(3)}{m.group('q')}{mask_value(m.group('val'))}{m.group('q')}"

    text = _QUOTED_KV_RE.sub(_kv_sub, text)
    text = _BEARER_RE.sub(lambda m: f"{m.group(1)}{mask_value(m.group(2))}", text)
    text = _JWT_RE.sub(lambda m: mask_value(m.group(1)), text)
    return text


# --------------------------------------------------------------------------- #
# logging.Filter implementation                                               #
# --------------------------------------------------------------------------- #

class SecretRedactionFilter(logging.Filter):
    """Mutates each LogRecord in place to redact secret values.

    Operates on:
    * ``record.args`` (positional args used by ``%`` formatting) — both dict and
      tuple forms.
    * ``record.msg`` if it is a string (regex-based redaction).
    * ``record.msg`` if it is a dict (whole-payload redaction).

    The filter never raises. If anything goes wrong, the original record is
    passed through unchanged so we don't lose the log line.
    """

    name = "slack_bot_secret_redaction"

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        try:
            # 1) record.args is the most common shape: ('msg %s', payload_dict)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = redact_mapping(record.args)
                elif isinstance(record.args, tuple):
                    record.args = tuple(
                        redact_mapping(a) if isinstance(a, (dict, list, tuple)) else a
                        for a in record.args
                    )

            # 2) record.msg can itself be a dict (rare but possible)
            if isinstance(record.msg, dict):
                record.msg = redact_mapping(record.msg)
            elif isinstance(record.msg, str):
                # Cheap pre-check before regex pass to avoid touching every line.
                if any(s in record.msg.lower() for s in ("token", "secret", "password", "bearer", "eyj")):
                    record.msg = redact_text(record.msg)
        except Exception:  # noqa: BLE001 — never break logging
            pass
        return True


# --------------------------------------------------------------------------- #
# Installation                                                                #
# --------------------------------------------------------------------------- #

_SHARED_FILTER: SecretRedactionFilter | None = None


def _attach_to_all_handlers(flt: SecretRedactionFilter) -> None:
    """Attach *flt* to every existing handler in the logging tree.

    Why handlers and not loggers: per the stdlib docs, filters attached to a
    logger are NOT consulted for records emitted by descendant loggers
    (https://docs.python.org/3/library/logging.html#filter-objects). Slack
    Bolt creates child loggers like ``slack_bolt.App`` and emits the leaky
    warning there, so a filter on the ``slack_bolt`` parent never fires.

    Handlers, by contrast, always see the propagated record — so attaching
    the filter to every handler in the tree gives us full coverage.
    """
    seen_handlers: set[int] = set()

    # Root handlers first.
    for h in logging.root.handlers:
        if id(h) not in seen_handlers and flt not in h.filters:
            h.addFilter(flt)
            seen_handlers.add(id(h))

    # Then every other already-instantiated logger's handlers.
    # ``Logger.manager.loggerDict`` may contain ``PlaceHolder`` objects; skip them.
    for lg in logging.root.manager.loggerDict.values():
        if not isinstance(lg, logging.Logger):
            continue
        for h in lg.handlers:
            if id(h) not in seen_handlers and flt not in h.filters:
                h.addFilter(flt)
                seen_handlers.add(id(h))


def _install_handler_hook(flt: SecretRedactionFilter) -> None:
    """Wrap ``Logger.addHandler`` so future handlers also get the filter.

    Loguru's stdlib bridge, slack_bolt, and any third-party library may
    install a handler *after* :func:`install` has run. Without this hook
    those late-added handlers would emit unredacted records.
    """
    original_add_handler = logging.Logger.addHandler

    def _add_handler_with_redaction(self: logging.Logger, hdlr: logging.Handler) -> None:
        original_add_handler(self, hdlr)
        try:
            if flt not in hdlr.filters:
                hdlr.addFilter(flt)
        except Exception:  # noqa: BLE001
            pass

    # Mark as patched so tests / repeat calls don't double-wrap.
    if not getattr(logging.Logger.addHandler, "_redaction_wrapped", False):
        _add_handler_with_redaction._redaction_wrapped = True  # type: ignore[attr-defined]
        logging.Logger.addHandler = _add_handler_with_redaction  # type: ignore[assignment]


def install(logger_names: Iterable[str] | None = None) -> SecretRedactionFilter:
    """Install the redaction filter so it runs on **every** log record.

    The filter is attached to:
    * The root logger and any explicit *logger_names* (defense-in-depth for
      records emitted directly on those loggers).
    * Every existing handler in the logging tree (this is what actually
      catches records from child loggers like ``slack_bolt.App``).
    * A monkey-patched ``Logger.addHandler`` so future handlers are covered too.

    Idempotent — calling :func:`install` more than once is a no-op.

    Set ``SLACK_BOT_DISABLE_LOG_REDACTION=true`` to skip installation (useful
    when debugging the filter itself).
    """
    global _SHARED_FILTER

    if os.environ.get("SLACK_BOT_DISABLE_LOG_REDACTION", "").lower() in ("1", "true", "yes"):
        # Always return a filter object so callers can use it manually.
        return _SHARED_FILTER or SecretRedactionFilter()

    if _SHARED_FILTER is not None:
        return _SHARED_FILTER

    flt = SecretRedactionFilter()
    _SHARED_FILTER = flt

    # Attach to a handful of loggers as a belt-and-braces defense for records
    # emitted directly on them (rather than on a child).
    targets = list(logger_names or [])
    targets.extend(["", "slack_bolt", "slack_sdk"])
    for name in dict.fromkeys(targets):  # preserves order, dedupes
        logging.getLogger(name).addFilter(flt)

    # The real work: every handler must run the filter.
    _attach_to_all_handlers(flt)
    _install_handler_hook(flt)

    return flt

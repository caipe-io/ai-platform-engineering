# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Dispatch "Run As" identity helper (anonymous-and-obo-routing).

Extracted from ``app._route_to_agent`` so the decision logic is unit-testable
without importing the full Slack Bolt app.

Runtime behavior is UNCHANGED — ``app.py`` delegates to
``apply_execution_identity`` in place of the inlined block it replaced.

Decision table (Decision 3):
  Run As mode       | user linked? | action
  ------------------|--------------|----------------------------------------------
  obo_user (User)   | yes          | no-op — context["obo_token"] already set
  obo_user (User)   | no           | no-op — middleware already stashed anon token
  service_account   | yes or no    | mint SA token → context["obo_token"]
  service_account + mint fails     | abort (return False), send ephemeral error

Returns ``True`` when dispatch should PROCEED, ``False`` when it should ABORT.
Callers must ``return`` immediately on False.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional

from loguru import logger

from .user_messages import send_error_notice as _send_error_notice_impl

# Type alias for the coroutine function that mints a token for a given SA sub.
ImpersonateFn = Callable[[str], Awaitable[Any]]


def apply_execution_identity(
    *,
    run_as_mode: str = "",
    sa_sub: Optional[str],
    sa_name: Optional[str] = None,
    agent_id: str,
    context: dict[str, Any],
    event: dict[str, Any],
    client: Any,
    say: Any,
    is_bot: bool,
    impersonate_fn: ImpersonateFn,
    # Backward-compat alias — callers that still pass exec_mode= by keyword
    # continue to work; prefer run_as_mode in new code.
    exec_mode: str = "",
) -> bool:
    """Apply the per-route "Run As" identity and return proceed/abort.

    Called by ``_route_to_agent`` when ``RBAC_ENABLED`` and context is set.
    Pure logic with injected dependencies so it can be unit-tested without
    importing ``slack_bolt``.

    Parameters
    ----------
    run_as_mode:
        ``"obo_user"`` (User) or ``"service_account"``.  The ``exec_mode``
        keyword is accepted as a backward-compat alias.
    sa_sub:
        The SA service-account-user sub (required when mode==service_account).
    agent_id:
        Agent identifier, for log messages only.
    context:
        Bolt request context dict; ``context["obo_token"]`` may be overwritten.
    event:
        Slack event dict; used to extract ``channel`` and ``user``.
    client:
        Slack WebClient; used to post ephemeral error messages to human senders.
    say:
        Bolt ``say`` helper; used to post in-thread notices for bot senders.
    is_bot:
        Whether the incoming message is from a bot (determines error delivery).
    impersonate_fn:
        Async callable ``(sa_sub: str) -> OboToken``; injected to allow mocking.
        Typically ``obo_exchange.impersonate_service_account``.

    Returns
    -------
    bool
        ``True`` → proceed with dispatch.
        ``False`` → abort (caller must ``return`` without calling ``_bind_obo_for_handler``).
    """
    # Resolve the effective mode: prefer run_as_mode, fall back to exec_mode alias.
    effective_mode = run_as_mode or exec_mode
    thread_ts = event.get("ts") if event else None
    if effective_mode != "service_account":
        # obo_user path — context["obo_token"] was set by the middleware; nothing to do.
        unlinked = context.get("unlinked_fallback", False) if context else False
        logger.info(
            "[{}] dispatch_identity: run_as=obo_user agent={} unlinked_fallback={} — using middleware token",
            thread_ts,
            agent_id,
            unlinked,
        )
        return True

    if not sa_sub or not sa_sub.strip():
        # Misconfigured route: run_as=service_account with no sub.
        logger.warning(
            "[{}] dispatch_identity: run_as=service_account agent={} has no "
            "service_account_sub — aborting dispatch (misconfigured route)",
            thread_ts,
            agent_id,
        )
        _send_error_notice(
            event=event,
            client=client,
            say=say,
            is_bot=is_bot,
            text=(
                "This agent route is misconfigured (service account route "
                "has no service_account_sub). Contact your admin."
            ),
        )
        return False

    # Mint SA token synchronously via a fresh event loop (same pattern as
    # _rbac_enrich_context in the middleware — Bolt handlers are sync).
    sa_loop: Optional[asyncio.AbstractEventLoop] = None
    try:
        sa_loop = asyncio.new_event_loop()
        sa_obo = sa_loop.run_until_complete(impersonate_fn(sa_sub))
        context["obo_token"] = sa_obo.access_token
        logger.info(
            "[{}] dispatch_identity: run_as=service_account agent={} sa={} ({}) — minted SA token",
            thread_ts,
            agent_id,
            sa_name or sa_sub,
            sa_sub,
        )
        return True
    except asyncio.CancelledError as exc:
        # PY-B2 / PY-S3: abort — never dispatch under the wrong identity.
        logger.warning(
            "[{}] dispatch_identity: run_as=service_account token mint cancelled "
            "agent={} sa={} ({}): {} — aborting dispatch to avoid running "
            "under wrong identity",
            thread_ts,
            agent_id,
            sa_name or sa_sub,
            sa_sub,
            exc,
        )
        _send_error_notice(
            event=event,
            client=client,
            say=say,
            is_bot=is_bot,
            text=(
                "This agent route is configured to run as a service account, "
                "but its access token could not be minted. "
                "Please try again shortly or contact your admin."
            ),
        )
        return False
    except Exception as exc:
        # PY-B2 / PY-S3: abort — never dispatch under the wrong identity.
        logger.warning(
            "[{}] dispatch_identity: run_as=service_account token mint failed "
            "agent={} sa={} ({}): {} — aborting dispatch to avoid running "
            "under wrong identity",
            thread_ts,
            agent_id,
            sa_name or sa_sub,
            sa_sub,
            exc,
        )
        _send_error_notice(
            event=event,
            client=client,
            say=say,
            is_bot=is_bot,
            text=(
                "This agent route is configured to run as a service account, "
                "but its access token could not be minted. "
                "Please try again shortly or contact your admin."
            ),
        )
        return False
    finally:
        if sa_loop is not None:
            sa_loop.close()


def _send_error_notice(
    *,
    event: dict[str, Any],
    client: Any,
    say: Any,
    is_bot: bool,
    text: str,
) -> None:
    """Post an ephemeral or in-thread error notice (PRC-3 delegate).

    Delegates to :func:`~utils.user_messages.send_error_notice` which holds
    the implementation. This wrapper is kept for backward compatibility so
    any existing callers within this module continue to work without changes.
    """
    _send_error_notice_impl(
        event=event,
        client=client,
        say=say,
        is_bot=is_bot,
        text=text,
    )

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Bolt registration boundary for Slack request handlers."""

from __future__ import annotations

import re
from typing import Any

from actions import (
  custom_error_handler,
  handle_app_home_opened,
  handle_assistant_thread_context_changed,
  handle_assistant_thread_started,
  handle_caipe_feedback,
  handle_caipe_retry,
  handle_delete_message,
  handle_escalation_get_help,
  handle_feedback_less_verbose,
  handle_feedback_modal_submission,
  handle_feedback_more_detail,
  handle_feedback_other,
  handle_feedback_wrong_answer,
  handle_hitl_action,
  handle_reaction_added,
  handle_reaction_removed,
  configure_actions,
)
from authorization import configure_authorization, rbac_global_middleware
from channel_routing import handle_mention, handle_message_events
from handler_dependencies import HandlerDependencies
from personal_routing import _register_slash_commands
from routing import configure_routing


def configure_handlers(dependencies: HandlerDependencies) -> None:
  """Install dependencies in each cohesive handler module."""
  configure_authorization(dependencies.for_authorization())
  configure_routing(dependencies)
  configure_actions(dependencies.for_actions())


def register_handlers(bolt_app: Any) -> None:
  """Attach all middleware, commands, events, actions, and views to Bolt."""
  _register_slash_commands(bolt_app)
  bolt_app.middleware(rbac_global_middleware)
  bolt_app.event("app_mention")(handle_mention)
  bolt_app.event("message")(handle_message_events)
  bolt_app.action(re.compile(r"hitl_.*"))(handle_hitl_action)
  bolt_app.action("caipe_feedback")(handle_caipe_feedback)
  bolt_app.action("caipe_feedback_more_detail")(handle_feedback_more_detail)
  bolt_app.action("caipe_feedback_less_verbose")(handle_feedback_less_verbose)
  bolt_app.action("caipe_retry")(handle_caipe_retry)
  bolt_app.action("caipe_escalation_get_help")(handle_escalation_get_help)
  bolt_app.action("caipe_delete_message")(handle_delete_message)
  bolt_app.action("caipe_feedback_wrong_answer")(handle_feedback_wrong_answer)
  bolt_app.action("caipe_feedback_other")(handle_feedback_other)
  bolt_app.view("caipe_feedback_modal")(handle_feedback_modal_submission)
  bolt_app.event("reaction_added")(handle_reaction_added)
  bolt_app.event("reaction_removed")(handle_reaction_removed)
  bolt_app.event("assistant_thread_context_changed")(
    handle_assistant_thread_context_changed
  )
  bolt_app.event("assistant_thread_started")(handle_assistant_thread_started)
  bolt_app.event("app_home_opened")(handle_app_home_opened)
  bolt_app.error(custom_error_handler)

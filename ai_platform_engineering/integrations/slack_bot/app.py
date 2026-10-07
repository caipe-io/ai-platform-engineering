# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Slack bot composition root."""

# Log redaction must be active before Slack Bolt and Slack SDK are imported.
from utils.log_redaction import install as _install_log_redaction

_install_log_redaction()

from bootstrap import SlackRuntime, build_runtime, run_runtime  # noqa: E402
from handler_dependencies import HandlerDependencies  # noqa: E402
from handlers import (  # noqa: E402
  configure_handlers,
  register_handlers,
)


def create_application() -> SlackRuntime:
  """Construct dependencies and register the Slack request boundary."""
  runtime = build_runtime()
  configure_handlers(
    HandlerDependencies(
      bolt_app=runtime.bolt_app,
      config=runtime.config,
      sse_client=runtime.sse_client,
      session_manager=runtime.session_manager,
      hitl_handler=runtime.hitl_handler,
      handled_response=runtime.handled_response,
      app_name=runtime.app_name,
      workspace_url=runtime.workspace_url,
      workspace_id=runtime.workspace_id,
      rbac_enabled=runtime.rbac_enabled,
      command_rate_limit=runtime.command_rate_limit,
      command_rate_window=runtime.command_rate_window,
      linking_prompt_cooldown=runtime.linking_prompt_cooldown,
    )
  )
  register_handlers(runtime.bolt_app)
  return runtime


runtime = create_application()
app = runtime.bolt_app


if __name__ == "__main__":
  run_runtime(runtime)

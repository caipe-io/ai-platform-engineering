# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Application-boundary tests for extracted Slack handler modules."""

from __future__ import annotations

import importlib
import pathlib
import sys
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import requests
import slack_bolt

from .handler_test_utils import load_handler_module


_APP_PY = pathlib.Path(__file__).resolve().parents[1] / "app.py"


def test_log_redaction_precedes_slack_runtime_imports() -> None:
  source = _APP_PY.read_text(encoding="utf-8")
  assert source.index("_install_log_redaction()") < source.index("from bootstrap import")


def test_composition_root_constructs_and_registers_once(monkeypatch) -> None:
  bootstrap = importlib.import_module("bootstrap")
  handlers = importlib.import_module("handlers")
  bolt_app = MagicMock()
  runtime = SimpleNamespace(
    bolt_app=bolt_app,
    config=MagicMock(),
    sse_client=MagicMock(),
    session_manager=MagicMock(),
    hitl_handler=MagicMock(),
    handled_response=SimpleNamespace(status=200, body=""),
    app_name="Example",
    workspace_url="https://example.com",
    workspace_id="example-workspace",
    rbac_enabled=True,
    command_rate_limit=5,
    command_rate_window=30.0,
    linking_prompt_cooldown=3600.0,
  )
  configure = MagicMock()
  register = MagicMock()
  monkeypatch.setattr(bootstrap, "build_runtime", MagicMock(return_value=runtime))
  monkeypatch.setattr(handlers, "configure_handlers", configure)
  monkeypatch.setattr(handlers, "register_handlers", register)
  sys.modules.pop("app", None)

  app_module = importlib.import_module("app")

  assert app_module.runtime is runtime
  assert app_module.app is bolt_app
  configure.assert_called_once()
  register.assert_called_once_with(bolt_app)


def test_handler_imports_have_no_runtime_side_effects(monkeypatch) -> None:
  app_constructor = MagicMock(side_effect=AssertionError("Bolt app constructed"))
  api_call = MagicMock(side_effect=AssertionError("API called"))
  sleep = MagicMock(side_effect=AssertionError("retry slept"))
  exit_process = MagicMock(side_effect=AssertionError("process exited"))

  monkeypatch.setattr(slack_bolt, "App", app_constructor)
  monkeypatch.setattr(requests, "get", api_call)
  monkeypatch.setattr(time, "sleep", sleep)
  monkeypatch.setattr(sys, "exit", exit_process)

  for module_name in (
    "actions",
    "authorization",
    "channel_routing",
    "conversation",
    "handlers",
    "personal_routing",
    "routing",
  ):
    sys.modules.pop(module_name, None)

  importlib.import_module("handlers")

  app_constructor.assert_not_called()
  api_call.assert_not_called()
  sleep.assert_not_called()
  exit_process.assert_not_called()


class _RecordingBoltApp:
  def __init__(self) -> None:
    self.registrations: list[tuple[str, object]] = []

  def _decorator(self, kind: str, selector: object):
    def register(handler):
      self.registrations.append((kind, selector))
      return handler

    return register

  def command(self, selector: object):
    return self._decorator("command", selector)

  def middleware(self, handler):
    self.registrations.append(("middleware", handler.__name__))
    return handler

  def event(self, selector: object):
    return self._decorator("event", selector)

  def action(self, selector: object):
    return self._decorator("action", selector)

  def view(self, selector: object):
    return self._decorator("view", selector)

  def error(self, handler):
    self.registrations.append(("error", handler.__name__))
    return handler


def test_registration_boundary_attaches_each_handler_family(monkeypatch) -> None:
  module = load_handler_module("handlers")
  bolt_app = _RecordingBoltApp()
  monkeypatch.setenv("SLACK_INTEGRATION_APP_NAME", "Example")

  module.register_handlers(bolt_app)

  kinds = [kind for kind, _selector in bolt_app.registrations]
  assert kinds.count("middleware") == 1
  assert kinds.count("command") == 3
  assert kinds.count("event") == 7
  assert kinds.count("action") == 9
  assert kinds.count("view") == 1
  assert kinds.count("error") == 1

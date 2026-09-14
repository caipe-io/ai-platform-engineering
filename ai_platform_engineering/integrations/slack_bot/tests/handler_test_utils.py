"""Test helpers for configuring extracted Slack handler modules."""

from __future__ import annotations

import importlib
import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

_APP_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

from handler_dependencies import HandlerDependencies  # noqa: E402
from utils.config import config  # noqa: E402
from utils.session_manager import SessionManager  # noqa: E402


_HANDLER_MODULES = (
    "actions",
    "authorization",
    "channel_routing",
    "conversation",
    "handlers",
    "personal_routing",
    "routing",
)


def load_handler_module(module_name: str, *, rbac_enabled: bool = False):
    """Import a fresh handler graph and install inert process dependencies."""
    for loaded_module in _HANDLER_MODULES:
        sys.modules.pop(loaded_module, None)

    authorization = importlib.import_module("authorization")
    routing = importlib.import_module("routing")
    actions = importlib.import_module("actions")

    dependencies = HandlerDependencies(
        bolt_app=MagicMock(),
        config=config,
        sse_client=MagicMock(),
        session_manager=SessionManager(),
        hitl_handler=MagicMock(),
        handled_response=SimpleNamespace(status=200, body=""),
        app_name="Example",
        workspace_url="https://example.com",
        workspace_id="example-workspace",
        rbac_enabled=rbac_enabled,
        command_rate_limit=5,
        command_rate_window=30.0,
        linking_prompt_cooldown=3600.0,
    )
    authorization.configure_authorization(dependencies.for_authorization())
    routing.configure_routing(dependencies)
    actions.configure_actions(dependencies.for_actions())
    return importlib.import_module(module_name)

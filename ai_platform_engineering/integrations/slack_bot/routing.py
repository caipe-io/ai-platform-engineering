# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Composition boundary for channel and personal Slack routing."""

from channel_routing import configure_channel_routing
from conversation import configure_conversation
from handler_dependencies import HandlerDependencies
from personal_routing import configure_personal_routing


def configure_routing(dependencies: HandlerDependencies) -> None:
  """Install dependencies in conversation, personal, and channel routing."""
  configure_conversation(dependencies.for_conversation())
  configure_personal_routing(dependencies.for_personal_routing())
  configure_channel_routing(dependencies.for_channel_routing())

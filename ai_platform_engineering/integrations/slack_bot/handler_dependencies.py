# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Shared dependency contract for Slack request handlers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sse_client import SSEClient
from utils.config_models import Config
from utils.hitl_handler import HITLCallbackHandler
from utils.session_manager import SessionManager


@dataclass(frozen=True)
class AuthorizationDependencies:
  """Collaborators used by identity enrichment and RBAC middleware."""

  handled_response: Any
  app_name: str
  workspace_id: str
  rbac_enabled: bool
  linking_prompt_cooldown: float


@dataclass(frozen=True)
class ConversationDependencies:
  """Collaborators used by conversation persistence and agent invocation."""

  config: Config
  sse_client: SSEClient
  workspace_url: str


@dataclass(frozen=True)
class ChannelRoutingDependencies:
  """Collaborators used by channel and mention routing."""

  bolt_app: Any
  config: Config
  sse_client: SSEClient
  session_manager: SessionManager
  app_name: str
  workspace_url: str
  rbac_enabled: bool


@dataclass(frozen=True)
class PersonalRoutingDependencies:
  """Collaborators used by direct-message and slash-command routing."""

  bolt_app: Any
  config: Config
  sse_client: SSEClient
  app_name: str
  workspace_url: str
  rbac_enabled: bool
  command_rate_limit: int
  command_rate_window: float


@dataclass(frozen=True)
class ActionDependencies:
  """Collaborators used by feedback, HITL, retry, and escalation actions."""

  bolt_app: Any
  config: Config
  sse_client: SSEClient
  session_manager: SessionManager
  hitl_handler: HITLCallbackHandler
  app_name: str


@dataclass(frozen=True)
class HandlerDependencies:
  """Aggregate dependency set owned only by the registration boundary."""

  bolt_app: Any
  config: Config
  sse_client: SSEClient
  session_manager: SessionManager
  hitl_handler: HITLCallbackHandler
  handled_response: Any
  app_name: str
  workspace_url: str
  workspace_id: str
  rbac_enabled: bool
  command_rate_limit: int
  command_rate_window: float
  linking_prompt_cooldown: float

  def for_authorization(self) -> AuthorizationDependencies:
    return AuthorizationDependencies(
      handled_response=self.handled_response,
      app_name=self.app_name,
      workspace_id=self.workspace_id,
      rbac_enabled=self.rbac_enabled,
      linking_prompt_cooldown=self.linking_prompt_cooldown,
    )

  def for_conversation(self) -> ConversationDependencies:
    return ConversationDependencies(
      config=self.config,
      sse_client=self.sse_client,
      workspace_url=self.workspace_url,
    )

  def for_channel_routing(self) -> ChannelRoutingDependencies:
    return ChannelRoutingDependencies(
      bolt_app=self.bolt_app,
      config=self.config,
      sse_client=self.sse_client,
      session_manager=self.session_manager,
      app_name=self.app_name,
      workspace_url=self.workspace_url,
      rbac_enabled=self.rbac_enabled,
    )

  def for_personal_routing(self) -> PersonalRoutingDependencies:
    return PersonalRoutingDependencies(
      bolt_app=self.bolt_app,
      config=self.config,
      sse_client=self.sse_client,
      app_name=self.app_name,
      workspace_url=self.workspace_url,
      rbac_enabled=self.rbac_enabled,
      command_rate_limit=self.command_rate_limit,
      command_rate_window=self.command_rate_window,
    )

  def for_actions(self) -> ActionDependencies:
    return ActionDependencies(
      bolt_app=self.bolt_app,
      config=self.config,
      sse_client=self.sse_client,
      session_manager=self.session_manager,
      hitl_handler=self.hitl_handler,
      app_name=self.app_name,
    )

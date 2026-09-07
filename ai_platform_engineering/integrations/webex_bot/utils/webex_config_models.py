# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Pydantic models for optional static Webex bot space routing config."""

from __future__ import annotations

import logging
import os
from typing import Any

from pydantic import BaseModel, Field

from ai_platform_engineering.integrations.slack_bot.utils.config_models import (
    AgentBinding,
    UsersConfig,
)

logger = logging.getLogger("caipe.webex_bot.webex_config_models")
DEFAULT_BOT_CONFIG_PATH = "/etc/caipe/bot-config.yaml"


class SpaceConfig(BaseModel):
    """Static route metadata for one Webex space (admin sync source)."""

    name: str
    agents: list[AgentBinding] = Field(default_factory=list)


class WebexBotConfig(BaseModel):
    """Deployment static Webex space routing config."""

    spaces: dict[str, SpaceConfig] = Field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "WebexBotConfig":
        """Load static Webex routing config from file or inline YAML."""

        import yaml

        raw_config: dict[str, Any]
        config_source = os.environ.get("WEBEX_INTEGRATION_BOT_CONFIG", "").strip()
        if config_source:
            if os.path.isfile(config_source):
                logger.info("Loading Webex bot config from file: %s", config_source)
                with open(config_source, encoding="utf-8") as config_file:
                    loaded = yaml.safe_load(config_file) or {}
            else:
                logger.info("Loading Webex bot config from inline YAML")
                loaded = yaml.safe_load(config_source) or {}
        elif os.path.isfile(DEFAULT_BOT_CONFIG_PATH):
            logger.info("Loading Webex bot config from %s", DEFAULT_BOT_CONFIG_PATH)
            with open(DEFAULT_BOT_CONFIG_PATH, encoding="utf-8") as config_file:
                loaded = yaml.safe_load(config_file) or {}
        else:
            logger.info("No Webex bot config found; starting with no static space routes")
            loaded = {}

        if not isinstance(loaded, dict):
            raise ValueError("Webex bot config must be a mapping")

        raw_config = loaded
        raw_spaces = raw_config.get("spaces") if isinstance(raw_config.get("spaces"), dict) else raw_config
        return cls(
            spaces={
                str(space_id): _space_config_from_raw(str(space_id), space_data)
                for space_id, space_data in raw_spaces.items()
            }
        )


def _space_config_from_raw(space_id: str, value: Any) -> SpaceConfig:
    if not isinstance(value, dict):
        raise ValueError(f"Webex space config for {space_id!r} must be a mapping")

    data = dict(value)
    if "agents" not in data:
        agent_id = data.get("agent_id")
        if isinstance(agent_id, str) and agent_id.strip():
            data["agents"] = [
                AgentBinding(
                    agent_id=agent_id.strip(),
                    users=UsersConfig(enabled=True, listen="all"),
                )
            ]
    data.setdefault("name", space_id)
    return SpaceConfig(**data)

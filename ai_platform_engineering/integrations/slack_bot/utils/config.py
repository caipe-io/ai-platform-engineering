# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
CAIPE Slack Bot configuration loading and initialization.
"""

from loguru import logger
from .config_models import Config

# Load all configuration
config = Config.from_env()
if config.channels:
  logger.info(f"Loaded configuration for {len(config.channels)} channel(s)")
else:
  logger.warning("No channels configured — bot will ignore all channel messages until config is provided")

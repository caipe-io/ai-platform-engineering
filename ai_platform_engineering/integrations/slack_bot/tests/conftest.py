# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Pytest configuration.
Provides fixtures and default setup for all tests.
"""

import os

# Set env vars BEFORE pytest collects tests (which imports modules at collection time)
os.environ["DYNAMIC_AGENTS_URL"] = "http://localhost:8001"
os.environ["SLACK_INTEGRATION_BOT_TOKEN"] = "xoxb-test-token"
os.environ["SLACK_INTEGRATION_BOT_CONFIG"] = """
C123:
  name: "#test-channel"
  agents:
    - agent_id: "test-agent"
      users:
        enabled: true
        listen: "mention"
        overthink:
          enabled: false
"""

# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

import os

from ai_platform_engineering.agents.cloudability.agent_cloudability.agentcard import (
    agent_skill,
    create_agent_card,
)
from ai_platform_engineering.utils.agntcy.agntcy_remote_agent_connect import (
    AgntcySlimRemoteAgentConnectTool,
)

SLIM_ENDPOINT = os.getenv("SLIM_ENDPOINT", "http://slim-dataplane:46357")

agent_card = create_agent_card(SLIM_ENDPOINT)
tool_map = {
    agent_card.name: agent_skill.examples,
}

a2a_remote_agent = AgntcySlimRemoteAgentConnectTool(
    name="cloudability_tools_agent",
    description=agent_card.description,
    endpoint=SLIM_ENDPOINT,
    remote_agent_card=agent_card,
)

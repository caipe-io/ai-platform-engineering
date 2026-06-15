# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

import os

from ai_platform_engineering.agents.cloudability.agent_cloudability.agentcard import (
    agent_skill,
    create_agent_card,
)
from ai_platform_engineering.utils.a2a_common.a2a_remote_agent_connect import (
    A2ARemoteAgentConnectTool,
)

AGENT_HOST = os.getenv("CLOUDABILITY_AGENT_HOST", "localhost")
AGENT_PORT = os.getenv("CLOUDABILITY_AGENT_PORT", "8000")
agent_url = f"http://{AGENT_HOST}:{AGENT_PORT}"

agent_card = create_agent_card(agent_url)
tool_map = {
    agent_card.name: agent_skill.examples,
}

a2a_remote_agent = A2ARemoteAgentConnectTool(
    name="cloudability_tools_agent",
    description=agent_card.description,
    remote_agent_card=agent_card,
    skill_id=agent_skill.id,
)

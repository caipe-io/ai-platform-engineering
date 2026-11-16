# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

from agent_cloudability.protocol_bindings.a2a_server.agent import CloudabilityAgent
from ai_platform_engineering.utils.a2a_common.base_langgraph_agent_executor import (
    BaseLangGraphAgentExecutor,
)


class CloudabilityAgentExecutor(BaseLangGraphAgentExecutor):
    """Cloudability AgentExecutor using the shared LangGraph executor."""

    def __init__(self):
        super().__init__(CloudabilityAgent())

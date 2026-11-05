# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Cloudability Agent implementation using common A2A base classes."""

import logging
import os
from typing import Literal

from cnoe_agent_utils.tracing import trace_agent_stream
from pydantic import BaseModel

from ai_platform_engineering.utils.a2a_common.base_langgraph_agent import BaseLangGraphAgent
from ai_platform_engineering.utils.subagent_prompts import load_subagent_prompt_config


class ResponseFormat(BaseModel):
    """Respond to the user in this format."""

    status: Literal["input_required", "completed", "error"] = "input_required"
    message: str


_prompt_config = load_subagent_prompt_config("cloudability")


class CloudabilityAgent(BaseLangGraphAgent):
    """Cloudability Agent for FinOps and cloud cost operations."""

    SYSTEM_INSTRUCTION = _prompt_config.get_system_instruction()
    RESPONSE_FORMAT_INSTRUCTION = _prompt_config.response_format_instruction

    def get_agent_name(self) -> str:
        return "cloudability"

    def get_system_instruction(self) -> str:
        return self.SYSTEM_INSTRUCTION

    def get_response_format_instruction(self) -> str:
        return self.RESPONSE_FORMAT_INSTRUCTION

    def get_response_format_class(self) -> type[BaseModel]:
        return ResponseFormat

    def get_mcp_config(self, server_path: str) -> dict:
        """Return MCP configuration for stdio mode."""
        env = {
            "CLOUDABILITY_API_URL": os.getenv(
                "CLOUDABILITY_API_URL",
                "https://api.cloudability.com/v3",
            ),
            "CLOUDABILITY_REGION": os.getenv("CLOUDABILITY_REGION", ""),
            "CLOUDABILITY_API_KEY": os.getenv("CLOUDABILITY_API_KEY", ""),
            "CLOUDABILITY_API_PUBLIC_KEY": (
                os.getenv("CLOUDABILITY_API_PUBLIC_KEY")
                or os.getenv("CLOUDABILITY_PUBLIC_KEY")
                or os.getenv("CLOUDABILITY_API_KEY_PUBLIC_KEY")
                or os.getenv("CLOUDABILITY_API_KEY_ID")
                or ""
            ),
            "CLOUDABILITY_API_PRIVATE_KEY": (
                os.getenv("CLOUDABILITY_API_PRIVATE_KEY")
                or os.getenv("CLOUDABILITY_PRIVATE_KEY")
                or os.getenv("CLOUDABILITY_API_KEY_PRIVATE_KEY")
                or os.getenv("CLOUDABILITY_API_KEY_SECRET")
                or ""
            ),
            "APPTIO_OPENTOKEN": (
                os.getenv("APPTIO_OPENTOKEN")
                or os.getenv("CLOUDABILITY_APPTIO_OPENTOKEN")
                or ""
            ),
            "APPTIO_ENVIRONMENT_ID": (
                os.getenv("APPTIO_ENVIRONMENT_ID")
                or os.getenv("CLOUDABILITY_ENVIRONMENT_ID")
                or ""
            ),
        }

        has_api_key_pair = bool(env["CLOUDABILITY_API_PUBLIC_KEY"] and env["CLOUDABILITY_API_PRIVATE_KEY"])
        if not env["CLOUDABILITY_API_KEY"] and not has_api_key_pair and not env["APPTIO_OPENTOKEN"]:
            raise ValueError(
                "Set CLOUDABILITY_API_PUBLIC_KEY/CLOUDABILITY_API_PRIVATE_KEY, "
                "CLOUDABILITY_API_KEY, or APPTIO_OPENTOKEN/APPTIO_ENVIRONMENT_ID "
                "to use the Cloudability MCP server."
            )

        return {
            "command": "uv",
            "args": ["run", "--project", os.path.dirname(server_path), server_path],
            "env": env,
            "transport": "stdio",
        }

    def get_tool_working_message(self) -> str:
        return _prompt_config.tool_working_message

    def get_tool_processing_message(self) -> str:
        return _prompt_config.tool_processing_message

    @trace_agent_stream("cloudability")
    async def stream(self, query: str, sessionId: str, trace_id: str = None):
        logger = logging.getLogger(__name__)
        try:
            async for event in super().stream(query, sessionId, trace_id):
                yield event
        except Exception as e:
            logger.error("Unexpected Cloudability agent error: %s", str(e), exc_info=True)
            yield {
                "is_task_complete": True,
                "require_user_input": False,
                "kind": "error",
                "content": (
                    "An unexpected error occurred in Cloudability: "
                    f"{str(e)}\n\nPlease try again or contact support if the issue persists."
                ),
            }

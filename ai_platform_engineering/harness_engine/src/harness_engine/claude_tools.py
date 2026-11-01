"""Expose selected CAIPE tools to the SDK without passing MCP credentials to it."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx2 as httpx
from claude_agent_sdk import SdkMcpTool, create_sdk_mcp_server

from harness_engine.config import Settings
from harness_engine.models import RunContext

logger = logging.getLogger(__name__)


class ClaudeToolBroker:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.url = (settings.claude_tool_broker_url or os.getenv("AUTHZ_SERVICE_URL", "")).rstrip("/")
        self.transport = transport

    @asynccontextmanager
    async def bind(self, context: RunContext) -> AsyncIterator[tuple[dict[str, Any], dict[str, str]]]:
        if not context.blueprint.tools.bindings:
            yield {}, {}
            return
        if not self.url or context.identity is None or context.identity.subject != context.binding.owner_subject:
            raise PermissionError("Selected tools require the CAIPE broker and delegated caller identity")
        if context.blueprint.tools.approval_policy != "never":
            raise ValueError("SDK MCP tools require an explicit policy without per-call approvals")
        headers = {"Authorization": f"Bearer {context.identity.bearer.get_secret_value()}"}
        if context.turn.traceparent:
            headers["traceparent"] = context.turn.traceparent
        path = f"{self.url}/api/harness-engine/runs/{context.turn.run_id}/tools"
        async with httpx.AsyncClient(transport=self.transport, headers=headers, timeout=960.0) as client:
            listed = await client.post(path, json={"operation": "list"})
            listed.raise_for_status()
            body = listed.json()
            if not body.get("success"):
                raise PermissionError("The tool broker rejected the selected tools")
            schemas = body["data"]["tools"]
            expected = {binding.tool_id for binding in context.blueprint.tools.bindings}
            if len(schemas) != len(expected) or {tool["tool_id"] for tool in schemas} != expected:
                raise ValueError("The tool broker returned a different allowlist")
            tools: list[SdkMcpTool[Any]] = []
            names: dict[str, str] = {}
            pending: set[asyncio.Task[dict[str, Any]]] = set()
            by_id = {schema["tool_id"]: schema for schema in schemas}
            for index, binding in enumerate(context.blueprint.tools.bindings):
                schema = by_id[binding.tool_id]
                alias = f"tool_{index}"
                tool_id = schema["tool_id"]
                names[f"mcp__caipe__{alias}"] = tool_id

                def handler_for(selected: str) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
                    async def send(arguments: dict[str, Any]) -> dict[str, Any]:
                        # Side-effecting calls are sent once. A failed response never
                        # causes the broker to repeat an ambiguous tool invocation.
                        try:
                            response = await client.post(
                                path, json={"operation": "call", "tool_id": selected, "arguments": arguments}
                            )
                            response.raise_for_status()
                        except httpx.HTTPError as error:
                            logger.warning(
                                "SDK MCP call failed",
                                extra={
                                    "run_id": context.turn.run_id,
                                    "error_type": type(error).__name__,
                                },
                            )
                            raise RuntimeError(
                                "MCP tool result could not be confirmed; do not retry automatically"
                            ) from None
                        result = response.json()
                        if not result.get("success") or not isinstance(result.get("data"), dict):
                            raise RuntimeError("MCP tool invocation did not return a result")
                        return result["data"]

                    async def invoke(arguments: dict[str, Any]) -> dict[str, Any]:
                        call = asyncio.create_task(send(arguments))
                        pending.add(call)
                        try:
                            # Stopping the SDK cannot prove that a dispatched MCP
                            # operation stopped. Drain its response before reuse.
                            return await asyncio.shield(call)
                        finally:
                            if call.done():
                                pending.discard(call)

                    return invoke

                tools.append(
                    SdkMcpTool(
                        name=alias,
                        description=f"{tool_id}: {schema.get('description', '')}",
                        input_schema=schema["input_schema"],
                        handler=handler_for(tool_id),
                    )
                )
            try:
                yield {"caipe": create_sdk_mcp_server(name="caipe", version="1", tools=tools)}, names
            finally:
                if pending:
                    outcomes = await asyncio.gather(*pending, return_exceptions=True)
                    for outcome in outcomes:
                        if isinstance(outcome, BaseException):
                            logger.warning(
                                "Dispatched SDK tool did not return a confirmed result",
                                extra={
                                    "run_id": context.turn.run_id,
                                    "error_type": type(outcome).__name__,
                                },
                            )

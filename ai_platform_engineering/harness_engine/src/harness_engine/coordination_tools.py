"""Owner-authorized chat handoffs through the BFF's durable delivery queue."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx2 as httpx

from harness_engine.models import RunContext


async def coordination_tools(
    context: RunContext, url: str, transport: httpx.AsyncBaseTransport | None = None
) -> list[tuple[dict[str, Any], Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]]]:
    if not context.turn.coordination_enabled or not url or context.identity is None:
        return []
    path = f"{url.rstrip('/')}/api/harness-engine/runs/{context.turn.run_id}/coordination"
    headers = {"Authorization": f"Bearer {context.identity.bearer.get_secret_value()}"}
    async with httpx.AsyncClient(transport=transport, timeout=15.0) as client:
        response = await client.post(path, headers=headers, json={"operation": "list"})
        response.raise_for_status()
        schemas = response.json()["data"]["tools"]
    if not schemas:
        return []
    if len(schemas) != 1 or schemas[0].get("tool_id") != "handoff_to_agent":
        raise ValueError("Unexpected coordination capability")

    async def handoff(arguments: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(transport=transport, timeout=15.0) as client:
            result = await client.post(path, headers=headers, json={"operation": "call", "arguments": arguments})
            result.raise_for_status()
            return result.json()["data"]

    return [(schemas[0], handoff)]

"""Remote A2A agent tools for Dynamic Agents.

Wraps an A2A-compatible remote agent as a plain LangChain tool so the
LangGraph agent can delegate to it with a normal tool call:

    dynamic-agents ──tool call──> POST {a2a_url}  (JSON-RPC ``tasks/send``)

No A2A SDK is needed on this side — ``tasks/send`` is a JSON-RPC POST over
``httpx``. The agent card at ``/.well-known/agent.json`` supplies the tool
name and description the LLM sees, so a remote agent describes itself.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from dynamic_agents.auth.token_context import current_user_token

logger = logging.getLogger(__name__)

AGENT_CARD_PATH = "/.well-known/agent.json"
AGENT_CARD_TIMEOUT_SECONDS = 10

_UNSAFE_NAME_CHARS = re.compile(r"[^a-zA-Z0-9_-]+")


def _sanitize_tool_name(raw: str) -> str:
    """Reduce an agent card name to a tool name the LLM APIs accept."""
    return _UNSAFE_NAME_CHARS.sub("_", raw).strip("_").lower()


def _part_text(part: Any) -> str | None:
    """Return the text of an A2A message/artifact part, if it is a text part.

    A2A spec revisions tag parts with either ``type`` or ``kind``; accept both.
    """
    if not isinstance(part, dict):
        return None
    if part.get("type", part.get("kind")) != "text":
        return None
    text = part.get("text")
    return text if isinstance(text, str) else None


def _extract_result_text(data: dict[str, Any]) -> str:
    """Flatten an A2A ``tasks/send`` JSON-RPC response into text.

    Raises:
        RuntimeError: if the remote agent returned a JSON-RPC error.
    """
    error = data.get("error")
    if error:
        message = error.get("message", error) if isinstance(error, dict) else error
        raise RuntimeError(f"Remote agent returned an error: {message}")

    result = data.get("result") or {}

    texts = [
        text
        for artifact in result.get("artifacts") or []
        if isinstance(artifact, dict)
        for part in artifact.get("parts") or []
        if (text := _part_text(part))
    ]

    # Agents that answer without producing an artifact put the reply on the
    # task status message instead.
    if not texts:
        status_message = (result.get("status") or {}).get("message") or {}
        texts = [
            text for part in status_message.get("parts") or [] if (text := _part_text(part))
        ]

    return "\n".join(texts) or str(result)


class _RemoteAgentInput(BaseModel):
    message: str = Field(description="The message to send to the remote agent")


class RemoteAgentTool(BaseTool):
    """LangChain tool that delegates to an A2A-compatible remote agent."""

    name: str
    description: str
    a2a_url: str
    bearer_token: str | None = None
    timeout: int = 120

    args_schema: type[BaseModel] = _RemoteAgentInput

    def _run(self, message: str) -> str:
        raise NotImplementedError("RemoteAgentTool is async-only; use ainvoke()")

    async def _arun(self, message: str) -> str:
        # Prefer the token bound to the current request over the one captured
        # when the tool was built: agent runtimes are cached and replayed
        # across requests, so a captured token goes stale. Same per-request
        # forwarding contract as the MCP httpx client factory.
        token = current_user_token.get() or self.bearer_token

        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        payload = {
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "id": str(uuid.uuid4()),
            "params": {
                "id": str(uuid.uuid4()),
                "message": {
                    "role": "user",
                    "parts": [{"type": "text", "text": message}],
                },
            },
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(self.a2a_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        return _extract_result_text(data)


async def _fetch_agent_card(a2a_url: str) -> dict[str, Any] | None:
    """Fetch ``/.well-known/agent.json`` for a remote agent, or None if unavailable.

    A remote agent that is still starting up must not fail agent
    initialization, so every failure degrades to ``None``.
    """
    card_url = urljoin(a2a_url, AGENT_CARD_PATH)
    try:
        async with httpx.AsyncClient(timeout=AGENT_CARD_TIMEOUT_SECONDS) as client:
            resp = await client.get(card_url)
            resp.raise_for_status()
            card = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"Could not fetch A2A agent card from {card_url}: {e}")
        return None
    return card if isinstance(card, dict) else None


def _fallback_name(a2a_url: str) -> str:
    """Name a remote agent after its host when no agent card is available.

    Deriving from the URL keeps two unreachable agents from colliding on a
    single generic tool name, which would break the LLM tool binding.
    """
    return _sanitize_tool_name(urlparse(a2a_url).hostname or "") or "remote_agent"


async def create_remote_agent_tool(
    *,
    a2a_url: str,
    name: str | None = None,
    description: str | None = None,
    bearer_token: str | None = None,
    timeout: int = 120,
) -> RemoteAgentTool:
    """Fetch the A2A agent card and return a LangChain tool wrapping it.

    Args:
        a2a_url: JSON-RPC endpoint of the remote agent (``tasks/send`` target).
        name: Tool name override; defaults to the agent card name.
        description: Tool description override; defaults to the agent card description.
        bearer_token: Fallback token used only when no per-request token is bound.
        timeout: Per-call timeout in seconds for ``tasks/send``.
    """
    resolved_name = name
    resolved_desc = description

    if not (resolved_name and resolved_desc):
        card = await _fetch_agent_card(a2a_url) or {}
        resolved_name = resolved_name or _sanitize_tool_name(card.get("name") or "")
        resolved_desc = resolved_desc or card.get("description")

    return RemoteAgentTool(
        name=resolved_name or _fallback_name(a2a_url),
        description=resolved_desc or f"Remote agent at {a2a_url}",
        a2a_url=a2a_url,
        bearer_token=bearer_token,
        timeout=timeout,
    )

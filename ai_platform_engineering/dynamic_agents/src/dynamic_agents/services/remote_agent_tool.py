"""Remote A2A agent tools for Dynamic Agents.

Wraps an A2A-compatible remote agent as a plain LangChain tool so the
LangGraph agent can delegate to it with a normal tool call:

    dynamic-agents ──tool call──> POST {a2a_url}  (JSON-RPC ``tasks/send``)

No A2A SDK is needed on this side: ``tasks/send`` is a JSON-RPC POST over
``httpx``. The agent card supplies the tool name and description the LLM sees,
so a remote agent describes itself. Cards are fetched from
``/.well-known/agent-card.json``, falling back to the pre-0.3.0
``/.well-known/agent.json``, and cached by URL so repeated runtime builds do not
refetch them.
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

# A2A publishes the public agent card here. The path changed in a2a-sdk 0.3.0:
# 0.2.x served `/.well-known/agent.json`, and 0.3.0 moved to
# `/.well-known/agent-card.json` while keeping the old value as
# `PREV_AGENT_CARD_WELL_KNOWN_PATH` for the transition. 1.x dropped the old path
# entirely. We ask for the current path first and fall back to the previous one,
# so a conforming server and a 0.2.x server both resolve.
AGENT_CARD_PATH = "/.well-known/agent-card.json"
LEGACY_AGENT_CARD_PATH = "/.well-known/agent.json"
AGENT_CARD_TIMEOUT_SECONDS = 10

_UNSAFE_NAME_CHARS = re.compile(r"[^a-zA-Z0-9_-]+")

# Resolved agent cards, keyed by A2A URL. Two reasons this is a cache and not a
# per-runtime field:
#
# 1. Agent runtimes are rebuilt often (AgentRuntimeCache evicts on a 600s idle
#    TTL and on config change), and refetching every card on every rebuild is
#    pure latency for data that rarely changes.
# 2. Keyed by URL, not by agent, so the per-agent selection in #2013's follow-up
#    only decides *which* tools get built. It does not change how cards are
#    resolved, and two agents pointing at the same remote share one fetch.
#
# Failures are deliberately not cached. A remote agent that is still starting up
# would otherwise be stuck with a URL-derived name and a generic description for
# as long as the process lived; not caching the failure means the next runtime
# build retries and the agent self-heals within the cache TTL.
_agent_card_cache: dict[str, dict[str, Any]] = {}


def clear_agent_card_cache() -> None:
    """Drop every cached agent card. Intended for tests and config reloads."""
    _agent_card_cache.clear()


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
    """Fetch the A2A agent card for a remote agent, or None if unavailable.

    Tries the current well-known path, then the pre-0.3.0 one. Only a 404 is
    retried against the legacy path: any other status means the server answered
    and does not want to serve us a card, so asking a second time is noise.

    A remote agent that is still starting up must not fail agent
    initialization, so every failure degrades to ``None``. Note that the caller
    then substitutes a URL-derived name and a generic description, which the LLM
    cannot route on — so a persistent failure here quietly costs the tool its
    usefulness rather than raising.
    """
    async with httpx.AsyncClient(timeout=AGENT_CARD_TIMEOUT_SECONDS) as client:
        for path in (AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH):
            card_url = urljoin(a2a_url, path)
            try:
                resp = await client.get(card_url)
                resp.raise_for_status()
                card = resp.json()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404 and path != LEGACY_AGENT_CARD_PATH:
                    logger.debug(f"No agent card at {card_url}; trying the legacy path")
                    continue
                logger.warning(f"Could not fetch A2A agent card from {card_url}: {e}")
                return None
            except (httpx.HTTPError, ValueError) as e:
                logger.warning(f"Could not fetch A2A agent card from {card_url}: {e}")
                return None
            if isinstance(card, dict):
                return card
            logger.warning(f"Agent card at {card_url} was not a JSON object")
            return None
    return None


async def _resolve_agent_card(a2a_url: str) -> dict[str, Any] | None:
    """Return this agent's card, from cache when we already have it.

    Only successes are remembered, so an agent that was down at the last build
    is retried at the next one rather than being written off for the lifetime of
    the process.
    """
    cached = _agent_card_cache.get(a2a_url)
    if cached is not None:
        return cached
    card = await _fetch_agent_card(a2a_url)
    if card is not None:
        _agent_card_cache[a2a_url] = card
    return card


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
        card = await _resolve_agent_card(a2a_url) or {}
        resolved_name = resolved_name or _sanitize_tool_name(card.get("name") or "")
        resolved_desc = resolved_desc or card.get("description")

    return RemoteAgentTool(
        name=resolved_name or _fallback_name(a2a_url),
        description=resolved_desc or f"Remote agent at {a2a_url}",
        a2a_url=a2a_url,
        bearer_token=bearer_token,
        timeout=timeout,
    )

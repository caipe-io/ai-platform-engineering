"""Remote A2A agent registry probe using the official SDK card resolver."""

from __future__ import annotations

import logging
from typing import Annotated
from urllib.parse import urlparse

import httpx
from a2a.client import A2ACardResolver, AgentCardResolutionError
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.auth.token_context import current_user_token

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/remote-agents", tags=["remote-agents"])


class RemoteAgentProbeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)


class RemoteAgentProbeResponse(BaseModel):
    name: str
    description: str
    protocol_version: str | None = None
    protocol_bindings: list[str]


@router.post("/probe", response_model=RemoteAgentProbeResponse)
async def probe_remote_agent(
    payload: RemoteAgentProbeRequest,
    _user: Annotated[UserContext, Depends(get_user_context)],
) -> RemoteAgentProbeResponse:
    """Resolve an Agent Card through the official A2A SDK."""
    parsed = urlparse(payload.endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Endpoint must be an HTTP or HTTPS URL")

    token = current_user_token.get()
    headers = {"Authorization": f"Bearer {token}"} if token else None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0), headers=headers) as client:
            card = await A2ACardResolver(client, payload.endpoint).get_agent_card()
    except (AgentCardResolutionError, httpx.HTTPError, ValueError) as exc:
        logger.info("A2A card probe failed for %s: %s", payload.endpoint, exc)
        raise HTTPException(status_code=502, detail=f"Could not resolve A2A Agent Card: {exc}") from exc

    interfaces = list(getattr(card, "supported_interfaces", []) or [])
    return RemoteAgentProbeResponse(
        name=card.name,
        description=card.description,
        protocol_version=interfaces[0].protocol_version if interfaces else None,
        protocol_bindings=list(dict.fromkeys(interface.protocol_binding for interface in interfaces)),
    )

"""Remote A2A agent registry probe using the official SDK card resolver."""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Literal

import httpx
from a2a.client import A2ACardResolver, AgentCardResolutionError
from fastapi import APIRouter, Depends, HTTPException
from google.protobuf.json_format import MessageToDict
from pydantic import BaseModel, Field

from dynamic_agents.auth.authz import require_org_admin_permission
from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.config import get_settings
from dynamic_agents.models import RemoteAgentCredentialSource
from dynamic_agents.services.a2a_destination import A2ADestinationPolicy, agent_card_location
from dynamic_agents.services.a2a_kubernetes_discovery import discover_services
from dynamic_agents.services.a2a_limits import A2ABoundedTransport
from dynamic_agents.services.remote_agent_tool import resolve_remote_agent_auth_headers

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/remote-agents", tags=["remote-agents"])


class RemoteAgentProbeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
    credential_source: RemoteAgentCredentialSource | None = None


class RemoteAgentProbeResponse(BaseModel):
    name: str
    description: str
    protocol_version: str | None = None
    protocol_bindings: list[str]
    supports_streaming: bool = False
    agent_card: dict = Field(default_factory=dict)


async def read_agent_card(payload: RemoteAgentProbeRequest) -> RemoteAgentProbeResponse:
    """Resolve an Agent Card through the official A2A SDK."""
    settings = get_settings()
    try:
        policy = A2ADestinationPolicy(payload.endpoint, settings.remote_a2a_allowed_http_origins)
        base_url, card_path = agent_card_location(payload.endpoint)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = current_user_token.get()
    try:
        async with asyncio.timeout(10.0):
            headers = await resolve_remote_agent_auth_headers(
                payload.credential_source.model_dump() if payload.credential_source else None,
                caller_token=token,
                credential_api_url=settings.credential_api_url,
                credential_service_audience=settings.credential_service_audience,
            )
            async with httpx.AsyncClient(
                transport=A2ABoundedTransport(min(settings.remote_a2a_max_response_bytes, 1024 * 1024)),
                timeout=httpx.Timeout(10.0), follow_redirects=False, event_hooks={"request": [policy.request_hook(headers)]}
            ) as client:
                card = await A2ACardResolver(client, base_url).get_agent_card(relative_card_path=card_path)
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="A2A Agent Card discovery exceeded its 10 second deadline") from exc
    except (AgentCardResolutionError, httpx.HTTPError, ValueError, RuntimeError) as exc:
        logger.info("A2A card probe failed for %s: %s", payload.endpoint, exc)
        raise HTTPException(status_code=502, detail="Could not resolve A2A Agent Card with the configured destination and authentication") from exc

    interfaces = list(getattr(card, "supported_interfaces", []) or [])
    return RemoteAgentProbeResponse(
        supports_streaming=card.capabilities.streaming,
        name=card.name,
        description=card.description,
        protocol_version=interfaces[0].protocol_version if interfaces else None,
        protocol_bindings=list(dict.fromkeys(interface.protocol_binding for interface in interfaces)),
        agent_card=MessageToDict(card),
    )


@router.post("/probe", response_model=RemoteAgentProbeResponse)
async def probe_remote_agent(payload: RemoteAgentProbeRequest,
    _authorized: Annotated[None, Depends(require_org_admin_permission)]) -> RemoteAgentProbeResponse:
    return await read_agent_card(payload)


@router.get("/discovery")
async def discovery_configuration(_authorized: Annotated[None, Depends(require_org_admin_permission)]) -> dict:
    namespaces = get_settings().remote_a2a_discovery_namespaces
    return {"namespaces": namespaces, "kubernetes_enabled": bool(namespaces)}


class DiscoveryRequest(BaseModel):
    source: Literal["urls", "kubernetes"]
    urls: list[Annotated[str, Field(min_length=1, max_length=2048)]] = Field(default_factory=list, max_length=8)
    namespace: str = Field(default="", max_length=63)


@router.post("/discover")
async def discover_remote_agents(payload: DiscoveryRequest,
    _authorized: Annotated[None, Depends(require_org_admin_permission)]) -> dict:
    settings = get_settings()
    if payload.source == "kubernetes":
        try:
            items = await discover_services(payload.namespace, settings.remote_a2a_discovery_namespaces, settings.remote_a2a_cluster_domain)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (OSError, TimeoutError, httpx.HTTPError, RuntimeError) as exc:
            raise HTTPException(status_code=502, detail="Kubernetes discovery unavailable; check the namespace configuration and read-only Service/EndpointSlice permissions") from exc
        return {"items": items}
    if not payload.urls:
        raise HTTPException(status_code=400, detail="Provide at least one discovery URL")
    semaphore = asyncio.Semaphore(4)

    async def discover_url(endpoint: str) -> dict:
        async with semaphore:
            try:
                # Public discovery never forwards the operator's JWT or saved credentials.
                card = await read_agent_card(RemoteAgentProbeRequest(endpoint=endpoint, credential_source=RemoteAgentCredentialSource(kind="none")))
                return {"endpoint": endpoint, **card.model_dump(exclude={"agent_card"})}
            except HTTPException as exc:
                return {"endpoint": endpoint, "error": str(exc.detail)}
    return {"items": await asyncio.gather(*(discover_url(url) for url in dict.fromkeys(url.strip() for url in payload.urls)))}

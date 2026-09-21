"""Agent inspection endpoints for the Dynamic Agents service.

Currently exposes a single thin reachability probe used by the
autonomous-agents service to verify that a configured ``dynamic_agent_id``
actually points at a real agent before it tries to schedule executions
through it. The probe is intentionally tiny -- it returns just enough
metadata for the autonomous-agents UI to render an "Ack OK" badge with
the agent's display name, and nothing else.

Why a dedicated probe instead of reusing a list/get endpoint:
* The full list/CRUD path for dynamic agents is owned by the UI's
  Next.js admin route (which talks to MongoDB via its own server-side
  helpers) -- adding a second public CRUD here would create two
  authorities for the same data.
* The probe is a pure existence check. It does not return system
  prompts, tool allowlists, or any other field that could leak the
  agent's internals to a less-privileged service-to-service caller.

Trust model: identical to every other route in this service -- the
``X-User-Context`` header is gateway-trusted via ``get_user_context``.
For probes coming from autonomous-agents the gateway is the
autonomous-agents service itself, which mints a synthetic system
identity (see ``autonomous_agents.services.dynamic_agents_client``).
Hardening that synthetic header into a signed service token is a
recommended follow-up, called out in the migration plan.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.models import UserContext
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/{agent_id}/probe")
async def probe_agent(
    agent_id: str,
    _user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Reachability probe for a single dynamic agent.

    Returns the agent's id, display name, and ``enabled`` flag so the
    autonomous-agents preflight can render a meaningful Ack badge
    without needing to pull the full agent config.

    Returns 404 when the id is not found rather than mapping it to a
    generic "ok / not ok" payload -- the caller already special-cases
    404 to render an actionable "agent was deleted" message.
    """
    agent = mongo.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

    return {
        "id": agent.id,
        "name": agent.name,
        "enabled": getattr(agent, "enabled", True),
    }

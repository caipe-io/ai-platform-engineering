"""Explicit publication of public agent identity definitions; no runtime config CRUD."""

from fastapi import APIRouter, Depends, HTTPException

from dynamic_agents.auth.auth import require_admin
from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.services.agent_badges import AgentBadgePublisher, BadgePublicationError
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service

router = APIRouter(prefix="/agents", tags=["agent identity"])


@router.post("/{agent_id}/badge")
async def publish_agent_badge(
    agent_id: str,
    record: dict,
    _user: UserContext = Depends(require_admin),
    settings: Settings = Depends(get_settings),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Publish an explicitly approved public definition; return a publication receipt."""
    if not settings.agntcy_identity_enabled:
        raise HTTPException(status_code=404, detail="Agent Badge publication is disabled")
    agent = mongo.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    try:
        return await AgentBadgePublisher(settings).publish(agent_id, agent.name, record)
    except BadgePublicationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

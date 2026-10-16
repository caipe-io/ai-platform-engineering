"""Authenticated discovery of operator-admitted sandbox execution profiles."""

from fastapi import APIRouter, Depends, HTTPException

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.services.sandbox_client import SandboxClient, SandboxError

router = APIRouter(prefix="/runtime-profiles", tags=["agents"])


@router.get("")
async def runtime_profiles(_user: UserContext = Depends(get_user_context)) -> dict:
    settings = get_settings()
    if not settings.sandbox_service_url:
        return {"profiles": []}
    try:
        profiles = await SandboxClient(settings).profiles()
    except SandboxError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"profiles": [{
        **profile.model_dump(), "capabilities": {
            "mcp": profile.capabilities.get("mcp", False) and bool(settings.harness_tools_public_url),
            "skills": profile.capabilities.get("skills", False),
            "attachments": profile.capabilities.get("attachments", False),
        },
    } for profile in profiles if profile.capabilities.get("mcp", False) and settings.harness_tools_public_url]}

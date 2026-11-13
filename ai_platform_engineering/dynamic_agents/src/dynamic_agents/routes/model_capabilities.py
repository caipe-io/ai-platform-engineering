"""Authenticated model-capability discovery."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import get_settings
from dynamic_agents.models import ModelConfig, UserContext
from dynamic_agents.services.model_capabilities import ModelCapabilities, get_model_capabilities
from dynamic_agents.services.model_connections import resolve_registered_model
from dynamic_agents.services.mongo import get_mongo_service

router = APIRouter(prefix="/model-capabilities", tags=["model-capabilities"])


class ModelCapabilitiesRequest(BaseModel):
    model: ModelConfig


@router.post("", response_model=ModelCapabilities)
async def model_capabilities(
    request: ModelCapabilitiesRequest,
    user: UserContext = Depends(get_user_context),
) -> ModelCapabilities:
    """Return declared capabilities for a provider/model selection."""
    plan = await resolve_registered_model(get_settings(), user, get_mongo_service(), request.model.id, metadata_only=True)
    return get_model_capabilities(plan.model_id if plan else request.model.id)

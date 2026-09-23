"""Authenticated model-capability discovery."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.models import ModelConfig, UserContext
from dynamic_agents.services.model_capabilities import ModelCapabilities, get_model_capabilities

router = APIRouter(prefix="/model-capabilities", tags=["model-capabilities"])


class ModelCapabilitiesRequest(BaseModel):
    model: ModelConfig


@router.post("", response_model=ModelCapabilities)
async def model_capabilities(
    request: ModelCapabilitiesRequest,
    user: UserContext = Depends(get_user_context),
) -> ModelCapabilities:
    """Return declared capabilities for a provider/model selection."""
    del user
    return get_model_capabilities(request.model.id)

"""Resolve model-scoped credentials for tests and agent graphs through one boundary."""

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.config import Settings
from dynamic_agents.models import UserContext
from dynamic_agents.services.credential_exchange import CredentialExchangeClient
from dynamic_agents.services.llm_clients import LLMConfigError, get_llm
from dynamic_agents.services.mongo import MongoDBService


@dataclass
class ResolvedModel:
    model_id: str
    provider: str
    revision: str
    parameters: dict[str, Any] = field(default_factory=dict, repr=False)
    instances: list[Any] = field(default_factory=list, repr=False)

    def instantiate(self, reasoning_effort: Any = None, streaming: bool | None = None) -> Any:
        model = get_llm(self.provider, self.model_id, reasoning_effort, streaming=streaming,
                        provider_options=self.parameters or None)
        self.instances.append(model)
        return model


class ModelConnectionError(LLMConfigError):
    """Safe authorization diagnostic from the credential broker."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def broker(settings: Settings, user: UserContext | None) -> CredentialExchangeClient:
    token = current_user_token.get() or ((user.obo_jwt or user.access_token) if user else None)
    if not settings.credential_api_url or not token:
        raise LLMConfigError("Saved model connections require the credential API and an authenticated caller.")
    return CredentialExchangeClient(base_url=settings.credential_api_url,
                                    audience=settings.credential_service_audience,
                                    token_provider=lambda: token)


async def resolve_model(settings: Settings, user: UserContext | None, payload: dict[str, Any]) -> ResolvedModel:
    """Authorization is evaluated for the current invocation, including metadata checks."""
    try:
        plan = await broker(settings, user).resolve_llm_model(payload)
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        message = "Model or saved credential access was denied." if code in (401, 403) else "Model connection is unavailable; check its saved credentials and runtime configuration."
        raise ModelConnectionError(message, code) from None
    except httpx.RequestError:
        raise LLMConfigError("The model credential service could not be reached.") from None
    return ResolvedModel(model_id=plan["model_id"], provider=plan["provider"],
                         revision=plan["revision"], parameters=plan.get("parameters", {}))


async def resolve_registered_model(settings: Settings, user: UserContext | None,
                                   mongo: MongoDBService | None, model_id: str,
                                   *, metadata_only: bool = False) -> ResolvedModel | None:
    # Keep environment-only deployments working without the optional credential service.
    # A registered connection always fails closed; never reinterpret its registry ID as an upstream ID.
    connection_id = bool(re.fullmatch(r"[0-9a-fA-F-]{36}-[0-9a-f]{16}", model_id))
    if not model_id or mongo is None:
        if connection_id:
            raise LLMConfigError("The saved model registry is unavailable.")
        return None
    record = await asyncio.to_thread(mongo.get_llm_model, model_id)
    if not isinstance(record, dict) or not record.get("connection_id"):
        if connection_id:
            raise LLMConfigError("The saved model connection was removed or is unavailable.")
        return None
    return await resolve_model(settings, user, {"model_id": model_id, "metadata_only": metadata_only})

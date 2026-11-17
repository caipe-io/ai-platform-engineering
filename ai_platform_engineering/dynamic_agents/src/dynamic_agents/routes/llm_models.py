"""Authenticated, bounded connection checks using the agent's native model factory."""

import asyncio
import re
import ssl
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from dynamic_agents.auth.auth import get_user_context
from dynamic_agents.config import get_settings
from dynamic_agents.models import UserContext
from dynamic_agents.services.llm_clients import LLMConfigError, close_model_transports
from dynamic_agents.services.model_connections import ResolvedModel, resolve_model

router = APIRouter(prefix="/llm-models", tags=["llm-models"])


class ModelTestRequest(BaseModel):
    model_id: str | None = Field(default=None, max_length=1024)
    upstream_model_id: str | None = Field(default=None, max_length=512)
    draft: dict[str, Any] | None = Field(default=None, repr=False)


def diagnostic(error: Exception, plan: ResolvedModel | None) -> dict[str, Any]:
    """Keep the provider's useful explanation while removing connection material."""
    status = getattr(error, "status_code", None)
    chain = error
    for _ in range(5):
        if not chain.__cause__:
            break
        chain = chain.__cause__
    category = {401: "authentication", 403: "authorization", 404: "not_found", 429: "rate_limit"}.get(status, "provider_error")
    if isinstance(error, (TimeoutError, httpx.TimeoutException)) or "timeout" in type(error).__name__.lower():
        category = "timeout"
    elif isinstance(chain, ssl.SSLError) or "certificate" in str(error).lower():
        category = "tls"
    elif isinstance(error, httpx.RequestError) or "connection" in type(error).__name__.lower():
        category = "connection"
    elif isinstance(error, LLMConfigError) and status not in (401, 403):
        category = "configuration"
    message = str(error)
    for value in sorted((str(value) for value in (plan.parameters.values() if plan else [])), key=len, reverse=True):
        if value:
            message = message.replace(value, "[redacted]")
    # Deployment credentials may not appear in the plan. Redact common SDK credential/header/URL forms too.
    message = re.sub(r"https?://[^\s\"'<>]+", "[endpoint]", message)
    message = re.sub(r"(?i)(bearer\s+|(?:api[_ -]?key|authorization|token|secret)[\"'\s:=]+)[^\s,\"'}]+", r"\1[redacted]", message)
    message = re.sub(r"\bsk-[A-Za-z0-9_-]+", "[redacted]", message)
    message = re.sub(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", "[redacted]", message)
    return {"success": False, "category": category, "message": message[:1200] or "Provider rejected the connection.", **({"status_code": status} if isinstance(status, int) else {})}


@router.post("/test")
async def test_model(request: ModelTestRequest, user: UserContext = Depends(get_user_context)) -> dict:
    started = time.monotonic()
    plan = None
    model = None
    try:
        async with asyncio.timeout(30):
            plan = await resolve_model(get_settings(), user, request.model_dump(exclude_none=True))
            if plan.provider in ("openai", "openai-compatible", "azure-openai", "anthropic-claude", "groq"):
                plan.parameters["max_retries"] = 0
            model = plan.instantiate(streaming=False)
            # Use a short bounded completion; no tool calls, agent, or registry writes.
            token_limit = {"max_output_tokens": 32} if plan.provider in ("google-gemini", "gcp-vertexai") else {"max_tokens": 32}
            response = await model.ainvoke("Reply only OK.", **token_limit)
            if not response.content and not (response.usage_metadata or {}).get("output_tokens") and response.response_metadata.get("finish_reason") != "length":
                result = {"success": False, "category": "invalid_response", "message": "The provider returned an empty completion."}
            else:
                result = {"success": True, "category": "success", "message": "Connected. The model returned a completion."}
    except Exception as error:
        result = diagnostic(error, plan)
    finally:
        # Per-connection transports are owned by this short-lived model, never the shared deployment pool.
        if model is not None:
            await close_model_transports(model)
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result

"""A2A SDK-backed remote-agent tools for Dynamic Agents."""

from __future__ import annotations

import re
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx
from a2a.client import ClientCallContext, ClientCallInterceptor, ClientConfig, ClientFactory
from a2a.client.interceptors import AfterArgs, BeforeArgs
from a2a.types import Message, Part, Role, SendMessageRequest
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from dynamic_agents.auth.token_context import current_user_token

_UNSAFE_NAME_CHARS = re.compile(r"[^a-zA-Z0-9_-]+")


def _sanitize_tool_name(raw: str) -> str:
    """Reduce a remote-agent name to a tool name accepted by model APIs."""
    return _UNSAFE_NAME_CHARS.sub("_", raw).strip("_").lower()


def _field_is_set(value: Any, field: str) -> bool:
    """Check a protobuf field while tolerating SDK response wrappers."""
    has_field = getattr(value, "HasField", None)
    if callable(has_field):
        try:
            return has_field(field)
        except ValueError:
            return False
    return getattr(value, field, None) is not None


def _text_parts(message: Any) -> list[str]:
    parts = getattr(message, "parts", None) or []
    return [part.text for part in parts if getattr(part, "text", None)]


def _response_text(response: Any) -> list[str]:
    """Extract visible output from SDK direct-message and task responses."""
    texts: list[str] = []
    if _field_is_set(response, "message"):
        texts.extend(_text_parts(response.message))
    if _field_is_set(response, "task"):
        task = response.task
        for artifact in getattr(task, "artifacts", None) or []:
            texts.extend(_text_parts(artifact))
        status = getattr(task, "status", None)
        if status is not None and _field_is_set(status, "message"):
            texts.extend(_text_parts(status.message))
    if _field_is_set(response, "artifact_update"):
        texts.extend(_text_parts(response.artifact_update.artifact))
    if _field_is_set(response, "status_update"):
        status = response.status_update.status
        if _field_is_set(status, "message"):
            texts.extend(_text_parts(status.message))
    return texts


class _RemoteAgentInput(BaseModel):
    message: str = Field(description="The message to send to the remote agent")


class _BearerForwardingInterceptor(ClientCallInterceptor):
    """Attach the current Dynamic Agents caller token to every SDK request."""

    def __init__(self, token: str | None):
        self._token = token

    async def before(self, args: BeforeArgs) -> None:
        if not self._token:
            return
        context = args.context or ClientCallContext()
        headers = dict(context.service_parameters or {})
        headers["Authorization"] = f"Bearer {self._token}"
        context.service_parameters = headers
        args.context = context

    async def after(self, args: AfterArgs) -> None:
        return None


class RemoteAgentTool(BaseTool):
    """LangChain tool that delegates through the official A2A Python SDK."""

    name: str
    description: str
    a2a_url: str
    bearer_token: str | None = None
    timeout: int = 120

    args_schema: type[BaseModel] = _RemoteAgentInput

    def _run(self, message: str) -> str:
        raise NotImplementedError("RemoteAgentTool is async-only; use ainvoke()")

    async def _arun(self, message: str) -> str:
        # The runtime cache outlives individual requests, so read the ContextVar
        # at tool-call time to forward the active caller's token.
        token = current_user_token.get() or self.bearer_token
        headers = {"Authorization": f"Bearer {token}"} if token else None
        timeout = httpx.Timeout(float(self.timeout))
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as http_client:
            factory = ClientFactory(
                ClientConfig(
                    streaming=False,
                    supported_protocol_bindings=["JSONRPC", "HTTP+JSON"],
                    httpx_client=http_client,
                )
            )
            client = await factory.create_from_url(
                self.a2a_url,
                interceptors=[_BearerForwardingInterceptor(token)],
                resolver_http_kwargs={"timeout": timeout},
            )
            try:
                request = SendMessageRequest(
                    message=Message(
                        message_id=str(uuid.uuid4()),
                        role=Role.ROLE_USER,
                        parts=[Part(text=message)],
                    )
                )
                results: list[str] = []
                context = ClientCallContext(timeout=float(self.timeout))
                async for response in client.send_message(request, context=context):
                    results.extend(_response_text(response))
                return "\n".join(results) or "Remote agent returned no text response."
            finally:
                await client.close()


async def create_remote_agent_tool(
    *,
    a2a_url: str,
    name: str | None = None,
    description: str | None = None,
    bearer_token: str | None = None,
    timeout: int = 120,
) -> RemoteAgentTool:
    """Create a tool from registry metadata; SDK handles protocol negotiation.

    Args:
        a2a_url: Base URL of the remote A2A agent.
        name: Registry or Agent Card name override.
        description: Registry or Agent Card description.
        bearer_token: Fallback token used only when no request token is bound.
        timeout: Per-request timeout in seconds, configured in the UI registry.
    """
    safe_name = _sanitize_tool_name(name or "") or _sanitize_tool_name(urlparse(a2a_url).hostname or "")
    return RemoteAgentTool(
        name=safe_name or "remote_agent",
        description=description or f"Remote A2A agent at {a2a_url}",
        a2a_url=a2a_url,
        bearer_token=bearer_token,
        timeout=timeout,
    )

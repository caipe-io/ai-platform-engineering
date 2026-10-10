"""A2A SDK-backed remote-agent tools for Dynamic Agents."""

from __future__ import annotations

import asyncio
import re
import uuid
from contextlib import aclosing
from typing import Any
from urllib.parse import urlparse

import httpx
from a2a.client import ClientCallContext, ClientConfig, ClientFactory
from a2a.types import Message, Part, Role, SendMessageRequest, TaskState
from langchain_core.tools import BaseTool
from langgraph.prebuilt import ToolRuntime
from pydantic import BaseModel, ConfigDict, Field

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import RemoteAgentCredentialSource
from dynamic_agents.services.a2a_destination import A2ADestinationPolicy
from dynamic_agents.services.a2a_limits import (
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    A2ABoundedTransport,
    A2AResponseLimitError,
)
from dynamic_agents.services.credential_exchange import CredentialExchangeClient

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


class _RemoteOutput:
    """Accumulate artifact snapshots and append chunks without duplicating output."""

    def __init__(self, max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES) -> None:
        self.max_output_bytes = max_output_bytes
        self.artifacts: dict[str, str] = {}
        self.messages: list[str] = []
        self.status_text = ""
        self.stream_seen = False
        self.finished = False

    @property
    def text(self) -> str:
        return "\n".join([*self.messages, *self.artifacts.values()]) or self.status_text

    def update(self, response: Any) -> bool:
        before = self.text
        if _field_is_set(response, "message"):
            self.messages.append("\n".join(_text_parts(response.message)))
        if _field_is_set(response, "task"):
            for artifact in response.task.artifacts:
                self.artifacts[artifact.artifact_id] = "".join(_text_parts(artifact))
        if _field_is_set(response, "artifact_update"):
            self.stream_seen = True
            update = response.artifact_update
            artifact = update.artifact
            text = "".join(_text_parts(artifact))
            self.artifacts[artifact.artifact_id] = (
                self.artifacts.get(artifact.artifact_id, "") + text if update.append else text
            )
        status = None
        if _field_is_set(response, "status_update"):
            self.stream_seen = True
            status = response.status_update.status
        elif _field_is_set(response, "task"):
            status = response.task.status
        if status is not None and _field_is_set(status, "message"):
            self.status_text = "\n".join(_text_parts(status.message))
        retained = [*self.messages, *self.artifacts.values()]
        size = sum(len(text.encode("utf-8")) for text in retained) + max(0, len(retained) - 1)
        size += len(self.status_text.encode("utf-8"))
        if size > self.max_output_bytes:
            raise A2AResponseLimitError(f"Remote A2A output exceeded {self.max_output_bytes} bytes")
        if status is not None:
            if status.state in {
                TaskState.TASK_STATE_FAILED,
                TaskState.TASK_STATE_CANCELED,
                TaskState.TASK_STATE_REJECTED,
            }:
                raise RuntimeError(self.status_text or "Remote A2A task failed or was canceled")
            self.finished = status.state in {
                TaskState.TASK_STATE_COMPLETED,
                TaskState.TASK_STATE_INPUT_REQUIRED,
                TaskState.TASK_STATE_AUTH_REQUIRED,
            }
        return self.text != before


class _RemoteAgentInput(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    runtime: ToolRuntime = None
    message: str = Field(description="The message to send to the remote agent")


async def resolve_remote_agent_auth_headers(
    credential_source: dict[str, Any] | None,
    *,
    caller_token: str | None,
    credential_api_url: str | None,
    credential_service_audience: str = "caipe-credential-service",
) -> dict[str, str]:
    """Resolve one caller, saved-secret, or connected-account header."""
    source = RemoteAgentCredentialSource.model_validate(credential_source or {})
    kind = source.kind
    header_name = source.name
    credential: str | None = None

    if kind == "caller_token":
        credential = caller_token
    elif kind in {"secret_ref", "provider_connection"}:
        if not caller_token:
            raise RuntimeError("Caller authentication is required to resolve the A2A credential")
        if not credential_api_url:
            raise RuntimeError("Credential service is not configured for this A2A agent")
        credential_client = CredentialExchangeClient(
            base_url=credential_api_url,
            audience=credential_service_audience,
            token_provider=lambda: caller_token,
        )
        if kind == "secret_ref":
            credential = await credential_client.retrieve_secret(source.secret_ref, intended_use="a2a_agent")
        else:
            exchanged = await credential_client.exchange_provider_connection_by_provider(
                source.provider,
                intended_use="a2a_agent",
            )
            access_token = exchanged.get("access_token")
            credential = access_token if isinstance(access_token, str) else None

    if not credential or not credential.strip():
        raise RuntimeError(f"A2A agent authentication credential is unavailable for {header_name}")
    header_value = credential.strip()
    if header_name.lower() == "authorization" and not header_value.lower().startswith("bearer "):
        header_value = f"Bearer {header_value}"
    return {header_name: header_value}


class RemoteAgentTool(BaseTool):
    """LangChain tool that delegates through the official A2A Python SDK."""

    name: str
    description: str
    a2a_url: str
    bearer_token: str | None = None
    credential_source: dict[str, Any] | None = None
    credential_api_url: str | None = None
    credential_service_audience: str = "caipe-credential-service"
    timeout: int = Field(default=120, ge=1, le=600)
    max_response_bytes: int = Field(default=DEFAULT_MAX_RESPONSE_BYTES, gt=0)
    max_output_bytes: int = Field(default=DEFAULT_MAX_OUTPUT_BYTES, gt=0)
    streaming: bool = False
    allowed_http_origins: list[str] = Field(default_factory=list)

    args_schema: type[BaseModel] = _RemoteAgentInput

    def _run(self, message: str, runtime: ToolRuntime | None = None) -> str:
        raise NotImplementedError("RemoteAgentTool is async-only; use ainvoke()")

    async def _resolve_auth_headers(self, caller_token: str | None) -> dict[str, str]:
        return await resolve_remote_agent_auth_headers(
            self.credential_source,
            caller_token=caller_token,
            credential_api_url=self.credential_api_url,
            credential_service_audience=self.credential_service_audience,
        )

    async def _arun(self, message: str, runtime: ToolRuntime | None = None) -> str:
        try:
            async with asyncio.timeout(self.timeout):
                return await self._execute(message, runtime)
        except TimeoutError as exc:
            raise TimeoutError(f"Remote A2A execution exceeded its {self.timeout} second deadline") from exc

    async def _execute(self, message: str, runtime: ToolRuntime | None) -> str:
        # The runtime cache outlives individual requests, so resolve caller-scoped
        # auth at tool-call time using the active request token.
        policy = A2ADestinationPolicy(self.a2a_url, self.allowed_http_origins)
        token = current_user_token.get() or self.bearer_token
        headers = await self._resolve_auth_headers(token)
        timeout = httpx.Timeout(float(self.timeout))
        async with httpx.AsyncClient(
            transport=A2ABoundedTransport(self.max_response_bytes),
            timeout=timeout, follow_redirects=False, event_hooks={"request": [policy.request_hook(headers)]}
        ) as http_client:
            factory = ClientFactory(
                ClientConfig(
                    streaming=self.streaming,
                    supported_protocol_bindings=["JSONRPC", "HTTP+JSON"],
                    httpx_client=http_client,
                )
            )
            client = await factory.create_from_url(
                self.a2a_url,
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
                output = _RemoteOutput(self.max_output_bytes)
                context = ClientCallContext(timeout=float(self.timeout))
                async with aclosing(client.send_message(request, context=context)) as responses:
                    async for response in responses:
                        changed = output.update(response)
                        if changed and self.streaming and runtime and runtime.tool_call_id:
                            runtime.stream_writer(
                                {"type": "tool_output", "tool_call_id": runtime.tool_call_id, "result": output.text}
                            )
                if output.stream_seen and not output.finished:
                    raise RuntimeError("Remote A2A stream ended before the task completed")
                return output.text or "Remote agent returned no text response."
            finally:
                await client.close()


async def create_remote_agent_tool(
    *,
    a2a_url: str,
    name: str | None = None,
    description: str | None = None,
    bearer_token: str | None = None,
    credential_source: dict[str, Any] | None = None,
    credential_api_url: str | None = None,
    credential_service_audience: str = "caipe-credential-service",
    timeout: int = 120,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    streaming: bool = False,
    allowed_http_origins: list[str] | None = None,
) -> RemoteAgentTool:
    """Create a tool from registry metadata; SDK handles protocol negotiation.

    Args:
        a2a_url: Base URL of the remote A2A agent.
        name: Registry or Agent Card name override.
        description: Registry or Agent Card description.
        bearer_token: Fallback token used only when no request token is bound.
        credential_source: Header authentication source configured for this endpoint.
        credential_api_url: Credential service URL used for secrets and OAuth connections.
        credential_service_audience: Credential service audience.
        streaming: Request streaming when supported by the Agent Card.
        timeout: Overall invocation deadline in seconds, configured in the UI registry.
        max_response_bytes: Total HTTP response bytes allowed across discovery and execution.
        max_output_bytes: Maximum accumulated UTF-8 output bytes.
    """
    safe_name = _sanitize_tool_name(name or "") or _sanitize_tool_name(urlparse(a2a_url).hostname or "")
    return RemoteAgentTool(
        name=safe_name or "remote_agent",
        description=description or f"Remote A2A agent at {a2a_url}",
        a2a_url=a2a_url,
        bearer_token=bearer_token,
        credential_source=credential_source,
        credential_api_url=credential_api_url,
        credential_service_audience=credential_service_audience,
        timeout=timeout,
        max_response_bytes=max_response_bytes,
        max_output_bytes=max_output_bytes,
        streaming=streaming,
        allowed_http_origins=allowed_http_origins or [],
    )

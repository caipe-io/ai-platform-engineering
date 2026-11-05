"""Harness Engine operator configuration."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import PurePosixPath
from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, SecretStr, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentCoreRuntimeTarget(BaseModel):
    """Operator-owned AgentCore target; ARNs never come from agent drafts.

    The legacy model name is retained for configuration compatibility, but a
    target can be either a custom AgentCore Runtime or a managed AgentCore
    Harness. The adapter selects the correct data-plane operation from the ARN.
    """

    provisioning: Literal["shared", "per_agent"] = "shared"
    arn: str | None = Field(
        None,
        min_length=20,
        pattern=(
            r"^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:"
            r"(?:runtime|harness)/[A-Za-z0-9_.-]+$"
        ),
    )
    qualifier: str = Field("DEFAULT", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    region: str | None = Field(None, pattern=r"^[a-z]{2}(?:-gov)?-[a-z]+-\d$")
    execution_role_arn: str | None = Field(
        None,
        pattern=r"^arn:aws[a-z-]*:iam::\d{12}:role/[A-Za-z0-9+=,.@_/-]+$",
    )
    model_id: str | None = Field(None, min_length=1, max_length=256)
    api_format: Literal["converse_stream", "responses", "chat_completions"] = (
        "converse_stream"
    )

    @model_validator(mode="after")
    def validate_mode(self) -> AgentCoreRuntimeTarget:
        if self.provisioning == "shared" and not self.arn:
            raise ValueError("shared AgentCore profiles require arn")
        if self.provisioning == "per_agent" and (
            not self.region or not self.execution_role_arn
        ):
            raise ValueError(
                "per_agent AgentCore profiles require region and execution_role_arn"
            )
        return self

    @property
    def is_managed_harness(self) -> bool:
        return self.provisioning == "per_agent" or bool(
            self.arn and ":harness/" in self.arn
        )


def validate_web_url(value: str, *, websocket: bool = False) -> str:
    parsed = urlsplit(value)
    schemes = {"wss"} if websocket else {"https"}
    if parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        schemes.add("ws" if websocket else "http")
    if parsed.scheme not in schemes or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Connection URLs require TLS without credentials, query or fragment")
    return value


class SandboxProfileInfo(BaseModel):
    """Public connection metadata; a configured profile is not a health attestation."""

    instance_id: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    display_name: str = Field(..., min_length=1, max_length=128)
    portal_url: str = Field(..., min_length=1, max_length=2048)
    policy_revision: str = Field(..., min_length=1, max_length=128)
    policy_summary: str = Field("", max_length=1024)
    status: Literal["configured"] = "configured"

    @model_validator(mode="after")
    def validate_portal(self) -> SandboxProfileInfo:
        validate_web_url(self.portal_url)
        return self


class SandboxPolicy(SandboxProfileInfo):
    """Operator-admitted identity and placement, never supplied by agent drafts."""

    owner_subject: str = Field(..., min_length=1, max_length=512)
    workspace_root: str = Field("/workspace", min_length=1, max_length=1024)

    @model_validator(mode="after")
    def validate_workspace(self) -> SandboxPolicy:
        path = PurePosixPath(self.workspace_root)
        if not path.is_absolute() or ".." in path.parts or "\x00" in self.workspace_root or str(path) == "/":
            raise ValueError("Sandbox workspace must be an absolute private directory")
        self.workspace_root = str(path)
        return self

    def public(self) -> SandboxProfileInfo:
        return SandboxProfileInfo.model_validate(self.model_dump(include=set(SandboxProfileInfo.model_fields)))

    def execution_identity(self) -> dict[str, str]:
        """Placement and policy identity, independent of cosmetic UI metadata."""
        return {
            "instance_id": self.instance_id, "owner_subject": self.owner_subject,
            "workspace_root": self.workspace_root, "policy_revision": self.policy_revision,
        }


class SandboxConnection(SandboxPolicy):
    """Private data-plane credential for a preprovisioned sandbox, not management."""

    url: str = Field(..., min_length=1, max_length=2048)
    token: SecretStr = Field(..., min_length=32)
    client_cert_file: str | None = Field(default=None, min_length=1, max_length=1024)
    client_key_file: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def validate_transport(self) -> SandboxConnection:
        validate_web_url(self.url, websocket=True)
        if (self.client_cert_file is None) != (self.client_key_file is None):
            raise ValueError("Sandbox client certificate and key must be configured together")
        if self.client_cert_file is not None and urlsplit(self.url).scheme != "wss":
            raise ValueError("Sandbox client certificates require WSS")
        for path in (self.client_cert_file, self.client_key_file):
            if path is not None and (not PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts or "\x00" in path):
                raise ValueError("Sandbox client certificate paths must be absolute")
        return self


class ClaudeSDKProfile(BaseModel):
    """Operator-owned Claude model and workspace policy."""

    model: str = Field(..., min_length=1, max_length=128)
    cwd: str = Field("/workspace", min_length=1, max_length=1024)
    permission_mode: str = Field("dontAsk", pattern=r"^(default|acceptEdits|plan|dontAsk)$")
    description: str = Field("", max_length=512)
    sandbox: SandboxConnection | None = None


class ClaudeWorkerProfile(BaseModel):
    """Private connection to an operator-managed SDK worker."""

    url: str = Field(..., min_length=1, max_length=2048)
    token: SecretStr
    profile_id: str = Field(..., pattern=r"^[A-Za-z0-9_.-]{1,64}$")
    description: str = Field("", max_length=512)
    tools_enabled: bool = False
    runtime: Literal["sdk", "claude_code_acp", "claude_code_cli_acp"] = "sdk"
    sandbox: SandboxPolicy | None = None

    @model_validator(mode="after")
    def validate_connection(self) -> ClaudeWorkerProfile:
        parsed = urlsplit(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Worker URL must be an HTTP(S) service URL without credentials or query parameters")
        if len(self.token.get_secret_value()) < 16:
            raise ValueError("Worker service credentials must contain at least 16 characters")
        if self.sandbox is not None and self.runtime != "claude_code_acp":
            raise ValueError("Sandbox profiles require the Claude ACP runtime")
        return self


class Settings(BaseSettings):
    """Environment-only service settings."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_ENGINE_", extra="ignore", hide_input_in_errors=True)

    host: str = "0.0.0.0"
    port: int = Field(8010, ge=1, le=65535)
    internal_token: str = Field("local-development-only", min_length=16)
    storage_backend: str = Field("memory", pattern=r"^(memory|mongodb)$")
    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_database: str = "harness_engine"
    event_retention_seconds: int = Field(86400, ge=300, le=2592000)
    long_poll_seconds: float = Field(15.0, ge=0.1, le=30.0)
    agentcore_runtimes_json: str = "{}"
    agentcore_endpoint_url: str | None = None
    agentcore_provision_timeout_seconds: float = Field(180.0, ge=1.0, le=900.0)
    agentcore_provision_poll_seconds: float = Field(2.0, ge=0.1, le=10.0)
    claude_sdk_profiles_json: SecretStr = SecretStr("{}")
    claude_worker_profiles_json: SecretStr = SecretStr("{}")
    claude_tool_broker_url: str | None = None
    claude_acp_command: list[str] = Field(default_factory=list)
    claude_acp_runtime: Literal["claude_code_acp", "claude_code_cli_acp"] = "claude_code_acp"
    claude_acp_tools: list[str] = Field(default_factory=list)
    deep_agents_enabled: bool = False
    sandbox_portal_url: str | None = None

    def model_copy(self, *, update: Mapping[str, Any] | None = None, deep: bool = False) -> Self:
        # Pydantic copies intentionally do not validate updates. Preserve the
        # established string-update API without reintroducing plaintext config
        # into representations, dumps or later validation failures.
        updates = dict(update or {})
        for field in ("claude_sdk_profiles_json", "claude_worker_profiles_json"):
            value = updates.get(field, getattr(self, field))
            if isinstance(value, str):
                value = SecretStr(value)
            if not isinstance(value, SecretStr):
                raise TypeError("Claude profile settings require a secret JSON string")
            updates[field] = value
        return super().model_copy(update=updates, deep=deep)

    @model_validator(mode="after")
    def validate_sandbox_portal(self) -> Settings:
        if self.sandbox_portal_url:
            validate_web_url(self.sandbox_portal_url)
        return self

    @property
    def uses_claude_acp(self) -> bool:
        return bool(self.claude_acp_command or any(profile.sandbox for profile in self.claude_sdk_profiles().values()))

    def agentcore_targets(self) -> dict[str, AgentCoreRuntimeTarget]:
        """Parse the operator allowlist without exposing raw settings to clients."""

        try:
            raw = json.loads(self.agentcore_runtimes_json)
            if not isinstance(raw, dict):
                raise ValueError("must be a JSON object")
            return {alias: AgentCoreRuntimeTarget.model_validate(value) for alias, value in raw.items()}
        except (json.JSONDecodeError, ValidationError, ValueError) as exc:
            raise ValueError("HARNESS_ENGINE_AGENTCORE_RUNTIMES_JSON is invalid") from exc

    def claude_sdk_profiles(self) -> dict[str, ClaudeSDKProfile]:
        """Parse safe aliases for Claude SDK model/workspace policy."""

        try:
            raw = json.loads(self.claude_sdk_profiles_json.get_secret_value())
            if not isinstance(raw, dict):
                raise ValueError("must be a JSON object")
            return {alias: ClaudeSDKProfile.model_validate(value) for alias, value in raw.items()}
        except (json.JSONDecodeError, ValidationError, ValueError):
            # Nested validation inputs can contain the sandbox service token.
            raise ValueError("HARNESS_ENGINE_CLAUDE_SDK_PROFILES_JSON is invalid") from None

    def claude_worker_profiles(self) -> dict[str, ClaudeWorkerProfile]:
        try:
            raw = json.loads(self.claude_worker_profiles_json.get_secret_value())
            if not isinstance(raw, dict):
                raise ValueError("must be a JSON object")
            return {alias: ClaudeWorkerProfile.model_validate(value) for alias, value in raw.items()}
        except (json.JSONDecodeError, ValidationError, ValueError):
            # Validation inputs contain the private worker credential.
            raise ValueError("HARNESS_ENGINE_CLAUDE_WORKER_PROFILES_JSON is invalid") from None

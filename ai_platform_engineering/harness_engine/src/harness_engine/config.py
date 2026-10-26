"""Harness Engine operator configuration."""

from __future__ import annotations

import hashlib
import json
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, BaseModel, Field, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def canonical_mongo_storage_binding(uri: str, database: str) -> str:
    """Compare configured cluster/database coordinates without credential material."""
    parsed = urlsplit(uri)
    if parsed.scheme not in {"mongodb", "mongodb+srv"} or not parsed.netloc:
        raise ValueError("A valid MongoDB connection URI is required")
    authority = parsed.netloc.rsplit("@", 1)[-1]
    hosts = sorted(host.lower().removesuffix(":27017") for host in authority.split(","))
    identity = json.dumps([parsed.scheme.lower(), hosts, database], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(identity.encode()).hexdigest()


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


class ClaudeSDKProfile(BaseModel):
    """Operator-owned Claude Agent SDK process profile."""

    model: str = Field(..., min_length=1, max_length=128)
    cwd: str = Field("/workspace", min_length=1, max_length=1024)
    permission_mode: str = Field("dontAsk", pattern=r"^(default|acceptEdits|plan|dontAsk)$")
    description: str = Field("", max_length=512)


class Settings(BaseSettings):
    """Environment-only service settings."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_ENGINE_", extra="ignore", populate_by_name=True)

    host: str = "0.0.0.0"
    port: int = Field(8010, ge=1, le=65535)
    internal_token: str = Field("local-development-only", min_length=16)
    storage_backend: str = Field("mongodb", pattern=r"^(memory|mongodb)$")
    mongodb_uri: str = Field(
        "mongodb://localhost:27017", validation_alias=AliasChoices("HARNESS_ENGINE_MONGODB_URI", "MONGODB_URI")
    )
    mongodb_database: str = Field(
        "caipe", validation_alias=AliasChoices("HARNESS_ENGINE_MONGODB_DATABASE", "MONGODB_DATABASE")
    )
    canonical_mongodb_uri: str | None = Field(None, validation_alias="MONGODB_URI", exclude=True, repr=False)
    canonical_mongodb_database: str | None = Field(None, validation_alias="MONGODB_DATABASE", exclude=True)

    event_retention_seconds: int = Field(86400, ge=300, le=2592000)
    long_poll_seconds: float = Field(15.0, ge=0.1, le=30.0)
    agentcore_runtimes_json: str = "{}"
    agentcore_endpoint_url: str | None = None
    agentcore_provision_timeout_seconds: float = Field(180.0, ge=1.0, le=900.0)
    agentcore_provision_poll_seconds: float = Field(2.0, ge=0.1, le=10.0)
    claude_sdk_profiles_json: str = "{}"
    claude_code_profiles_json: str = "{}"
    coding_sandbox_service_url: str | None = Field(None, max_length=2048)
    coding_sandbox_provision_timeout_seconds: float = Field(180.0, ge=1.0, le=900.0)
    coding_tools_public_url: str | None = Field(None, max_length=2048)
    coding_platform_url: str | None = Field(None, max_length=2048)
    coding_resources_url: str | None = Field(None, max_length=2048)
    coding_obo_token_url: str | None = Field(None, max_length=2048)
    coding_obo_client_id: str | None = Field(None, max_length=256)
    coding_obo_client_secret: str | None = Field(None, max_length=8192, exclude=True, repr=False)
    coding_obo_audience: str = Field("caipe-platform", min_length=1, max_length=256)

    @model_validator(mode="after")
    def canonical_storage(self) -> Settings:
        if self.storage_backend == "mongodb" and (
            (self.canonical_mongodb_uri is not None and canonical_mongo_storage_binding(self.mongodb_uri, self.mongodb_database)
             != canonical_mongo_storage_binding(self.canonical_mongodb_uri, self.mongodb_database))
            or (self.canonical_mongodb_database is not None and self.mongodb_database != self.canonical_mongodb_database)
        ):
            raise ValueError(
                "Harness Engine must use CAIPE's canonical MongoDB URI and database; "
                "migrate existing provider collections before changing the storage binding"
            )
        return self

    @property
    def storage_binding(self) -> str:
        return canonical_mongo_storage_binding(self.mongodb_uri, self.mongodb_database)

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
            raw = json.loads(self.claude_sdk_profiles_json)
            if not isinstance(raw, dict):
                raise ValueError("must be a JSON object")
            return {alias: ClaudeSDKProfile.model_validate(value) for alias, value in raw.items()}
        except (json.JSONDecodeError, ValidationError, ValueError) as exc:
            raise ValueError("HARNESS_ENGINE_CLAUDE_SDK_PROFILES_JSON is invalid") from exc

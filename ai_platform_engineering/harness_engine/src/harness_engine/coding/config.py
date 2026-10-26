"""Operator-owned Claude Code profiles; agent drafts select aliases only."""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from harness_engine.config import Settings


class GitPolicy(BaseModel):
    """Operator-approved Git destinations/actions; user permissions still narrow them."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    repositories: list[str] = Field(min_length=1, max_length=100)
    read_tool_ids: list[str] = Field(min_length=1, max_length=64)
    write_tool_ids: list[str] = Field(default_factory=list, max_length=64)
    ref_prefixes: list[str] = Field(default_factory=lambda: ["refs/heads/agent/"], min_length=1, max_length=16)
    allow_default_branch_write: bool = False
    allow_protected_branch_write: bool = False
    allow_branch_delete: bool = False
    max_operations: int = Field(128, ge=1, le=1024)
    max_pack_bytes: int = Field(64 * 1024 * 1024, ge=1024, le=256 * 1024 * 1024)
    max_repository_bytes: int = Field(256 * 1024 * 1024, ge=1024, le=1024 * 1024 * 1024)
    timeout_seconds: float = Field(120, ge=1, le=600)
    audit_service_url: str
    credential_audience: str = Field("caipe-credential-service", min_length=1, max_length=128)

    @field_validator("repositories")
    @classmethod
    def valid_repositories(cls, value: list[str]) -> list[str]:
        if any(
            not re.fullmatch(r"(?:[A-Za-z0-9_.-]+|\*)/(?:[A-Za-z0-9_.-]+|\*)", item) or ".." in item for item in value
        ):
            raise ValueError("Git repositories must be approved owner/repository patterns")
        return [item.lower() for item in value]

    @field_validator("ref_prefixes")
    @classmethod
    def valid_refs(cls, value: list[str]) -> list[str]:
        if any(
            not item.startswith("refs/heads/") or not item.endswith("/") or ".." in item or "@{" in item or "\\" in item
            for item in value
        ):
            raise ValueError("Git write prefixes must select branch namespaces")
        return value


class ClaudeCodeProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    sandbox_profile_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    revision: str = Field(min_length=1, max_length=256)
    description: str = Field("", max_length=512)
    max_turns: int = Field(100, ge=1, le=1000)
    permission_mode: str = Field("default", pattern=r"^(default|acceptEdits|plan)$")
    model: str | None = Field(None, min_length=1, max_length=128)
    git: GitPolicy | None = None


def profile_fingerprint(profile: ClaudeCodeProfile) -> str:
    return hashlib.sha256(
        json.dumps(profile.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def profiles(settings: Settings) -> dict[str, ClaudeCodeProfile]:
    try:
        raw = json.loads(settings.claude_code_profiles_json)
        if not isinstance(raw, dict) or len(raw) > 100:
            raise ValueError
        values = {key: ClaudeCodeProfile.model_validate(value) for key, value in raw.items()}
        if any(not isinstance(key, str) or not key or len(key) > 64 for key in values):
            raise ValueError
        return values
    except (json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise ValueError("HARNESS_ENGINE_CLAUDE_CODE_PROFILES_JSON is invalid") from exc


def service_url(value: str | None) -> str:
    parsed = urlsplit(value or "")
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("A valid operator-owned service URL is required")
    return (value or "").rstrip("/")


class SandboxSettings(BaseModel):
    sandbox_service_url: str
    sandbox_provision_timeout_seconds: float = 180.0

    @field_validator("sandbox_service_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        return service_url(value)

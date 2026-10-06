# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Configuration for the SharePoint MCP server."""

from __future__ import annotations

import os
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class SharePointConfig(BaseModel):
    """Validated Microsoft Graph and site configuration."""

    tenant_id: UUID
    client_id: UUID
    client_secret: SecretStr = Field(min_length=1)
    site_url: str
    request_timeout_seconds: float = Field(default=30.0, gt=0, le=120)
    max_download_bytes: int = Field(default=2_000_000, ge=1_024, le=10_000_000)

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("site_url")
    @classmethod
    def normalize_site_url(cls, value: str) -> str:
        """Require a canonical HTTPS SharePoint site URL without query or fragment."""
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower()
        path = unquote(parsed.path).rstrip("/")

        if parsed.scheme.lower() != "https":
            raise ValueError("site_url must use HTTPS")
        if parsed.username or parsed.password or parsed.port:
            raise ValueError("site_url must not contain credentials or a custom port")
        if not hostname.endswith(".sharepoint.com"):
            raise ValueError("site_url must use a *.sharepoint.com hostname")
        if not (path.startswith("/sites/") or path.startswith("/teams/")):
            raise ValueError("site_url must identify a /sites/... or /teams/... site")
        if any(segment in {".", ".."} for segment in path.split("/")):
            raise ValueError("site_url must not contain relative path segments")

        return urlunsplit(("https", hostname, path, "", ""))

    @classmethod
    def from_env(cls) -> SharePointConfig:
        """Load required settings from environment variables."""
        required = {
            "tenant_id": os.getenv("SHAREPOINT_TENANT_ID"),
            "client_id": os.getenv("SHAREPOINT_CLIENT_ID"),
            "client_secret": os.getenv("SHAREPOINT_CLIENT_SECRET"),
            "site_url": os.getenv("SHAREPOINT_SITE_URL"),
        }
        missing = [f"SHAREPOINT_{name.upper()}" for name, value in required.items() if not value]
        if missing:
            raise ValueError(f"Missing required environment variables: {', '.join(missing)}")

        return cls(
            **required,
            request_timeout_seconds=os.getenv("SHAREPOINT_REQUEST_TIMEOUT_SECONDS", "30"),
            max_download_bytes=os.getenv("SHAREPOINT_MAX_DOWNLOAD_BYTES", "2000000"),
        )

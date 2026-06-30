# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
Directory self-registration: publishes CAIPE's built-in MCP servers to the
AGNTCY Directory so they are discoverable by other platforms.

This runs once on startup (after MongoDB is connected) and registers each
enabled MCP server as an OASF record with an integration/mcp module.

Environment variables:
  DIRECTORY_SELF_REGISTER=true         enable self-registration (default: false)
  DIRECTORY_BASE_URL=http://...:8888   AI Finder base URL (shared with sync)
  DIRECTORY_REGISTER_LABELS=key=val    labels to attach to self-registered records
  DIRECTORY_TIMEOUT=10.0               HTTP request timeout
"""

import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Schema version for the OASF records we publish
OASF_SCHEMA_VERSION = "1.0.0"


def _server_to_oasf_record(
    server: dict,
    labels: dict[str, str],
) -> dict:
    """Convert an MCP server MongoDB document to an OASF agent record.

    Creates a minimal but valid OASF record with an integration/mcp module
    containing the server's connection details.
    """
    transport_map = {
        "http": "streamable-http",
        "sse": "sse",
    }
    oasf_transport = transport_map.get(server.get("transport", "http"), "streamable-http")
    endpoint = server.get("endpoint", "")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "name": server.get("name", server.get("_id", "unknown")),
        "description": server.get("description", ""),
        "version": "1.0.0",
        "schema_version": OASF_SCHEMA_VERSION,
        "authors": ["CAIPE Platform <caipe@cnoe.io>"],
        "created_at": now,
        "labels": {
            **labels,
            "source": "caipe",
            "server_id": server.get("_id", ""),
        },
        "modules": [
            {
                "name": "integration/mcp",
                "id": 202,
                "data": {
                    "name": server.get("_id", server.get("name", "")),
                    "description": server.get("description", ""),
                    "connections": [
                        {
                            "type": oasf_transport,
                            "url": endpoint,
                        }
                    ],
                },
            }
        ],
        "locators": [],
    }


class DirectoryRegisterService:
    """Publishes CAIPE's built-in MCP servers to the AGNTCY Directory."""

    def __init__(
        self,
        base_url: str,
        labels: dict[str, str] | None = None,
        timeout: float = 10.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._labels = labels or {}
        self._timeout = timeout
        self._registered_ids: set[str] = set()

    @classmethod
    def from_env(cls) -> Optional["DirectoryRegisterService"]:
        """Create from environment. Returns None if self-registration is disabled."""
        if os.getenv("DIRECTORY_SELF_REGISTER", "").lower() != "true":
            return None

        base_url = os.getenv("DIRECTORY_BASE_URL", "http://dir-apiserver:8888")
        timeout = float(os.getenv("DIRECTORY_TIMEOUT", "10.0"))

        # Parse labels from DIRECTORY_REGISTER_LABELS (comma-separated key=value)
        labels: dict[str, str] = {}
        raw_labels = os.getenv("DIRECTORY_REGISTER_LABELS", "")
        if raw_labels:
            for pair in raw_labels.split(","):
                pair = pair.strip()
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    labels[k.strip()] = v.strip()

        return cls(base_url=base_url, labels=labels, timeout=timeout)

    def register_servers(self, servers: list[dict]) -> dict:
        """Register a list of MCP server documents with the Directory.

        Args:
            servers: List of MCP server MongoDB documents (from mcp_servers collection).
                     Only enabled, non-directory servers are registered.

        Returns:
            Summary dict with counts of registered/skipped/failed.
        """
        registered = 0
        skipped = 0
        failed = 0

        for server in servers:
            server_id = server.get("_id", "")

            # Skip servers that came from the Directory (avoid circular registration)
            if server.get("source") == "directory" or server.get("directory_agent"):
                skipped += 1
                continue

            # Skip disabled servers
            if not server.get("enabled", False):
                skipped += 1
                continue

            # Skip already registered in this session
            if server_id in self._registered_ids:
                skipped += 1
                continue

            record = _server_to_oasf_record(server, self._labels)
            success = self._publish_record(server_id, record)
            if success:
                self._registered_ids.add(server_id)
                registered += 1
            else:
                failed += 1

        logger.info(
            "Directory self-registration: registered=%d, skipped=%d, failed=%d",
            registered,
            skipped,
            failed,
        )
        return {"registered": registered, "skipped": skipped, "failed": failed}

    def _publish_record(self, server_id: str, record: dict) -> bool:
        """Publish an OASF record to the Directory. Returns True on success."""
        try:
            with httpx.Client(timeout=self._timeout) as client:
                # Check if already registered (by label filter)
                check_resp = client.get(
                    f"{self._base_url}/v1/agents",
                    params={"filter": f"server_id={server_id}"},
                )
                if check_resp.status_code == 200:
                    payload = check_resp.json()
                    existing = payload if isinstance(payload, list) else payload.get("results", [])
                    if existing:
                        logger.debug("Server '%s' already in Directory, skipping", server_id)
                        return True

                # Register new record
                resp = client.post(
                    f"{self._base_url}/v1/agents",
                    json={"agent": record},
                )
                if resp.status_code in (200, 201):
                    logger.info("Registered server '%s' in Directory", server_id)
                    return True
                else:
                    logger.warning(
                        "Failed to register '%s': HTTP %d — %s",
                        server_id,
                        resp.status_code,
                        resp.text[:200],
                    )
                    return False
        except Exception as exc:
            logger.warning("Failed to register '%s' in Directory: %s", server_id, exc)
            return False

    @property
    def status(self) -> dict:
        """Return registration status."""
        return {
            "enabled": True,
            "registered_count": len(self._registered_ids),
            "registered_ids": sorted(self._registered_ids),
            "base_url": self._base_url,
        }


# Module-level singleton
_register_service: DirectoryRegisterService | None = None
_initialized = False


def get_directory_register() -> DirectoryRegisterService | None:
    """Get the directory register service singleton (None if disabled)."""
    global _register_service, _initialized
    if not _initialized:
        _initialized = True
        _register_service = DirectoryRegisterService.from_env()
    return _register_service

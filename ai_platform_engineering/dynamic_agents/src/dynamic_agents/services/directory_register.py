# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
Directory self-registration: publishes CAIPE's built-in MCP servers to the
AGNTCY Directory so they are discoverable by other platforms.

The Directory's write path is the Store gRPC service (Push RPC), not a REST
POST to AI Finder. This module supports two modes:

1. **dirctl mode** (recommended for production): Generates OASF record JSON
   files and invokes `dirctl push <file> --server-addr <address>` to push
   them through the Store service. Requires `dirctl` binary available in PATH
   and a configured Directory endpoint.

2. **File-only mode** (local dev / init-container): Generates OASF record
   files to a directory. A sidecar or init-container can then push them
   with `dirctl push <file> --server-addr <address>` per record.

The service reconciles periodically (not one-shot) to handle MCP servers that
become available after initial startup (e.g., AgentGateway discovery).

Environment variables:
  DIRECTORY_SELF_REGISTER=true         enable self-registration (default: false)
  DIRECTORY_BASE_URL=http://...:8888   Directory server address (for dirctl)
  DIRECTORY_REGISTER_LABELS=key=val    labels to attach to self-registered records
  DIRECTORY_REGISTER_DIR=/tmp/dir-records  directory for exported record files
  DIRECTORY_REGISTER_MODE=file         "file" (default) or "dirctl"
  DIRECTORY_REGISTER_INTERVAL=0        reconcile interval in seconds (0 = one-shot)
"""

import asyncio
import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

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
    """Publishes CAIPE's built-in MCP servers to the AGNTCY Directory.

    Supports two modes:
    - "file": writes OASF record JSON files for external import
    - "dirctl": invokes `dirctl import` to push records via gRPC Store
    """

    def __init__(
        self,
        base_url: str,
        labels: dict[str, str] | None = None,
        output_dir: str = "/tmp/caipe-dir-records",
        mode: str = "file",
        reconcile_interval: float = 0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._labels = labels or {}
        self._output_dir = Path(output_dir)
        self._mode = mode  # "file" or "dirctl"
        self._reconcile_interval = reconcile_interval
        self._registered_ids: set[str] = set()
        self._task: asyncio.Task | None = None
        self._running = False

    @classmethod
    def from_env(cls) -> Optional["DirectoryRegisterService"]:
        """Create from environment. Returns None if self-registration is disabled."""
        if os.getenv("DIRECTORY_SELF_REGISTER", "").lower() != "true":
            return None

        base_url = os.getenv("DIRECTORY_BASE_URL", "http://dir-apiserver:8888")
        output_dir = os.getenv("DIRECTORY_REGISTER_DIR", "/tmp/caipe-dir-records")
        mode = os.getenv("DIRECTORY_REGISTER_MODE", "file")
        reconcile_interval = float(os.getenv("DIRECTORY_REGISTER_INTERVAL", "0"))

        # Parse labels from DIRECTORY_REGISTER_LABELS (comma-separated key=value)
        labels: dict[str, str] = {}
        raw_labels = os.getenv("DIRECTORY_REGISTER_LABELS", "")
        if raw_labels:
            for pair in raw_labels.split(","):
                pair = pair.strip()
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    labels[k.strip()] = v.strip()

        return cls(
            base_url=base_url,
            labels=labels,
            output_dir=output_dir,
            mode=mode,
            reconcile_interval=reconcile_interval,
        )

    def start(self) -> None:
        """Start the registration reconcile loop (if interval > 0)."""
        if self._reconcile_interval > 0:
            self._running = True
            self._task = asyncio.create_task(self._reconcile_loop())
            logger.info(
                "Directory self-registration started (mode=%s, interval=%ds)",
                self._mode,
                int(self._reconcile_interval),
            )

    async def stop(self) -> None:
        """Stop the reconcile loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _reconcile_loop(self) -> None:
        """Periodic reconcile: re-checks MongoDB for new enabled MCP servers."""
        await asyncio.sleep(10)  # Initial delay for seed/AgentGateway to populate
        while self._running:
            try:
                await self._reconcile_once()
            except Exception as exc:
                logger.error("Directory self-registration failed: %s", exc, exc_info=True)
            await asyncio.sleep(self._reconcile_interval)

    async def _reconcile_once(self) -> None:
        """Single reconcile cycle: read MCP servers from MongoDB and register."""
        from dynamic_agents.services.mongo import get_mongo_service
        from dynamic_agents.config import get_settings

        mongo = get_mongo_service()
        if mongo._db is None:
            return

        settings = get_settings()
        collection = mongo._db[settings.mcp_servers_collection]
        servers = list(collection.find({"enabled": True, "source": {"$ne": "directory"}}))
        if servers:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self.register_servers, servers)

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

        # Ensure output directory exists
        self._output_dir.mkdir(parents=True, exist_ok=True)

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
            success = self._export_record(server_id, record)
            if success:
                self._registered_ids.add(server_id)
                registered += 1
            else:
                failed += 1

        # If in dirctl mode and we have new records, run import
        if self._mode == "dirctl" and registered > 0:
            self._run_dirctl_import()

        logger.info(
            "Directory self-registration: registered=%d, skipped=%d, failed=%d (mode=%s)",
            registered,
            skipped,
            failed,
            self._mode,
        )
        return {"registered": registered, "skipped": skipped, "failed": failed}

    def _export_record(self, server_id: str, record: dict) -> bool:
        """Write an OASF record to the output directory as JSON."""
        try:
            filepath = self._output_dir / f"{server_id}.json"
            filepath.write_text(json.dumps(record, indent=2, default=str))
            logger.debug("Exported OASF record for '%s' to %s", server_id, filepath)
            return True
        except Exception as exc:
            logger.warning("Failed to export record for '%s': %s", server_id, exc)
            return False

    def _run_dirctl_import(self) -> None:
        """Run `dirctl push` for each exported record to push them to the Directory Store."""
        import glob as glob_mod

        record_files = list(glob_mod.glob(str(self._output_dir / "*.json")))
        if not record_files:
            logger.debug("No record files to push in %s", self._output_dir)
            return

        pushed = 0
        failed = 0
        for filepath in record_files:
            try:
                cmd = [
                    "dirctl", "push", filepath,
                    "--server-addr", self._base_url,
                ]
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if result.returncode == 0:
                    pushed += 1
                    logger.debug("dirctl push succeeded for %s: %s", filepath, result.stdout.strip()[:100])
                else:
                    failed += 1
                    logger.warning(
                        "dirctl push failed for %s (exit %d): %s",
                        filepath,
                        result.returncode,
                        result.stderr.strip()[:200],
                    )
            except FileNotFoundError:
                logger.warning(
                    "dirctl binary not found. Records exported to %s — "
                    "run `dirctl push <file> --server-addr %s` manually or via sidecar.",
                    self._output_dir,
                    self._base_url,
                )
                return
            except Exception as exc:
                failed += 1
                logger.warning("dirctl push error for %s: %s", filepath, exc)

        logger.info("dirctl push complete: %d pushed, %d failed", pushed, failed)

    @property
    def status(self) -> dict:
        """Return registration status."""
        return {
            "enabled": True,
            "mode": self._mode,
            "output_dir": str(self._output_dir),
            "registered_count": len(self._registered_ids),
            "registered_ids": sorted(self._registered_ids),
            "reconcile_interval": int(self._reconcile_interval),
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

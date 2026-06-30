# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
Directory self-registration: publishes CAIPE's built-in MCP servers to the
AGNTCY Directory so they are discoverable by other platforms.

Uses the agntcy-dir Python SDK (gRPC client) to push records directly to the
Directory Store service and optionally publish them for network routing.

The service reconciles periodically (not one-shot) to handle MCP servers that
become available after initial startup (e.g., AgentGateway discovery).

Environment variables:
  DIRECTORY_SELF_REGISTER=true         enable self-registration (default: false)
  DIRECTORY_SERVER_ADDRESS=host:8888   Directory gRPC server address
  DIRECTORY_REGISTER_LABELS=key=val    labels to attach to self-registered records
  DIRECTORY_REGISTER_INTERVAL=300      reconcile interval in seconds (0 = one-shot)
  DIRECTORY_REGISTER_PUBLISH=true      also publish records for network routing
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Schema version for the OASF records we publish
OASF_SCHEMA_VERSION = "1.0.0"


def _server_to_oasf_record_dict(
    server: dict,
    labels: dict[str, str],
) -> dict:
    """Convert an MCP server MongoDB document to an OASF agent record dict.

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

    record_dict = {
        "name": server.get("name", server.get("_id", "unknown")),
        "description": server.get("description", ""),
        "version": "1.0.0",
        "schema_version": OASF_SCHEMA_VERSION,
        "authors": ["CAIPE Platform <caipe@cnoe.io>"],
        "created_at": now,
        "annotations": {
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
    return record_dict


class DirectoryRegisterService:
    """Publishes CAIPE's built-in MCP servers to the AGNTCY Directory.

    Uses the agntcy-dir Python SDK to push OASF records directly via gRPC,
    eliminating the need for the `dirctl` CLI binary or file export.
    """

    def __init__(
        self,
        server_address: str,
        labels: dict[str, str] | None = None,
        reconcile_interval: float = 300,
        publish_to_routing: bool = True,
    ) -> None:
        self._server_address = server_address
        self._labels = labels or {}
        self._reconcile_interval = reconcile_interval
        self._publish_to_routing = publish_to_routing
        self._registered_ids: set[str] = set()
        self._registered_cids: dict[str, str] = {}  # server_id -> CID
        self._task: asyncio.Task | None = None
        self._running = False
        self._client = None  # Lazy-initialized SDK client

    def _get_client(self):
        """Get or create the SDK client (lazy initialization)."""
        if self._client is None:
            from agntcy.dir_sdk.client import Client, Config

            config = Config(server_address=self._server_address)
            self._client = Client(config)
        return self._client

    @classmethod
    def from_env(cls) -> Optional["DirectoryRegisterService"]:
        """Create from environment. Returns None if self-registration is disabled."""
        if os.getenv("DIRECTORY_SELF_REGISTER", "").lower() != "true":
            return None

        server_address = os.getenv("DIRECTORY_SERVER_ADDRESS", "dir-apiserver:8888")
        reconcile_interval = float(os.getenv("DIRECTORY_REGISTER_INTERVAL", "300"))
        publish_to_routing = os.getenv("DIRECTORY_REGISTER_PUBLISH", "true").lower() == "true"

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
            server_address=server_address,
            labels=labels,
            reconcile_interval=reconcile_interval,
            publish_to_routing=publish_to_routing,
        )

    def start(self) -> None:
        """Start the registration reconcile loop (if interval > 0)."""
        if self._reconcile_interval > 0:
            self._running = True
            self._task = asyncio.create_task(self._reconcile_loop())
            logger.info(
                "Directory self-registration started (interval=%ds, publish=%s)",
                int(self._reconcile_interval),
                self._publish_to_routing,
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

        Uses the SDK to push OASF records via gRPC and optionally publish
        them for network routing.

        Args:
            servers: List of MCP server MongoDB documents.
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

            record_dict = _server_to_oasf_record_dict(server, self._labels)
            cid = self._push_record(server_id, record_dict)
            if cid:
                self._registered_ids.add(server_id)
                self._registered_cids[server_id] = cid
                registered += 1

                # Optionally publish for network routing
                if self._publish_to_routing:
                    self._publish_record(cid)
            else:
                failed += 1

        logger.info(
            "Directory self-registration: registered=%d, skipped=%d, failed=%d",
            registered,
            skipped,
            failed,
        )
        return {"registered": registered, "skipped": skipped, "failed": failed}

    def _push_record(self, server_id: str, record_dict: dict) -> Optional[str]:
        """Push an OASF record to the Directory Store via SDK.

        Returns the CID string if successful, None otherwise.
        """
        try:
            from agntcy.dir.core.v1 import record_pb2
            from google.protobuf import json_format

            # Create protobuf Record with the OASF data as a Struct
            record = record_pb2.Record()
            json_format.ParseDict({"data": record_dict}, record)

            client = self._get_client()
            refs = client.push([record])

            if refs and len(refs) > 0:
                cid = refs[0].cid
                logger.info("Pushed '%s' to Directory: CID=%s", server_id, cid)
                return cid
            else:
                logger.warning("Push returned no CID for '%s'", server_id)
                return None
        except Exception as exc:
            logger.warning("Failed to push '%s' to Directory: %s", server_id, exc)
            return None

    def _publish_record(self, cid: str) -> None:
        """Publish a record for network routing (makes it discoverable by other peers)."""
        try:
            from agntcy.dir.core.v1 import record_pb2
            from agntcy.dir.routing.v1 import routing_service_pb2

            ref = record_pb2.RecordRef(cid=cid)
            req = routing_service_pb2.PublishRequest(
                record_refs=routing_service_pb2.RecordRefs(refs=[ref])
            )
            client = self._get_client()
            client.publish(req)
            logger.debug("Published CID=%s to routing network", cid)
        except Exception as exc:
            logger.debug("Failed to publish CID=%s to routing: %s", cid, exc)

    @property
    def status(self) -> dict:
        """Return registration status."""
        return {
            "enabled": True,
            "server_address": self._server_address,
            "registered_count": len(self._registered_ids),
            "registered_ids": sorted(self._registered_ids),
            "registered_cids": dict(self._registered_cids),
            "reconcile_interval": int(self._reconcile_interval),
            "publish_to_routing": self._publish_to_routing,
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

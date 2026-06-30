# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
Directory sync service: periodically discovers agents from an AGNTCY Directory
instance and upserts corresponding MCP server records into MongoDB so the
dynamic agents runtime can route to them.

Architecture:
  - Runs as an async background task during DA lifespan
  - Creates/updates MCP server records with source="directory"
  - Does NOT delete records (agents may be temporarily offline)
  - Marks stale records with a last_seen timestamp for eventual cleanup
  - Exposes a manual sync endpoint for the UI

Environment variables:
  DIRECTORY_ENABLED=true
  DIRECTORY_BASE_URL=http://dir-apiserver:8888
  DIRECTORY_LABEL_FILTER=key=value
  DIRECTORY_TIMEOUT=10.0
  DIRECTORY_SYNC_INTERVAL=300  (seconds, default 5 min)
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

from dynamic_agents.services.directory_source import DirectoryAgentSource, DirectoryAgentRecord

logger = logging.getLogger(__name__)

# Prefix for MCP server IDs created by Directory sync
DIRECTORY_MCP_PREFIX = "directory-"


def _agent_record_to_mcp_document(record: DirectoryAgentRecord) -> dict:
    """Convert a DirectoryAgentRecord to an MCP server MongoDB document.

    Protocol-aware behavior:
    - MCP records (protocol="mcp"): stored as enabled=True, with proper transport
      type mapped from OASF connection type. These are directly callable by the
      MCP runtime client.
    - A2A records (protocol="a2a"): stored as enabled=False, catalog-only.
      The runtime MCP client should not attempt to connect. A future A2A routing
      path will handle communication.
    """
    server_id = f"{DIRECTORY_MCP_PREFIX}{record.name}"
    now = datetime.now(timezone.utc)

    # Map OASF transport type to CAIPE transport field
    if record.is_mcp:
        transport_map = {
            "streamable-http": "http",
            "sse": "sse",
        }
        transport = transport_map.get(record.transport, "http")
        enabled = True
    else:
        transport = "http"
        enabled = False

    doc = {
        "_id": server_id,
        "name": f"[Directory] {record.name}",
        "description": record.metadata.get("description", f"Agent discovered from AGNTCY Directory: {record.name}"),
        "transport": transport,
        "endpoint": record.url,
        "enabled": enabled,
        "source": "directory",
        "directory_agent": True,
        "directory_protocol": record.protocol,
        "config_driven": False,
        "agentgateway_discovered": False,
        "directory_cid": record.metadata.get("directory_cid"),
        "directory_capabilities": record.capabilities,
        "directory_metadata": record.metadata,
        "directory_last_seen": now,
        "updated_at": now,
    }

    # Include A2A card if present
    if record.a2a_card:
        doc["directory_a2a_card"] = record.a2a_card

    # Include MCP tools manifest if available (for UI display before probing)
    if record.mcp_tools:
        doc["directory_mcp_tools"] = record.mcp_tools

    return doc


class DirectorySyncService:
    """Manages periodic sync of agents from AGNTCY Directory into MongoDB."""

    def __init__(self, source: DirectoryAgentSource, sync_interval: float = 300.0) -> None:
        self._source = source
        self._sync_interval = sync_interval
        self._task: asyncio.Task | None = None
        self._last_sync: datetime | None = None
        self._last_sync_count: int = 0
        self._running = False
        self._sync_lock = asyncio.Lock()

    @classmethod
    def from_env(cls) -> "DirectorySyncService | None":
        """Create from environment. Returns None if Directory is disabled."""
        source = DirectoryAgentSource.from_env()
        if source is None:
            return None
        interval = float(os.getenv("DIRECTORY_SYNC_INTERVAL", "300"))
        return cls(source=source, sync_interval=interval)

    def start(self) -> None:
        """Start the background sync loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._sync_loop())
        logger.info(
            "Directory sync started (interval=%ds, base_url=%s)",
            int(self._sync_interval),
            self._source._base_url,
        )

    async def stop(self) -> None:
        """Stop the background sync loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Directory sync stopped")

    async def _sync_loop(self) -> None:
        """Background loop: sync on startup, then every sync_interval seconds."""
        # Initial sync after a short delay (let MongoDB connect first)
        await asyncio.sleep(5)
        while self._running:
            try:
                await self.sync_once()
            except Exception as exc:
                logger.error("Directory sync failed: %s", exc, exc_info=True)
            await asyncio.sleep(self._sync_interval)

    async def sync_once(self) -> dict:
        """Run a single sync cycle. Returns a summary dict.

        This runs the HTTP fetch in a thread to avoid blocking the event loop.
        Uses an asyncio.Lock to prevent races between manual and background sync.
        """
        async with self._sync_lock:
            return await self._do_sync()

    async def _do_sync(self) -> dict:
        """Internal sync implementation (must be called under _sync_lock)."""
        loop = asyncio.get_event_loop()
        records = await loop.run_in_executor(None, self._source.fetch_agents)

        if not records:
            logger.debug("Directory sync: no agents discovered")
            return {"synced": 0, "added": 0, "updated": 0}

        # Perform upserts into MongoDB
        from dynamic_agents.services.mongo import get_mongo_service
        from dynamic_agents.config import get_settings

        mongo = get_mongo_service()
        if mongo._db is None:
            logger.warning("Directory sync skipped: MongoDB not connected")
            return {"synced": 0, "added": 0, "updated": 0, "error": "mongodb_not_connected"}

        settings = get_settings()
        collection = mongo._db[settings.mcp_servers_collection]

        added = 0
        updated = 0

        for record in records:
            doc = _agent_record_to_mcp_document(record)
            server_id = doc["_id"]

            existing = collection.find_one({"_id": server_id})
            if existing is None:
                # New agent — insert with created_at
                doc["created_at"] = doc["updated_at"]
                collection.insert_one(doc)
                added += 1
                logger.info("Directory sync: added new agent '%s' (%s)", record.name, server_id)
            else:
                # Existing agent — update mutable fields only
                update_fields = {
                    "endpoint": doc["endpoint"],
                    "description": doc["description"],
                    "transport": doc["transport"],
                    "enabled": doc["enabled"],
                    "directory_protocol": doc["directory_protocol"],
                    "directory_cid": doc["directory_cid"],
                    "directory_capabilities": doc["directory_capabilities"],
                    "directory_metadata": doc["directory_metadata"],
                    "directory_last_seen": doc["directory_last_seen"],
                    "updated_at": doc["updated_at"],
                }
                # Conditionally include optional fields
                if "directory_a2a_card" in doc:
                    update_fields["directory_a2a_card"] = doc["directory_a2a_card"]
                if "directory_mcp_tools" in doc:
                    update_fields["directory_mcp_tools"] = doc["directory_mcp_tools"]
                collection.update_one({"_id": server_id}, {"$set": update_fields})
                updated += 1

        self._last_sync = datetime.now(timezone.utc)
        self._last_sync_count = len(records)

        logger.info(
            "Directory sync complete: %d agents (added=%d, updated=%d)",
            len(records),
            added,
            updated,
        )
        return {"synced": len(records), "added": added, "updated": updated}

    @property
    def status(self) -> dict:
        """Return current sync status."""
        return {
            "enabled": True,
            "running": self._running,
            "last_sync": self._last_sync.isoformat() if self._last_sync else None,
            "last_sync_count": self._last_sync_count,
            "sync_interval_seconds": int(self._sync_interval),
            "base_url": self._source._base_url,
        }


# Module-level singleton
_directory_sync: DirectorySyncService | None = None
_initialized = False


def get_directory_sync() -> DirectorySyncService | None:
    """Get the directory sync service singleton (None if disabled)."""
    global _directory_sync, _initialized
    if not _initialized:
        _initialized = True
        _directory_sync = DirectorySyncService.from_env()
    return _directory_sync

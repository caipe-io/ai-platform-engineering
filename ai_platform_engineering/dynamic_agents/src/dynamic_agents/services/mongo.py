"""MongoDB service for Dynamic Agents.

DA is a pure runtime reader — all config writes (CRUD, seeding) are
handled by the Next.js gateway. This module provides read-only access
to agent and MCP server configurations.
"""

import logging
from functools import lru_cache
from pathlib import Path

import yaml
from pymongo import ASCENDING, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.errors import PyMongoError

from dynamic_agents.config import Settings, get_settings
from dynamic_agents.models import (
    DynamicAgentConfig,
    MCPServerConfig,
)

logger = logging.getLogger(__name__)

# Packaged seed config: the authoritative declaration of how built-in MCP
# servers authenticate upstream (see services/config.yaml, same directory).
_SEED_CONFIG_PATH = Path(__file__).with_name("config.yaml")


@lru_cache(maxsize=1)
def _builtin_credential_sources() -> dict[str, list[dict]]:
    """Built-in MCP ``credential_sources`` keyed by server id.

    Read once from the packaged ``config.yaml``. AgentGateway discovery (the
    UI's MCP-server provisioning path) historically persisted ``mcp_servers``
    documents *without* ``credential_sources``; transform-based gateway routes
    then emitted an empty Bearer and the upstream returned 401 (most visibly
    ``knowledge-base``/RAG). Using the seed config as the source of truth keeps
    this in sync with the runtime declaration the gateway transforms rely on.

    Best-effort: a missing/unreadable config yields an empty map (no injection),
    so a packaging hiccup can never break reads.
    """
    try:
        with _SEED_CONFIG_PATH.open() as fh:
            data = yaml.safe_load(fh) or {}
    except (OSError, yaml.YAMLError) as exc:  # pragma: no cover - defensive
        logger.warning(
            "Could not load built-in MCP credential sources from %s: %s",
            _SEED_CONFIG_PATH,
            exc,
        )
        return {}
    result: dict[str, list[dict]] = {}
    for server in data.get("mcp_servers") or []:
        server_id = server.get("id")
        sources = server.get("credential_sources")
        if server_id and sources:
            result[server_id] = sources
    return result


def _inject_builtin_credential_sources(doc: dict) -> dict:
    """Self-heal: fill ``credential_sources`` for known built-in MCP servers.

    Read-time defense-in-depth for documents persisted before discovery
    attached ``credential_sources``. Only fills when the field is absent;
    an explicit empty list means the operator cleared credentials.
    """
    if "credential_sources" in doc:
        return doc
    builtin = _builtin_credential_sources().get(doc.get("_id"))
    if builtin:
        doc = {**doc, "credential_sources": builtin}
    return doc


def _strip_nulls(doc: dict) -> dict:
    """Strip None values from a MongoDB document before pydantic construction.

    Pydantic only applies default_factory when a key is absent — an explicit
    None passed as a kwarg bypasses the default. Stripping nulls here lets
    fields like interrupt_on recover their default when stored as null in
    older documents.
    """
    return {k: v for k, v in doc.items() if v is not None}


class MongoDBService:
    """MongoDB service for reading dynamic agent and MCP server configs."""

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()
        self._client: MongoClient | None = None
        self._db: Database | None = None

    def connect(self) -> bool:
        """Connect to MongoDB. Returns True if successful."""
        try:
            self._client = MongoClient(
                self.settings.mongodb_uri,
                serverSelectionTimeoutMS=5000,
                retryWrites=False,
                tz_aware=True,
            )
            # Verify connectivity
            self._client.admin.command("ping")
            self._db = self._client[self.settings.mongodb_database]
            logger.info(f"MongoDB connected (database: {self.settings.mongodb_database})")
            self._ensure_indexes()
            return True
        except PyMongoError as e:
            logger.error(f"Failed to connect to MongoDB: {e}")
            self._client = None
            self._db = None
            return False

    def disconnect(self) -> None:
        """Disconnect from MongoDB."""
        if self._client:
            self._client.close()
            self._client = None
            self._db = None

    def _ensure_indexes(self) -> None:
        """Create indexes for collections."""
        if self._db is None:
            return

        # Dynamic agents indexes
        agents_coll = self._get_agents_collection()
        agents_coll.create_index([("owner_id", ASCENDING)])
        agents_coll.create_index([("visibility", ASCENDING)])
        agents_coll.create_index([("enabled", ASCENDING)])
        agents_coll.create_index([("name", ASCENDING)])

        # MCP servers indexes
        servers_coll = self._get_servers_collection()
        servers_coll.create_index([("enabled", ASCENDING)])

        self._db["conversations"].create_index(
            [("owner_subject", ASCENDING), ("metadata.project_id", ASCENDING), ("updated_at", ASCENDING)]
        )

        logger.info("MongoDB indexes ensured")

    def _get_agents_collection(self) -> Collection:
        """Get the dynamic_agents collection."""
        if self._db is None:
            raise RuntimeError("MongoDB not connected")
        return self._db[self.settings.dynamic_agents_collection]

    def _get_servers_collection(self) -> Collection:
        """Get the mcp_servers collection."""
        if self._db is None:
            raise RuntimeError("MongoDB not connected")
        return self._db[self.settings.mcp_servers_collection]

    # =========================================================================
    # Read-only agent access
    # =========================================================================

    def get_agent(self, agent_id: str) -> DynamicAgentConfig | None:
        """Get a dynamic agent config by ID."""
        doc = self._get_agents_collection().find_one({"_id": agent_id})
        if doc:
            return DynamicAgentConfig(**_strip_nulls(doc))
        return None

    def resolve_rag_datasource_ids(
        self,
        collection_ids: list[str],
        datasource_ids: list[str] | None = None,
    ) -> list[str]:
        """Expand RAG collections into current datasource ids.

        Collections are control-plane documents only; chunks remain keyed by
        ``datasource_id`` in Milvus. Reading membership for each tool call
        means a Platform/team knowledge-base update automatically propagates
        to cached agent runtimes without rebuilding or rewriting agents.

        Mongo errors fail closed to the explicitly pinned datasource ids.
        """
        direct = list(dict.fromkeys(datasource_ids or []))
        if not collection_ids:
            return direct
        if self._db is None:
            logger.warning("Cannot resolve RAG collections: MongoDB is not connected")
            return direct
        try:
            docs = self._db["rag_collections"].find(
                {"_id": {"$in": list(dict.fromkeys(collection_ids))}},
                {"source_ids": 1},
            )
            combined = direct[:]
            seen = set(combined)
            for doc in docs:
                for source_id in doc.get("source_ids") or []:
                    if isinstance(source_id, str) and source_id and source_id not in seen:
                        seen.add(source_id)
                        combined.append(source_id)
            return combined
        except PyMongoError as exc:
            logger.error("Failed to resolve RAG collection membership: %s", exc)
            return direct

    # =========================================================================
    # Read-only MCP server access
    # =========================================================================

    def get_server(self, server_id: str) -> MCPServerConfig | None:
        """Get an MCP server config by ID."""
        doc = self._get_servers_collection().find_one({"_id": server_id})
        if doc:
            return MCPServerConfig(**_strip_nulls(_inject_builtin_credential_sources(doc)))
        return None

    def get_servers_by_ids(self, server_ids: list[str]) -> list[MCPServerConfig]:
        """Get multiple MCP servers by their IDs."""
        docs = self._get_servers_collection().find({"_id": {"$in": server_ids}})
        return [
            MCPServerConfig(**_strip_nulls(_inject_builtin_credential_sources(doc)))
            for doc in docs
        ]

    def get_agent_mcp_servers(self, agent: DynamicAgentConfig) -> list[MCPServerConfig]:
        """Get MCP servers for an agent AND all its subagents.

        When a parent agent spawns subagents, the runtime needs access to
        MCP server configs for both the parent and its subagents. Without
        this, subagent tools silently fail to load because their MCP server
        configs are missing from the registry passed to AgentRuntime.
        """
        server_ids: set[str] = set(agent.allowed_tools.keys())
        if agent.subagents:
            for ref in agent.subagents:
                subagent_config = self.get_agent(ref.agent_id)
                if subagent_config:
                    server_ids.update(subagent_config.allowed_tools.keys())
        return self.get_servers_by_ids(list(server_ids)) if server_ids else []


# Singleton instance
_mongo_service: MongoDBService | None = None


def get_mongo_service() -> MongoDBService:
    """Get or create the MongoDB service singleton."""
    global _mongo_service
    if _mongo_service is None:
        _mongo_service = MongoDBService()
        _mongo_service.connect()
    return _mongo_service


def reset_mongo_service() -> None:
    """Reset the MongoDB service singleton (for retry logic during startup)."""
    global _mongo_service
    if _mongo_service is not None:
        _mongo_service.disconnect()
    _mongo_service = None

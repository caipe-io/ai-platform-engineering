"""Resolve native persistence and logical filesystem settings in one place."""

from dataclasses import dataclass

from dynamic_agents.config import Settings
from dynamic_agents.models import AgentBackend, AgentBackendConfig, DynamicAgentConfig


@dataclass(frozen=True)
class RuntimeStorage:
    database: str
    backend_type: str
    checkpoint_collection: str
    checkpoint_writes_collection: str
    checkpoint_ttl: int | None
    gridfs_bucket_name: str
    fs_namespace: tuple[str, str | None, str]
    fs_ttl_seconds: int


def resolve_runtime_storage(
    agent: DynamicAgentConfig | None,
    session_id: str | None,
    settings: Settings,
    *,
    agent_id: str | None = None,
) -> RuntimeStorage:
    """Resolve overrides or legacy defaults without reading a mutable registry.

    A config-less administrative operation uses only the supplied identity and
    server defaults. A custom checkpoint collection has its conventional writes
    collection; absent an override, preserve the separately configured default.
    """
    backend = agent.backend if agent is not None else None
    config = backend.config if backend is not None else None
    collection = config.checkpoint_collection if config is not None else None
    ttl = config.fs_ttl_seconds if config is not None else None
    if ttl is None:
        ttl = settings.default_fs_ttl_seconds
    if settings.max_fs_ttl_seconds and ttl and ttl > settings.max_fs_ttl_seconds:
        ttl = settings.max_fs_ttl_seconds
    namespace = config.fs_namespace if config is not None else None
    return RuntimeStorage(
        database=settings.mongodb_database,
        backend_type=backend.type if backend and backend.type else settings.default_runtime_backend,
        checkpoint_collection=collection or settings.checkpoint_collection,
        checkpoint_writes_collection=f"{collection}_writes" if collection else settings.checkpoint_writes_collection,
        checkpoint_ttl=config.checkpoint_ttl if config is not None else None,
        gridfs_bucket_name=settings.gridfs_bucket_name,
        fs_namespace=tuple(namespace) if namespace else (agent.id if agent is not None else agent_id or "", session_id, "filesystem"),
        fs_ttl_seconds=ttl,
    )


def materialize_runtime_config(agent: DynamicAgentConfig, session_id: str, settings: Settings) -> DynamicAgentConfig:
    """Pin logical filesystem defaults while retaining legacy checkpoint spelling."""
    storage = resolve_runtime_storage(agent, session_id, settings)
    backend = agent.backend or AgentBackend()
    config = (backend.config or AgentBackendConfig()).model_copy(update={
        "fs_namespace": list(storage.fs_namespace),
        "fs_ttl_seconds": storage.fs_ttl_seconds,
    })
    backend = backend.model_copy(update={"type": storage.backend_type, "config": config})
    # Setting checkpoint_collection to its resolved default would rename the
    # writes collection. Keep that nullable override exactly as supplied.
    return agent.model_copy(update={"backend": backend}, deep=True)

"""AgentRuntime cache (pool) with TTL-based cleanup and bounded LRU eviction.

Manages a pool of ``AgentRuntime`` instances keyed by
``(agent_id, session_id)``, with automatic expiry, config-change
invalidation, and a flat capacity limit.
"""

from __future__ import annotations

import asyncio
import gc
import logging
import os
import resource
import sys
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from pymongo import MongoClient

from dynamic_agents.config import get_settings
from dynamic_agents.metrics import metrics as prom_metrics
from dynamic_agents.models import (
    ClientContext,
    DynamicAgentConfig,
    MCPServerConfig,
    UserContext,
)
from dynamic_agents.services.agent_runtime import AgentRuntime
from dynamic_agents.services.llm_clients import close_all as close_llm_clients

if TYPE_CHECKING:
    from dynamic_agents.services.mongo import MongoDBService

logger = logging.getLogger(__name__)


class RuntimeInitError(Exception):
    """Raised when an AgentRuntime fails to initialize."""

    def __init__(self, agent_id: str, cause: Exception):
        self.agent_id = agent_id
        self.cause = cause
        super().__init__(f"Failed to initialize runtime for agent '{agent_id}': {cause}")


class RuntimeCapacityError(Exception):
    """Raised when the cache is at capacity and all runtimes are actively streaming."""

    def __init__(self, max_size: int):
        self.max_size = max_size
        super().__init__(f"Agent runtime cache at capacity ({max_size} active streams). Please try again shortly.")


class AgentRuntimeCache:
    """Cache for AgentRuntime instances with TTL + bounded LRU eviction.

    Runs a background sweep every ``sweep_interval`` seconds to purge
    runtimes that have been idle longer than ``ttl_seconds``.

    When the cache reaches max capacity and a new runtime is needed,
    the least-recently-used idle runtime is evicted. If all runtimes
    are actively streaming, a ``RuntimeCapacityError`` is raised.
    """

    def __init__(
        self,
        ttl_seconds: int = 600,
        mongo_service: "MongoDBService | None" = None,
        max_size: int | None = None,
    ):
        self._cache: dict[str, "AgentRuntime"] = {}
        self._ttl = ttl_seconds
        self._sweep_interval = ttl_seconds
        self._mongo_service = mongo_service
        self._sweep_task: asyncio.Task | None = None
        # Shared MongoClient for all runtimes (checkpointer).
        # Created lazily on first get_or_create.
        self._shared_mongo_client: MongoClient | None = None
        # Single-flight: futures for in-progress initializations.
        # Prevents duplicate init when concurrent requests hit the same key.
        # Self-cleaning: removed in finally block after init completes/fails.
        self._pending: dict[str, asyncio.Future["AgentRuntime"]] = {}

        # Flat cap on concurrent cached runtimes
        if max_size is not None:
            self._max_size = max_size
        else:
            self._max_size = get_settings().agent_runtime_max_cache_size
        self._update_metrics()

    def _update_metrics(self) -> None:
        """Publish bounded cache state after each mutation."""
        prom_metrics.runtime_cache_entries.set(len(self._cache))
        prom_metrics.runtime_cache_capacity.set(self._max_size)
        prom_metrics.runtime_cache_pending_initializations.set(len(self._pending))

    def set_mongo_service(self, mongo_service: "MongoDBService") -> None:
        """Set the MongoDB service for subagent resolution.

        This is called after the cache is created, since the MongoDB service
        may not be available at cache creation time.
        """
        self._mongo_service = mongo_service

    def start(self) -> None:
        """Start the background sweep task."""
        if self._sweep_task is None or self._sweep_task.done():
            self._sweep_task = asyncio.create_task(self._sweep_loop())
            logger.info(
                "Runtime cache started (interval=%ds, ttl=%ds, max_size=%d)",
                self._sweep_interval,
                self._ttl,
                self._max_size,
            )

    async def stop(self) -> None:
        """Stop the background sweep and clear all runtimes."""
        if self._sweep_task and not self._sweep_task.done():
            self._sweep_task.cancel()
            try:
                await self._sweep_task
            except asyncio.CancelledError:
                logger.debug("Sweep task cancelled")
            self._sweep_task = None
        await self.clear()
        # Close the shared MongoClient after all runtimes are cleared
        if self._shared_mongo_client:
            self._shared_mongo_client.close()
            self._shared_mongo_client = None
            logger.info("Closed shared MongoClient")
        # Close shared LLM transport clients
        close_llm_clients()
        logger.info("Runtime cache stopped")

    async def _sweep_loop(self) -> None:
        """Periodically purge idle runtimes."""
        while True:
            await asyncio.sleep(self._sweep_interval)
            try:
                await self._cleanup_expired()
            except Exception:
                logger.exception("Error during runtime cache sweep")

    def _make_key(self, agent_id: str, session_id: str) -> str:
        """Create cache key from agent and session IDs."""
        return f"{agent_id}:{session_id}"

    async def get_or_create(
        self,
        agent_config: DynamicAgentConfig,
        mcp_servers: list[MCPServerConfig],
        session_id: str,
        user: UserContext | None = None,
        client_context: ClientContext | None = None,
        project_id: str | None = None,
        projects_enabled: bool = False,
    ) -> "AgentRuntime":
        """Get an existing runtime or create a new one.

        Uses a single-flight pattern: if multiple concurrent requests arrive
        for the same key, only the first performs initialization. Others await
        the same future, receiving the same runtime (or the same exception).

        Raises:
            RuntimeCapacityError: If the cache is full and all runtimes are streaming.
            RuntimeInitError: If the new runtime fails to initialize.
        """
        key = self._make_key(agent_config.id, session_id)

        # Fast path: cached and valid
        if key in self._cache:
            runtime = self._cache[key]
            if runtime.is_stale(agent_config, mcp_servers):
                logger.info(
                    "Runtime cache invalidated due to config change for agent %s",
                    agent_config.id,
                )
                await runtime.cleanup()
                del self._cache[key]
                prom_metrics.runtime_cache_evictions_total.labels(reason="config_change").inc()
                self._update_metrics()
            elif user and (
                getattr(getattr(runtime, "_user", None), "sub", None) != user.sub
                or getattr(getattr(runtime, "_user", None), "email", None) != user.email
            ):
                logger.info(
                    "Runtime cache invalidated due to user context change for agent %s",
                    agent_config.id,
                )
                await runtime.cleanup()
                del self._cache[key]
                prom_metrics.runtime_cache_evictions_total.labels(reason="user_change").inc()
                self._update_metrics()
            elif getattr(runtime, "_project_id", None) != project_id:
                logger.info(
                    "Runtime cache invalidated due to immutable Project change for agent %s",
                    agent_config.id,
                )
                await runtime.cleanup()
                del self._cache[key]
                prom_metrics.runtime_cache_evictions_total.labels(reason="project_change").inc()
                self._update_metrics()
            elif getattr(runtime, "_projects_enabled", False) != projects_enabled:
                logger.info(
                    "Runtime cache invalidated due to platform Projects setting change for agent %s",
                    agent_config.id,
                )
                await runtime.cleanup()
                del self._cache[key]
                prom_metrics.runtime_cache_evictions_total.labels(reason="config_change").inc()
                self._update_metrics()
            elif runtime.idle_seconds >= self._ttl:
                logger.info(
                    "Runtime cache expired due to inactivity (%.0fs idle) for agent %s",
                    runtime.idle_seconds,
                    agent_config.id,
                )
                await runtime.cleanup()
                del self._cache[key]
                prom_metrics.runtime_cache_evictions_total.labels(reason="expired").inc()
                self._update_metrics()
            else:
                runtime.touch()
                logger.debug("Runtime cache hit for agent %s session %s", agent_config.id, session_id)
                return runtime

        # Someone else is already initializing this key — wait for their result
        if key in self._pending:
            return await self._pending[key]

        # We're the first — create a future and perform initialization
        loop = asyncio.get_event_loop()
        fut: asyncio.Future["AgentRuntime"] = loop.create_future()
        self._pending[key] = fut
        self._update_metrics()

        try:
            runtime = await self._create_runtime(
                key,
                agent_config,
                mcp_servers,
                session_id,
                user,
                client_context,
                project_id,
                projects_enabled,
            )
            self._cache[key] = runtime
            self._update_metrics()
            fut.set_result(runtime)
            logger.info(
                "Created new cached runtime for agent %s session %s (cache %d/%d)",
                agent_config.id,
                session_id,
                len(self._cache),
                self._max_size,
            )
            return runtime
        except Exception as e:
            fut.set_exception(e)
            raise
        finally:
            self._pending.pop(key, None)
            self._update_metrics()

    @asynccontextmanager
    async def ephemeral(
        self,
        agent_config: "DynamicAgentConfig",
        mcp_servers: list["MCPServerConfig"],
        session_id: str,
        *,
        user: "UserContext | None" = None,
        client_context: "ClientContext | None" = None,
        project_id: str | None = None,
        projects_enabled: bool = False,
    ):
        """Async context manager: create a throwaway runtime, cleaned up on exit. Not cached.

        Uses in-memory checkpointer (no MongoDB writes).
        """
        runtime = AgentRuntime(
            agent_config,
            mcp_servers,
            mongo_service=self._mongo_service,
            user=user,
            client_context=client_context,
            session_id=session_id,
            ephemeral=True,
            project_id=project_id,
            projects_enabled=projects_enabled,
        )
        try:
            await runtime.initialize()
        except Exception as e:
            logger.exception("Ephemeral runtime initialization failed for agent '%s'", agent_config.id)
            raise RuntimeInitError(agent_config.id, e) from e

        logger.info("Created ephemeral runtime for agent %s (in-memory, not cached)", agent_config.id)
        try:
            yield runtime
        finally:
            await runtime.cleanup()
            logger.debug("Ephemeral runtime cleaned up for agent %s", agent_config.id)

    @asynccontextmanager
    async def persistent(
        self,
        agent_config: "DynamicAgentConfig",
        mcp_servers: list["MCPServerConfig"],
        session_id: str,
        *,
        user: "UserContext | None" = None,
        client_context: "ClientContext | None" = None,
        project_id: str | None = None,
        projects_enabled: bool = False,
    ):
        """Create a non-cached Mongo-backed runtime and clean it up on exit.

        Scheduled invocations need durable LangGraph checkpoints so a user can
        continue the resulting conversation, but should not enter the shared
        runtime cache where an interactive request could race with the run.
        """
        runtime = AgentRuntime(
            agent_config,
            mcp_servers,
            mongo_service=self._mongo_service,
            user=user,
            client_context=client_context,
            session_id=session_id,
            project_id=project_id,
            projects_enabled=projects_enabled,
        )
        try:
            await runtime.initialize()
        except Exception as e:
            logger.exception(
                "Persistent runtime initialization failed for agent '%s'",
                agent_config.id,
            )
            raise RuntimeInitError(agent_config.id, e) from e

        logger.info("Created persistent one-shot runtime for agent %s", agent_config.id)
        try:
            yield runtime
        finally:
            await runtime.cleanup()
            logger.debug(
                "Persistent one-shot runtime cleaned up for agent %s",
                agent_config.id,
            )

    async def _create_runtime(
        self,
        key: str,
        agent_config: DynamicAgentConfig,
        mcp_servers: list[MCPServerConfig],
        session_id: str,
        user: UserContext | None,
        client_context: ClientContext | None,
        project_id: str | None,
        projects_enabled: bool,
    ) -> "AgentRuntime":
        """Create and initialize a new runtime. Called under single-flight guard."""

        # Evict if at capacity
        if len(self._cache) >= self._max_size:
            await self._evict_lru()

        # Lazily create the shared MongoClient
        if self._shared_mongo_client is None:
            settings = get_settings()
            self._shared_mongo_client = MongoClient(settings.mongodb_uri, tz_aware=True)
            logger.info("Created shared MongoClient for runtime cache")

        # Create new runtime
        runtime = AgentRuntime(
            agent_config,
            mcp_servers,
            mongo_service=self._mongo_service,
            user=user,
            client_context=client_context,
            session_id=session_id,
            mongo_client=self._shared_mongo_client,
            project_id=project_id,
            projects_enabled=projects_enabled,
        )
        try:
            await runtime.initialize()
        except Exception as e:
            logger.exception("Runtime initialization failed for agent '%s'", agent_config.id)
            raise RuntimeInitError(agent_config.id, e) from e

        return runtime

    async def _evict_lru(self) -> None:
        """Evict the least-recently-used idle runtime.

        Raises RuntimeCapacityError if all runtimes are actively streaming.
        """
        # Find eviction candidate: highest idle_seconds among non-streaming runtimes
        candidate_key: str | None = None
        candidate_idle: float = -1

        for key, runtime in self._cache.items():
            if runtime._is_streaming:
                continue
            if runtime.idle_seconds > candidate_idle:
                candidate_idle = runtime.idle_seconds
                candidate_key = key

        if candidate_key is None:
            prom_metrics.runtime_cache_capacity_rejections_total.inc()
            raise RuntimeCapacityError(self._max_size)

        runtime = self._cache.pop(candidate_key)
        prom_metrics.runtime_cache_evictions_total.labels(reason="capacity").inc()
        self._update_metrics()
        await runtime.cleanup()
        logger.info(
            "LRU evicted runtime %s (idle %.0fs) to make room (cache %d/%d)",
            candidate_key,
            candidate_idle,
            len(self._cache),
            self._max_size,
        )

        # Break reference cycles from the evicted graph/tools
        gc.collect()

    async def _cleanup_expired(self) -> None:
        """Remove expired runtimes from cache."""
        expired_keys = [key for key, runtime in self._cache.items() if runtime.idle_seconds >= self._ttl]
        for key in expired_keys:
            runtime = self._cache.pop(key, None)
            if runtime:
                await runtime.cleanup()
        if expired_keys:
            prom_metrics.runtime_cache_evictions_total.labels(reason="expired").inc(len(expired_keys))
            self._update_metrics()
            gc.collect()

    async def clear(self) -> None:
        """Clear all cached runtimes."""
        for runtime in self._cache.values():
            await runtime.cleanup()
        self._cache.clear()
        self._update_metrics()
        gc.collect()

    async def invalidate(self, agent_id: str, session_id: str) -> bool:
        """Invalidate a specific runtime from the cache.

        Returns:
            True if a runtime was invalidated, False if not found.
        """
        key = self._make_key(agent_id, session_id)
        runtime = self._cache.pop(key, None)
        if runtime:
            await runtime.cleanup()
            self._update_metrics()
            logger.info(f"Runtime cache invalidated for agent={agent_id}")
            return True
        return False

    def cancel_stream(self, agent_id: str, session_id: str) -> bool:
        """Cancel an active stream for a specific agent/session.

        Returns:
            True if cancellation was requested, False if no runtime or already cancelled.
        """
        key = self._make_key(agent_id, session_id)
        runtime = self._cache.get(key)
        if runtime:
            cancelled = runtime.cancel()
            logger.info(
                f"[cancel_stream] Cancel requested for agent={agent_id}, session={session_id}: cancelled={cancelled}"
            )
            return cancelled
        logger.warning(f"[cancel_stream] No runtime found for agent={agent_id}, session={session_id}")
        return False

    def stats(self) -> dict:
        """Return cache statistics with per-runtime memory proxy metrics."""
        runtimes = []
        for key, runtime in self._cache.items():
            agent_id, session_id = key.split(":", 1)

            tool_count = (
                sum(len(tools) for tools in runtime.config.allowed_tools.values())
                if runtime.config.allowed_tools
                else 0
            )

            skills_count = (
                len(runtime._skills_files) if hasattr(runtime, "_skills_files") and runtime._skills_files else 0
            )
            skills_bytes = (
                sum(len(str(v)) for v in runtime._skills_files.values())
                if hasattr(runtime, "_skills_files") and runtime._skills_files
                else 0
            )

            mcp_server_count = len(runtime.config.allowed_tools) if runtime.config.allowed_tools else 0
            subagent_count = len(runtime.config.subagents) if runtime.config.subagents else 0

            runtimes.append(
                {
                    "agent_id": agent_id,
                    "agent_name": runtime.config.name,
                    "session_id": session_id,
                    "age_seconds": round(runtime.age_seconds),
                    "idle_seconds": round(runtime.idle_seconds),
                    "is_streaming": runtime._is_streaming,
                    "initialized": runtime._initialized,
                    "memory_proxies": {
                        "tool_count": tool_count,
                        "mcp_server_count": mcp_server_count,
                        "subagent_count": subagent_count,
                        "skills_count": skills_count,
                        "skills_content_bytes": skills_bytes,
                        "has_graph": runtime._graph is not None,
                        "has_checkpointer": runtime._checkpointer is not None,
                        "has_mongo_client": runtime._mongo_client is not None,
                    },
                }
            )

        # Process-level memory
        rusage = resource.getrusage(resource.RUSAGE_SELF)
        if sys.platform == "darwin":
            rss_mb = round(rusage.ru_maxrss / (1024 * 1024), 1)
        else:
            rss_mb = round(rusage.ru_maxrss / 1024, 1)

        # Current RSS from /proc (Linux) — more useful for capacity planning
        rss_current_mb = None
        try:
            with open(f"/proc/{os.getpid()}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_current_mb = round(int(line.split()[1]) / 1024, 1)
                        break
        except (OSError, ValueError):
            # Best-effort metric: /proc may be unavailable or unparsable in some environments.
            pass

        return {
            "count": len(self._cache),
            "max_size": self._max_size,
            "ttl_seconds": self._ttl,
            "process": {
                "pid": os.getpid(),
                "rss_peak_mb": rss_mb,
                "rss_current_mb": rss_current_mb,
            },
            "runtimes": runtimes,
        }


# Singleton cache instance
_runtime_cache: AgentRuntimeCache | None = None


def get_runtime_cache() -> AgentRuntimeCache:
    """Get the singleton runtime cache."""
    global _runtime_cache
    if _runtime_cache is None:
        settings = get_settings()
        _runtime_cache = AgentRuntimeCache(ttl_seconds=settings.agent_runtime_ttl_seconds)
    return _runtime_cache

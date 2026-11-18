"""Health check and debug endpoints for Dynamic Agents service."""

import time

from fastapi import APIRouter, Depends, Response

from dynamic_agents.config import Settings, get_settings
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service
from dynamic_agents.services.runtime_cache import get_runtime_cache

router = APIRouter(tags=["health"])


@router.get("/health")
async def liveness() -> dict:
    """Liveness probe — process health only, no dependency checks."""
    return {"status": "ok", "saved_model_connections": 1, "credential_api_configured": bool(get_settings().credential_api_url)}


@router.get("/healthz")
async def health_check(
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    """Liveness probe — returns healthy/unhealthy based on MongoDB connectivity."""
    health_status = "healthy"
    health_details = {}

    if mongo._client is None:
        health_status = "unhealthy"
        health_details["mongodb"] = "Not connected"

    return {
        "status": health_status,
        "timestamp": int(time.time()),
        "details": health_details,
    }


@router.get("/readyz")
async def readiness_check(
    mongo: MongoDBService = Depends(get_mongo_service),
    response: Response = None,
) -> dict:
    """Readiness probe — returns 200 if ready, 503 if MongoDB is not connected."""
    if mongo._client is not None:
        return {"ready": True}
    response.status_code = 503
    return {"ready": False, "error": "MongoDB not connected"}


@router.get("/debug/config")
async def debug_config(
    settings: Settings = Depends(get_settings),
) -> dict:
    """Debug endpoint — returns service configuration."""
    return {
        "mongodb_database": settings.mongodb_database,
        "collections": {
            "dynamic_agents": settings.dynamic_agents_collection,
            "mcp_servers": settings.mcp_servers_collection,
        },
        "agent_runtime_ttl_seconds": settings.agent_runtime_ttl_seconds,
    }


@router.get("/debug/runtimes")
async def debug_runtimes() -> dict:
    """Debug endpoint — returns cached runtime stats."""
    cache = get_runtime_cache()
    return cache.stats()

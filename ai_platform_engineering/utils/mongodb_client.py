# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""
Shared MongoDB Client

Provides a singleton pymongo client for the Python backend services
(skills catalog, hub scan results, API keys).

Reuses the same MONGODB_URI / MONGODB_DATABASE env vars as the UI and Slack bot.
"""

import logging
import os
import time
from typing import Optional

from pymongo import MongoClient
from pymongo.errors import PyMongoError

try:
    from loguru import logger
except ImportError:
    logger = logging.getLogger(__name__)

_client: Optional[MongoClient] = None
_policy_cache: Optional[str] = None
_policy_cache_time: float = 0.0

POLICY_CACHE_TTL = int(os.getenv("POLICY_CACHE_TTL", "60"))


def get_mongodb_client() -> Optional[MongoClient]:
    """Get or create the shared MongoDB client singleton.

    Returns None if MONGODB_URI is not configured.
    """
    global _client

    uri = os.getenv("MONGODB_URI")
    if not uri:
        return None

    if _client is not None:
        return _client

    database = os.getenv("MONGODB_DATABASE", "caipe")
    try:
        _client = MongoClient(
            uri,
            serverSelectionTimeoutMS=5000,
            retryWrites=False,
        )
        # Verify connectivity
        _client.admin.command("ping")
        logger.info(f"MongoDB client connected (database: {database})")
        return _client
    except PyMongoError as e:
        logger.warning(f"Failed to connect to MongoDB: {e}")
        _client = None
        return None


def get_policy_from_mongodb() -> Optional[str]:
    """Fetch the default global policy content from MongoDB.

    Returns the ASP policy content string, or None if unavailable.
    Uses an in-memory cache with configurable TTL.
    """
    global _policy_cache, _policy_cache_time

    now = time.time()
    if _policy_cache is not None and (now - _policy_cache_time) < POLICY_CACHE_TTL:
        return _policy_cache

    client = get_mongodb_client()
    if client is None:
        return None

    database = os.getenv("MONGODB_DATABASE", "caipe")
    try:
        db = client[database]
        collection = db["policies"]
        doc = collection.find_one({"name": "default"}, {"_id": 0, "content": 1})
        if doc and doc.get("content"):
            _policy_cache = doc["content"]
            _policy_cache_time = now
            logger.info("Loaded policy from MongoDB")
            return _policy_cache
        return None
    except PyMongoError as e:
        logger.warning(f"Failed to read policy from MongoDB: {e}")
        return None


def invalidate_policy_cache() -> None:
    """Clear the in-memory policy cache, forcing a fresh read on next access."""
    global _policy_cache, _policy_cache_time
    _policy_cache = None
    _policy_cache_time = 0.0

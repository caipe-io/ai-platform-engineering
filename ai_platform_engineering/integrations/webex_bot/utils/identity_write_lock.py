"""Serialize Webex identity writes across bot replicas and the UI callback.

A lock has no automatic expiry: a paused writer must not resume after another
writer has taken over. Operators may remove an orphan only after stopping writers.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator
from uuid import uuid4

from pymongo import MongoClient
from pymongo.collection import Collection

_client: MongoClient | None = None


def identity_lock_collection() -> Collection[Any]:
    """Use the same database and collection as the browser callback."""
    global _client
    uri = os.environ.get("MONGODB_URI", "").strip()
    if not uri:
        raise ValueError("Webex auto-linking requires MongoDB")
    if _client is None:
        _client = MongoClient(uri, serverSelectionTimeoutMS=5000, socketTimeoutMS=10000)
    return _client[os.environ.get("MONGODB_DATABASE", "caipe")]["webex_identity_write_locks"]


@asynccontextmanager
async def webex_identity_write_lock() -> AsyncIterator[None]:
    """Fail closed on contention; callers can retry the existing SSO flow."""
    collection = identity_lock_collection()
    nonce = uuid4().hex
    await asyncio.to_thread(collection.insert_one, {"_id": "identity-write", "nonce": nonce, "created_at": datetime.now(timezone.utc)})
    try:
        yield
    finally:
        await asyncio.to_thread(collection.delete_one, {"_id": "identity-write", "nonce": nonce})

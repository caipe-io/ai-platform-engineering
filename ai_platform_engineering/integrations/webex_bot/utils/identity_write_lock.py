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
from pymongo.errors import DuplicateKeyError

_client: MongoClient | None = None


def identity_lock_collection() -> Collection[Any]:
    """Use the same database and collection as the browser callback."""
    global _client
    uri = os.environ.get("MONGODB_URI", "").strip()
    if not uri:
        raise ValueError("Webex auto-linking requires MongoDB")
    if _client is None:
        _client = MongoClient(uri, serverSelectionTimeoutMS=5000, socketTimeoutMS=10000, retryWrites=False)
    return _client[os.environ.get("MONGODB_DATABASE", "caipe")]["webex_identity_write_locks"]


@asynccontextmanager
async def webex_identity_write_lock() -> AsyncIterator[None]:
    """Fail closed on contention; callers can retry the existing SSO flow."""
    collection = identity_lock_collection()
    nonce = uuid4().hex
    for attempt in range(21):
        try:
            await asyncio.to_thread(collection.insert_one, {"_id": "identity-write", "nonce": nonce, "created_at": datetime.now(timezone.utc)})
            break
        except DuplicateKeyError:
            if attempt == 20:
                raise
            await asyncio.sleep(0.1)
    release = False
    try:
        yield
        release = True
    except IdentityLinkRejected:
        release = True
        raise
    finally:
        # A timed-out Keycloak write may still commit. Retain its lock until
        # an operator reconciles it; an expiring/released lock cannot fence it.
        if release:
            await asyncio.to_thread(collection.delete_one, {"_id": "identity-write", "nonce": nonce})


class IdentityLinkRejected(ValueError):
    """Expected rejection before any uncertain identity write."""


def identity_binding_collection() -> Collection[Any]:
    """Durable ownership/suppression records shared with the BFF."""
    return identity_lock_collection().database["webex_identity_bindings"]


def identity_key(kind: str, value: str) -> str:
    return f"{kind}:{os.environ.get('KEYCLOAK_REALM', 'caipe')}:{value}"


async def reserve_dm_dispatch(bot_id: str, message_id: str) -> bool:
    """Reserve a provider message once across replicas before DM dispatch."""
    collection = identity_binding_collection()
    try:
        await asyncio.to_thread(collection.insert_one, {
            "_id": identity_key("message", f"{bot_id}:{message_id}"),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except DuplicateKeyError:
        return False

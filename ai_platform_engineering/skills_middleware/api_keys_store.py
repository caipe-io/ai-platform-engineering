# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""MongoDB-backed catalog API keys (hashed secrets only) for FR-018 / T046.

Key format: ``{key_id}.{secret}`` (secret is opaque). Only a versioned scrypt
digest is stored (matches the BFF ``catalog-api-keys`` module).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
import string
import time
from typing import Any

logger = logging.getLogger(__name__)

_COLLECTION = "catalog_api_keys"
_SCRYPT_PREFIX = "scrypt:v1"
_SCRYPT_KEY_LEN = 32
_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_MAXMEM = 32 * 1024 * 1024


def _pepper() -> str:
    return os.getenv("CAIPE_CATALOG_API_KEY_PEPPER", os.getenv("SKILLS_API_KEY_PEPPER", ""))


# assisted-by Codex Codex-sonnet-4-6
def _hash_secret(key_id: str, secret: str) -> str:
    digest = hashlib.scrypt(
        f"{_pepper()}:{secret}".encode("utf-8"),
        salt=key_id.encode("utf-8"),
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_KEY_LEN,
        maxmem=_SCRYPT_MAXMEM,
    )
    encoded = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"{_SCRYPT_PREFIX}:{encoded}"


def _get_collection():
    try:
        from ai_platform_engineering.utils.mongodb_client import get_mongodb_client
    except ImportError:
        return None
    client = get_mongodb_client()
    if client is None:
        return None
    database = os.getenv("MONGODB_DATABASE", "caipe")
    return client[database][_COLLECTION]


def verify_catalog_api_key(raw_key: str) -> str | None:
    """Validate a raw API key string; return ``owner_user_id`` if valid, else None."""
    raw_key = (raw_key or "").strip()
    if "." not in raw_key:
        return None
    key_id, _, secret = raw_key.partition(".")
    key_id = key_id.strip()
    secret = secret.strip()
    if not key_id or not secret:
        return None

    coll = _get_collection()
    if coll is None:
        return None

    try:
        doc = coll.find_one(
            {"key_id": key_id, "revoked_at": None},
            {"key_hash": 1, "owner_user_id": 1, "_id": 0},
        )
    except Exception as e:
        logger.warning("catalog_api_keys lookup failed: %s", e)
        return None

    if not doc:
        return None
    if not hmac.compare_digest(
        str(doc.get("key_hash") or ""),
        _hash_secret(key_id, secret),
    ):
        return None

    # Optional last_used_at (best-effort)
    try:
        coll.update_one(
            {"key_id": key_id},
            {"$set": {"last_used_at": time.time()}},
        )
    except Exception:
        pass

    owner = doc.get("owner_user_id")
    return str(owner) if owner is not None else None


def create_catalog_api_key(
    owner_user_id: str,
    *,
    scopes: list[str] | None = None,
) -> tuple[str, str]:
    """Create a new key; returns ``(full_key, key_id)`` for one-time display.

    Raises:
        RuntimeError: if MongoDB is unavailable.
    """
    coll = _get_collection()
    if coll is None:
        raise RuntimeError("MongoDB unavailable for catalog_api_keys")

    alphabet = string.ascii_letters + string.digits
    key_id = "sk_" + "".join(secrets.choice(alphabet) for _ in range(12))
    secret = "".join(secrets.choice(alphabet) for _ in range(32))
    full_key = f"{key_id}.{secret}"
    now = time.time()
    doc: dict[str, Any] = {
        "key_id": key_id,
        "key_hash": _hash_secret(key_id, secret),
        "owner_user_id": owner_user_id,
        "scopes": scopes or ["catalog:read"],
        "created_at": now,
        "revoked_at": None,
    }
    try:
        coll.insert_one(doc)
    except Exception as e:
        logger.error("Failed to insert catalog_api_key: %s", e)
        raise RuntimeError("Failed to persist API key") from e
    return full_key, key_id


def list_catalog_api_keys(owner_user_id: str) -> list[dict[str, Any]]:
    """Return non-sensitive metadata for keys owned by ``owner_user_id`` (active first)."""
    coll = _get_collection()
    if coll is None:
        return []
    try:
        cur = coll.find(
            {"owner_user_id": owner_user_id},
            {"key_hash": 0},
        ).sort("created_at", -1)
        return [
            {
                "key_id": d.get("key_id"),
                "owner_user_id": d.get("owner_user_id"),
                "scopes": d.get("scopes"),
                "created_at": d.get("created_at"),
                "revoked_at": d.get("revoked_at"),
                "last_used_at": d.get("last_used_at"),
            }
            for d in cur
            if d.get("key_id")
        ]
    except Exception as e:
        logger.warning("list_catalog_api_keys failed: %s", e)
        return []


def get_catalog_api_key_owner_if_active(key_id: str) -> str | None:
    """Return owner_user_id if key exists and is not revoked, else None."""
    coll = _get_collection()
    if coll is None:
        return None
    try:
        doc = coll.find_one(
            {"key_id": key_id},
            {"owner_user_id": 1, "revoked_at": 1, "_id": 0},
        )
    except Exception as e:
        logger.warning("get_catalog_api_key_owner_if_active failed: %s", e)
        return None
    if not doc or doc.get("revoked_at") is not None:
        return None
    o = doc.get("owner_user_id")
    return str(o) if o is not None else None


def revoke_catalog_api_key(key_id: str) -> bool:
    """Set ``revoked_at`` for a key. Returns True if a document was updated."""
    coll = _get_collection()
    if coll is None:
        return False
    try:
        res = coll.update_one(
            {"key_id": key_id},
            {"$set": {"revoked_at": time.time()}},
        )
        return res.modified_count > 0
    except Exception as e:
        logger.warning("revoke_catalog_api_key failed: %s", e)
        return False

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Content-addressed blob store for user-attachment bytes.

Multimodal chat attachments (images, PDFs, …) must not ride inline as base64
inside the LangGraph message content — that content is persisted to the MongoDB
(DocumentDB) checkpoint on every turn, which bloats the working set, amplifies
per-turn I/O, and can breach Mongo's hard 16 MB per-document cap. Instead we
mirror how the model providers themselves work: **bytes live once in object
storage, referenced by a key; only the reference is persisted in conversation
state.** The rehydration middleware fetches the bytes back into the outgoing
model request at inference time (see ``services/middleware.py``).

This module intentionally reuses only the *pattern* of the audit-service store
(``audit_service/storage.py``: a ``local`` and an ``s3`` backend behind one
structural interface) — not its code, whose public surface (Parquet, batching,
minute-partitioning, ``AuditQuery``) is audit-shaped and would not transfer.

Interface (single-blob, not batched):

    put(data, *, content_type) -> key   # content-addressed; idempotent
    get(key) -> bytes
    readiness_check() -> None            # head_bucket for s3, write-probe for local

Key layout is **content-addressed**: ``{prefix}/{sha256[:2]}/{sha256}``. Two
uploads of the same bytes collapse to one object (free dedup), keys are
immutable, and the sha fan-out keeps any single directory / S3 prefix from
growing unbounded. No time partitioning (that is audit-specific).

There is deliberately **no lifecycle/retention rule in v1** — orphaned blobs
(checkpoint deleted, blob remains) are accepted for now; a GC job is a tracked
follow-up. That is also why the S3 backend needs no ``DeleteObject`` permission.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger("caipe.dynamic_agents.attachment_store")


def _content_key(prefix: str, data: bytes) -> str:
    """Content-addressed key: ``{prefix}/{sha256[:2]}/{sha256}``."""
    digest = hashlib.sha256(data).hexdigest()
    parts = [p for p in (prefix, digest[:2], digest) if p]
    return "/".join(parts)


@runtime_checkable
class AttachmentStore(Protocol):
    """Structural interface shared by the local and S3 backends."""

    @property
    def backend_name(self) -> str: ...

    def put(self, data: bytes, *, content_type: str) -> str: ...

    def get(self, key: str) -> bytes: ...

    def readiness_check(self) -> None: ...


class LocalAttachmentStore:
    """Content-addressed blob store on local disk.

    Writes are atomic (tmp file + ``os.replace``) and idempotent — re-``put``ing
    identical bytes is a no-op because the key is the content hash. Mirrors the
    atomic-write shape of ``LocalAuditStore`` (``audit_service/storage.py``).
    """

    def __init__(self, root: str, *, prefix: str = "attachments") -> None:
        self.root = Path(root)
        self.prefix = prefix.strip("/")

    @property
    def backend_name(self) -> str:
        return "local"

    def _path_for(self, key: str) -> Path:
        # Keys are relative POSIX paths we generated; keep them under root.
        return self.root / key

    def readiness_check(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        probe = self.root / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)

    def put(self, data: bytes, *, content_type: str) -> str:
        key = _content_key(self.prefix, data)
        path = self._path_for(key)
        if path.exists():
            # Content-addressed: identical bytes already stored.
            return key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.parent / f".{path.name}.tmp"
        with open(tmp_path, "wb") as handle:
            handle.write(data)
        os.replace(tmp_path, path)
        return key

    def get(self, key: str) -> bytes:
        with open(self._path_for(key), "rb") as handle:
            return handle.read()


class S3AttachmentStore:
    """Content-addressed blob store backed by S3 (or an S3-compatible endpoint).

    Uses boto3 via the default credential chain (IRSA-friendly), so no static
    secret is needed in-cluster. ``endpoint_url`` supports MinIO / other
    S3-compatible stores for local testing. ``put`` is idempotent because the
    key is the content hash — a re-upload simply overwrites identical bytes.
    """

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str = "attachments",
        region: str = "us-west-2",
        endpoint_url: str | None = None,
    ) -> None:
        if not bucket:
            raise ValueError(
                "ATTACHMENT_S3_BUCKET is required when ATTACHMENT_BACKEND=s3"
            )
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.region = region
        self.endpoint_url = endpoint_url or None
        self._client = self._build_client()

    @property
    def backend_name(self) -> str:
        return "s3"

    def _build_client(self) -> Any:
        import boto3  # type: ignore[import-untyped]

        kwargs: dict[str, Any] = {"region_name": self.region}
        if self.endpoint_url:
            kwargs["endpoint_url"] = self.endpoint_url
        return boto3.client("s3", **kwargs)

    def readiness_check(self) -> None:
        self._client.head_bucket(Bucket=self.bucket)

    def put(self, data: bytes, *, content_type: str) -> str:
        key = _content_key(self.prefix, data)
        self._client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type or "application/octet-stream",
        )
        return key

    def get(self, key: str) -> bytes:
        response = self._client.get_object(Bucket=self.bucket, Key=key)
        return response["Body"].read()


def build_attachment_store(settings: Any) -> AttachmentStore:
    """Construct the configured attachment store backend.

    Mirrors the ``local | s3 | raise`` selection of the audit service
    (``audit_service/main.py``). Called once and shared; both backends are
    cheap to hold (the S3 client is a thin boto3 handle).
    """
    backend = (getattr(settings, "attachment_backend", "local") or "local").strip().lower()
    prefix = getattr(settings, "attachment_s3_prefix", "attachments")
    if backend == "local":
        return LocalAttachmentStore(
            getattr(settings, "attachment_local_path", "/var/lib/caipe-attachments"),
            prefix=prefix,
        )
    if backend == "s3":
        return S3AttachmentStore(
            bucket=getattr(settings, "attachment_s3_bucket", ""),
            prefix=prefix,
            region=getattr(settings, "attachment_s3_region", "us-west-2"),
            endpoint_url=getattr(settings, "attachment_s3_endpoint_url", None),
        )
    raise ValueError(
        f"Unknown ATTACHMENT_BACKEND={backend!r}; expected 'local' or 's3'"
    )

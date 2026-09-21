# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit coverage for the attachment blob store (local + s3 backends).

Verifies the content-addressed key layout, put/get round-trip, atomic-write
idempotency (re-putting identical bytes is a no-op, free dedup), the S3 backend
against a stub client (no live S3), and ``build_attachment_store`` selection.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest

from dynamic_agents.services.attachment_store import (
    LocalAttachmentStore,
    S3AttachmentStore,
    _content_key,
    build_attachment_store,
)

# --- Content-addressed key layout -------------------------------------------


def test_content_key_layout_is_prefix_sha_fanout():
    data = b"hello world"
    digest = hashlib.sha256(data).hexdigest()
    assert _content_key("attachments", data) == f"attachments/{digest[:2]}/{digest}"


def test_content_key_is_stable_across_calls():
    data = b"same bytes"
    assert _content_key("attachments", data) == _content_key("attachments", data)


def test_content_key_empty_prefix_drops_leading_segment():
    data = b"x"
    digest = hashlib.sha256(data).hexdigest()
    assert _content_key("", data) == f"{digest[:2]}/{digest}"


# --- LocalAttachmentStore ----------------------------------------------------


def test_local_put_get_round_trip(tmp_path):
    store = LocalAttachmentStore(str(tmp_path))
    data = b"\x89PNG\r\n\x1a\n some image bytes"
    key = store.put(data, content_type="image/png")
    assert store.get(key) == data
    assert store.backend_name == "local"


def test_local_put_is_content_addressed_dedup(tmp_path):
    store = LocalAttachmentStore(str(tmp_path))
    data = b"identical bytes"
    key1 = store.put(data, content_type="application/pdf")
    key2 = store.put(data, content_type="application/pdf")
    # Same bytes -> same key -> exactly one object on disk.
    assert key1 == key2
    files = [p for p in tmp_path.rglob("*") if p.is_file() and not p.name.startswith(".")]
    assert len(files) == 1


def test_local_distinct_bytes_get_distinct_keys(tmp_path):
    store = LocalAttachmentStore(str(tmp_path))
    k1 = store.put(b"aaa", content_type="text/plain")
    k2 = store.put(b"bbb", content_type="text/plain")
    assert k1 != k2
    assert store.get(k1) == b"aaa"
    assert store.get(k2) == b"bbb"


def test_local_put_leaves_no_tmp_files(tmp_path):
    # Atomic write: the .tmp scratch file is renamed away, never left behind.
    store = LocalAttachmentStore(str(tmp_path))
    store.put(b"payload", content_type="application/octet-stream")
    leftovers = [p for p in tmp_path.rglob("*.tmp")]
    assert leftovers == []


def test_local_custom_prefix_appears_in_key(tmp_path):
    store = LocalAttachmentStore(str(tmp_path), prefix="blobs")
    key = store.put(b"z", content_type="text/plain")
    assert key.startswith("blobs/")


def test_local_readiness_check_creates_root_and_cleans_probe(tmp_path):
    root = tmp_path / "nested" / "attach"
    store = LocalAttachmentStore(str(root))
    store.readiness_check()
    assert root.is_dir()
    assert not (root / ".write-probe").exists()


# --- S3AttachmentStore (stub client, no live S3) -----------------------------


class _StubS3Client:
    """Minimal in-memory stand-in for the boto3 S3 client surface used."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.head_calls: list[str] = []
        self.put_kwargs: list[dict[str, Any]] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:
        self.put_kwargs.append(
            {"Bucket": Bucket, "Key": Key, "Body": Body, "ContentType": ContentType}
        )
        self.objects[Key] = Body

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        return {"Body": _Body(self.objects[Key])}

    def head_bucket(self, *, Bucket: str) -> None:
        self.head_calls.append(Bucket)


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data


def _s3_store_with_stub(**kwargs: Any) -> tuple[S3AttachmentStore, _StubS3Client]:
    stub = _StubS3Client()
    store = S3AttachmentStore.__new__(S3AttachmentStore)
    store.bucket = kwargs.get("bucket", "sdp-ai-audit-dev")
    store.prefix = kwargs.get("prefix", "attachments")
    store.region = kwargs.get("region", "us-west-2")
    store.endpoint_url = kwargs.get("endpoint_url")
    store._client = stub
    return store, stub


def test_s3_requires_bucket():
    with pytest.raises(ValueError, match="ATTACHMENT_S3_BUCKET"):
        S3AttachmentStore(bucket="")


def test_s3_put_get_round_trip_and_content_type():
    store, stub = _s3_store_with_stub()
    key = store.put(b"pdf-bytes", content_type="application/pdf")
    assert store.get(key) == b"pdf-bytes"
    assert store.backend_name == "s3"
    assert stub.put_kwargs[0]["Bucket"] == "sdp-ai-audit-dev"
    assert stub.put_kwargs[0]["ContentType"] == "application/pdf"
    assert stub.put_kwargs[0]["Key"] == key


def test_s3_default_content_type_when_blank():
    store, stub = _s3_store_with_stub()
    store.put(b"x", content_type="")
    assert stub.put_kwargs[0]["ContentType"] == "application/octet-stream"


def test_s3_key_uses_content_addressed_layout():
    store, _ = _s3_store_with_stub(prefix="attachments")
    data = b"deterministic"
    digest = hashlib.sha256(data).hexdigest()
    assert store.put(data, content_type="text/plain") == f"attachments/{digest[:2]}/{digest}"


def test_s3_readiness_check_heads_bucket():
    store, stub = _s3_store_with_stub()
    store.readiness_check()
    assert stub.head_calls == ["sdp-ai-audit-dev"]


# --- build_attachment_store selection ---------------------------------------


class _Settings:
    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)


def test_build_selects_local(tmp_path):
    s = _Settings(attachment_backend="local", attachment_local_path=str(tmp_path))
    store = build_attachment_store(s)
    assert isinstance(store, LocalAttachmentStore)


def test_build_selects_s3():
    s = _Settings(
        attachment_backend="s3",
        attachment_s3_bucket="sdp-ai-audit-dev",
        attachment_s3_prefix="attachments",
        attachment_s3_region="us-west-2",
        attachment_s3_endpoint_url=None,
    )
    # Constructing S3AttachmentStore builds a boto3 client; that's fine offline
    # (no network call until put/get/head). Just assert the type + config.
    store = build_attachment_store(s)
    assert isinstance(store, S3AttachmentStore)
    assert store.bucket == "sdp-ai-audit-dev"


def test_build_rejects_unknown_backend():
    s = _Settings(attachment_backend="gcs")
    with pytest.raises(ValueError, match="Unknown ATTACHMENT_BACKEND"):
        build_attachment_store(s)


def test_build_defaults_to_local_when_backend_blank(tmp_path):
    s = _Settings(attachment_backend="", attachment_local_path=str(tmp_path))
    assert isinstance(build_attachment_store(s), LocalAttachmentStore)

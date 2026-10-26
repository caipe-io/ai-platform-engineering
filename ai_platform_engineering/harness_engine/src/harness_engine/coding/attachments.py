"""Canonical opaque attachment references for the existing chat composer."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from gridfs import GridFSBucket
from gridfs.errors import NoFile
from pydantic import BaseModel, ConfigDict, Field
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from harness_engine.coding.acp_client import AttachmentContent
from harness_engine.coding.admission import CodingAdmissionError, ConversationFence, RunFence
from harness_engine.models import AttachmentReference

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
BUCKET = "harness_attachments"


class UploadAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=256)
    expected_harness_id: str = Field(min_length=1, max_length=128)
    visible_conversation_id: str | None = Field(None, min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=256)
    media_type: str = Field(min_length=1, max_length=128)
    data: str = Field(max_length=4 * ((MAX_ATTACHMENT_BYTES + 2) // 3))


class CodingAttachments:
    def __init__(self, database: Database[dict[str, Any]]) -> None:
        self.db, self.bucket = database, GridFSBucket(database, bucket_name=BUCKET)

    async def upload(self, subject: str, request: UploadAttachment) -> AttachmentReference:
        fence = ConversationFence(
            self.db,
            subject=subject,
            agent_id=request.agent_id,
            conversation_id=request.conversation_id,
            harness_id=request.expected_harness_id,
            visible_conversation_id=request.visible_conversation_id,
        )
        await fence.require()

        def store() -> AttachmentReference:
            fence.require_sync()
            try:
                raw = base64.b64decode(request.data, validate=True)
            except (ValueError, binascii.Error):
                raise CodingAdmissionError("The attachment bytes are invalid") from None
            if len(raw) > MAX_ATTACHMENT_BYTES:
                raise CodingAdmissionError("The attachment exceeds its supported size")
            digest = hashlib.sha256(raw).hexdigest()
            identifier = str(
                uuid5(
                    NAMESPACE_URL,
                    "\0".join(
                        (subject, request.agent_id, request.conversation_id, request.name, request.media_type, digest)
                    ),
                )
            )
            metadata = {
                "owner_subject": subject,
                "agent_id": request.agent_id,
                "conversation_id": request.conversation_id,
                "media_type": request.media_type,
                "size_bytes": len(raw),
                "sha256": digest,
            }
            existing = self.db[f"{BUCKET}.files"].find_one({"_id": identifier})
            if existing is None:
                try:
                    self.bucket.upload_from_stream_with_id(identifier, request.name, raw, metadata=metadata)
                except DuplicateKeyError:
                    existing = self.db[f"{BUCKET}.files"].find_one({"_id": identifier})
                    if not existing or existing.get("metadata") != metadata:
                        raise CodingAdmissionError("The canonical attachment identity conflicts") from None
            elif existing.get("metadata") != metadata:
                raise CodingAdmissionError("The canonical attachment identity conflicts")
            # Re-read owner, participants, route, soft-delete and runtime mapping
            # after IO. A retained routing row is never sufficient authority.
            try:
                fence.require_sync()
            except CodingAdmissionError:
                self.bucket.delete(identifier)
                raise
            return AttachmentReference(
                id=identifier, name=request.name, media_type=request.media_type, size_bytes=len(raw), sha256=digest
            )

        result = await asyncio.to_thread(store)
        await fence.require()
        return result

    async def resolve(self, fence: RunFence, references: list[AttachmentReference]) -> list[AttachmentContent]:
        await fence.require()
        results = []
        total = 0
        for reference in references:

            def read() -> tuple[bytes, str]:
                doc = self.db[f"{BUCKET}.files"].find_one({"_id": reference.id})
                metadata = (doc or {}).get("metadata", {})
                expected = {
                    "owner_subject": fence.context.binding.owner_subject,
                    "agent_id": fence.context.binding.agent_id,
                    "conversation_id": fence.context.binding.conversation_id,
                    "media_type": reference.media_type,
                    "size_bytes": reference.size_bytes,
                }
                if (
                    not doc
                    or any(metadata.get(key) != value for key, value in expected.items())
                    or not isinstance(metadata.get("sha256"), str)
                    or reference.sha256 is not None
                    and metadata["sha256"] != reference.sha256
                    or doc.get("filename") != reference.name
                    or doc.get("length") != reference.size_bytes
                ):
                    raise CodingAdmissionError("The attachment reference is outside this execution context")
                try:
                    with self.bucket.open_download_stream(reference.id) as source:
                        return source.read(MAX_ATTACHMENT_BYTES + 1), metadata["sha256"]
                except NoFile:
                    raise CodingAdmissionError("The canonical attachment is unavailable") from None

            raw, stored_sha = await asyncio.to_thread(read)
            total += len(raw)
            if (
                len(raw) != reference.size_bytes
                or len(raw) > MAX_ATTACHMENT_BYTES
                or total > 20 * MAX_ATTACHMENT_BYTES
                or hashlib.sha256(raw).hexdigest() != stored_sha
            ):
                raise CodingAdmissionError("The canonical attachment failed integrity verification")
            results.append(
                AttachmentContent(
                    id=reference.id,
                    name=reference.name,
                    media_type=reference.media_type,
                    data=base64.b64encode(raw).decode(),
                )
            )
        await fence.require()
        return results

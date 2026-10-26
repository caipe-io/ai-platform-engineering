"""Bounded completed workspace artifacts beside canonical provider checkpoints."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
from typing import Any
from urllib.parse import quote, urlencode
from uuid import uuid4

from gridfs import GridFSBucket
from gridfs.errors import NoFile
from pymongo.database import Database

from harness_engine.canonical_context import CanonicalContextError, resolve_canonical_conversation
from harness_engine.coding.admission import CodingAdmissionError, RunFence
from harness_engine.coding.sandbox import SandboxAllocation, SandboxClient

BUCKET = "harness_workspace_artifacts"
MAX_FILES = 64
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
_CREDENTIALS = {
    "credentials",
    "credentials.json",
    "secrets",
    "kubeconfig",
    "id_rsa",
    "id_ed25519",
    "token",
    "tokens.json",
}


def artifact_path(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 1024
        or "\\" in value
        or any(ord(char) < 32 for char in value)
    ):
        raise CodingAdmissionError("The workspace artifact path is invalid")
    value = value.removeprefix("/")
    parts = value.split("/")
    if (
        len(parts) > 16
        or any(part in {"", ".", ".."} or part.startswith(".") or ":" in part for part in parts)
        or any(part.casefold() in _CREDENTIALS for part in parts)
        or parts[-1].casefold() in {"agents.md", "claude.md"}
        or parts[0].casefold() in {"skills", "inputs"}
    ):
        raise CodingAdmissionError("Managed or credential files cannot be published as artifacts")
    return value


async def capture_artifacts(client: SandboxClient, allocation: SandboxAllocation, fence: RunFence) -> dict[str, Any]:
    """Quiescent outputs become visible only with their acknowledged state head."""
    await fence.require(allow_cancelled=True)
    listing = await client.workspace_files(allocation)
    if not isinstance(listing.get("files"), list) or type(listing.get("truncated")) is not bool:
        raise CodingAdmissionError("The workspace artifact list is invalid")
    bucket = GridFSBucket(fence.db, bucket_name=BUCKET)
    results, warnings, total = [], [], 0
    if listing["truncated"] or len(listing["files"]) > MAX_FILES:
        warnings.append(
            "The approved artifact view reached its file limit; the complete workspace remains in canonical native state."
        )
    for raw in listing["files"][:MAX_FILES]:
        try:
            path = artifact_path(raw)
        except CodingAdmissionError:
            continue
        query = urlencode(
            {"conversation_id": allocation.conversation_id, "uid": allocation.uid, "path": path, "encoding": "base64"}
        )
        response = await client._request(
            "GET", f"/api/caipe/sandboxes/{quote(allocation.id, safe='')}/workspace/content?{query}"
        )
        try:
            if (
                response.get("path") != path
                or response.get("encoding") != "base64"
                or not isinstance(response.get("content"), str)
            ):
                raise ValueError
            encoded = response["content"]
            if len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
                raise ValueError
            data = base64.b64decode(encoded, validate=True)
            sha = hashlib.sha256(data).hexdigest()
            if len(data) > MAX_FILE_BYTES or response.get("bytes") != len(data) or response.get("sha256") != sha:
                raise ValueError
        except (ValueError, binascii.Error):
            warnings.append(
                "Some files exceeded the approved artifact limits or integrity contract; they remain in canonical native state."
            )
            continue
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            warnings.append(
                "The approved artifact view reached its byte limit; the complete workspace remains in canonical native state."
            )
            break
        await fence.require(allow_cancelled=True)
        identifier = str(uuid4())
        metadata = {
            "binding_id": fence.context.binding.binding_id,
            "run_id": fence.context.turn.run_id,
            "owner_subject": fence.context.binding.owner_subject,
            "path": path,
            "sha256": sha,
            "bytes": len(data),
        }
        await asyncio.to_thread(bucket.upload_from_stream_with_id, identifier, path, data, metadata=metadata)
        results.append({"id": identifier, "path": path, "bytes": len(data), "sha256": sha})
    await fence.require(allow_cancelled=True)
    return {"files": results, "warnings": list(dict.fromkeys(warnings))}


class CanonicalWorkspace:
    def __init__(self, database: Database[dict[str, Any]]) -> None:
        self.db, self.bucket = database, GridFSBucket(database, bucket_name=BUCKET)

    async def _manifest(
        self, subject: str, agent_id: str, conversation_id: str, visible_id: str | None = None
    ) -> dict[str, Any]:
        def read():
            try:
                conversation = resolve_canonical_conversation(
                    self.db,
                    owner_subject=subject,
                    agent_id=agent_id,
                    conversation_id=conversation_id,
                    visible_conversation_id=visible_id,
                )
            except CanonicalContextError:
                raise CodingAdmissionError("The canonical workspace context is unavailable") from None
            gateway = self.db.harness_gateway_bindings.find_one(
                {
                    "owner_subject": subject,
                    "agent_id": agent_id,
                    "conversation_id": conversation_id,
                    "harness_id": "claude_code_acp",
                }
            )
            binding = self.db.harness_sessions.find_one(
                {
                    "owner_subject": subject,
                    "agent_id": agent_id,
                    "conversation_id": conversation_id,
                    "harness_id": "claude_code_acp",
                    "status": {"$ne": "closed"},
                },
                sort=[("epoch", -1)],
            )
            if not conversation or not gateway or not binding:
                raise CodingAdmissionError("The canonical workspace is unavailable")
            head = binding.get("_provider_state_head")
            if not head or head.get("phase") != "ready":
                return {"artifacts": {"files": [], "warnings": []}}
            manifest = self.db.harness_provider_checkpoints.find_one(
                {
                    "_id": head.get("checkpoint_id"),
                    "binding_id": binding["binding_id"],
                    "owner_subject": subject,
                    "agent_id": agent_id,
                    "conversation_id": conversation_id,
                }
            )
            if not manifest:
                raise CodingAdmissionError("The acknowledged workspace checkpoint is unavailable")
            return manifest

        return await asyncio.to_thread(read)

    async def list(
        self, subject: str, agent_id: str, conversation_id: str, visible_id: str | None = None
    ) -> dict[str, Any]:
        manifest = await self._manifest(subject, agent_id, conversation_id, visible_id)
        artifacts = manifest.get("artifacts", {"files": [], "warnings": []})
        return {
            "fs_namespace": [agent_id, conversation_id, "filesystem"],
            "files": ["/" + entry["path"] for entry in artifacts["files"]],
            "warnings": artifacts.get("warnings", []),
            "snapshot": "acknowledged",
        }

    async def content(
        self, subject: str, agent_id: str, conversation_id: str, path: str, visible_id: str | None = None
    ) -> dict[str, Any]:
        path = artifact_path(path)
        manifest = await self._manifest(subject, agent_id, conversation_id, visible_id)
        entry = next((item for item in manifest.get("artifacts", {}).get("files", []) if item["path"] == path), None)
        if not entry:
            raise CodingAdmissionError("The approved workspace artifact is unavailable")

        def read():
            try:
                with self.bucket.open_download_stream(entry["id"]) as source:
                    if source.length != entry["bytes"] or source.length > MAX_FILE_BYTES:
                        raise CodingAdmissionError("The workspace artifact length changed")
                    return source.read(MAX_FILE_BYTES + 1)
            except NoFile:
                raise CodingAdmissionError("The acknowledged workspace artifact is unavailable") from None

        data = await asyncio.to_thread(read)
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise CodingAdmissionError("The workspace artifact failed integrity verification")
        try:
            content = data.decode("utf-8")
            encoding = "utf-8"
        except UnicodeError:
            content = base64.b64encode(data).decode()
            encoding = "base64"
        return {
            "fs_namespace": [agent_id, conversation_id, "filesystem"],
            "path": "/" + path,
            "content": content,
            "encoding": encoding,
            "bytes": len(data),
            "sha256": entry["sha256"],
            "snapshot": "acknowledged",
        }

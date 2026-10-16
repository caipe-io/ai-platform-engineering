"""Bounded artifacts between an admitted sandbox and CAIPE's file store.

The sandbox owns its working filesystem. Only approved regular text artifacts
are copied into the existing logical namespace for CAIPE file/download tools.
Provider state, managed instructions and credential paths remain outside this
artifact contract. Canonical workflow storage is checked before and after IO.
"""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import quote, urlencode

from deepagents.backends.utils import create_file_data
from gridfs.errors import NoFile
from pymongo.errors import PyMongoError

from dynamic_agents.models import DynamicAgentConfig
from dynamic_agents.services.file_content import decode_file_content, file_data_from_bytes, verify_file_receipt
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.harness_admission import require_harness_workspace
from dynamic_agents.services.mongo import MongoDBService
from dynamic_agents.services.runtime_storage import resolve_runtime_storage
from dynamic_agents.services.sandbox_client import SandboxAllocation, SandboxClient, SandboxError
from dynamic_agents.services.session_runs import await_session_operation

MAX_FILES = 64
MAX_SCANNED_INPUT_FILES = 1024
MAX_FILE_BYTES = 512 * 1024
MAX_EXPORT_BYTES = 4 * 1024 * 1024
MAX_INPUT_FILE_BYTES = 256 * 1024
MAX_INPUT_BYTES = 512 * 1024
MAX_WRITE_BYTES = 256 * 1024
MAX_STORED_INPUT_BYTES = 1024 * 1024
_MANAGED_NAMES = {"agents.md", "claude.md"}
_CREDENTIAL_NAMES = {"credentials", "credentials.json", "kubeconfig", "id_rsa", "id_ed25519", "token", "tokens.json"}
_CREDENTIAL_DIRS = {"credentials", "secrets"}


class HarnessWorkspaceBridge:
    def __init__(self, mongo: MongoDBService, agent: DynamicAgentConfig, session_id: str,
                 client: SandboxClient, allocation: SandboxAllocation) -> None:
        if mongo._db is None:
            raise SandboxError("Workspace artifact storage is unavailable")
        if (agent.execution.kind != "sandbox" or allocation.profile_id != agent.execution.profile_id or
                allocation.conversation_id != SandboxClient.conversation_reference(agent.id, session_id)):
            raise SandboxError("The workspace does not match its admitted agent conversation")
        self.mongo, self.agent, self.session_id = mongo, agent, session_id
        self.client, self.allocation = client, allocation
        storage = resolve_runtime_storage(agent, session_id, mongo.settings)
        self.namespace = storage.fs_namespace
        self.store = MongoDBGridFSStore(db=mongo._db, bucket_name=storage.gridfs_bucket_name,
                                       ttl_seconds=storage.fs_ttl_seconds)
        self.warnings: list[str] = []
        self._format_versions: dict[str, dict[str, Any]] = {}

    def _warn(self, warning: str) -> None:
        if warning not in self.warnings:
            self.warnings.append(warning)

    async def _privacy(self) -> None:
        namespace = await require_harness_workspace(self.mongo, self.agent, self.session_id, self.mongo.settings)
        if namespace != self.namespace:
            raise SandboxError("The admitted workspace namespace changed")

    def _relative(self, value: Any, *, logical: bool = False, workspace_absolute: bool = False) -> str:
        if not isinstance(value, str) or not value or len(value) > 1024 or "\\" in value or any(ord(char) < 32 for char in value):
            raise SandboxError("The workspace artifact path is invalid")
        cwd = self.allocation.cwd.rstrip("/")
        if workspace_absolute and value.startswith(cwd + "/"):
            value = value[len(cwd) + 1:]
        elif logical and value.startswith("/") and not value.startswith("//"):
            value = value[1:]
        elif value.startswith("/"):
            raise SandboxError("The workspace artifact path is outside its admitted workspace")
        parts = value.split("/")
        if len(parts) > 16 or any(part in {"", ".", ".."} or part.startswith(".") or ":" in part for part in parts):
            raise SandboxError("The workspace artifact path is invalid")
        if any(part.casefold() in _CREDENTIAL_DIRS for part in parts[:-1]) or parts[-1].casefold() in _CREDENTIAL_NAMES:
            raise SandboxError("Credential artifacts cannot cross the workspace boundary")
        return value

    @staticmethod
    def _managed(path: str) -> bool:
        return path.split("/")[0].casefold() == "skills" or path.split("/")[-1].casefold() in _MANAGED_NAMES

    @staticmethod
    def _text(value: Any, maximum: int) -> str:
        if not isinstance(value, str) or any(ord(char) < 32 and char not in "\n\r\t" for char in value):
            raise SandboxError("The workspace artifact is not approved UTF-8 text")
        try:
            size = len(value.encode("utf-8"))
        except UnicodeError:
            raise SandboxError("The workspace artifact is not approved UTF-8 text") from None
        if size > maximum:
            raise SandboxError("The workspace artifact exceeds its supported size")
        return value

    def _path(self, endpoint: str, path: str | None = None) -> str:
        query = {"conversation_id": self.allocation.conversation_id, "uid": self.allocation.uid}
        if path is not None:
            query["path"] = path
        return f"/api/caipe/sandboxes/{quote(self.allocation.id, safe='')}/workspace/{endpoint}?{urlencode(query)}"

    async def _content(self, path: str) -> str:
        data = await self.client._request("GET", self._path("content", path))
        if not isinstance(data, dict) or data.get("path") != path:
            raise SandboxError("The workspace artifact response changed its requested path")
        return self._text(data.get("content"), MAX_FILE_BYTES)

    async def _bytes(self, path: str) -> bytes:
        data = await self.client._request("GET", self._path("content", path) + "&encoding=base64")
        if not isinstance(data, dict) or data.get("path") != path or data.get("encoding") != "base64":
            raise SandboxError("The workspace artifact response changed its requested path or encoding")
        try:
            content = decode_file_content(data, maximum=MAX_FILE_BYTES)
            verify_file_receipt(data, content)
            return content
        except ValueError as exc:
            raise SandboxError(str(exc)) from None

    def _stored_value(self, identifier: Any) -> dict[str, Any]:
        # Read the immutable upload ID, not a key that may be replaced between
        # metadata admission and IO. The byte bound also covers corrupt metadata.
        try:
            source = self.store._fs.get(identifier)
            if source.length > MAX_STORED_INPUT_BYTES:
                raise SandboxError("A workflow artifact exceeds its supported size")
            raw = source.read(MAX_STORED_INPUT_BYTES + 1)
            if len(raw) > MAX_STORED_INPUT_BYTES:
                raise SandboxError("A workflow artifact exceeds its supported size")
            value = json.loads(raw.decode("utf-8"))
        except (NoFile, UnicodeError, json.JSONDecodeError):
            raise SandboxError("The workflow artifact changed during its snapshot") from None
        if not isinstance(value, dict):
            raise SandboxError("The workflow artifact has invalid stored data")
        return value

    def _input_snapshot(self) -> dict[str, Any]:
        # Metadata bounds precede GridFS reads: an oversized native artifact
        # must not be loaded into memory merely to discover that it is too big.
        docs = list(self.store._files_collection.find({"metadata.namespace": list(self.namespace)},
            {"metadata.key": 1, "length": 1}).limit(MAX_SCANNED_INPUT_FILES + 1))
        required = self.namespace != (self.agent.id, self.session_id, "filesystem")
        if len(docs) > MAX_SCANNED_INPUT_FILES:
            if required:
                raise SandboxError("The workflow input snapshot exceeds its supported file limit")
            self._warn("The conversation input-copy scan reached its file limit; additional files remain in CAIPE and the restored native workspace.")
            docs = docs[:MAX_SCANNED_INPUT_FILES]
        files: dict[str, Any] = {}
        size = 0
        for doc in docs:
            key = doc.get("metadata", {}).get("key")
            try:
                path = self._relative(key, logical=True)
            except SandboxError:
                self._warn("Some native files were excluded from sandbox inputs because their paths are not approved.")
                continue
            if self._managed(path):
                continue
            if not isinstance(doc.get("length"), int) or isinstance(doc.get("length"), bool):
                raise SandboxError("A workflow input has invalid stored metadata")
            if doc["length"] > MAX_STORED_INPUT_BYTES:
                if not required:
                    self._warn("Some conversation files exceed the input-copy budget and were not copied into inputs/. They remain downloadable in CAIPE; the restored native workspace is retained.")
                    continue
                raise SandboxError("A workflow input exceeds its supported size")
            value = self._stored_value(doc["_id"])
            try:
                data = decode_file_content(value, maximum=MAX_FILE_BYTES)
            except ValueError as exc:
                raise SandboxError(str(exc)) from None
            if len(data) > MAX_INPUT_FILE_BYTES or len(files) >= MAX_FILES or size + len(data) > MAX_INPUT_BYTES:
                if required:
                    raise SandboxError("The workflow input snapshot exceeds its supported size")
                self._warn("Some conversation files exceed the input-copy budget and were not copied into inputs/. They remain downloadable in CAIPE; the restored native workspace is retained.")
                continue
            size += len(data)
            if value.get("encoding") == "base64":
                files[f"inputs/{path}"] = {"encoding": "base64", "content": base64.b64encode(data).decode("ascii")}
            else:
                files[f"inputs/{path}"] = self._text(data.decode("utf-8"), MAX_INPUT_FILE_BYTES)
        return files

    async def seed_inputs(self) -> dict[str, Any]:
        """Return one managed file map to merge with instructions/skills in prepare."""
        await self._privacy()
        files = await await_session_operation(self._input_snapshot)
        await self._privacy()
        return files

    async def before_tool(self, name: str, arguments: dict[str, Any]) -> None:
        if name != "format_file":
            return
        await self._privacy()
        path = self._relative(arguments.get("file_path"), logical=True, workspace_absolute=True)
        if self._managed(path):
            raise SandboxError("Managed runtime files cannot be published as artifacts")
        text = await self._content(path)
        await self._privacy()
        await await_session_operation(self.store.put, self.namespace, f"/{path}", create_file_data(text))
        arguments["file_path"] = f"/{path}"
        self._format_versions[f"/{path}"] = await await_session_operation(self._output_versions, f"/{path}")

    def _output_versions(self, path: str) -> dict[str, Any]:
        keys = [path + "_formatted.json", path + "_formatted"]
        return {doc["metadata"]["key"]: doc["_id"] for doc in self.store._files_collection.find(
            {"metadata.namespace": list(self.namespace), "metadata.key": {"$in": keys}},
            {"metadata.key": 1},
        )}

    def _formatted_outputs(self, path: str, previous: dict[str, Any]) -> dict[str, str]:
        outputs: dict[str, str] = {}
        for key, identifier in self._output_versions(path).items():
            if previous.get(key) == identifier:
                continue
            doc = self.store._files_collection.find_one({"_id": identifier}, {"length": 1})
            if doc is None or not isinstance(doc.get("length"), int) or isinstance(doc.get("length"), bool) or doc["length"] > MAX_STORED_INPUT_BYTES:
                raise SandboxError("A formatted artifact exceeds its supported size")
            value = self._stored_value(identifier)
            if value.get("encoding", "utf-8") != "utf-8":
                raise SandboxError("The formatted artifact changed during its snapshot")
            content = value.get("content")
            if isinstance(content, list) and all(isinstance(line, str) for line in content):
                content = "\n".join(content)
            outputs[self._relative(key, logical=True)] = self._text(content, MAX_WRITE_BYTES)
        return outputs

    async def after_tool(self, name: str, arguments: dict[str, Any], result: Any) -> None:
        del result
        if name != "format_file":
            return
        path = f"/{self._relative(arguments.get('file_path'), logical=True)}"
        previous = self._format_versions.pop(path, None)
        if previous is None:
            raise SandboxError("The formatter did not import its bound workspace artifact")
        await self._privacy()
        try:
            outputs = await await_session_operation(self._formatted_outputs, path, previous)
            await self._privacy()
            for relative, content in outputs.items():
                response = await self.client._request("PUT", self._path("content").split("?", 1)[0], {
                    "conversation_id": self.allocation.conversation_id, "uid": self.allocation.uid,
                    "path": relative, "content": content,
                })
                if response.get("path") != relative or response.get("bytes") != len(content.encode("utf-8")):
                    raise SandboxError("The formatted workspace artifact acknowledgement is invalid")
                await self._privacy()
        except SandboxError:
            self._warn("A formatted artifact is retained in CAIPE but could not be mirrored into the sandbox workspace.")
            raise

    async def publish(self) -> list[str]:
        """Copy bounded completed artifacts; existing unrelated records are retained."""
        await self._privacy()
        try:
            result = await self.client._request("GET", self._path("files"))
            if not isinstance(result, dict) or not isinstance(result.get("files"), list) or type(result.get("truncated")) is not bool:
                raise SandboxError("The workspace artifact listing is invalid")
            if result["truncated"] or len(result["files"]) > MAX_FILES:
                self._warn("The workspace artifact export was truncated; additional files remain in the sandbox.")
            size = 0
            for raw in result["files"][:MAX_FILES]:
                try:
                    path = self._relative(raw)
                    if self._managed(path) or path.split("/")[0] == "inputs":
                        continue
                    data = await self._bytes(path)
                    size += len(data)
                    if size > MAX_EXPORT_BYTES:
                        self._warn("The workspace artifact export reached its byte limit; additional files remain in the sandbox.")
                        break
                    await self._privacy()
                    await await_session_operation(self.store.put, self.namespace, f"/{path}", file_data_from_bytes(data))
                except (SandboxError, PyMongoError):
                    self._warn("Some workspace files could not be exported as approved artifacts.")
            await self._privacy()
        except (SandboxError, PyMongoError):
            self._warn("The workspace artifact export could not be completed; files remain in the sandbox.")
        return list(self.warnings)

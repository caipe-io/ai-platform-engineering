"""Canonical file API and sandbox exports share one byte-preserving GridFS record."""

import base64
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from dynamic_agents.routes import files
from dynamic_agents.services.file_content import MAX_BINARY_FILE_BYTES
from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from tests.test_native_acp_mongodb import native_database as native_database


@pytest.fixture(autouse=True)
def file_store(native_database: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(files, "_get_gridfs_store", lambda db: MongoDBGridFSStore(db=db))


async def test_upload_download_keeps_bytes_in_existing_file_namespace(native_database: SimpleNamespace) -> None:
    state = native_database
    namespace = [state.agent.id, state.session_id, "filesystem"]
    raw = bytes(range(256)) * 31
    encoded = base64.b64encode(raw).decode()
    await files.put_file_content(files.FilePutRequest(fs_namespace=namespace, path="/report.pdf", content=encoded, encoding="base64"), state.user, state.mongo)
    result = await files.get_file_content(json.dumps(namespace), "/report.pdf", state.user, state.mongo)
    assert result.encoding == "base64"
    assert base64.b64decode(result.content, validate=True) == raw
    assert files._get_gridfs_store(state.db)._files_collection.count_documents({}) == 1
    listed = await files.list_files(json.dumps(namespace), state.user, state.mongo)
    assert listed.files == ["/report.pdf"]


async def test_rejected_binary_upload_preserves_previous_file(native_database: SimpleNamespace) -> None:
    state = native_database
    namespace = [state.agent.id, state.session_id, "filesystem"]
    await files.put_file_content(files.FilePutRequest(fs_namespace=namespace, path="/report.txt", content="original"), state.user, state.mongo)
    with pytest.raises(HTTPException) as exc:
        await files.put_file_content(files.FilePutRequest(fs_namespace=namespace, path="/report.txt", content=base64.b64encode(b"x" * (MAX_BINARY_FILE_BYTES + 1)).decode(), encoding="base64"), state.user, state.mongo)
    assert exc.value.status_code == 400
    result = await files.get_file_content(json.dumps(namespace), "/report.txt", state.user, state.mongo)
    assert result.content == "original"
    assert result.encoding == "utf-8"

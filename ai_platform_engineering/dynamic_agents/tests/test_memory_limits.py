from types import SimpleNamespace

import pytest
from langgraph.store.base import PutOp

from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.memory_codec import MemoryFile, MemoryRecord, render
from dynamic_agents.services.memory_middleware import CaipeMemoryMiddleware
from dynamic_agents.services.memory_paths import global_source


class _FilesCollection:
    def find(self, _query: dict) -> list:
        return []


class _GridFS:
    def __init__(self) -> None:
        self.metadata: dict | None = None

    def put(self, _content: bytes, *, filename: str, metadata: dict) -> None:
        assert filename == "/global/AGENTS.md"
        self.metadata = metadata


def _store(ttl_seconds: int) -> tuple[MongoDBGridFSStore, _GridFS]:
    store = object.__new__(MongoDBGridFSStore)
    gridfs = _GridFS()
    store._ttl_seconds = ttl_seconds
    store._files_collection = _FilesCollection()
    store._fs = gridfs
    return store, gridfs


def test_memory_ttl_zero_writes_no_expiry_while_ephemeral_store_does() -> None:
    operation = PutOp(
        namespace=("subject", "memory"),
        key="/global/AGENTS.md",
        value={"content": "memory"},
    )
    memory_store, memory_gridfs = _store(0)
    ephemeral_store, ephemeral_gridfs = _store(21600)

    memory_store._handle_put(operation)
    ephemeral_store._handle_put(operation)

    assert memory_gridfs.metadata is not None
    assert "expireAt" not in memory_gridfs.metadata
    assert ephemeral_gridfs.metadata is not None
    assert "expireAt" in ephemeral_gridfs.metadata


class _OverBudgetBackend:
    async def adownload_files(self, paths: list[str]) -> list[SimpleNamespace]:
        text = render(
            MemoryFile(
                scope="global",
                records=[
                    MemoryRecord(
                        memory_id="mem_0123456789abcdefghij",
                        title="Large",
                        body="x" * 200,
                    )
                ],
            )
        )
        return [SimpleNamespace(error=None, content=text.encode()) for _ in paths]

    async def aupload_files(self, _files: list[tuple[str, bytes]]) -> list[SimpleNamespace]:
        raise AssertionError("an existing over-budget file must never be truncated or rewritten")


@pytest.mark.asyncio
async def test_existing_over_budget_file_loads_intact() -> None:
    middleware = CaipeMemoryMiddleware(
        backend=_OverBudgetBackend(),
        sources=lambda: [global_source()],
        enabled=lambda: True,
        agent_id="agent-a",
        max_file_chars=100,
    )

    result = await middleware.abefore_agent({}, None, {})

    assert len(result["memory_contents"][global_source()]) > 100
    assert result["memory_contents"][global_source()].rstrip().endswith("x" * 200)

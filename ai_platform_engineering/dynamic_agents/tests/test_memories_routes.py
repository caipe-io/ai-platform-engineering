from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from dynamic_agents.models import UserContext
from dynamic_agents.routes import memories
from dynamic_agents.services.memory_codec import MemoryFile, MemoryRecord, parse, render


class _Store:
    def __init__(self, text: str) -> None:
        self.text = text

    def get(self, _namespace, _key):
        return SimpleNamespace(value={"content": self.text})

    def put(self, _namespace, _key, value):
        self.text = str(value["content"])


def _record(memory_id: str, title: str, body: str, *, source: str = "agent") -> MemoryRecord:
    return MemoryRecord(
        memory_id=memory_id,
        title=title,
        body=body,
        source=source,
        created_at="2026-08-06T00:00:00Z",
        updated_at="2026-08-06T00:00:00Z",
    )


def _dependencies(monkeypatch, store: _Store):
    monkeypatch.setattr(memories, "_get_store", lambda _mongo, _settings: store)
    return (
        UserContext(email="user@example.com", sub="user-sub"),
        SimpleNamespace(),
        SimpleNamespace(memory_max_file_chars=8000),
    )


def test_structured_writes_require_non_blank_title_and_body() -> None:
    with pytest.raises(ValidationError):
        memories.MemoryAppendRequest(
            path="/memories/global/AGENTS.md",
            title="   ",
            body="Remember this",
        )
    with pytest.raises(ValidationError):
        memories.MemoryUpdateRequest(
            path="/memories/global/AGENTS.md",
            memory_id="mem_0123456789abcdefghij",
            title="Preferred greeting",
            body="\n\t",
        )


@pytest.mark.asyncio
async def test_append_rejects_duplicate_normalized_title(monkeypatch) -> None:
    existing = _record("mem_0123456789abcdefghij", "Preferred greeting", "Start with Howdy.")
    store = _Store(render(MemoryFile(scope="global", records=[existing])))
    user, mongo, settings = _dependencies(monkeypatch, store)

    with pytest.raises(HTTPException) as exc_info:
        await memories.append_memory(
            memories.MemoryAppendRequest(
                path="/memories/global/AGENTS.md",
                title=" preferred---GREETING! ",
                body="Start with Hello.",
            ),
            user,
            mongo,
            settings,
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "duplicate_memory_title"
    assert exc_info.value.detail["existing_memory_id"] == existing.memory_id
    assert len(parse(store.text).records) == 1


@pytest.mark.asyncio
async def test_patch_updates_only_the_requested_id_and_preserves_provenance(monkeypatch) -> None:
    first = _record("mem_0123456789abcdefghij", "Preferred greeting", "Start with Hello.", source="agent")
    second = _record("mem_abcdefghij0123456789", "Response length", "Be concise.", source="manual")
    store = _Store(render(MemoryFile(scope="global", records=[first, second])))
    user, mongo, settings = _dependencies(monkeypatch, store)

    result = await memories.update_memory(
        memories.MemoryUpdateRequest(
            path="/memories/global/AGENTS.md",
            memory_id=first.memory_id,
            title="Greeting style",
            body="Start with Howdy.",
        ),
        user,
        mongo,
        settings,
    )

    records = parse(store.text).records
    assert result["data"]["memory"]["memory_id"] == first.memory_id
    assert [(record.memory_id, record.title, record.body) for record in records] == [
        (first.memory_id, "Greeting style", "Start with Howdy."),
        (second.memory_id, "Response length", "Be concise."),
    ]
    assert records[0].source == "agent"


@pytest.mark.asyncio
async def test_patch_rejects_title_owned_by_another_id(monkeypatch) -> None:
    first = _record("mem_0123456789abcdefghij", "Preferred greeting", "Start with Howdy.")
    second = _record("mem_abcdefghij0123456789", "Response length", "Be concise.")
    original = render(MemoryFile(scope="global", records=[first, second]))
    store = _Store(original)
    user, mongo, settings = _dependencies(monkeypatch, store)

    with pytest.raises(HTTPException) as exc_info:
        await memories.update_memory(
            memories.MemoryUpdateRequest(
                path="/memories/global/AGENTS.md",
                memory_id=second.memory_id,
                title="preferred greeting",
                body="Use fewer words.",
            ),
            user,
            mongo,
            settings,
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["existing_memory_id"] == first.memory_id
    assert store.text == original


@pytest.mark.asyncio
async def test_non_empty_raw_file_write_is_rejected(monkeypatch) -> None:
    original_record = _record(
        "mem_0123456789abcdefghij",
        "Preferred greeting",
        "Start with Hello.",
        source="agent",
    )
    original = render(MemoryFile(scope="global", records=[original_record]))
    edited = original.replace("Start with Hello.", "Start with Howdy.")
    store = _Store(original)
    user, mongo, settings = _dependencies(monkeypatch, store)

    with pytest.raises(HTTPException) as exc_info:
        await memories.put_memory_file(
            memories.MemoryPutRequest(
                path="/memories/global/AGENTS.md",
                text=edited,
            ),
            user,
            mongo,
            settings,
        )

    assert exc_info.value.status_code == 403
    assert "read-only" in str(exc_info.value.detail)
    assert store.text == original


@pytest.mark.asyncio
async def test_empty_put_still_clears_a_mounted_file(monkeypatch) -> None:
    record = _record("mem_0123456789abcdefghij", "Preferred greeting", "Start with Howdy.")
    store = _Store(render(MemoryFile(scope="global", records=[record])))
    user, mongo, settings = _dependencies(monkeypatch, store)

    result = await memories.put_memory_file(
        memories.MemoryPutRequest(
            path="/memories/global/AGENTS.md",
            text="",
            mounted=True,
        ),
        user,
        mongo,
        settings,
    )

    assert parse(store.text).records == []
    assert result["data"]["file"]["records"] == []

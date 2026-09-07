from types import SimpleNamespace

import pytest
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import ToolMessage

from dynamic_agents.services.memory_codec import parse
from dynamic_agents.services.memory_middleware import CaipeMemoryMiddleware
from dynamic_agents.services.memory_paths import global_source, seed_content


class _Backend:
    def __init__(self, files: dict[str, str] | None = None, error: str | None = None) -> None:
        self.files = files or {}
        self.error = error
        self.reads = 0
        self.uploads: list[tuple[str, bytes]] = []

    async def adownload_files(self, paths: list[str]):
        self.reads += 1
        return [
            SimpleNamespace(
                error=self.error if self.error else (None if path in self.files else "file_not_found"),
                content=self.files[path].encode() if path in self.files and not self.error else None,
            )
            for path in paths
        ]

    async def aupload_files(self, files: list[tuple[str, bytes]]):
        self.uploads.extend(files)
        for path, content in files:
            self.files[path] = content.decode()
        return [SimpleNamespace(error=None) for _ in files]


def _middleware(
    backend: _Backend,
    enabled=lambda: True,
    on_injected=None,
) -> CaipeMemoryMiddleware:
    return CaipeMemoryMiddleware(
        backend=backend,
        sources=lambda: [global_source()],
        enabled=enabled,
        agent_id="agent-a",
        max_file_chars=8000,
        on_injected=on_injected,
    )


@pytest.mark.asyncio
async def test_disabled_memory_performs_zero_store_io() -> None:
    backend = _Backend({global_source(): seed_content(global_source())})

    result = await _middleware(backend, enabled=lambda: False).abefore_agent({}, None, {})

    assert result == {}
    assert backend.reads == 0


@pytest.mark.asyncio
async def test_memory_reloads_every_turn_and_sees_external_write() -> None:
    backend = _Backend({global_source(): seed_content(global_source())})
    middleware = _middleware(backend)

    first = await middleware.abefore_agent({}, None, {})
    backend.files[global_source()] = "## Externally changed\nnew value\n"
    second = await middleware.abefore_agent({"memory_contents": first["memory_contents"]}, None, {})

    assert backend.reads == 2
    assert "Externally changed" in second["memory_contents"][global_source()]


@pytest.mark.asyncio
async def test_backend_error_degrades_without_failing_the_turn(caplog) -> None:
    backend = _Backend(error="mongo unavailable")

    result = await _middleware(backend).abefore_agent({}, None, {})

    assert result == {}
    assert "continuing without it" in caplog.text


@pytest.mark.asyncio
async def test_freeform_file_is_promoted_and_emitted_as_injected_memory() -> None:
    text = '<!-- caipe-memory:file v=1 scope=global -->\nAlways start with "Howdy" when replying.\n'
    backend = _Backend({global_source(): text})
    injected: list[list[str]] = []

    result = await _middleware(backend, on_injected=injected.append).abefore_agent({}, None, {})

    stored = result["memory_contents"][global_source()]
    parsed = parse(stored)
    assert len(parsed.records) == 1
    assert parsed.records[0].body == 'Always start with "Howdy" when replying.'
    assert injected == [[parsed.records[0].memory_id]]
    assert backend.files[global_source()] == stored
    assert backend.uploads == [(global_source(), stored.encode())]


@pytest.mark.asyncio
async def test_over_budget_agent_edit_is_rejected_before_store_write() -> None:
    path = global_source()
    backend = _Backend({path: seed_content(path)})
    middleware = CaipeMemoryMiddleware(
        backend=backend,
        sources=lambda: [path],
        enabled=lambda: True,
        agent_id="agent-a",
        max_file_chars=100,
    )
    request = ToolCallRequest(
        tool_call={
            "id": "call-1",
            "name": "edit_file",
            "args": {
                "file_path": path,
                "old_string": "_No memories saved here yet._",
                "new_string": "x" * 200,
            },
        },
        tool=None,
        state={},
        runtime=None,  # type: ignore[arg-type]
    )
    called = False

    async def handler(_request: ToolCallRequest) -> ToolMessage:
        nonlocal called
        called = True
        return ToolMessage(content="updated", tool_call_id="call-1")

    result = await middleware.awrap_tool_call(request, handler)

    assert called is False
    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert "100 characters" in str(result.content)
    assert backend.files[path] == seed_content(path)


@pytest.mark.asyncio
async def test_agent_duplicate_title_is_rejected_and_rolled_back() -> None:
    path = global_source()
    original = "## Preferred greeting\nStart with Howdy.\n"
    duplicate = "## Preferred greeting\nStart with Howdy.\n\n## preferred---GREETING!\nStart with Hello.\n"
    backend = _Backend({path: original})
    middleware = _middleware(backend)
    request = ToolCallRequest(
        tool_call={
            "id": "call-duplicate",
            "name": "edit_file",
            "args": {
                "file_path": path,
                "old_string": original,
                "new_string": duplicate,
            },
        },
        tool=None,
        state={},
        runtime=None,  # type: ignore[arg-type]
    )

    async def handler(_request: ToolCallRequest) -> ToolMessage:
        backend.files[path] = duplicate
        return ToolMessage(content="updated", tool_call_id="call-duplicate")

    result = await middleware.awrap_tool_call(request, handler)

    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert "unique `## Title`" in str(result.content)
    assert backend.files[path] == original


@pytest.mark.asyncio
async def test_agent_cannot_append_into_general_memory_bucket() -> None:
    path = global_source()
    original = "## General memory\nStart with Howdy.\n"
    appended = "## General memory\nStart with Howdy.\nKeep replies concise.\n"
    backend = _Backend({path: original})
    middleware = _middleware(backend)
    request = ToolCallRequest(
        tool_call={
            "id": "call-general",
            "name": "edit_file",
            "args": {
                "file_path": path,
                "old_string": "Start with Howdy.",
                "new_string": "Start with Howdy.\nKeep replies concise.",
            },
        },
        tool=None,
        state={},
        runtime=None,  # type: ignore[arg-type]
    )

    async def handler(_request: ToolCallRequest) -> ToolMessage:
        backend.files[path] = appended
        return ToolMessage(content="updated", tool_call_id="call-general")

    result = await middleware.awrap_tool_call(request, handler)

    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert "new uniquely titled `##` section" in str(result.content)
    assert backend.files[path] == original

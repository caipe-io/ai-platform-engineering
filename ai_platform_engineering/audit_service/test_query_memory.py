"""Regressions for bounded audit query memory and reader concurrency."""
from __future__ import annotations

import asyncio
import threading
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_platform_engineering.audit_service.config import Settings
from ai_platform_engineering.audit_service.main import _query_with_slot, create_app
from ai_platform_engineering.audit_service.storage import (
    AuditQuery,
    LocalAuditStore,
    QueryResult,
    S3AuditStore,
)


def _query(limit: int = 5) -> AuditQuery:
    return AuditQuery(
        since=datetime(2026, 1, 1, tzinfo=timezone.utc),
        until=datetime(2026, 1, 2, tzinfo=timezone.utc),
        limit=limit,
    )


def test_local_scan_retains_only_limit_records(tmp_path: Path, monkeypatch: Any) -> None:
    store = LocalAuditStore(str(tmp_path))
    query = _query()
    monkeypatch.setattr(store, "_files_for_range", lambda *_: [tmp_path / "events.ndjson"])

    def records(*_: Any) -> Any:
        for index in range(6_000):
            yield {
                "ts": (query.since + timedelta(seconds=index)).isoformat(),
                "payload": str(index) + "x" * 4_096,
            }

    monkeypatch.setattr(store, "_read_file", records)
    tracemalloc.start()
    try:
        result = store.query(query)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result.total == 6_000
    assert result.truncated
    assert len(result.records) == 5
    assert result.records[0]["payload"].startswith("5999x")
    # Retaining the full matching scan takes >24 MiB for this fixture.
    assert peak < 2 * 1024 * 1024


def test_query_preserves_filters_totals_and_stable_ties(tmp_path: Path) -> None:
    store = LocalAuditStore(str(tmp_path), gzip_enabled=False)
    ts = _query().since.isoformat()
    store.write_batch([
        {"ts": ts, "type": "auth", "id": 1},
        {"ts": ts, "type": "other", "id": 2},
        {"ts": ts, "type": "auth", "id": 3},
        {"ts": ts, "type": "auth", "id": 4},
    ])
    result = store.query(AuditQuery(since=_query().since, until=_query().until, limit=2, type="auth"))
    assert [record["id"] for record in result.records] == [1, 3]
    assert result.total == 3
    assert result.truncated


def test_s3_does_not_read_entire_range_ahead_of_slow_object(monkeypatch: Any) -> None:
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda _: object())
    monkeypatch.setattr("ai_platform_engineering.audit_service.storage._S3_IO_MAX_WORKERS", 2)
    store = S3AuditStore(bucket="example-bucket")
    monkeypatch.setattr(store, "_keys_for_range", lambda *_: [str(i) for i in range(100)])
    release = threading.Event()
    second_started = threading.Event()
    too_far = threading.Event()

    def read(key: str) -> list[dict[str, Any]]:
        if key == "0":
            assert release.wait(5)
        elif key == "1":
            second_started.set()
        else:
            too_far.set()
        return [{"ts": (_query().since + timedelta(seconds=int(key))).isoformat(), "id": key}]

    monkeypatch.setattr(store, "_read_object", read)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(store.query, _query())
        try:
            assert second_started.wait(5)
            assert not too_far.wait(0.1)
        finally:
            release.set()
        result = pending.result(timeout=5)
    assert result.total == 100
    assert len(result.records) == 5
    assert [record["id"] for record in result.records] == ["99", "98", "97", "96", "95"]


def test_concurrent_queries_are_bounded_without_blocking_ingest(tmp_path: Path, monkeypatch: Any) -> None:
    app = create_app(Settings(local_path=str(tmp_path), read_concurrency=1))
    entered = threading.Event()
    release = threading.Event()
    extra_reader = threading.Event()
    lock = threading.Lock()
    calls = 0

    def query(_: AuditQuery) -> QueryResult:
        nonlocal calls
        with lock:
            calls += 1
            if calls > 1:
                extra_reader.set()
        entered.set()
        assert release.wait(5)
        return QueryResult(records=[], total=0, truncated=False)

    with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as executor:
        monkeypatch.setattr(app.state.audit_store, "query", query)
        first = executor.submit(client.get, "/v1/audit/events")
        try:
            assert entered.wait(5)
            second = executor.submit(client.get, "/v1/audit/events")
            assert not extra_reader.wait(0.1)
            assert client.get("/healthz").status_code == 200
            assert client.post("/v1/audit/events", json={"type": "auth", "outcome": "allow"}).status_code == 202
        finally:
            release.set()
        assert first.result(timeout=5).status_code == 200
        assert second.result(timeout=5).status_code == 200
    assert calls == 2


def test_cancelled_reader_holds_slot_until_storage_finishes(tmp_path: Path, monkeypatch: Any) -> None:
    store = LocalAuditStore(str(tmp_path))
    release = threading.Event()
    entered = threading.Event()
    calls = 0

    def query(_: AuditQuery) -> QueryResult:
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(5)
        return QueryResult(records=[], total=0, truncated=False)

    monkeypatch.setattr(store, "query", query)

    async def scenario() -> None:
        slots = asyncio.Semaphore(1)
        first = asyncio.create_task(_query_with_slot(store, _query(), slots))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            first.cancel()
            second = asyncio.create_task(_query_with_slot(store, _query(), slots))
            await asyncio.sleep(0.05)
            assert calls == 1
            assert not first.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await first
        await second
        assert calls == 2

    asyncio.run(scenario())

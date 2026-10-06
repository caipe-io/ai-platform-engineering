from __future__ import annotations

import asyncio
import threading
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from ai_platform_engineering.audit_service.config import Settings
from ai_platform_engineering.audit_service.main import _query_events, create_app
from ai_platform_engineering.audit_service.storage import (
    AuditQuery,
    AuditQueryCancelled,
    LocalAuditStore,
    QueryResult,
    S3AuditStore,
)


def _query(**kwargs: object) -> AuditQuery:
    values = {
        "since": datetime(2026, 6, 20, tzinfo=timezone.utc),
        "until": datetime(2026, 6, 21, tzinfo=timezone.utc),
        "limit": 2,
    }
    values.update(kwargs)
    return AuditQuery(**values)


@pytest.mark.parametrize("backend", ["local", "s3"])
def test_scan_counts_all_matches_and_keeps_newest_with_stable_ties(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, backend: str
) -> None:
    records = [
        {"ts": "2026-06-20T01:00:00Z", "id": "old", "outcome": "allow"},
        {"ts": "2026-06-20T03:00:00Z", "id": "first", "outcome": "allow"},
        {"ts": "2026-06-20T03:00:00Z", "id": "second", "outcome": "allow"},
        {"ts": "2026-06-20T04:00:00Z", "id": "filtered", "outcome": "deny"},
        {"ts": "2026-06-20T02:00:00Z", "id": "middle", "outcome": "allow"},
    ]
    if backend == "local":
        store = LocalAuditStore(str(tmp_path))
        store.write_batch(records)
    else:
        store = S3AuditStore.__new__(S3AuditStore)
        monkeypatch.setattr(store, "_keys_for_range", lambda *args, **kwargs: iter(["object"]))
        monkeypatch.setattr(store, "_read_object", lambda *args: records)
    result = store.query(_query(outcome="allow"))
    assert [record["id"] for record in result.records] == ["first", "second"]
    assert result.total == 4
    assert result.truncated


def test_s3_limits_pending_fetches_behind_a_slow_object(monkeypatch: pytest.MonkeyPatch) -> None:
    store = S3AuditStore.__new__(S3AuditStore)
    monkeypatch.setattr(store, "_keys_for_range", lambda *args, **kwargs: (str(i) for i in range(1000)))
    release = threading.Event()
    first_window_started = threading.Event()
    exceeded_window = threading.Event()
    lock = threading.Lock()
    started = 0

    def read(key: str, query: AuditQuery) -> list[dict[str, object]]:
        nonlocal started
        with lock:
            started += 1
            if started == 16:
                first_window_started.set()
            if started > 16 and not release.is_set():
                exceeded_window.set()
        if key == "0":
            assert release.wait(5)
        return [{"ts": "2026-06-20T01:00:00Z", "id": key}]

    monkeypatch.setattr(store, "_read_object", read)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(store.query, _query())
        try:
            assert first_window_started.wait(5)
            assert not exceeded_window.wait(0.1)
        finally:
            release.set()
        result = future.result(timeout=5)
    assert result.total == 1000
    assert len(result.records) == 2


def test_s3_streams_pages_and_stops_listing_after_cancellation() -> None:
    cancel = threading.Event()

    class Client:
        def __init__(self) -> None:
            self.calls = 0

        def list_objects_v2(self, **kwargs: object) -> dict[str, object]:
            self.calls += 1
            return {
                "Contents": [{"Key": "audit/object.parquet"}],
                "IsTruncated": True,
                "NextContinuationToken": "next",
            }

    store = S3AuditStore.__new__(S3AuditStore)
    store.bucket = "example-bucket"
    store._client = Client()
    keys = iter(store._list_parquet_keys("audit/", cancel_event=cancel))
    assert store._client.calls == 0
    assert next(keys) == "audit/object.parquet"
    cancel.set()
    with pytest.raises(AuditQueryCancelled):
        next(keys)
    assert store._client.calls == 1


def test_s3_cancellation_closes_body_and_skips_decode(monkeypatch: pytest.MonkeyPatch) -> None:
    cancel = threading.Event()
    body = BytesIO(b"unused")

    class Client:
        def get_object(self, **kwargs: object) -> dict[str, object]:
            cancel.set()
            return {"Body": body}

    store = S3AuditStore.__new__(S3AuditStore)
    store.bucket = "example-bucket"
    store._client = Client()
    monkeypatch.setattr(store, "_from_parquet_bytes", lambda _: pytest.fail("cancelled scan decoded an object"))
    with pytest.raises(AuditQueryCancelled):
        store._read_object("object", _query(cancel_event=cancel))
    assert body.closed


def test_day_prefixes_do_not_list_legacy_objects_twice() -> None:
    store = S3AuditStore.__new__(S3AuditStore)
    store.prefix = "audit"
    query = _query()
    prefixes = list(store._prefixes_for_range(query.since, query.until, "day"))
    assert len(prefixes) == 2
    assert all(delimiter is None for _, delimiter in prefixes)


@pytest.mark.parametrize("disconnected,expected_status", [(True, 499), (False, 504)])
@pytest.mark.parametrize("worker_outcome", ["success", "failure", "cancellation"])
def test_http_scan_cancels_and_holds_capacity_until_worker_exits(
    disconnected: bool, expected_status: int, worker_outcome: str, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        slots = threading.BoundedSemaphore(1)
        started = threading.Event()
        release = threading.Event()
        cancel = threading.Event()

        class Store:
            def query(self, query: AuditQuery) -> QueryResult:
                started.set()
                assert release.wait(5)
                assert query.cancel_event.is_set()
                if worker_outcome == "failure":
                    raise OSError("backend read failed")
                if worker_outcome == "cancellation":
                    raise AuditQueryCancelled
                return QueryResult([], 0, False)

        async def is_disconnected() -> bool:
            return disconnected

        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(audit_read_slots=slots)),
            is_disconnected=is_disconnected,
        )
        try:
            with pytest.raises(HTTPException) as exc:
                await _query_events(request, Store(), _query(cancel_event=cancel), 0.05)
            assert exc.value.status_code == expected_status
            assert started.is_set()
            assert cancel.is_set()
            assert not slots.acquire(blocking=False)
            with pytest.raises(HTTPException) as busy:
                await _query_events(request, Store(), _query(cancel_event=threading.Event()), 1)
            assert busy.value.status_code == 503
        finally:
            release.set()
        deadline = asyncio.get_running_loop().time() + 2
        while not slots.acquire(blocking=False):
            assert asyncio.get_running_loop().time() < deadline
            await asyncio.sleep(0.01)
        slots.release()
        workers = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        await asyncio.gather(*workers, return_exceptions=True)

    asyncio.run(scenario())
    failures = [record for record in caplog.records if record.getMessage() == "audit history scan failed"]
    assert len(failures) == (1 if worker_outcome == "failure" else 0)
    if failures:
        assert failures[0].exc_info is not None
        assert isinstance(failures[0].exc_info[1], OSError)


def test_settings_read_scan_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIT_SERVICE_READ_MAX_CONCURRENT", "3")
    monkeypatch.setenv("AUDIT_SERVICE_READ_TIMEOUT_SECONDS", "4.5")
    settings = Settings.from_env()
    assert settings.read_max_concurrent == 3
    assert settings.read_timeout_seconds == 4.5


def test_read_pressure_does_not_block_ingest_or_readiness(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = threading.Event()
    release = threading.Event()

    def scan(self: LocalAuditStore, query: AuditQuery) -> QueryResult:
        started.set()
        assert release.wait(5)
        return QueryResult([], 0, False)

    monkeypatch.setattr(LocalAuditStore, "query", scan)
    settings = Settings(local_path=str(tmp_path), read_max_concurrent=1, verbosity="verbose")
    with TestClient(create_app(settings)) as client, ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(client.get, "/v1/audit/events")
        try:
            assert started.wait(5)
            assert client.get("/v1/audit/events").status_code == 503
            assert client.post("/v1/audit/events", json={"type": "auth"}).status_code == 202
            assert client.get("/readyz").status_code == 200
        finally:
            release.set()
        assert first.result(timeout=5).status_code == 200


def test_local_scan_retains_only_requested_records(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = LocalAuditStore(str(tmp_path))
    query = _query(limit=5)
    monkeypatch.setattr(store, "_files_for_range", lambda *_: [tmp_path / "events.ndjson"])

    def records(_: Path) -> Iterator[dict[str, str]]:
        for index in range(6000):
            yield {
                "ts": (query.since + timedelta(seconds=index)).isoformat(),
                "payload": str(index) + "x" * 4096,
            }

    monkeypatch.setattr(store, "_read_file", records)
    tracemalloc.start()
    try:
        result = store.query(query)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result.total == 6000
    assert result.truncated
    assert len(result.records) == 5
    assert result.records[0]["payload"].startswith("5999x")
    # The full scan holds over 24 MiB of payloads; retained results fit below 2 MiB.
    assert peak < 2 * 1024 * 1024


def test_zero_limit_counts_matches_without_retaining_records(tmp_path: Path) -> None:
    store = LocalAuditStore(str(tmp_path))
    store.write_batch([{"ts": "2026-06-20T01:00:00Z", "type": "auth"}])
    result = store.query(_query(limit=0))
    assert result.records == []
    assert result.total == 1
    assert result.truncated


@pytest.mark.parametrize("failure_stage", ["fetch", "body", "decode"])
def test_failed_s3_object_returns_an_error_without_partial_totals(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, failure_stage: str
) -> None:
    store = S3AuditStore.__new__(S3AuditStore)
    good_body = store._to_parquet_bytes([{"ts": "2026-06-20T01:00:00Z", "type": "auth"}])
    bad_streams: list[BytesIO] = []

    class BrokenBody(BytesIO):
        def read(self, size: int = -1) -> bytes:
            raise OSError("example backend detail")

    class Client:
        def head_bucket(self, **kwargs: object) -> None:
            pass

        def get_object(self, **kwargs: object) -> dict[str, object]:
            if kwargs["Key"] == "good.parquet":
                return {"Body": BytesIO(good_body)}
            if failure_stage == "fetch":
                raise OSError("example backend detail")
            stream = BrokenBody() if failure_stage == "body" else BytesIO(b"invalid parquet")
            bad_streams.append(stream)
            return {"Body": stream}

    monkeypatch.setattr(S3AuditStore, "_build_client", lambda _: Client())
    monkeypatch.setattr(S3AuditStore, "_keys_for_range", lambda *args, **kwargs: iter(["good.parquet", "bad.parquet"]))
    settings = Settings(backend="s3", s3_bucket="example-bucket")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        response = client.get(
            "/v1/audit/events", params={"since": "2026-06-20T00:00:00Z", "until": "2026-06-21T00:00:00Z"}
        )
    assert response.status_code == 500
    assert "total" not in response.text
    assert "example backend detail" not in response.text
    assert all(stream.closed for stream in bad_streams)
    failures = [record for record in caplog.records if "s3://example-bucket/bad.parquet" in record.getMessage()]
    assert len(failures) == 1
    assert failures[0].exc_info is not None

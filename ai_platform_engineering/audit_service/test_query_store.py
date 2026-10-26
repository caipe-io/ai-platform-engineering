from __future__ import annotations

import asyncio
import base64
import gzip
import io
import json
import os
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

import mongomock
import pytest
from botocore.response import StreamingBody
from fastapi.testclient import TestClient
from pymongo import MongoClient
from pymongo.errors import AutoReconnect

from ai_platform_engineering.audit_service.archive_worker import ArchiveWorker
from ai_platform_engineering.audit_service.config import Settings
from ai_platform_engineering.audit_service.main import create_app
from ai_platform_engineering.audit_service.scripts.cas_migration.migrate_query_store import backfill, local_records, s3_records
from ai_platform_engineering.audit_service.query_store import CursorError, EventConflict, MongoAuditStore
from ai_platform_engineering.audit_service.storage import AuditQuery, S3AuditStore

NOW = datetime.now(timezone.utc).replace(microsecond=0)


@pytest.fixture(params=["mock", "mongo"])
def store(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[MongoAuditStore]:
    if request.param == "mongo":
        uri = os.getenv("AUDIT_TEST_MONGODB_URI")
        if not uri:
            pytest.skip("Set AUDIT_TEST_MONGODB_URI for real MongoDB coverage")
        client = MongoClient(uri, tz_aware=True, w="majority", journal=True)
    else:
        client = mongomock.MongoClient(tz_aware=True)
    database = "audit_query_test_" + uuid4().hex
    result = MongoAuditStore("", database, client=client)
    result.initialize()
    monkeypatch.setattr("ai_platform_engineering.audit_service.query_store.utc_now", lambda: NOW)
    monkeypatch.setattr("ai_platform_engineering.audit_service.archive_worker.utc_now", lambda: NOW)
    yield result
    client.drop_database(database)
    client.close()


def event(event_id: str, **fields: object) -> dict[str, Any]:
    return {"audit_event_id": event_id, "ts": (NOW - timedelta(hours=1)).isoformat(), "type": "cas_decision", **fields}


def page(store: MongoAuditStore, *, cursor: str | None = None) -> dict[str, Any]:
    query = AuditQuery(since=NOW - timedelta(days=1), until=NOW, limit=2)
    return store.page(query, cursor=cursor, scope="same-filter")


def visible(store: MongoAuditStore) -> None:
    # Make inserted documents older than the query's ingestion cutoff.
    store.events.update_many({}, {"$set": {"ingested_at": NOW - timedelta(seconds=1)}})


def test_cursor_pages_ties_without_skip_or_count(store: MongoAuditStore) -> None:
    store.insert([event(str(index)) for index in range(5)])
    visible(store)
    first = page(store)
    second = page(store, cursor=first["next_cursor"])
    third = page(store, cursor=second["next_cursor"])
    assert [row["audit_event_id"] for p in (first, second, third) for row in p["records"]] == ["4", "3", "2", "1", "0"]
    assert third["next_cursor"] is None
    assert page(store, cursor=first["cursor"])["records"] == first["records"]


def test_delegation_filter_links_lifecycle_and_decisions(store: MongoAuditStore) -> None:
    store.insert([
        event("created", type="cas_delegation", delegation_id="approval-1"),
        event("allowed", delegation_id="approval-1", outcome="allow"),
        event("other", delegation_id="approval-2"),
    ])
    visible(store)
    query = AuditQuery(NOW - timedelta(days=1), NOW, 10, delegation_id="approval-1")
    result = store.page(query, cursor=None, scope="delegation-filter")
    assert {row["audit_event_id"] for row in result["records"]} == {"created", "allowed"}
    assert any(key[0] == "event.delegation_id" for index in store.events.index_information().values() for key in index["key"])


def test_real_mongo_can_read_one_page_without_scanning_all_records(store: MongoAuditStore) -> None:
    if not isinstance(store.client, MongoClient):
        pytest.skip("MongoDB query planner assertion requires the real server")
    store.insert([event(f"event-{index:05}") for index in range(5000)])
    visible(store)
    query = {"ts": {"$gte": NOW - timedelta(days=1), "$lte": NOW}, "ingested_at": {"$lte": NOW}}
    explanation = store.events.find(query).sort([("ts", -1), ("_id", -1)]).limit(31).explain()
    assert "IXSCAN" in json.dumps(explanation["queryPlanner"]["winningPlan"], default=str)
    assert explanation["executionStats"]["nReturned"] == 31
    assert explanation["executionStats"]["totalDocsExamined"] <= 31


def test_cursor_excludes_newly_ingested_old_events(store: MongoAuditStore) -> None:
    store.insert([event(str(index)) for index in range(4)])
    visible(store)
    first = page(store)
    store.insert([event("late")])
    second = page(store, cursor=first["next_cursor"])
    assert [r["audit_event_id"] for r in second["records"]] == ["1", "0"]
    assert second["since"] == first["since"]
    assert second["as_of"] == first["as_of"]


def test_cursor_rejects_changed_scope_malformed_and_unbounded_ranges(store: MongoAuditStore) -> None:
    first = page(store)
    query = AuditQuery(NOW - timedelta(days=1), NOW, 2)
    for cursor in ("not-a-cursor", "W10=", "a" * 4097):
        with pytest.raises(CursorError):
            store.page(query, cursor=cursor, scope="same-filter")
    with pytest.raises(CursorError):
        store.page(query, cursor=first["cursor"], scope="different-filter")
    state = json.loads(base64.urlsafe_b64decode(first["cursor"]))
    state["since"] = (NOW - timedelta(days=100)).isoformat()
    forged = base64.urlsafe_b64encode(json.dumps(state).encode()).decode()
    with pytest.raises(CursorError):
        page(store, cursor=forged)


def test_exact_filters_are_database_predicates(store: MongoAuditStore) -> None:
    store.insert(
        [
            event(
                "a",
                subject_ref="user:primary",
                outcome="deny",
                decision_id="decision-a",
                user_email="primary@example.test",
            ),
            event("b", subject_ref="user:secondary", outcome="allow", decision_id="decision-b"),
        ]
    )
    visible(store)
    query = AuditQuery(
        NOW - timedelta(days=1),
        NOW,
        2,
        subject_ref="user:primary",
        decision_id="decision-a",
        outcome="deny",
        user_email="EXAMPLE.TEST",
    )
    assert [r["audit_event_id"] for r in store.page(query, cursor=None, scope="filters")["records"]] == ["a"]


def test_ingestion_is_idempotent_but_ids_are_immutable(store: MongoAuditStore) -> None:
    assert store.insert([event("a")]) == 1
    assert store.insert([event("a")]) == 0
    with pytest.raises(EventConflict):
        store.insert([event("a", outcome="deny")])
    assert store.events.count_documents({}) == 1


@pytest.mark.parametrize(
    ("results", "delays", "flushed", "failed"),
    [
        ([2, 2, 1, 0], [0, 0, 1, 1], 5, 0),
        ([2, OSError("archive unavailable"), 0], [0, 1, 1], 2, 1),
        ([OSError("archive unavailable")], [1], 0, 1),
    ],
)
def test_archive_loop_drains_full_batches_but_waits_when_idle_or_failed(
    results: list[int | Exception], delays: list[int], flushed: int, failed: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    worker = ArchiveWorker(Mock(), Mock(backend_name="s3"), batch_size=2, interval=1)
    flush = Mock(side_effect=results)
    monkeypatch.setattr(worker, "flush_once", flush)

    async def exercise() -> None:
        # Cancel at the last scheduling point rather than waiting in real time.
        with patch("ai_platform_engineering.audit_service.archive_worker.asyncio.sleep", new_callable=AsyncMock) as sleep:
            sleep.side_effect = [None] * (len(results) - 1) + [asyncio.CancelledError()]
            with pytest.raises(asyncio.CancelledError):
                await worker.run()
            assert [call.args[0] for call in sleep.await_args_list] == delays

    asyncio.run(exercise())
    assert flush.call_count == len(results)
    assert worker.flushed_events == flushed
    assert worker.failed_flushes == failed
    assert (worker.last_error is not None) == isinstance(results[-1], Exception)


def test_archival_retries_same_durable_batch_across_replicas(store: MongoAuditStore) -> None:
    store.insert([event("a"), event("b")])
    archive = Mock(backend_name="s3")
    archive.write_batch.side_effect = [OSError("write response lost"), None]
    first = ArchiveWorker(store, archive, batch_size=2, interval=0.01, retention_days=2)
    second = ArchiveWorker(store, archive, batch_size=2, interval=0.01, retention_days=2)
    with pytest.raises(OSError):
        first.flush_once()
    assert store.events.count_documents({"expires_at": {"$exists": True}}) == 0
    assert second.flush_once() == 0  # Cannot steal a live lease.
    store.progress.update_one({"_id": "archive"}, {"$set": {"lease_until": NOW - timedelta(seconds=1)}})
    assert second.flush_once() == 2
    assert archive.write_batch.call_args_list[0] == archive.write_batch.call_args_list[1]
    assert store.events.count_documents({"archived": True}) == 2
    assert store.events.count_documents({"expires_at": NOW + timedelta(days=2)}) == 2
    assert "batch" not in store.progress.find_one({"_id": "archive"})


def test_completed_batch_recovers_even_after_query_record_expiry(store: MongoAuditStore) -> None:
    archive = Mock(backend_name="s3")
    store.progress.insert_one(
        {
            "_id": "archive",
            "lease_until": NOW - timedelta(seconds=1),
            "batch": {"id": "done", "events": ["already-expired"], "archived_at": NOW},
        }
    )
    worker = ArchiveWorker(store, archive, batch_size=2, interval=0.01)
    assert worker.flush_once() == 1
    archive.write_batch.assert_not_called()
    assert "batch" not in store.progress.find_one({"_id": "archive"})


def test_ingest_acknowledges_mongo_not_archive_and_rejects_db_failure(store: MongoAuditStore, tmp_path: Path) -> None:
    settings = Settings(local_path=str(tmp_path), verbosity="verbose", flush_interval_seconds=60)
    with TestClient(create_app(settings, query_store=store)) as client:
        assert client.post("/v1/audit/events", json=event("accepted")).status_code == 202
        assert store.events.find_one({"_id": "accepted"}) is not None
        original_insert = store.insert
        store.insert = Mock(side_effect=AutoReconnect("unavailable"))
        assert client.post("/v1/audit/events", json=event("unavailable")).status_code == 503
        store.insert = original_insert
        assert store.events.find_one({"_id": "unavailable"}) is None


def test_archive_outage_does_not_disable_query_readiness(store: MongoAuditStore, monkeypatch: pytest.MonkeyPatch) -> None:
    archive_client = Mock()
    archive_client.head_bucket.side_effect = OSError("archive unavailable")
    archive_client.put_object.side_effect = OSError("archive unavailable")
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: archive_client)
    settings = Settings(backend="s3", s3_bucket="example-audit", verbosity="verbose", flush_interval_seconds=60)
    with TestClient(create_app(settings, query_store=store)) as client:
        assert client.post("/v1/audit/events", json=event("accepted")).status_code == 202
        assert client.get("/readyz").status_code == 200
        visible(store)
        response = client.get("/v1/audit/events", params={"since": (NOW - timedelta(days=1)).isoformat(), "until": NOW.isoformat()})
        assert response.status_code == 200
        assert response.json()["records"][0]["audit_event_id"] == "accepted"


def test_backfill_is_dry_run_idempotent_and_preserves_distinct_legacy_rows(store: MongoAuditStore, tmp_path: Path) -> None:
    path = tmp_path / "audit.ndjson"
    legacy = {"ts": (NOW - timedelta(hours=1)).isoformat(), "type": "auth"}
    path.write_text("\n".join(json.dumps(r) for r in [event("known"), legacy, legacy]), encoding="utf-8")
    before = path.read_bytes()
    args = {"since": NOW - timedelta(days=1), "until": NOW}
    dry = backfill(local_records(tmp_path), None, **args)
    assert dry["matched"] == 3 and dry["generated_ids"] == 2
    assert store.events.count_documents({}) == 0
    assert backfill(local_records(tmp_path), store, **args)["inserted"] == 3
    assert backfill(local_records(tmp_path), store, **args)["already_present"] == 3
    assert store.events.count_documents({"archived": True}) == 3
    assert path.read_bytes() == before


def test_backfill_fails_visibly_on_corrupt_archive(tmp_path: Path) -> None:
    (tmp_path / "bad.ndjson").write_text("not json\n", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        backfill(local_records(tmp_path), None, since=NOW - timedelta(days=1), until=NOW)


def test_mongo_secret_components_are_url_encoded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.delenv("AUDIT_SERVICE_MONGODB_URI", raising=False)
    monkeypatch.setenv("AUDIT_SERVICE_MONGODB_HOST", "data-store:27017")
    monkeypatch.setenv("AUDIT_SERVICE_MONGODB_USERNAME", "example-user")
    monkeypatch.setenv("AUDIT_SERVICE_MONGODB_PASSWORD", "test /:?")
    assert Settings.from_env().mongodb_uri == "mongodb://example-user:test%20%2F%3A%3F@data-store:27017/?authSource=admin"


@pytest.mark.parametrize(("override", "expected"), [(None, 7), ("0", 0), ("30", 30)])
def test_query_retention_defaults_to_seven_days_independently_of_archive_retention(
    override: str | None, expected: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AUDIT_SERVICE_QUERY_RETENTION_DAYS", raising=False)
    monkeypatch.delenv("AUDIT_SERVICE_S3_RETENTION_DAYS", raising=False)
    if override is not None:
        monkeypatch.setenv("AUDIT_SERVICE_QUERY_RETENTION_DAYS", override)
    assert Settings().query_retention_days == 7
    settings = Settings.from_env()
    assert settings.query_retention_days == expected
    assert settings.s3_retention_days == 0


@pytest.mark.parametrize("days", [0, 7])
def test_query_expiry_is_applied_after_archival_or_import_not_event_time(store: MongoAuditStore, days: int) -> None:
    store.retention_days = days
    old_ts = (NOW - timedelta(days=30)).isoformat()
    store.insert([event("pending", ts=old_ts)])
    assert "expires_at" not in store.events.find_one({"_id": "pending"})
    archive = Mock(backend_name="s3")
    worker = ArchiveWorker(store, archive, batch_size=2, interval=1, retention_days=days)
    assert worker.flush_once() == 1
    archive.write_batch.assert_called_once()
    assert store.insert([event("imported", ts=old_ts)], archived=True) == 1
    for event_id in ("pending", "imported"):
        record = store.events.find_one({"_id": event_id})
        assert record["archived"] is True
        if days:
            assert record["expires_at"] == NOW + timedelta(days=days)
        else:
            assert "expires_at" not in record


def test_s3_backfill_preserves_payload_without_archive_writes(store: MongoAuditStore, monkeypatch: pytest.MonkeyPatch) -> None:
    client = Mock()
    client.get_paginator.return_value.paginate.return_value = [{"Contents": [{"Key": "audit/primary.parquet"}]}, {"Contents": [{"Key": "audit/secondary.parquet"}]}]
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: client)
    archive = S3AuditStore(bucket="example-audit")
    records = [event("a", gateway_checks=[{"gate": "caller_tool", "decision": "DENY"}])]
    body = archive._to_parquet_bytes(records)
    client.get_object.side_effect = [{"Body": io.BytesIO(body)}, {"Body": io.BytesIO(body)}]
    counts = backfill(s3_records(archive), store, since=NOW - timedelta(days=1), until=NOW)
    assert counts["matched"] == 2 and counts["inserted"] == 1 and counts["already_present"] == 1
    assert store.events.find_one({"_id": "a"})["event"]["gateway_checks"] == records[0]["gateway_checks"]
    client.put_object.assert_not_called()
    client.delete_object.assert_not_called()


@pytest.mark.parametrize("compressed", [False, True])
def test_s3_legacy_ndjson_backfill(store: MongoAuditStore, monkeypatch: pytest.MonkeyPatch, compressed: bool) -> None:
    client = Mock()
    key = "audit/legacy.ndjson.gz" if compressed else "audit/legacy.ndjson"
    client.get_paginator.return_value.paginate.return_value = [{"Contents": [{"Key": key}]}]
    data = (json.dumps(event("legacy")) + "\n").encode()
    encoded = gzip.compress(data) if compressed else data
    client.get_object.return_value = {"Body": StreamingBody(io.BytesIO(encoded), len(encoded))}
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: client)
    result = backfill(s3_records(S3AuditStore(bucket="example-audit")), store, since=NOW - timedelta(days=1), until=NOW)
    assert result["inserted"] == 1
    client.put_object.assert_not_called()

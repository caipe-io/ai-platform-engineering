"""Persistence and worker recovery contracts against an isolated MongoDB."""
from __future__ import annotations

import asyncio
import json
import os
from datetime import timedelta
from uuid import uuid4

import pytest
from pymongo import AsyncMongoClient

from common.ingestor_listener import ingestion_claim
from common.job_manager import JobManager, JobStatus
from common.metadata_storage import MetadataStorage
from common.migrations.redis_to_mongo import import_snapshot, snapshot_mongo, normalize_snapshot
from common.models.rag import DataSourceInfo
from common.mongo_storage import MongoStorage, CURRENT_CLAIM, utcnow

pytestmark = pytest.mark.skipif(not os.getenv("RAG_TEST_MONGODB_URI"), reason="Set RAG_TEST_MONGODB_URI to an isolated MongoDB for persistence tests")


async def isolated(test):
  client = AsyncMongoClient(os.environ["RAG_TEST_MONGODB_URI"], tz_aware=True)
  name = "rag_test_" + uuid4().hex
  storage = MongoStorage(client[name], client=client)
  try:
    await storage.setup()
    await test(storage)
  finally:
    await client.drop_database(name)
    await storage.aclose()


def test_claim_excludes_competing_workers_and_fences_expired_owner():
  async def scenario(storage):
    metadata = MetadataStorage(storage)
    jobs = JobManager(storage=storage)
    source = DataSourceInfo(datasource_id="primary", ingestor_id="example:primary", source_type="example", last_updated=None)
    first = await storage.acquire_datasource("primary")
    assert first and await storage.acquire_datasource("primary") is None
    marker = CURRENT_CLAIM.set(first)
    await metadata.store_datasource_info(source)
    assert await jobs.upsert_job("first", datasource_id="primary", status=JobStatus.IN_PROGRESS)
    assert await jobs.increment_progress("first") == 1
    CURRENT_CLAIM.reset(marker)
    past = utcnow() - timedelta(seconds=1)
    await storage.db.rag_datasource_claims.update_one({"_id": "primary"}, {"$set": {"lease_until": past}})
    await storage.db.rag_jobs.update_one({"_id": "first"}, {"$set": {"claim_until": past}})
    second = await storage.acquire_datasource("primary")
    assert second["generation"] > first["generation"]
    marker = CURRENT_CLAIM.set(first)
    assert await jobs.increment_progress("first") == -1
    with pytest.raises(RuntimeError):
      await metadata.store_datasource_info(source)
    CURRENT_CLAIM.reset(marker)
    await storage.recover_interrupted()
    assert (await jobs.get_job("first")).status == JobStatus.FAILED
    marker = CURRENT_CLAIM.set(second)
    await metadata.store_datasource_info(source)
    assert await jobs.upsert_job("second", datasource_id="primary", status=JobStatus.IN_PROGRESS)
    await storage.release_datasource(first)
    assert await jobs.increment_progress("second") == 1
    CURRENT_CLAIM.reset(marker)
  asyncio.run(isolated(scenario))


def test_concurrent_counters_errors_termination_and_history():
  async def scenario(storage):
    jobs = JobManager(storage=storage, max_jobs_per_datasource=2)
    await jobs.upsert_job("primary", datasource_id="source", status=JobStatus.IN_PROGRESS)
    await asyncio.gather(*(jobs.increment_progress("primary") for _ in range(50)))
    await jobs.add_error_msg("primary", "first")
    await jobs.add_error_msg("primary", "second")
    record = await jobs.get_job("primary")
    assert record.progress_counter == 50 and record.error_msgs == ["first", "second"]
    await jobs.terminate_job("primary")
    assert await jobs.increment_progress("primary") == -1
    assert not await jobs.upsert_job("primary", status=JobStatus.COMPLETED)
    for index in range(4):
      await jobs.upsert_job(f"completed-{index}", datasource_id="source", status=JobStatus.COMPLETED)
    assert len(await jobs.get_jobs_by_datasource("source")) == 2
  asyncio.run(isolated(scenario))


def test_commands_claim_once_and_recover_crash_before_datasource_claim():
  async def scenario(storage):
    jobs = JobManager(storage=storage)
    await jobs.upsert_job("primary", datasource_id="source")
    await storage.enqueue("example", json.dumps({"job_id": "primary"}))
    claims = await asyncio.gather(*(storage.claim_command("example") for _ in range(10)))
    assert len([claim for claim in claims if claim]) == 1
    command = next(claim for claim in claims if claim)
    await storage.db.rag_commands.update_one({"_id": command["_id"]}, {"$set": {"lease_until": utcnow() - timedelta(seconds=1)}})
    await storage.recover_interrupted()
    assert (await jobs.get_job("primary")).status == JobStatus.FAILED
    assert await storage.claim_command("example") is None
    assert (await storage.db.rag_commands.find_one({"_id": command["_id"]}))["state"] == "failed"
  asyncio.run(isolated(scenario))


def test_claim_scope_survives_callback_tasks_and_release_fails_incomplete_job():
  async def scenario(storage):
    jobs = JobManager(storage=storage)
    async with ingestion_claim(storage, "primary") as acquired:
      assert acquired
      await jobs.upsert_job("primary", datasource_id="primary", status=JobStatus.IN_PROGRESS)
      assert await asyncio.create_task(jobs.increment_progress("primary")) == 1
    assert CURRENT_CLAIM.get() is None
    assert (await jobs.get_job("primary")).status == JobStatus.FAILED
  asyncio.run(isolated(scenario))


def test_migration_round_trip_preserves_ttl_numbers_order_and_pending_commands():
  async def scenario(storage):
    expires = (utcnow() + timedelta(hours=1)).replace(microsecond=0).isoformat()
    errors_expiry = (utcnow() + timedelta(hours=2)).replace(microsecond=0).isoformat()
    payload = json.dumps({"ingestor_id": "example:primary", "job_id": "primary"})
    records = [
      {"key": "rag/datasource:primary", "type": "string", "value": json.dumps({"owner_subject": "test-user", "datasource_id": "primary"}), "expires_at": None},
      {"key": "job:primary", "type": "hash", "value": {"job_id": "primary", "status": "pending", "created_at": "1", "datasource_id": "primary"}, "expires_at": expires},
      {"key": "job:primary:errors", "type": "list", "value": ["first", "second"], "expires_at": errors_expiry},
      {"key": "jobs:by_datasource:primary", "type": "set", "value": ["primary"], "expires_at": None},
      {"key": "ingestor:example:requests", "type": "list", "value": [payload], "expires_at": None},
      {"key": "graph_relation_heuristics:example", "type": "hash", "value": {"total_matches": "2", "deep_match_quality_sum": "1", "prop_pattern:a.b->id:EXACT:quality_sum": "0.5"}, "expires_at": None},
      {"key": "graph_relation_heuristics:example:examples", "type": "list", "value": ["first", "second"], "expires_at": None},
      {"key": "rag/ingestor_preview:primary", "type": "list", "value": ['{"ok":true}'], "expires_at": expires},
    ]
    await import_snapshot(storage, records)
    await import_snapshot(storage, records)
    assert await snapshot_mongo(storage) == normalize_snapshot(records)
    await storage.hincrbyfloat("graph_relation_heuristics:example", "deep_match_quality_sum", 0.5)
    assert (await storage.hgetall("graph_relation_heuristics:example"))["deep_match_quality_sum"] == 1.5
    await storage.db.rag_jobs.update_one({"_id": "primary"}, {"$set": {"expires_at": utcnow() - timedelta(seconds=1)}})
    assert await JobManager(storage=storage).get_job("primary") is None
    assert not await JobManager(storage=storage).upsert_job("primary", status=JobStatus.IN_PROGRESS)
    await storage.db.rag_previews.update_one({"_id": "rag/ingestor_preview:primary"}, {"$set": {"expires_at": utcnow() - timedelta(seconds=1)}})
    assert await storage.wait_preview("rag/ingestor_preview:primary", 0.01) is None
  asyncio.run(isolated(scenario))


def test_migration_rejects_existing_state_and_preserves_error_only_keys():
  async def scenario(storage):
    await storage.db.rag_jobs.insert_one({"_id": "existing", "status": "completed"})
    records = [{"key": "job:orphan:errors", "type": "list", "value": ["retained-error"], "expires_at": (utcnow() + timedelta(hours=1)).replace(microsecond=0).isoformat()}]
    with pytest.raises(ValueError, match="not empty"):
      await import_snapshot(storage, records)
    assert await storage.db.rag_jobs.find_one({"_id": "existing"})
    await storage.db.rag_jobs.delete_one({"_id": "existing"})
    await import_snapshot(storage, records)
    assert await snapshot_mongo(storage) == records
    await storage.setup()
    with pytest.raises(ValueError, match="accepted runtime writes"):
      await import_snapshot(storage, records)
  asyncio.run(isolated(scenario))


def test_expired_hash_and_list_are_recreated_before_ttl_cleanup():
  async def scenario(storage):
    expired = utcnow() - timedelta(seconds=1)
    key = "graph_relation_heuristics:primary"
    await storage.hincrby(key, "total_matches", 10)
    await storage.collection(key).update_one({"_id": key}, {"$set": {"expires_at": expired}})
    assert await storage.hincrby(key, "total_matches", 1) == 1
    assert (await storage.hgetall(key))["total_matches"] == 1
    await storage.rpush(key + ":examples", "expired")
    await storage.db.rag_ontology_examples.update_many({}, {"$set": {"expires_at": expired}})
    await storage.rpush(key + ":examples", "current")
    assert await storage.lrange(key + ":examples", 0, -1) == ["current"]
  asyncio.run(isolated(scenario))


def test_ontology_batches_keep_numeric_sums_and_bounded_ordered_examples():
  async def scenario(storage):
    key = "graph_relation_heuristics:primary"
    batch = storage.pipeline()
    for index in range(25):
      batch.hincrby(key, "total_matches", 1)
      batch.hincrbyfloat(key, "quality_sum", 0.5)
      batch.hset(key, mapping={"entity_a_type": "example"})
      batch.rpush(key + ":examples", str(index))
      batch.ltrim(key + ":examples", 0, 19)
    await batch.execute()
    read = storage.pipeline()
    read.hgetall(key)
    read.lrange(key + ":examples", 0, -1)
    values, examples = await read.execute()
    assert values["total_matches"] == 25 and values["quality_sum"] == 12.5
    assert examples == [str(index) for index in range(20)]
    assert await storage.db.rag_ontology_examples.count_documents({}) == 20
  asyncio.run(isolated(scenario))


@pytest.mark.parametrize("start,stop,expected", [
  (-2, -1, ["c", "d"]), (0, -2, ["a", "b", "c"]), (-100, 100, ["a", "b", "c", "d"]),
  (0, -100, []), (3, 1, []), (100, 200, []), (-3, -2, ["b", "c"]),
])
def test_ltrim_redis_inclusive_negative_indices(start: int, stop: int, expected: list[str]) -> None:
  async def scenario(storage: MongoStorage) -> None:
    for value in ["a", "b", "c", "d"]:
      await storage.rpush("graph_relation_heuristics:primary:examples", value)
    await storage.ltrim("graph_relation_heuristics:primary:examples", start, stop)
    assert await storage.lrange("graph_relation_heuristics:primary:examples", 0, -1) == expected
  asyncio.run(isolated(scenario))


def test_ensure_setup_initializes_indexes_once() -> None:
  async def scenario(storage: MongoStorage) -> None:
    fresh = MongoStorage(storage.db)
    assert not fresh._setup_complete
    await fresh.ensure_setup()
    assert fresh._setup_complete
    await fresh.ensure_setup()
    indexes = await fresh.db.rag_ontology_examples.index_information()
    assert "expires_at_1" in indexes
  asyncio.run(isolated(scenario))

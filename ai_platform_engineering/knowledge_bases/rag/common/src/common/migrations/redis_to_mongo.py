"""Offline, reversible migration of RAG's legacy Redis records.

Run with every producer stopped and Redis writes paused. Snapshot files contain
application metadata and must be handled with the same controls as backups.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

try:
  from redis.asyncio import Redis
except ImportError:
  Redis = None

from common.mongo_storage import MongoStorage, encode_field, decode_field, utcnow

PATTERNS = ("rag/*", "job:*", "jobs:by_datasource:*", "graph_relation_heuristics:*", "graph_rag/*", "ingestor:*:requests")
NUMERIC_JOB_FIELDS = {"created_at", "completed_at", "total", "progress_counter", "failed_counter", "document_count", "chunk_count"}


def command_id(key: str, sequence: int, value: str) -> str:
  return hashlib.sha256(f"{key}\0{sequence}\0{value}".encode()).hexdigest()


def normalize_snapshot(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
  """Canonicalize logical values while preserving list order and deadlines."""
  result = []
  for record in records:
    if record.get("expires_at") and datetime.fromisoformat(record["expires_at"]) <= utcnow():
      continue
    record = dict(record)
    if record["key"].startswith("ingestor:") and record["key"].endswith(":requests") and record["key"].count(":") == 2:
      grouped: dict[str, list[str]] = {}
      for payload in record["value"]:
        request = json.loads(payload)
        queue = f"ingestor:{record['key'].split(':')[1]}:{request['ingestor_id']}:requests"
        grouped.setdefault(queue, []).append(payload)
      result.extend({**record, "key": queue, "value": values} for queue, values in grouped.items())
      continue
    if record["type"] == "set":
      record["value"] = sorted(record["value"])
    if record["type"] == "hash":
      record["value"] = {str(key): str(float(value)) if key.endswith("_sum") else str(value) for key, value in record["value"].items()}
    result.append(record)
  # A queue can be present in both legacy and addressed forms during an
  # interrupted rolling upgrade. Keep each source list ordered when combining.
  merged: dict[str, dict] = {}
  for record in result:
    if record["key"] in merged:
      previous = merged[record["key"]]
      if previous["type"] != "list" or record["type"] != "list" or previous["expires_at"] != record["expires_at"]:
        raise ValueError(f"Conflicting records for {record['key']}")
      previous["value"].extend(record["value"])
    else:
      merged[record["key"]] = {**record, "value": list(record["value"]) if record["type"] == "list" else record["value"]}
  return sorted(merged.values(), key=lambda item: item["key"])


async def snapshot_redis(redis) -> list[dict[str, Any]]:
  records = []
  seen = set()
  for pattern in PATTERNS:
    async for key in redis.scan_iter(match=pattern):
      if key in seen:
        continue
      seen.add(key)
      kind = await redis.type(key)
      if kind == "none":
        continue
      if kind == "string":
        value = await redis.get(key)
      elif kind == "hash":
        value = await redis.hgetall(key)
      elif kind == "list":
        value = await redis.lrange(key, 0, -1)
      elif kind == "set":
        value = sorted(await redis.smembers(key))
      else:
        raise ValueError(f"Unsupported Redis type {kind} for {key}; migration aborted")
      expiry_ms = await redis.pexpiretime(key)
      if expiry_ms == -2 or value is None:
        continue
      expires_at = datetime.fromtimestamp(expiry_ms / 1000, timezone.utc).isoformat() if expiry_ms > 0 else None
      records.append({"key": key, "type": kind, "value": value, "expires_at": expires_at})
  return normalize_snapshot(records)


async def prepare_import(storage: MongoStorage, records: list[dict[str, Any]]) -> str:
  digest = hashlib.sha256(json.dumps(records, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
  state = await storage.db.rag_migration_state.find_one({"_id": "redis-to-mongo"})
  if state:
    if state.get("digest") != digest or state.get("phase") not in {"importing", "imported"}:
      raise ValueError("Destination belongs to another snapshot or has accepted runtime writes; use an empty isolated target")
    return digest
  owned = ("rag_datasources", "rag_ingestors", "rag_mcp_settings", "rag_ontology_state", "rag_ontology_statistics", "rag_ontology_examples", "rag_jobs", "rag_job_errors", "rag_commands", "rag_previews", "rag_sequences")
  for name in owned:
    if await storage.db[name].find_one({}):
      raise ValueError(f"Destination {name} is not empty; refusing to overwrite existing RAG data")
  await storage.db.rag_migration_state.insert_one({"_id": "redis-to-mongo", "digest": digest, "phase": "importing"})
  return digest


def write_snapshot(path: Path, records: list[dict[str, Any]]) -> None:
  """Create backups privately from the first byte, then replace atomically."""
  temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
  descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
  try:
    with os.fdopen(descriptor, "w") as output:
      json.dump(records, output, indent=2)
      output.write("\n")
      output.flush()
      os.fsync(output.fileno())
    os.replace(temporary, path)
  finally:
    temporary.unlink(missing_ok=True)


async def import_snapshot(storage: MongoStorage, records: list[dict[str, Any]]) -> None:
  source_records = records
  records = normalize_snapshot(records)
  if any(item["key"].startswith("job:") and item["type"] == "hash" and item["value"].get("status") == "in_progress" for item in records):
    raise ValueError("Drain active jobs or explicitly terminate interrupted jobs through the legacy API before taking the final snapshot")
  digest = await prepare_import(storage, source_records)
  for item in records:
    key, kind, value = item["key"], item["type"], item["value"]
    expires = {"expires_at": datetime.fromisoformat(item["expires_at"])} if item.get("expires_at") else {}
    if key.startswith("jobs:by_datasource:"):
      if kind != "set":
        raise ValueError(f"Unexpected datasource index type for {key}")
      continue
    if key.startswith("job:") and key.endswith(":errors"):
      job_id = key[4:-7]
      for index, message in enumerate(value, 1):
        await storage.db.rag_job_errors.replace_one({"job_id": job_id, "sequence": index}, {"job_id": job_id, "sequence": index, "message": message, **expires}, upsert=True)
      await storage.db.rag_jobs.update_one({"_id": job_id}, {"$max": {"error_sequence": len(value)}})
    elif key.startswith("job:"):
      if kind != "hash":
        raise ValueError(f"Unexpected job type for {key}")
      record = {field: int(data) if field in NUMERIC_JOB_FIELDS else data for field, data in value.items()}
      record.update(_id=key[4:], **expires)
      record["error_sequence"] = next((len(error["value"]) for error in records if error["key"] == key + ":errors"), 0)
      await storage.db.rag_jobs.replace_one({"_id": record["_id"]}, record, upsert=True)
    elif key.startswith("ingestor:") and key.endswith(":requests"):
      if kind != "list":
        raise ValueError(f"Unexpected command queue type for {key}")
      for index, payload in enumerate(value):
        request = json.loads(payload)
        queue = key
        # Legacy queues omit the logical id. Route the stored request to its
        # owning ingestor without altering its payload or ordering.
        if key.count(":") == 2:
          queue = f"ingestor:{key.split(':')[1]}:{request['ingestor_id']}:requests"
        record = {"_id": command_id(queue, index, payload), "queue": queue, "payload": payload, "job_id": request.get("job_id"), "state": "queued", "created_at": datetime.fromtimestamp(index / 1000, timezone.utc), **expires}
        await storage.db.rag_commands.replace_one({"_id": record["_id"]}, record, upsert=True)
    elif key.startswith("rag/ingestor_preview:"):
      if kind != "list" or len(value) != 1:
        raise ValueError(f"Unexpected preview response for {key}")
      await storage.db.rag_previews.replace_one({"_id": key}, {"_id": key, "value": value[0], **expires}, upsert=True)
    elif kind == "list" and key.startswith("graph_relation_heuristics:"):
      for index, example in enumerate(value, 1):
        await storage.db.rag_ontology_examples.replace_one({"key": key, "sequence": index}, {"key": key, "sequence": index, "value": example, **expires}, upsert=True)
      await storage.db.rag_sequences.update_one({"_id": key}, {"$max": {"next": len(value)}}, upsert=True)
    elif kind in {"string", "hash"}:
      record = {"_id": key, **expires}
      if kind == "string":
        record["value"] = value
      else:
        def number(field: str, data: str) -> Any:
          if field in {"total_matches", "count"} or field.endswith(":count"):
            return int(data)
          if field.endswith("_sum"):
            return float(data)
          return data
        record["fields"] = {encode_field(field): number(field, data) for field, data in value.items()}
      await storage.collection(key).replace_one({"_id": key}, record, upsert=True)
    else:
      raise ValueError(f"Unsupported RAG record {key} ({kind}); migration aborted")

  await storage.db.rag_migration_state.update_one({"_id": "redis-to-mongo", "digest": digest}, {"$set": {"phase": "imported"}})


async def snapshot_mongo(storage: MongoStorage) -> list[dict[str, Any]]:
  records = []
  def append(key: str, kind: str, value: Any, record: dict) -> None:
    expires = record.get("expires_at")
    records.append({"key": key, "type": kind, "value": value, "expires_at": (expires.replace(tzinfo=timezone.utc) if expires.tzinfo is None else expires.astimezone(timezone.utc)).isoformat() if expires else None})
  for name in ("rag_datasources", "rag_ingestors", "rag_mcp_settings", "rag_ontology_state", "rag_ontology_statistics"):
    async for record in storage.db[name].find({}):
      if "value" not in record and "fields" not in record:
        continue
      if "fields" in record:
        append(record["_id"], "hash", {decode_field(key): value for key, value in record["fields"].items()}, record)
      elif "value" in record:
        append(record["_id"], "string", record["value"], record)
  indexes: dict[str, list[str]] = {}
  async for job in storage.db.rag_jobs.find({}):
    fields = {key: str(value) for key, value in job.items() if key not in {"_id", "error_sequence", "claim_token", "claim_until", "expires_at"}}
    append("job:" + job["_id"], "hash", fields, job)
    if job.get("datasource_id"):
      indexes.setdefault(job["datasource_id"], []).append(job["_id"])
  errors_by_job: dict[str, list[dict]] = {}
  async for error in storage.db.rag_job_errors.find({}).sort([("job_id", 1), ("sequence", 1)]):
    errors_by_job.setdefault(error["job_id"], []).append(error)
  for job_id, errors in errors_by_job.items():
    append("job:" + job_id + ":errors", "list", [error["message"] for error in errors], errors[0])
  for source, jobs in indexes.items():
    append("jobs:by_datasource:" + source, "set", sorted(jobs), {})
  queues: dict[str, list[dict]] = {}
  async for command in storage.db.rag_commands.find({"state": "queued"}).sort([("created_at", 1), ("_id", 1)]):
    if not command.get("expires_at") or command["expires_at"] > utcnow():
      queues.setdefault(command["queue"], []).append(command)
  for key, commands in queues.items():
    if len({command.get("expires_at") for command in commands}) > 1:
      raise ValueError("Drain or expire pending preview commands before snapshotting queues with mixed deadlines")
    append(key, "list", [command["payload"] for command in commands], commands[0])
  examples: dict[str, list[dict]] = {}
  async for record in storage.db.rag_ontology_examples.find({}).sort("sequence", 1):
    examples.setdefault(record["key"], []).append(record)
  for key, values in examples.items():
    append(key, "list", [record["value"] for record in values], values[0])
  async for record in storage.db.rag_previews.find({}):
    append(record["_id"], "list", [record["value"]], record)
  return normalize_snapshot(records)


async def export_redis(redis, records: list[dict[str, Any]]) -> None:
  # An empty, separately provisioned Redis prevents rollback from overwriting
  # unrelated application data or reusing an evicting cache as durable state.
  if await redis.dbsize() != 0:
    raise ValueError("Reverse-export requires an empty isolated Redis database")
  for record in normalize_snapshot(records):
    key, value = record["key"], record["value"]
    if record["type"] == "string":
      await redis.set(key, value)
    elif record["type"] == "hash":
      await redis.hset(key, mapping=value)
    elif record["type"] == "list":
      await redis.rpush(key, *value)
    elif record["type"] == "set":
      await redis.sadd(key, *value)
    if record.get("expires_at"):
      await redis.pexpireat(key, int(datetime.fromisoformat(record["expires_at"]).timestamp() * 1000))


async def main(args: argparse.Namespace) -> None:
  if Redis is None:
    raise RuntimeError("Install common[migration] in the operator virtual environment before running the migration")
  storage = MongoStorage()
  redis = Redis.from_url(args.redis_url, decode_responses=True)
  try:
    if args.mode in {"dry-run", "snapshot"}:
      frozen_at = asyncio.get_running_loop().time()
      if args.freeze_seconds:
        await redis.execute_command("CLIENT", "PAUSE", args.freeze_seconds * 1000, "WRITE")
      records = await snapshot_redis(redis)
      if args.freeze_seconds and asyncio.get_running_loop().time() - frozen_at >= args.freeze_seconds:
        raise RuntimeError("Redis write pause expired before the snapshot completed; renew the pause and retry")
      if args.mode == "snapshot":
        write_snapshot(args.snapshot, records)
      print(json.dumps({"records": len(records), "types": sorted({record["type"] for record in records})}))
    elif args.mode == "import":
      await storage.setup(runtime=False)
      await import_snapshot(storage, json.loads(args.snapshot.read_text()))
    elif args.mode == "verify":
      expected = normalize_snapshot(json.loads(args.snapshot.read_text()))
      actual = await snapshot_mongo(storage)
      if expected != actual:
        expected_keys = {item["key"] for item in expected}
        actual_keys = {item["key"] for item in actual}
        raise ValueError(f"Semantic verification failed: missing={sorted(expected_keys - actual_keys)}, unexpected={sorted(actual_keys - expected_keys)}; compare snapshot values before cutover")
      await storage.db.rag_migration_state.update_one({"_id": "redis-to-mongo"}, {"$set": {"phase": "verified"}})
      print(f"Verified {len(actual)} logical records including values, ordering, and expiration")
    elif args.mode == "reverse-export":
      active = await storage.db.rag_commands.count_documents({"state": "claimed"})
      active += await storage.db.rag_jobs.count_documents({"status": "in_progress"})
      if active:
        raise ValueError("Stop workers and drain active commands before reverse export")
      records = await snapshot_mongo(storage)
      write_snapshot(args.snapshot, records)
      await export_redis(redis, records)
  finally:
    await redis.aclose()
    await storage.aclose()


def cli() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("mode", choices=["dry-run", "snapshot", "import", "verify", "reverse-export"])
  parser.add_argument("--redis-url", default=os.getenv("LEGACY_RAG_REDIS_URL", "redis://localhost:6379"))
  parser.add_argument("--snapshot", type=Path, default=Path("rag-state-snapshot.json"))
  parser.add_argument("--freeze-seconds", type=int, default=0, help="Pause legacy Redis writes while reading a final snapshot")
  args = parser.parse_args()
  if args.freeze_seconds < 0:
    parser.error("--freeze-seconds must be nonnegative")
  asyncio.run(main(args))


if __name__ == "__main__":
  cli()

"""Shared MongoDB persistence and leased command delivery for RAG.

Coordination always reads the primary. Expiration predicates enforce deadlines
before MongoDB's asynchronous TTL cleanup removes expired records.
"""
from __future__ import annotations

import asyncio
import base64
import fnmatch
import json
import os
import re
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from pymongo import AsyncMongoClient, ReturnDocument, UpdateOne
from pymongo.errors import DuplicateKeyError
from pymongo.read_preferences import ReadPreference

CURRENT_CLAIM: ContextVar[dict[str, Any] | None] = ContextVar("rag_claim", default=None)
LEASE_SECONDS = 120


class IngestionLeaseLostError(RuntimeError):
  """The current operation cannot continue after losing its datasource lease."""


def utcnow() -> datetime:
  return datetime.now(timezone.utc)


def live_filter() -> dict[str, Any]:
  return {"$or": [{"expires_at": {"$exists": False}}, {"expires_at": {"$gt": utcnow()}}]}


def encode_field(field: str) -> str:
  return "f_" + base64.urlsafe_b64encode(field.encode()).decode()


def decode_field(field: str) -> str:
  return base64.urlsafe_b64decode(field[2:]).decode()


class MongoBatch:
  """Ordered operations for the existing metadata/ontology facades."""

  def __init__(self, storage: MongoStorage) -> None:
    self.storage = storage
    self.operations: list[tuple[str, tuple, dict]] = []

  def __getattr__(self, name: str) -> Any:
    def enqueue(*args: Any, **kwargs: Any) -> MongoBatch:
      self.operations.append((name, args, kwargs))
      return self
    return enqueue

  async def execute(self) -> list[Any]:
    operations, self.operations = self.operations, []
    if operations and all(name in {"hgetall", "lrange"} for name, _, _ in operations):
      hashes = [args[0] for name, args, _ in operations if name == "hgetall"]
      lists = [args[0] for name, args, _ in operations if name == "lrange"]
      values: dict[str, Any] = {}
      groups: dict[str, list[str]] = {}
      for key in hashes:
        groups.setdefault(self.storage.collection(key).name, []).append(key)
      for collection, keys in groups.items():
        async for record in self.storage.db[collection].find({"_id": {"$in": keys}, **live_filter()}):
          values[record["_id"]] = {decode_field(field): value for field, value in record.get("fields", {}).items()}
      async for record in self.storage.db.rag_ontology_examples.find({"key": {"$in": lists}, **live_filter()}).sort("sequence", 1):
        values.setdefault(record["key"], []).append(record["value"])
      return [values.get(args[0], {}) if name == "hgetall" else values.get(args[0], [])[args[1]:None if args[2] == -1 else args[2] + 1] for name, args, _ in operations]
    supported = {"hset", "hmset", "hincrby", "hincrbyfloat", "rpush", "ltrim"}
    if operations and all(name in supported for name, _, _ in operations):
      updates: dict[str, dict] = {}
      examples: dict[str, list] = {}
      trims: dict[str, tuple[int, int]] = {}
      for name, args, kwargs in operations:
        key = args[0]
        if name in {"hincrby", "hincrbyfloat"}:
          increments = updates.setdefault(key, {}).setdefault("$inc", {})
          field = f"fields.{encode_field(args[1])}"
          increments[field] = increments.get(field, 0) + (args[2] if len(args) > 2 else 1)
        elif name in {"hset", "hmset"}:
          mapping = kwargs.get("mapping", args[1] if len(args) > 1 else {})
          updates.setdefault(key, {}).setdefault("$set", {}).update({f"fields.{encode_field(field)}": value for field, value in mapping.items()})
        elif name == "rpush":
          examples.setdefault(key, []).extend(args[1:])
        elif name == "ltrim":
          trims[key] = (args[1], args[2])
      grouped: dict[str, list] = {}
      for key, update in updates.items():
        grouped.setdefault(self.storage.collection(key).name, []).append(UpdateOne({"_id": key}, update, upsert=True))
      for collection, writes in grouped.items():
        keys = [key for key in updates if self.storage.collection(key).name == collection]
        await self.storage.db[collection].delete_many({"_id": {"$in": keys}, "expires_at": {"$lte": utcnow()}})
        await self.storage.db[collection].bulk_write(writes, ordered=True)
      for key, values in examples.items():
        await self.storage.db.rag_ontology_examples.delete_many({"key": key, "expires_at": {"$lte": utcnow()}})
        existing = await self.storage.db.rag_ontology_examples.find_one({"key": key, **live_filter()})
        expiry = {"expires_at": existing["expires_at"]} if existing and existing.get("expires_at") else {}
        sequence = await self.storage.db.rag_sequences.find_one_and_update({"_id": key}, {"$inc": {"next": len(values)}}, upsert=True, return_document=ReturnDocument.AFTER)
        first = sequence["next"] - len(values) + 1
        await self.storage.db.rag_ontology_examples.insert_many([{"key": key, "sequence": first + index, "value": value, **expiry} for index, value in enumerate(values)])
      for key, (start, stop) in trims.items():
        await self.storage.ltrim(key, start, stop)
      return []
    return [await getattr(self.storage, name)(*args, **kwargs) for name, args, kwargs in operations]


class MongoStorage:
  """Mongo-backed storage used by the public RAG storage facades."""

  def __init__(self, database: Any | None = None, *, client: Any | None = None) -> None:
    self._setup_complete = False
    self.client = client
    if database is None:
      uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
      options: dict[str, Any] = {"retryWrites": False, "tz_aware": True, "read_preference": ReadPreference.PRIMARY, "serverSelectionTimeoutMS": 10000}
      ca_file = os.getenv("MONGODB_TLS_CA_FILE") or os.getenv("MONGODB_TLS_CA_PATH")
      if ca_file:
        options.update(tls=True, tlsCAFile=ca_file)
      self.client = AsyncMongoClient(uri, **options)
      database = self.client[os.getenv("MONGODB_DATABASE", "caipe")]
    self.db = database.with_options(read_preference=ReadPreference.PRIMARY)

  async def setup(self, *, runtime: bool = True) -> None:
    await self.ping()
    if runtime and os.getenv("RAG_WRITES_PAUSED", "false").lower() != "true":
      await self.db.rag_migration_state.update_one({"_id": "redis-to-mongo"}, {"$set": {"phase": "live"}})
    for name in ("rag_datasources", "rag_ingestors", "rag_mcp_settings", "rag_ontology_state", "rag_ontology_statistics", "rag_ontology_examples", "rag_commands", "rag_previews", "rag_jobs", "rag_job_errors"):
      await self.db[name].create_index("expires_at", expireAfterSeconds=0)
    await self.db.rag_jobs.create_index([("datasource_id", 1), ("created_at", -1)])
    await self.db.rag_jobs.create_index([("status", 1), ("claim_until", 1)])
    await self.db.rag_commands.create_index([("job_id", 1), ("state", 1)])
    await self.db.rag_job_errors.create_index([("job_id", 1), ("sequence", 1)], unique=True)
    await self.db.rag_commands.create_index([("queue", 1), ("state", 1), ("created_at", 1)])
    await self.db.rag_commands.create_index([("state", 1), ("lease_until", 1)])
    await self.db.rag_ontology_examples.create_index([("key", 1), ("sequence", 1)], unique=True)

    self._setup_complete = True

  async def ensure_setup(self) -> None:
    """Initialize this client once before independent startup or reload paths."""
    if not self._setup_complete:
      await self.setup()

  async def ping(self) -> bool:
    await self.db.command("ping")
    return True

  async def aclose(self) -> None:
    if self.client is not None:
      await self.client.close()

  def pipeline(self) -> MongoBatch:
    return MongoBatch(self)

  def collection(self, key: str) -> Any:
    if key.startswith("rag/datasource:"):
      return self.db.rag_datasources
    if key.startswith("rag/ingestor:"):
      return self.db.rag_ingestors
    if key.startswith("rag/mcp/"):
      return self.db.rag_mcp_settings
    if key.startswith("graph_relation_heuristics:"):
      return self.db.rag_ontology_statistics
    return self.db.rag_ontology_state

  async def get(self, key: str) -> Any:
    record = await self.collection(key).find_one({"_id": key, **live_filter()})
    return record.get("value") if record else None

  async def set(self, key: str, value: Any, *, ex: int | None = None) -> bool:
    record: dict[str, Any] = {"_id": key, "value": value}
    if ex:
      record["expires_at"] = utcnow() + timedelta(seconds=ex)
    claim = CURRENT_CLAIM.get()
    if key.startswith("rag/datasource:"):
      query = {"_id": key}
      if claim:
        if key != f"rag/datasource:{claim["_id"]}":
          raise RuntimeError("Datasource does not match the ingestion claim")
        await self.assert_claim(claim["_id"], claim["token"])
        query.update(claim_token=claim["token"], claim_until={"$gt": utcnow()})
      update: dict[str, Any] = {"$set": {k: v for k, v in record.items() if k != "_id"}}
      if not ex:
        update["$unset"] = {"expires_at": ""}
      changed = await self.collection(key).update_one(query, update, upsert=claim is None)
      if claim and changed.matched_count != 1:
        raise RuntimeError("Datasource claim is no longer current")
    else:
      await self.collection(key).replace_one({"_id": key}, record, upsert=True)
    return True

  async def setex(self, key: str, ttl: int, value: Any) -> bool:
    return await self.set(key, value, ex=ttl)

  async def keys(self, pattern: str) -> list[str]:
    # Prefix ownership avoids scanning ontology records for directory requests.
    prefix = pattern.split("*", 1)[0].split("?", 1)[0]
    if prefix:
      collection = self.collection(prefix)
      collections = [collection]
    else:
      collections = [self.db[name] for name in ("rag_datasources", "rag_ingestors", "rag_mcp_settings", "rag_ontology_state", "rag_ontology_statistics")]
    result = []
    query = {**live_filter(), "$and": [{"$or": [{"value": {"$exists": True}}, {"fields": {"$exists": True}}]}]}
    if prefix:
      query["_id"] = {"$regex": "^" + re.escape(prefix)}
    for collection in collections:
      async for record in collection.find(query, {"_id": 1}):
        if fnmatch.fnmatchcase(record["_id"], pattern):
          result.append(record["_id"])
    if not prefix or prefix.startswith("graph_relation_heuristics:"):
      example_query = live_filter()
      if prefix:
        example_query["key"] = {"$regex": "^" + re.escape(prefix)}
      async for record in self.db.rag_ontology_examples.find(example_query, {"key": 1}):
        if fnmatch.fnmatchcase(record["key"], pattern) and record["key"] not in result:
          result.append(record["key"])
    return result

  async def scan(self, cursor: int = 0, *, match: str = "*", count: int = 100) -> tuple[int, list[str]]:
    # Existing ontology cleanup deletes each returned batch, so an offset would
    # skip records. Returning all matching ids also avoids cursor instability.
    return 0, await self.keys(match)

  async def delete(self, *keys: str) -> int:
    deleted = 0
    for key in keys:
      deleted += (await self.collection(key).delete_one({"_id": key})).deleted_count
      deleted += (await self.db.rag_ontology_examples.delete_many({"key": key})).deleted_count
      await self.db.rag_sequences.delete_one({"_id": key})
    return deleted

  async def hgetall(self, key: str) -> dict[str, Any]:
    record = await self.collection(key).find_one({"_id": key, **live_filter()})
    return {decode_field(field): value for field, value in record.get("fields", {}).items()} if record else {}

  async def hget(self, key: str, field: str) -> Any:
    return (await self.hgetall(key)).get(field)

  async def _discard_expired_hash(self, key: str) -> None:
    await self.collection(key).delete_one({"_id": key, "expires_at": {"$lte": utcnow()}})

  async def hset(self, key: str, field: str | None = None, value: Any = None, *, mapping: dict | None = None) -> int:
    await self._discard_expired_hash(key)
    values = mapping if mapping is not None else {field: value}
    await self.collection(key).update_one({"_id": key}, {"$set": {f"fields.{encode_field(str(k))}": v for k, v in values.items()}}, upsert=True)
    return len(values)

  async def hmset(self, key: str, mapping: dict) -> int:
    return await self.hset(key, mapping=mapping)

  async def hincrby(self, key: str, field: str, amount: int = 1) -> int:
    await self._discard_expired_hash(key)
    path = f"fields.{encode_field(field)}"
    record = await self.collection(key).find_one_and_update({"_id": key}, {"$inc": {path: amount}}, upsert=True, return_document=ReturnDocument.AFTER)
    return record["fields"][encode_field(field)]

  async def hincrbyfloat(self, key: str, field: str, amount: float) -> float:
    return await self.hincrby(key, field, amount)

  async def rpush(self, key: str, *values: Any) -> int:
    # Ontology examples are separate bounded documents, avoiding MongoDB's
    # per-document size limit even during a large heuristic batch.
    await self.db.rag_ontology_examples.delete_many({"key": key, "expires_at": {"$lte": utcnow()}})
    existing = await self.db.rag_ontology_examples.find_one({"key": key, **live_filter()})
    expiry = {"expires_at": existing["expires_at"]} if existing and existing.get("expires_at") else {}
    for value in values:
      sequence = await self.db.rag_sequences.find_one_and_update({"_id": key}, {"$inc": {"next": 1}}, upsert=True, return_document=ReturnDocument.AFTER)
      await self.db.rag_ontology_examples.insert_one({"key": key, "sequence": sequence["next"], "value": value, **expiry})
    return await self.llen(key)

  async def lrange(self, key: str, start: int, stop: int) -> list[Any]:
    records = [record async for record in self.db.rag_ontology_examples.find({"key": key, **live_filter()}).sort("sequence", 1)]
    return [record["value"] for record in records[start:None if stop == -1 else stop + 1]]

  async def llen(self, key: str) -> int:
    return await self.db.rag_ontology_examples.count_documents({"key": key, **live_filter()})

  async def ltrim(self, key: str, start: int, stop: int) -> None:
    query = {"key": key, **live_filter()}
    length = await self.db.rag_ontology_examples.count_documents(query)
    start = max(length + start, 0) if start < 0 else start
    stop = length + stop if stop < 0 else min(stop, length - 1)
    keep = []
    if start <= stop and start < length:
      keep = [record["_id"] async for record in self.db.rag_ontology_examples.find(query).sort("sequence", 1).skip(start).limit(stop - start + 1)]
    await self.db.rag_ontology_examples.delete_many({"key": key, "_id": {"$nin": keep}})

  async def enqueue(self, queue: str, payload: str, *, expires_at: datetime | None = None) -> str:
    command_id = str(uuid4())
    record = {"_id": command_id, "queue": queue, "payload": payload, "state": "queued", "created_at": utcnow()}
    request = json.loads(payload)
    record["job_id"] = request.get("job_id")
    if request.get("response_key") and expires_at is None:
      expires_at = utcnow() + timedelta(minutes=5)
    if expires_at:
      record["expires_at"] = expires_at
    await self.db.rag_commands.insert_one(record)
    return command_id

  async def claim_command(self, queue: str) -> dict | None:
    return await self.db.rag_commands.find_one_and_update(
      {"queue": queue, "state": "queued", **live_filter()},
      {"$set": {"state": "claimed", "token": str(uuid4()), "lease_until": utcnow() + timedelta(seconds=LEASE_SECONDS)}},
      sort=[("created_at", 1)], return_document=ReturnDocument.AFTER,
    )

  async def finish_command(self, command: dict, *, failed: bool = False) -> None:
    await self.db.rag_commands.update_one({"_id": command["_id"], "token": command["token"], "lease_until": {"$gt": utcnow()}}, {"$set": {"state": "failed" if failed else "completed", "expires_at": utcnow() + timedelta(days=7)}})

  async def publish_preview(self, key: str, response: str) -> None:
    await self.db.rag_previews.replace_one({"_id": key}, {"_id": key, "value": response, "expires_at": utcnow() + timedelta(minutes=5)}, upsert=True)

  async def wait_preview(self, key: str, timeout: int) -> str | None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
      record = await self.db.rag_previews.find_one_and_delete({"_id": key, **live_filter()})
      if record:
        return record["value"]
      await asyncio.sleep(0.25)
    return None

  async def acquire_datasource(self, datasource_id: str, job_id: str | None = None) -> dict | None:
    token = str(uuid4())
    try:
      record = await self.db.rag_datasource_claims.find_one_and_update(
        {"_id": datasource_id, "lease_until": {"$lte": utcnow()}},
        {"$set": {"token": token, "job_id": job_id, "lease_until": utcnow() + timedelta(seconds=LEASE_SECONDS)}, "$inc": {"generation": 1}},
        upsert=True, return_document=ReturnDocument.AFTER,
      )
    except DuplicateKeyError:
      return None
    # Generations prevent a delayed acquisition from stamping over a newer
    # owner after its own lease has expired. The placeholder supports first sync.
    try:
      await self.db.rag_datasources.update_one(
        {"_id": f"rag/datasource:{datasource_id}", "$or": [{"claim_generation": {"$lt": record["generation"]}}, {"claim_generation": {"$exists": False}}]},
        {"$set": {"claim_token": token, "claim_until": record["lease_until"], "claim_generation": record["generation"]}}, upsert=True,
      )
    except DuplicateKeyError:
      return None
    await self.assert_claim(datasource_id, token)
    if job_id:
      await self.db.rag_jobs.update_one({"_id": job_id, "status": {"$nin": ["terminated", "failed"]}}, {"$set": {"claim_token": token, "claim_until": record["lease_until"]}})
    return record

  async def renew(self, claim: dict | None, command: dict | None = None) -> bool:
    deadline = utcnow() + timedelta(seconds=LEASE_SECONDS)
    if command:
      changed = await self.db.rag_commands.update_one({"_id": command["_id"], "token": command["token"], "state": "claimed", "lease_until": {"$gt": utcnow()}}, {"$set": {"lease_until": deadline}})
      if changed.matched_count != 1:
        return False
    if claim:
      changed = await self.db.rag_datasource_claims.update_one({"_id": claim["_id"], "token": claim["token"], "lease_until": {"$gt": utcnow()}}, {"$set": {"lease_until": deadline}})
      if changed.matched_count != 1:
        return False
      await self.db.rag_jobs.update_many({"claim_token": claim["token"]}, {"$set": {"claim_until": deadline}})
      await self.db.rag_datasources.update_one({"_id": f"rag/datasource:{claim["_id"]}", "claim_token": claim["token"]}, {"$set": {"claim_until": deadline}})
    return True

  async def release_datasource(self, claim: dict) -> None:
    await self.db.rag_datasource_claims.update_one(
      {"_id": claim["_id"], "token": claim["token"]},
      {"$set": {"lease_until": utcnow(), "released": True}},
    )
    await self.db.rag_datasources.update_one({"_id": f"rag/datasource:{claim['_id']}", "claim_token": claim["token"]}, {"$set": {"claim_until": utcnow()}})
    await self.db.rag_jobs.update_many({"claim_token": claim["token"], "status": {"$in": ["pending", "in_progress"]}}, {"$set": {"status": "failed", "message": "Ingestion stopped before completion; retry explicitly", "completed_at": int(utcnow().timestamp())}})

  async def assert_claim(self, datasource_id: str, token: str) -> None:
    if not await self.db.rag_datasource_claims.find_one({"_id": datasource_id, "token": token, "lease_until": {"$gt": utcnow()}}):
      raise RuntimeError("Ingestion claim expired; explicit retry is required")

  async def recover_interrupted(self) -> None:
    async for command in self.db.rag_commands.find({"state": "claimed", "lease_until": {"$lte": utcnow()}}):
      changed = await self.db.rag_commands.update_one({"_id": command["_id"], "token": command["token"], "lease_until": {"$lte": utcnow()}}, {"$set": {"state": "failed", "expires_at": utcnow() + timedelta(days=7)}})
      if changed.modified_count and command.get("job_id"):
        await self.db.rag_jobs.update_one(
          {"_id": command["job_id"], "status": {"$in": ["pending", "in_progress"]}},
          {"$set": {"status": "failed", "message": "Command worker stopped; retry explicitly", "completed_at": int(utcnow().timestamp())}},
        )
    await self.db.rag_jobs.update_many(
      {"status": {"$in": ["pending", "in_progress"]}, "claim_until": {"$lte": utcnow()}},
      {"$set": {"status": "failed", "message": "Ingestor lease expired; retry explicitly", "completed_at": int(utcnow().timestamp())}},
    )

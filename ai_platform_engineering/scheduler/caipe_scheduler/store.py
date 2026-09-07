"""Mongo connection + schedule-doc CRUD."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from pymongo import MongoClient, ReturnDocument
from pymongo.collection import Collection

from caipe_scheduler.config import Settings
from caipe_scheduler.models import DEFAULT_HTTP_TIMEOUT_SECONDS


class ScheduleStore:
  def __init__(self, settings: Settings):
    self._client: MongoClient[dict[str, Any]] = MongoClient(settings.mongodb_uri)
    self._db = self._client[settings.mongodb_database]
    self._col: Collection[dict[str, Any]] = self._db[settings.schedules_collection]
    self._one_off_runs: Collection[dict[str, Any]] = self._db[settings.one_off_runs_collection]
    self._dynamic_agents = self._db["dynamic_agents"]
    # schedule_id is the public unique handle; ensure it.
    self._col.create_index("schedule_id", unique=True)
    self._col.create_index("owner_sub")
    self._col.create_index("owner_user_id")
    self._col.create_index("agent_id")
    self._one_off_runs.create_index("one_off_run_id", unique=True)
    self._one_off_runs.create_index("schedule_id")
    self._one_off_runs.create_index("owner_sub")
    self._one_off_runs.create_index("owner_user_id")
    self._one_off_runs.create_index([("status", 1), ("run_at", 1)])

  # - lookups -
  def agent_exists(self, agent_id: str) -> bool:
    return self._dynamic_agents.count_documents({"_id": agent_id}, limit=1) > 0

  @staticmethod
  def owner_filter(owner_sub: str, owner_user_id: str) -> dict[str, Any]:
    """Match current owner_sub records and legacy email-only records."""
    return {
      "$or": [
        {"owner_sub": owner_sub},
        {
          "owner_sub": {"$exists": False},
          "owner_user_id": owner_user_id,
        },
      ]
    }

  def count_for_owner(self, owner_sub: str, owner_user_id: str) -> int:
    return self._col.count_documents(self.owner_filter(owner_sub, owner_user_id))

  def get(self, schedule_id: str) -> dict[str, Any] | None:
    return self._col.find_one({"schedule_id": schedule_id})

  def get_for_owner(
    self,
    schedule_id: str,
    *,
    owner_sub: str,
    owner_user_id: str,
  ) -> dict[str, Any] | None:
    return self._col.find_one(
      {
        "schedule_id": schedule_id,
        **self.owner_filter(owner_sub, owner_user_id),
      }
    )

  def list(
    self,
    *,
    owner_sub: str | None = None,
    owner_user_id: str | None = None,
    agent_id: str | None = None,
  ) -> list[dict[str, Any]]:
    query: dict[str, Any] = {}
    if owner_sub and owner_user_id:
      query.update(self.owner_filter(owner_sub, owner_user_id))
    elif owner_user_id:
      query["owner_user_id"] = owner_user_id
    if agent_id:
      query["agent_id"] = agent_id
    return list(self._col.find(query).sort("created_at", -1))

  # - writes -
  def insert(self, doc: dict[str, Any]) -> None:
    now = datetime.now(timezone.utc)
    doc.setdefault("created_at", now)
    doc.setdefault("updated_at", now)
    doc.setdefault("version", 1)
    doc.setdefault("versions", [])
    doc.setdefault("events", [])
    self._col.insert_one(doc)

  def patch(self, schedule_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    if not patch:
      return self.get(schedule_id)

    existing = self.get(schedule_id)
    if not existing:
      return None

    now = datetime.now(timezone.utc)
    versioned_fields = {
      "agent_id",
      "project_id",
      "edit_agent_id",
      "title",
      "message_template",
      "attributes",
      "cron",
      "tz",
      "http_timeout_seconds",
      "enabled",
      "cronjob_name",
    }
    changed_fields = sorted(key for key, value in patch.items() if key in versioned_fields and existing.get(key) != value)
    patch["updated_at"] = now

    update: dict[str, Any] = {"$set": patch}
    if changed_fields:
      previous_version = {
        "version": int(existing.get("version") or 1),
        "superseded_at": now,
        "changed_fields": changed_fields,
        "title": existing.get("title"),
        "agent_id": existing.get("agent_id"),
        "project_id": existing.get("project_id"),
        "edit_agent_id": existing.get("edit_agent_id"),
        "message_template": existing.get("message_template"),
        "attributes": existing.get("attributes") or {},
        "cron": existing.get("cron"),
        "tz": existing.get("tz"),
        "http_timeout_seconds": (
          existing.get("http_timeout_seconds") or DEFAULT_HTTP_TIMEOUT_SECONDS
        ),
        "enabled": existing.get("enabled", True),
        "cronjob_name": existing.get("cronjob_name"),
        "created_at": existing.get("created_at"),
        "updated_at": existing.get("updated_at"),
      }
      update["$set"]["version"] = int(existing.get("version") or 1) + 1
      update["$push"] = {
        "versions": {
          "$each": [previous_version],
          "$slice": -50,
        }
      }

    return self._col.find_one_and_update(
      {"schedule_id": schedule_id},
      update,
      return_document=ReturnDocument.AFTER,
    )

  def record_change_event(self, schedule_id: str, event: dict[str, Any]) -> None:
    """Append non-restorable history without growing the schedule indefinitely."""
    self._col.update_one(
      {"schedule_id": schedule_id},
      {
        "$push": {
          "events": {
            "$each": [event],
            "$slice": -50,
          }
        }
      },
    )

  def set_cronjob_name(self, schedule_id: str, cronjob_name: str) -> None:
    self._col.update_one(
      {"schedule_id": schedule_id},
      {"$set": {"cronjob_name": cronjob_name, "updated_at": datetime.now(timezone.utc)}},
    )

  def record_run(
    self,
    schedule_id: str,
    *,
    status: str,
    error: str | None = None,
    http_status: int | None = None,
  ) -> None:
    self._col.update_one(
      {"schedule_id": schedule_id},
      {
        "$set": {
          "last_run": {
            "ts": datetime.now(timezone.utc),
            "status": status,
            "error": error,
            "http_status": http_status,
          },
          "updated_at": datetime.now(timezone.utc),
        }
      },
    )

  # - one-off runs -
  def create_one_off_run(self, doc: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    doc.setdefault("created_at", now)
    doc.setdefault("updated_at", now)
    doc.setdefault("status", "pending")
    self._one_off_runs.insert_one(doc)
    return self._one_off_runs.find_one({"one_off_run_id": doc["one_off_run_id"]}) or doc

  def list_one_off_runs(
    self,
    schedule_id: str,
    *,
    statuses: list[str] | None = None,
  ) -> list[dict[str, Any]]:
    query: dict[str, Any] = {"schedule_id": schedule_id}
    if statuses:
      query["status"] = {"$in": statuses}
    return list(self._one_off_runs.find(query).sort("run_at", -1))

  def get_one_off_run(self, one_off_run_id: str) -> dict[str, Any] | None:
    return self._one_off_runs.find_one({"one_off_run_id": one_off_run_id})

  def next_pending_one_off_run_at(self) -> datetime | None:
    doc = self._one_off_runs.find_one(
      {"status": "pending"},
      sort=[("run_at", 1)],
      projection={"run_at": 1},
    )
    return doc.get("run_at") if doc else None

  def claim_due_one_off_runs(
    self,
    *,
    limit: int,
    claim_timeout_seconds: int,
  ) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(seconds=claim_timeout_seconds)
    self._one_off_runs.update_many(
      {
        "status": "claimed",
        "claimed_at": {"$lt": stale_cutoff},
        "job_name": {"$exists": False},
      },
      {
        "$set": {"status": "pending", "updated_at": now},
        "$unset": {"claimed_at": ""},
      },
    )

    candidates = list(
      self._one_off_runs.find(
        {"status": "pending", "run_at": {"$lte": now}},
        projection={"_id": 0},
      )
      .sort("run_at", 1)
      .limit(limit)
    )
    claimed: list[dict[str, Any]] = []
    for candidate in candidates:
      doc = self._one_off_runs.find_one_and_update(
        {
          "one_off_run_id": candidate["one_off_run_id"],
          "status": "pending",
          "run_at": {"$lte": now},
        },
        {
          "$set": {
            "status": "claimed",
            "claimed_at": now,
            "updated_at": now,
          }
        },
        return_document=ReturnDocument.AFTER,
      )
      if doc:
        claimed.append(doc)
    return claimed

  def mark_one_off_fired(self, one_off_run_id: str, *, job_name: str) -> None:
    now = datetime.now(timezone.utc)
    self._one_off_runs.update_one(
      {"one_off_run_id": one_off_run_id},
      {
        "$set": {
          "status": "fired",
          "job_name": job_name,
          "fired_at": now,
          "updated_at": now,
          "error": None,
        }
      },
    )

  def mark_one_off_failed(self, one_off_run_id: str, *, error: str) -> None:
    now = datetime.now(timezone.utc)
    self._one_off_runs.update_one(
      {"one_off_run_id": one_off_run_id},
      {
        "$set": {
          "status": "failed",
          "error": error[:1000],
          "completed_at": now,
          "updated_at": now,
        }
      },
    )

  def record_one_off_run(
    self,
    one_off_run_id: str,
    *,
    status: str,
    error: str | None = None,
    http_status: int | None = None,
  ) -> None:
    now = datetime.now(timezone.utc)
    self._one_off_runs.update_one(
      {"one_off_run_id": one_off_run_id},
      {
        "$set": {
          "status": "succeeded" if status == "ok" else "failed",
          "error": error,
          "http_status": http_status,
          "completed_at": now,
          "updated_at": now,
        }
      },
    )

  def cancel_one_off_runs_for_schedule(self, schedule_id: str) -> int:
    now = datetime.now(timezone.utc)
    result = self._one_off_runs.update_many(
      {
        "schedule_id": schedule_id,
        "status": {"$in": ["pending", "claimed"]},
      },
      {
        "$set": {
          "status": "cancelled",
          "updated_at": now,
          "completed_at": now,
          "error": "Parent schedule deleted.",
        }
      },
    )
    return result.modified_count

  def delete(self, schedule_id: str) -> int:
    return self._col.delete_one({"schedule_id": schedule_id}).deleted_count

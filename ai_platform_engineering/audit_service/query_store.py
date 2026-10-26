"""Durable audit ingestion and indexed, cursor-based reads. Archives are not queried."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any

from pymongo import DESCENDING, MongoClient
from pymongo.errors import BulkWriteError

from ai_platform_engineering.audit_service.storage import AuditQuery


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp(value: datetime | str) -> datetime:
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def query_scope(params: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(params, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class CursorError(ValueError):
    """Malformed cursor, or a cursor used with different filters."""


class EventConflict(ValueError):
    """An immutable event ID was reused for a different payload."""


class MongoAuditStore:
    def __init__(self, uri: str, database: str, *, client: Any = None, retention_days: int = 0) -> None:
        self.client = client or MongoClient(
            uri,
            tz_aware=True,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            w="majority",
            journal=True,
            connect=False,
        )
        self.db = self.client[database]
        self.events = self.db["audit_event_records"]
        self.progress = self.db["audit_archive_progress"]
        self.retention_days = retention_days

    def initialize(self) -> None:
        self.readiness_check()
        self.events.create_index([("ts", DESCENDING), ("_id", DESCENDING)])
        for field in ("tenant_id", "type", "outcome", "subject_ref", "resource_ref", "correlation_id", "decision_id", "delegation_id"):
            keys = [(f"event.{field}", 1), ("ts", DESCENDING), ("_id", DESCENDING)]
            self.events.create_index(keys)
        self.events.create_index([("archived", 1), ("ingested_at", 1), ("_id", 1)])
        self.events.create_index("expires_at", expireAfterSeconds=0)

    def readiness_check(self) -> None:
        self.db.command("ping")

    def insert(self, records: list[dict[str, Any]], *, archived: bool = False) -> int:
        now = utc_now()
        docs = []
        for value in records:
            event = dict(value)
            event_id = event.get("audit_event_id")
            if not isinstance(event_id, str) or not 1 <= len(event_id) <= 192:
                raise ValueError("audit_event_id must be a nonempty string of at most 192 characters")
            ts = timestamp(event["ts"])
            event["ts"] = ts.isoformat().replace("+00:00", "Z")
            digest = query_scope(event)
            doc = {
                "_id": event_id,
                "ts": ts,
                "ingested_at": now,
                "archived": archived,
                "event_hash": digest,
                "event": event,
            }
            if archived:
                doc["archived_at"] = now
                if self.retention_days:
                    doc["expires_at"] = now + timedelta(days=self.retention_days)
            docs.append(doc)
        if not docs:
            return 0
        try:
            self.events.insert_many(docs, ordered=False)
            return len(docs)
        except BulkWriteError as exc:
            errors = exc.details.get("writeErrors", [])
            if (
                not errors
                or exc.details.get("writeConcernErrors")
                or any(error.get("code") != 11000 for error in errors)
            ):
                raise
            for error in errors:
                doc = docs[error["index"]]
                existing = self.events.find_one({"_id": doc["_id"]}, {"event_hash": 1})
                if not existing or existing["event_hash"] != doc["event_hash"]:
                    raise EventConflict("audit_event_id already identifies a different event") from exc
            return int(exc.details.get("nInserted", 0))

    def page(self, query: AuditQuery, *, cursor: str | None, scope: str, max_days: int = 31) -> dict[str, Any]:
        since, until = query.since, query.until
        # BSON timestamps have millisecond precision. Exclude the current millisecond
        # so requests arriving after this page do not leak into its continuation.
        as_of = utc_now() - timedelta(milliseconds=1)
        after = None
        if cursor:
            try:
                if len(cursor) > 4096:
                    raise ValueError("oversized cursor")
                state = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
                if state["scope"] != scope:
                    raise ValueError("filters changed")
                since, until, as_of = (timestamp(state[key]) for key in ("since", "until", "as_of"))
                if since > until or as_of > utc_now():
                    raise ValueError("invalid cursor bounds")
                if state.get("last_ts") is not None:
                    last, event_id = timestamp(state["last_ts"]), state["last_id"]
                    if not isinstance(event_id, str) or not 1 <= len(event_id) <= 192 or not since <= last <= until:
                        raise ValueError("invalid cursor position")
                    after = {"$or": [{"ts": {"$lt": last}}, {"ts": last, "_id": {"$lt": event_id}}]}
            except (ValueError, KeyError, TypeError, AttributeError, UnicodeError, OverflowError) as exc:
                raise CursorError("Invalid cursor, or filters changed; start a new query") from exc
        if since > until or until - since > timedelta(days=max_days):
            raise CursorError(f"Query range exceeds {max_days} days; start a new query")
        state = {"scope": scope, "since": since.isoformat(), "until": until.isoformat(), "as_of": as_of.isoformat()}
        page_cursor = cursor or base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":")).encode()).decode()
        filters: dict[str, Any] = {"ts": {"$gte": since, "$lte": until}, "ingested_at": {"$lte": as_of}}
        for key, value in asdict(query).items():
            if key in {"since", "until", "limit", "time_resolution"} or value is None:
                continue
            if key == "user_email":
                filters["event.user_email"] = {"$regex": re.escape(value), "$options": "i"}
            elif key == "capability":
                filters["$and"] = [{"$or": [{"event.capability": value}, {"event.action": value}]}]
            else:
                filters[f"event.{key}"] = value
        if after:
            filters.setdefault("$and", []).append(after)
        docs = list(self.events.find(filters).sort([("ts", -1), ("_id", -1)]).limit(query.limit + 1).max_time_ms(5000))
        has_more = len(docs) > query.limit
        docs = docs[: query.limit]
        next_cursor = None
        if has_more:
            last_doc = docs[-1]
            state = {
                "scope": scope,
                "since": since.isoformat(),
                "until": until.isoformat(),
                "as_of": as_of.isoformat(),
                "last_ts": last_doc["ts"].isoformat(),
                "last_id": last_doc["_id"],
            }
            next_cursor = base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":")).encode()).decode()
        return {
            "records": [doc["event"] for doc in docs],
            "cursor": page_cursor,
            "next_cursor": next_cursor,
            "limit": query.limit,
            "since": since.isoformat(),
            "until": until.isoformat(),
            "as_of": as_of.isoformat(),
        }

    def storage_usage(self) -> dict[str, Any]:
        return {
            "query_backend": "mongodb",
            "record_count": self.events.estimated_document_count(),
            "pending_archive_count": self.events.count_documents({"archived": False}, maxTimeMS=5000),
        }

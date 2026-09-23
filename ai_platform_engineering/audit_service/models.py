"""Pydantic models for audit ingest and query responses."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class AuditEvent(BaseModel):
    """Flexible audit event model.

    The service preserves unknown fields so UI, bridge, and agent producers can
    evolve without a collector deploy for every new audit attribute.
    """

    model_config = ConfigDict(extra="allow")

    audit_event_id: str | None = None
    ts: datetime | str | None = None
    type: str | None = None
    tenant_id: str | None = None
    subject_hash: str | None = None
    subject_ref: str | None = None
    actor_hash: str | None = None
    actor_ref: str | None = None
    impersonation: bool | None = None
    impersonation_started_at: datetime | str | None = None
    action: str | None = None
    outcome: str | None = None
    reason_code: str | None = None
    correlation_id: str | None = None
    component: str | None = None
    resource_ref: str | None = None
    pdp: str | None = None
    source: str | None = None

    def to_record(self) -> dict[str, Any]:
        record = self.model_dump(mode="json", exclude_none=True)
        record.setdefault("audit_event_id", str(uuid4()))
        record.setdefault("ts", utc_now_iso())
        return record


class IngestResponse(BaseModel):
    accepted: int
    queued: int


class QueryResponse(BaseModel):
    records: list[dict[str, Any]]
    total: int
    limit: int
    truncated: bool = Field(description="True when matching rows exceeded limit.")

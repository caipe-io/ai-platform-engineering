"""Audit storage backends used by the lightweight audit service."""

from __future__ import annotations

import gzip
import io
import json
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4

_PARQUET_INDEX_FIELDS = (
    "ts",
    "type",
    "outcome",
    "component",
    "correlation_id",
    "tenant_id",
    "source",
    "action",
    "capability",
    "resource_ref",
    "subject_hash",
    "subject_ref",
    "actor_ref",
    "reason_code",
    "agent_name",
    "tool_name",
    "user_email",
)
_AUDIT_KEY_TS_RE = re.compile(r"audit-(\d{8}T\d{6}Z)-")
_KEY_TIME_PRUNE_TOLERANCE = timedelta(minutes=2)
_S3_IO_MAX_WORKERS = 16


def _format_bytes(value: int) -> str:
    amount = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if amount < 1024 or unit == "TiB":
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{amount:.1f} TiB"


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _day_parts(day: datetime) -> tuple[str, str, str]:
    return day.strftime("%Y"), day.strftime("%m"), day.strftime("%d")


def _hour_parts(value: datetime) -> tuple[str, str, str, str]:
    return value.strftime("%Y"), value.strftime("%m"), value.strftime("%d"), value.strftime("%H")


def _minute_parts(value: datetime) -> tuple[str, str, str, str, str]:
    return (
        value.strftime("%Y"),
        value.strftime("%m"),
        value.strftime("%d"),
        value.strftime("%H"),
        value.strftime("%M"),
    )


def _iter_days(since: datetime, until: datetime) -> Iterable[datetime]:
    cur = since.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = until.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    while cur <= end:
        yield cur
        cur = cur + timedelta(days=1)


def _iter_hours(since: datetime, until: datetime) -> Iterable[datetime]:
    cur = since.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = until.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    while cur <= end:
        yield cur
        cur = cur + timedelta(hours=1)


def _iter_minutes(since: datetime, until: datetime) -> Iterable[datetime]:
    cur = since.astimezone(timezone.utc).replace(second=0, microsecond=0)
    end = until.astimezone(timezone.utc).replace(second=0, microsecond=0)
    while cur <= end:
        yield cur
        cur = cur + timedelta(minutes=1)


def _parse_key_datetime(key: str) -> datetime | None:
    match = _AUDIT_KEY_TS_RE.search(key)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _record_sort_key(record: dict[str, Any]) -> datetime:
    return _parse_datetime(record.get("ts")) or datetime.min.replace(tzinfo=timezone.utc)


def _batch_partition_time(records: list[dict[str, Any]]) -> datetime:
    parsed = [_parse_datetime(record.get("ts")) for record in records]
    timestamps = [value for value in parsed if value is not None]
    if timestamps:
        return max(timestamps)
    return datetime.now(timezone.utc)


def _record_matches(record: dict[str, Any], query: "AuditQuery") -> bool:
    ts = _parse_datetime(record.get("ts"))
    if ts is None or ts < query.since or ts > query.until:
        return False
    for field in (
        "type",
        "outcome",
        "component",
        "correlation_id",
        "tenant_id",
        "source",
        "action",
        "resource_ref",
        "subject_hash",
        "reason_code",
        "agent_name",
        "tool_name",
    ):
        expected = getattr(query, field)
        if expected is not None and record.get(field) != expected:
            return False
    if query.capability is not None and (record.get("capability") or record.get("action")) != query.capability:
        return False
    if query.user_email is not None:
        actual = record.get("user_email")
        if not isinstance(actual, str) or query.user_email.lower() not in actual.lower():
            return False
    return True


@dataclass(frozen=True)
class AuditQuery:
    since: datetime
    until: datetime
    limit: int
    time_resolution: str = "auto"
    type: str | None = None
    outcome: str | None = None
    component: str | None = None
    correlation_id: str | None = None
    tenant_id: str | None = None
    source: str | None = None
    action: str | None = None
    capability: str | None = None
    resource_ref: str | None = None
    subject_hash: str | None = None
    reason_code: str | None = None
    agent_name: str | None = None
    tool_name: str | None = None
    user_email: str | None = None


@dataclass(frozen=True)
class QueryResult:
    records: list[dict[str, Any]]
    total: int
    truncated: bool


class LocalAuditStore:
    """Date-partitioned local NDJSON store with optional gzip compression."""

    def __init__(self, root: str, *, gzip_enabled: bool = True) -> None:
        self.root = Path(root)
        self.gzip_enabled = gzip_enabled

    @property
    def backend_name(self) -> str:
        return "local"

    def readiness_check(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        probe = self.root / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)

    def storage_health(self, *, warning_percent: float = 85.0, critical_percent: float = 95.0) -> dict[str, Any]:
        # assisted-by Codex Codex-sonnet-4-6
        self.readiness_check()
        usage = shutil.disk_usage(self.root)
        used_percent = round((usage.used / usage.total) * 100, 2) if usage.total else 100.0
        if used_percent >= critical_percent:
            status = "down"
        elif used_percent >= warning_percent:
            status = "warning"
        else:
            status = "healthy"

        return {
            "backend": self.backend_name,
            "status": status,
            "detail": f"local disk {used_percent:.1f}% used ({_format_bytes(usage.free)} free)",
            "local_path": str(self.root),
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
            "used_percent": used_percent,
            "warning_percent": warning_percent,
            "critical_percent": critical_percent,
        }

    def write_batch(self, records: list[dict[str, Any]]) -> str | None:
        if not records:
            return None

        partition_time = _batch_partition_time(records)
        yyyy, mm, dd = _day_parts(partition_time)
        day_dir = self.root / yyyy / mm / dd
        day_dir.mkdir(parents=True, exist_ok=True)

        suffix = ".ndjson.gz" if self.gzip_enabled else ".ndjson"
        filename = f"audit-{partition_time.strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:12]}{suffix}"
        path = day_dir / filename
        tmp_path = day_dir / f".{filename}.tmp"

        opener = gzip.open if self.gzip_enabled else open
        with opener(tmp_path, "wt", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record, separators=(",", ":"), default=str))
                handle.write("\n")
        os.replace(tmp_path, path)
        return str(path)

    def purge_expired(self, *, retention_days: int, now: datetime | None = None) -> int:
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=retention_days)
        deleted = 0
        for file_path in self._local_files():
            created_at = _parse_key_datetime(file_path.name)
            if created_at is None:
                try:
                    created_at = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
                except OSError:
                    continue
            if created_at >= cutoff:
                continue
            try:
                file_path.unlink()
                deleted += 1
            except FileNotFoundError:
                continue
            except OSError:
                continue
        if deleted:
            self._prune_empty_dirs()
        return deleted

    def query(self, query: AuditQuery) -> QueryResult:
        matches: list[dict[str, Any]] = []
        for file_path in self._files_for_range(query.since, query.until):
            for record in self._read_file(file_path):
                if not _record_matches(record, query):
                    continue
                matches.append(record)

        matches.sort(key=_record_sort_key, reverse=True)
        total = len(matches)
        return QueryResult(records=matches[: query.limit], total=total, truncated=total > query.limit)

    def _files_for_range(self, since: datetime, until: datetime) -> list[Path]:
        files: list[Path] = []
        for day in _iter_days(since, until):
            yyyy, mm, dd = _day_parts(day)
            day_dir = self.root / yyyy / mm / dd
            if not day_dir.is_dir():
                continue
            files.extend(sorted(day_dir.glob("*.ndjson")))
            files.extend(sorted(day_dir.glob("*.ndjson.gz")))
        return files

    def _local_files(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        files = list(self.root.rglob("*.ndjson"))
        files.extend(self.root.rglob("*.ndjson.gz"))
        return files

    def _prune_empty_dirs(self) -> None:
        if not self.root.is_dir():
            return
        dirs = [path for path in self.root.rglob("*") if path.is_dir()]
        for dir_path in sorted(dirs, key=lambda path: len(path.parts), reverse=True):
            try:
                dir_path.rmdir()
            except OSError:
                continue

    def audit_dir_bytes(self) -> int:
        """Return total bytes used by all audit files in the store directory."""
        total = 0
        for file_path in self._local_files():
            try:
                total += file_path.stat().st_size
            except OSError:
                continue
        return total

    def _read_file(self, file_path: Path) -> Iterable[dict[str, Any]]:
        opener = gzip.open if file_path.suffix == ".gz" else open
        try:
            with opener(file_path, "rt", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict):
                        yield record
        except OSError:
            return


class S3RetentionError(Exception):
    """Raised when an S3 lifecycle-rule update fails (e.g. missing IAM permissions)."""


class S3AuditStore:
    """S3-backed audit store using minute-partitioned Parquet objects."""

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str = "audit",
        region: str = "us-east-1",
        endpoint_url: str | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("AUDIT_SERVICE_S3_BUCKET is required when AUDIT_SERVICE_BACKEND=s3")
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.region = region
        self.endpoint_url = endpoint_url or None
        self._client = self._build_client()

    @property
    def backend_name(self) -> str:
        return "s3"

    def _build_client(self) -> Any:
        import boto3  # type: ignore[import-untyped]

        kwargs: dict[str, Any] = {"region_name": self.region}
        if self.endpoint_url:
            kwargs["endpoint_url"] = self.endpoint_url
        return boto3.client("s3", **kwargs)

    def readiness_check(self) -> None:
        self._client.head_bucket(Bucket=self.bucket)

    def storage_health(self) -> dict[str, Any]:
        # assisted-by Codex Codex-sonnet-4-6
        self.readiness_check()
        target = f"s3://{self.bucket}/{self.prefix}".rstrip("/")
        return {
            "backend": self.backend_name,
            "status": "healthy",
            "detail": f"S3 bucket reachable at {target}",
            "bucket": self.bucket,
            "prefix": self.prefix,
            "region": self.region,
            "endpoint_url": self.endpoint_url,
        }

    def get_s3_retention_days(self) -> int:
        """Return the lifecycle-rule expiration in days, or 0 if none is set."""
        try:
            response = self._client.get_bucket_lifecycle_configuration(Bucket=self.bucket)
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "response", {}).get("Error", {}).get("Code") in (
                "NoSuchLifecycleConfiguration",
                "NoSuchBucketPolicy",
            ):
                return 0
            return 0
        for rule in response.get("Rules", []):
            if rule.get("ID") == "caipe-audit-retention" and rule.get("Status") == "Enabled":
                return int(rule.get("Expiration", {}).get("Days", 0))
        return 0

    def set_s3_retention_days(self, days: int) -> None:
        """Set (or remove) the S3 lifecycle expiration rule for this prefix.

        Pass days=0 to remove the rule entirely.
        """
        if days <= 0:
            try:
                existing = self._client.get_bucket_lifecycle_configuration(Bucket=self.bucket)
                rules = [r for r in existing.get("Rules", []) if r.get("ID") != "caipe-audit-retention"]
                if rules:
                    self._client.put_bucket_lifecycle_configuration(
                        Bucket=self.bucket,
                        LifecycleConfiguration={"Rules": rules},
                    )
                else:
                    self._client.delete_bucket_lifecycle(Bucket=self.bucket)
            except Exception:  # noqa: BLE001
                pass
            return

        prefix_filter = f"{self.prefix}/" if self.prefix else ""
        new_rule: dict[str, Any] = {
            "ID": "caipe-audit-retention",
            "Status": "Enabled",
            "Filter": {"Prefix": prefix_filter},
            "Expiration": {"Days": days},
        }
        try:
            existing = self._client.get_bucket_lifecycle_configuration(Bucket=self.bucket)
            rules = [r for r in existing.get("Rules", []) if r.get("ID") != "caipe-audit-retention"]
        except Exception:  # noqa: BLE001
            rules = []
        rules.append(new_rule)
        try:
            self._client.put_bucket_lifecycle_configuration(
                Bucket=self.bucket,
                LifecycleConfiguration={"Rules": rules},
            )
        except Exception as exc:  # noqa: BLE001
            reason = getattr(exc, "response", {}).get("Error", {}).get("Message") or str(exc)
            raise S3RetentionError(
                f"Failed to update S3 lifecycle rule (check S3 permissions, e.g. "
                f"s3:PutLifecycleConfiguration on bucket {self.bucket}): {reason}"
            ) from exc

    def storage_usage(self, *, max_objects: int = 10_000) -> dict[str, Any]:
        """Return approximate storage usage under this prefix.

        Scans up to *max_objects* objects so the call doesn't block for
        very large buckets.  Sets ``capped=True`` when the scan was cut short.
        """
        prefix = f"{self.prefix}/" if self.prefix else ""
        total_bytes = 0
        total_objects = 0
        capped = False
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            try:
                response = self._client.list_objects_v2(**kwargs)
            except Exception:  # noqa: BLE001
                break
            for obj in response.get("Contents", []):
                total_bytes += obj.get("Size", 0)
                total_objects += 1
                if total_objects >= max_objects:
                    capped = True
                    break
            if capped or not response.get("IsTruncated"):
                break
            token = response.get("NextContinuationToken")
            if not token:
                break
        return {
            "object_count": total_objects,
            "total_bytes": total_bytes,
            "total_bytes_human": _format_bytes(total_bytes),
            "capped": capped,
        }

    def write_batch(self, records: list[dict[str, Any]]) -> str | None:
        if not records:
            return None

        partition_time = _batch_partition_time(records)
        yyyy, mm, dd, hh, minute = _minute_parts(partition_time)
        filename = f"audit-{partition_time.strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:12]}.parquet"
        key = "/".join(part for part in (self.prefix, yyyy, mm, dd, hh, minute, filename) if part)
        body = self._to_parquet_bytes(records)
        self._client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentType="application/vnd.apache.parquet",
        )
        return f"s3://{self.bucket}/{key}"

    def query(self, query: AuditQuery) -> QueryResult:
        keys = [
            key
            for key in self._keys_for_range(query.since, query.until, query.time_resolution)
            if self._key_may_overlap(key, query)
        ]

        matches: list[dict[str, Any]] = []
        if keys:
            workers = max(1, min(_S3_IO_MAX_WORKERS, len(keys)))
            with ThreadPoolExecutor(max_workers=workers) as executor:
                for records in executor.map(self._read_object, keys):
                    for record in records:
                        if _record_matches(record, query):
                            matches.append(record)

        matches.sort(key=_record_sort_key, reverse=True)
        total = len(matches)
        return QueryResult(records=matches[: query.limit], total=total, truncated=total > query.limit)

    def _keys_for_range(self, since: datetime, until: datetime, time_resolution: str = "auto") -> list[str]:
        resolution = self._resolve_time_resolution(since, until, time_resolution)
        prefixes = list(self._prefixes_for_range(since, until, resolution))
        if not prefixes:
            return []

        seen: set[str] = set()
        ordered_keys: list[str] = []
        workers = max(1, min(_S3_IO_MAX_WORKERS, len(prefixes)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [
                executor.submit(self._list_parquet_keys, prefix, delimiter=delimiter)
                for prefix, delimiter in prefixes
            ]
            for future in futures:
                for key in future.result():
                    if key not in seen:
                        seen.add(key)
                        ordered_keys.append(key)
        return ordered_keys

    def _resolve_time_resolution(self, since: datetime, until: datetime, requested: str) -> str:
        value = requested.strip().lower()
        if value in {"minute", "hour", "day"}:
            return value
        span = until - since
        if span <= timedelta(hours=1):
            return "minute"
        if span <= timedelta(days=1):
            return "hour"
        return "day"

    def _prefixes_for_range(
        self,
        since: datetime,
        until: datetime,
        resolution: str,
    ) -> Iterable[tuple[str, str | None]]:
        # assisted-by Codex Codex-sonnet-4-6
        if resolution == "minute":
            for hour in _iter_hours(since, until):
                yield self._join_prefix(*_hour_parts(hour)), None
        elif resolution == "hour":
            for hour in _iter_hours(since, until):
                yield self._join_prefix(*_hour_parts(hour)), None
        else:
            for day in _iter_days(since, until):
                yield self._join_prefix(*_day_parts(day)), None

        # Legacy branch builds wrote directly under YYYY/MM/DD. Keep those
        # visible without recursively listing the newer HH/mm prefixes.
        for day in _iter_days(since, until):
            yyyy, mm, dd = _day_parts(day)
            yield self._join_prefix(yyyy, mm, dd), "/"

    def _join_prefix(self, *parts: str) -> str:
        prefix = "/".join(part for part in (self.prefix, *parts) if part)
        return f"{prefix}/" if prefix else ""

    def _list_parquet_keys(self, prefix: str, *, delimiter: str | None = None) -> list[str]:
        keys: list[str] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if delimiter is not None:
                kwargs["Delimiter"] = delimiter
            if token:
                kwargs["ContinuationToken"] = token
            response = self._client.list_objects_v2(**kwargs)
            for item in response.get("Contents", []):
                key = item.get("Key")
                if isinstance(key, str) and key.endswith(".parquet"):
                    keys.append(key)
            if not response.get("IsTruncated"):
                break
            token = response.get("NextContinuationToken")
            if not token:
                break
        return keys

    def _key_may_overlap(self, key: str, query: AuditQuery) -> bool:
        key_dt = _parse_key_datetime(key)
        if key_dt is None:
            return True
        return (
            query.since - _KEY_TIME_PRUNE_TOLERANCE
            <= key_dt
            <= query.until + _KEY_TIME_PRUNE_TOLERANCE
        )

    def _read_object(self, key: str) -> list[dict[str, Any]]:
        try:
            response = self._client.get_object(Bucket=self.bucket, Key=key)
            body = response["Body"].read()
            return list(self._from_parquet_bytes(body))
        except Exception:
            return []

    def _to_parquet_bytes(self, records: list[dict[str, Any]]) -> bytes:
        import pyarrow as pa  # type: ignore[import-untyped]
        import pyarrow.parquet as pq  # type: ignore[import-untyped]

        rows = []
        for record in records:
            row = {
                field: None if record.get(field) is None else str(record.get(field))
                for field in _PARQUET_INDEX_FIELDS
            }
            row["record_json"] = json.dumps(record, separators=(",", ":"), default=str)
            rows.append(row)

        table = pa.Table.from_pylist(rows)
        sink = io.BytesIO()
        pq.write_table(table, sink, compression="snappy")
        return sink.getvalue()

    def _from_parquet_bytes(self, body: bytes) -> Iterable[dict[str, Any]]:
        import pyarrow.parquet as pq  # type: ignore[import-untyped]

        table = pq.read_table(io.BytesIO(body))
        for row in table.to_pylist():
            raw_record = row.get("record_json")
            if isinstance(raw_record, str):
                try:
                    record = json.loads(raw_record)
                except json.JSONDecodeError:
                    record = None
                if isinstance(record, dict):
                    yield record
                    continue
            record = {
                key: value
                for key, value in row.items()
                if key != "record_json" and value is not None
            }
            if record:
                yield record

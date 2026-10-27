"""CAS release migration: one-off archive-to-Mongo backfill; dry-run unless --apply is set."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from ai_platform_engineering.audit_service.config import Settings
from ai_platform_engineering.audit_service.query_store import MongoAuditStore, timestamp
from ai_platform_engineering.audit_service.storage import S3AuditStore


def ndjson_records(lines: Iterable[str], source: str) -> Iterator[tuple[str, int, dict[str, Any]]]:
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        record = json.loads(line)
        if not isinstance(record, dict):
            raise ValueError(f"Invalid archive record at {source}:{index + 1}")
        yield source, index, record


def local_records(root: Path) -> Iterator[tuple[str, int, dict[str, Any]]]:
    if not root.is_dir():
        raise ValueError("Local archive directory does not exist")
    for path in root.rglob("*"):
        if not path.is_file() or not path.name.endswith((".ndjson", ".ndjson.gz")):
            continue
        opener = gzip.open if path.suffix == ".gz" else open
        with opener(path, "rt", encoding="utf-8") as handle:
            yield from ndjson_records(handle, f"local:{path.relative_to(root).as_posix()}")


def s3_records(archive: S3AuditStore) -> Iterator[tuple[str, int, dict[str, Any]]]:
    prefix = f"{archive.prefix}/" if archive.prefix else ""
    paginator = archive._client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=archive.bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"]
            if not key.endswith((".parquet", ".ndjson", ".ndjson.gz")):
                continue
            # One archive object at a time. Do not use the interactive legacy
            # reader: it intentionally hides read errors and could conceal gaps.
            response = archive._client.get_object(Bucket=archive.bucket, Key=key)
            with response["Body"] as stream:
                if not key.endswith(".parquet"):
                    decoded = gzip.GzipFile(fileobj=stream) if key.endswith(".gz") else stream
                    with io.TextIOWrapper(decoded, encoding="utf-8") as lines:
                        yield from ndjson_records(lines, f"s3://{archive.bucket}/{key}")
                    continue
                parquet = pq.ParquetFile(io.BytesIO(stream.read()))
            index = 0
            for batch in parquet.iter_batches(batch_size=500):
                for row in batch.to_pylist():
                    raw = row.get("record_json")
                    record = json.loads(raw) if raw is not None else {k: v for k, v in row.items() if v is not None}
                    if not isinstance(record, dict):
                        raise ValueError(f"Invalid archive record at {key}:{index + 1}")
                    yield f"s3://{archive.bucket}/{key}", index, record
                    index += 1


def backfill(
    records: Iterable[tuple[str, int, dict[str, Any]]],
    store: MongoAuditStore | None,
    *,
    since: datetime,
    until: datetime,
    batch_size: int = 500,
) -> dict[str, int]:
    if since > until or batch_size < 1:
        raise ValueError("Invalid migration range or batch size")
    counts = {"scanned": 0, "matched": 0, "inserted": 0, "already_present": 0, "generated_ids": 0}
    pending = []

    def flush() -> None:
        if store is not None and pending:
            inserted = store.insert(pending, archived=True)
            counts["inserted"] += inserted
            counts["already_present"] += len(pending) - inserted
        pending.clear()

    for source, index, raw in records:
        counts["scanned"] += 1
        event = dict(raw)
        ts = timestamp(event["ts"])
        if not since <= ts <= until:
            continue
        if event.get("audit_event_id") is None:
            # Distinct legacy rows remain distinct even when payloads match.
            event["audit_event_id"] = "legacy:" + hashlib.sha256(f"{source}\n{index}".encode()).hexdigest()
            counts["generated_ids"] += 1
        if not isinstance(event["audit_event_id"], str) or not 1 <= len(event["audit_event_id"]) <= 192:
            raise ValueError("Invalid archive event ID")
        event["ts"] = ts.isoformat().replace("+00:00", "Z")
        # Dry-run validates serializability too, without connecting to MongoDB.
        json.dumps(event, allow_nan=False)
        counts["matched"] += 1
        pending.append(event)
        if len(pending) >= batch_size:
            flush()
    flush()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, type=timestamp)
    parser.add_argument("--until", required=True, type=timestamp)
    parser.add_argument("--apply", action="store_true", help="Write to MongoDB; otherwise validate and count only")
    args = parser.parse_args()
    settings = Settings.from_env()
    store = (
        MongoAuditStore(settings.mongodb_uri, settings.mongodb_database, retention_days=settings.query_retention_days)
        if args.apply
        else None
    )
    if store:
        store.initialize()
    if settings.backend == "local":
        records = local_records(Path(settings.local_path))
    elif settings.backend == "s3":
        records = s3_records(
            S3AuditStore(
                bucket=settings.s3_bucket,
                prefix=settings.s3_prefix,
                region=settings.s3_region,
                endpoint_url=settings.s3_endpoint_url,
            )
        )
    else:
        raise ValueError("Archive backend must be local or s3")
    result = backfill(records, store, since=args.since, until=args.until)
    print(json.dumps({"mode": "apply" if args.apply else "dry-run", **result}))


if __name__ == "__main__":
    main()

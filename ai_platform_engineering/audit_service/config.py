"""Runtime configuration for the audit service."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(value, minimum)


def _float_env(name: str, default: float, *, minimum: float = 0.001) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(value, minimum)


def _percent_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return min(max(value, 0.0), 100.0)


@dataclass(frozen=True)
class Settings:
    """Audit service settings sourced from environment variables."""

    backend: str = "local"
    local_path: str = "/var/lib/caipe-audit-service"
    local_gzip: bool = True
    local_retention_days: int = 1
    local_disk_warning_percent: float = 85.0
    local_disk_critical_percent: float = 95.0
    s3_bucket: str = ""
    s3_prefix: str = "audit"
    s3_region: str = "us-east-1"
    s3_endpoint_url: str | None = None
    s3_retention_days: int = 0
    queue_max_size: int = 10_000
    flush_batch_size: int = 500
    flush_interval_seconds: float = 1.0
    read_default_limit: int = 1_000
    read_max_limit: int = 10_000
    read_max_days: int = 31
    read_concurrency: int = 2
    verbosity: str = "minimal"

    @classmethod
    def from_env(cls) -> "Settings":
        # assisted-by Codex Codex-sonnet-4-6
        disk_warning_percent = _percent_env("AUDIT_SERVICE_LOCAL_DISK_WARNING_PERCENT", 85.0)
        disk_critical_percent = max(
            disk_warning_percent,
            _percent_env("AUDIT_SERVICE_LOCAL_DISK_CRITICAL_PERCENT", 95.0),
        )
        return cls(
            backend=os.getenv("AUDIT_SERVICE_BACKEND", "local").strip().lower(),
            local_path=os.getenv("AUDIT_SERVICE_LOCAL_PATH", "/var/lib/caipe-audit-service"),
            local_gzip=_bool_env("AUDIT_SERVICE_LOCAL_GZIP", True),
            local_retention_days=_int_env("AUDIT_SERVICE_LOCAL_RETENTION_DAYS", 1),
            local_disk_warning_percent=disk_warning_percent,
            local_disk_critical_percent=disk_critical_percent,
            s3_bucket=os.getenv("AUDIT_SERVICE_S3_BUCKET", ""),
            s3_prefix=os.getenv("AUDIT_SERVICE_S3_PREFIX", "audit"),
            s3_region=os.getenv("AUDIT_SERVICE_S3_REGION", "us-east-1"),
            s3_endpoint_url=os.getenv("AUDIT_SERVICE_S3_ENDPOINT_URL"),
            s3_retention_days=_int_env("AUDIT_SERVICE_S3_RETENTION_DAYS", 0, minimum=0),
            queue_max_size=_int_env("AUDIT_SERVICE_QUEUE_MAX_SIZE", 10_000),
            flush_batch_size=_int_env("AUDIT_SERVICE_FLUSH_BATCH_SIZE", 500),
            flush_interval_seconds=_float_env("AUDIT_SERVICE_FLUSH_INTERVAL_SECONDS", 1.0),
            read_default_limit=_int_env("AUDIT_SERVICE_READ_DEFAULT_LIMIT", 1_000),
            read_max_limit=_int_env("AUDIT_SERVICE_READ_MAX_LIMIT", 10_000),
            read_max_days=_int_env("AUDIT_SERVICE_READ_MAX_DAYS", 31),
            read_concurrency=_int_env("AUDIT_SERVICE_READ_CONCURRENCY", 2),
            verbosity=os.getenv("AUDIT_LOG_VERBOSITY", "minimal").strip().lower(),
        )

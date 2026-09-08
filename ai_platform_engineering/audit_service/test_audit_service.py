from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from ai_platform_engineering.audit_service.config import Settings
from ai_platform_engineering.audit_service.main import create_app
from ai_platform_engineering.audit_service.queue_service import PUBLIC_FLUSH_ERROR, AuditQueueService
from ai_platform_engineering.audit_service.storage import (
    AuditQuery,
    LocalAuditStore,
    S3AuditStore,
    S3RetentionError,
)
from ai_platform_engineering.audit_service.verbosity import (
    allowed_types,
    filter_records,
    is_event_allowed,
)


def _settings(tmp_path: Path, **overrides: object) -> Settings:
    values = {
        "local_path": str(tmp_path),
        "local_gzip": True,
        "local_retention_days": 1,
        "local_disk_warning_percent": 85.0,
        "local_disk_critical_percent": 95.0,
        "queue_max_size": 10,
        "flush_batch_size": 2,
        "flush_interval_seconds": 0.05,
        "read_default_limit": 100,
        "read_max_limit": 500,
        "read_max_days": 7,
        "verbosity": "verbose",
    }
    values.update(overrides)
    return Settings(**values)


def _wait_for_flushed(client: TestClient, expected: int) -> None:
    deadline = time.time() + 2
    while time.time() < deadline:
        status = client.get("/v1/audit/status").json()
        if status["flushed_events"] >= expected:
            return
        time.sleep(0.02)
    raise AssertionError(f"audit service did not flush {expected} events")


def test_ingests_batches_and_reads_filtered_events(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/audit/events",
            json={
                "events": [
                    {
                        "ts": "2026-06-20T01:00:00Z",
                        "type": "openfga_rebac",
                        "component": "admin_ui",
                        "outcome": "allow",
                        "correlation_id": "corr-1",
                    },
                    {
                        "ts": "2026-06-20T01:01:00Z",
                        "type": "auth",
                        "component": "login",
                        "outcome": "deny",
                        "correlation_id": "corr-2",
                    },
                ]
            },
        )

        assert response.status_code == 202
        assert response.json()["accepted"] == 2
        _wait_for_flushed(client, 2)

        read = client.get(
            "/v1/audit/events",
            params={
                "since": "2026-06-20T00:00:00Z",
                "until": "2026-06-20T02:00:00Z",
                "type": "openfga_rebac",
            },
        )

        assert read.status_code == 200
        body = read.json()
        assert body["total"] == 1
        assert body["records"][0]["correlation_id"] == "corr-1"


def test_rejects_when_queue_is_full(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path, queue_max_size=1, flush_batch_size=10, flush_interval_seconds=10))
    with TestClient(app) as client:
        response = client.post(
            "/v1/audit/events",
            json={"events": [{"type": "auth"}, {"type": "auth"}]},
        )

        assert response.status_code == 503
        status = client.get("/v1/audit/status").json()
        assert status["rejected_events"] == 2


def test_accepts_single_event_payload_and_defaults_timestamp(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path, flush_batch_size=1))
    with TestClient(app) as client:
        response = client.post("/v1/audit/events", json={"type": "auth", "outcome": "allow"})

        assert response.status_code == 202
        _wait_for_flushed(client, 1)

        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat().replace("+00:00", "Z")
        since = (now_dt.replace(microsecond=0) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        read = client.get(
            "/v1/audit/events",
            params={
                "since": since,
                "until": now,
                "outcome": "allow",
            },
        )

        assert read.status_code == 200
        records = read.json()["records"]
        assert len(records) == 1
    assert records[0]["type"] == "auth"
    assert records[0]["audit_event_id"]


def test_settings_reads_local_retention_days(monkeypatch) -> None:
    monkeypatch.setenv("AUDIT_SERVICE_LOCAL_RETENTION_DAYS", "3")

    settings = Settings.from_env()

    assert settings.local_retention_days == 3


def test_status_reports_local_disk_pressure(tmp_path: Path, monkeypatch) -> None:
    # assisted-by Codex Codex-sonnet-4-6
    monkeypatch.setattr(
        "ai_platform_engineering.audit_service.storage.shutil.disk_usage",
        lambda _: SimpleNamespace(total=1_000, used=920, free=80),
    )
    app = create_app(
        _settings(
            tmp_path,
            local_disk_warning_percent=85.0,
            local_disk_critical_percent=95.0,
        )
    )

    with TestClient(app) as client:
        status = client.get("/v1/audit/status")

    assert status.status_code == 200
    storage = status.json()["storage"]
    assert storage["backend"] == "local"
    assert storage["status"] == "warning"
    assert storage["used_percent"] == 92.0
    assert storage["free_bytes"] == 80
    assert "local disk 92.0% used" in storage["detail"]


def test_status_reports_local_disk_critical(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "ai_platform_engineering.audit_service.storage.shutil.disk_usage",
        lambda _: SimpleNamespace(total=1_000, used=960, free=40),
    )
    app = create_app(
        _settings(
            tmp_path,
            local_disk_warning_percent=85.0,
            local_disk_critical_percent=95.0,
        )
    )

    with TestClient(app) as client:
        status = client.get("/v1/audit/status")

    assert status.status_code == 200
    assert status.json()["storage"]["status"] == "down"


def test_status_sanitizes_storage_health_errors(tmp_path: Path, monkeypatch) -> None:
    def fail_storage_health(self: LocalAuditStore, **_: object) -> dict[str, object]:
        raise RuntimeError("secret backend path /tmp/audit-token")

    monkeypatch.setattr(LocalAuditStore, "storage_health", fail_storage_health)
    app = create_app(_settings(tmp_path))

    with TestClient(app) as client:
        status = client.get("/v1/audit/status")

    assert status.status_code == 200
    storage = status.json()["storage"]
    assert storage["status"] == "down"
    assert storage["detail"] == "storage health check failed; see audit-service logs"
    assert "secret" not in storage["detail"]


def test_queue_status_sanitizes_flush_errors() -> None:
    class FailingStore:
        @property
        def backend_name(self) -> str:
            return "local"

        def readiness_check(self) -> None:
            return None

        def write_batch(self, records: list[dict[str, object]]) -> str | None:
            raise RuntimeError("secret stack trace payload")

    service = AuditQueueService(
        FailingStore(),
        queue_max_size=10,
        flush_batch_size=1,
        flush_interval_seconds=0.01,
    )

    assert service.enqueue_many([{"type": "auth"}])
    asyncio.run(service._flush_remaining())

    status = service.status()
    assert status["failed_flushes"] == 1
    assert status["last_error"] == PUBLIC_FLUSH_ERROR
    assert "secret" not in status["last_error"]


def test_local_store_purges_expired_audit_files(tmp_path: Path) -> None:
    store = LocalAuditStore(str(tmp_path), gzip_enabled=False)
    old_dir = tmp_path / "2026" / "06" / "18"
    recent_dir = tmp_path / "2026" / "06" / "20"
    old_dir.mkdir(parents=True)
    recent_dir.mkdir(parents=True)
    old_file = old_dir / "audit-20260618T000000Z-old.ndjson"
    recent_file = recent_dir / "audit-20260620T115959Z-recent.ndjson"
    old_file.write_text('{"type":"auth"}\n', encoding="utf-8")
    recent_file.write_text('{"type":"auth"}\n', encoding="utf-8")

    deleted = store.purge_expired(retention_days=1, now=datetime(2026, 6, 20, 12, 0, tzinfo=timezone.utc))

    assert deleted == 1
    assert not old_file.exists()
    assert recent_file.exists()
    assert not old_dir.exists()


def test_s3_store_writes_and_reads_parquet_objects(monkeypatch) -> None:
    class FakeS3Client:
        def __init__(self) -> None:
            self.objects: dict[str, bytes] = {}
            self.content_types: dict[str, str] = {}

        def head_bucket(self, *, Bucket: str) -> None:  # noqa: N803
            assert Bucket == "audit-bucket"

        def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:  # noqa: N803
            assert Bucket == "audit-bucket"
            self.objects[Key] = Body
            self.content_types[Key] = ContentType

        def list_objects_v2(
            self,
            *,
            Bucket: str,
            Prefix: str,
            ContinuationToken: str | None = None,
            Delimiter: str | None = None,
        ) -> dict[str, object]:  # noqa: N803
            assert Bucket == "audit-bucket"
            assert Delimiter in (None, "/")
            return {
                "Contents": [{"Key": key} for key in sorted(self.objects) if key.startswith(Prefix)],
                "IsTruncated": False,
            }

        def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:  # noqa: N803
            assert Bucket == "audit-bucket"
            return {"Body": BytesIO(self.objects[Key])}

    fake_client = FakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake_client)

    store = S3AuditStore(bucket="audit-bucket", prefix="audit", region="us-east-1")
    path = store.write_batch(
        [
            {
                "ts": "2026-06-20T01:00:00Z",
                "type": "auth",
                "component": "admin_ui",
                "outcome": "allow",
                "correlation_id": "corr-1",
                "subject_hash": "sha256:alice",
                "subject_ref": "user:alice",
                "actor_ref": "user:alice",
            }
        ]
    )

    assert path is not None
    key = path.removeprefix("s3://audit-bucket/")
    assert key.startswith("audit/2026/06/20/01/00/")
    assert key.endswith(".parquet")
    assert fake_client.content_types[key] == "application/vnd.apache.parquet"

    result = store.query(
        AuditQuery(
            since=datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc),
            until=datetime(2026, 6, 20, 2, 0, tzinfo=timezone.utc),
            limit=10,
            outcome="allow",
        )
    )

    assert result.total == 1
    assert result.records[0]["correlation_id"] == "corr-1"
    assert result.records[0]["subject_ref"] == "user:alice"
    assert result.records[0]["actor_ref"] == "user:alice"


def test_s3_query_scopes_listing_and_fetch_to_date_range(monkeypatch) -> None:
    class ScopedFakeS3Client:
        def __init__(self) -> None:
            self.objects: dict[str, bytes] = {}
            self.list_prefixes: list[str] = []
            self.get_keys: list[str] = []
            self._lock = threading.Lock()

        def head_bucket(self, *, Bucket: str) -> None:  # noqa: N803
            pass

        def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:  # noqa: N803
            self.objects[Key] = Body

        def list_objects_v2(
            self,
            *,
            Bucket: str,
            Prefix: str,
            ContinuationToken: str | None = None,
            Delimiter: str | None = None,
        ) -> dict[str, object]:  # noqa: N803
            with self._lock:
                self.list_prefixes.append(Prefix)
            return {
                "Contents": [{"Key": key} for key in sorted(self.objects) if key.startswith(Prefix)],
                "IsTruncated": False,
            }

        def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:  # noqa: N803
            with self._lock:
                self.get_keys.append(Key)
            return {"Body": BytesIO(self.objects[Key])}

    fake_client = ScopedFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake_client)
    store = S3AuditStore(bucket="audit-bucket", prefix="audit", region="us-east-1")

    store.write_batch(
        [{"ts": "2026-06-20T01:00:00Z", "type": "auth", "outcome": "allow", "correlation_id": "in-range"}]
    )
    store.write_batch(
        [{"ts": "2026-07-15T01:00:00Z", "type": "auth", "outcome": "allow", "correlation_id": "out-of-range"}]
    )

    fake_client.list_prefixes.clear()
    fake_client.get_keys.clear()

    result = store.query(
        AuditQuery(
            since=datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc),
            until=datetime(2026, 6, 20, 2, 0, tzinfo=timezone.utc),
            limit=10,
        )
    )

    assert result.total == 1
    assert result.records[0]["correlation_id"] == "in-range"
    assert all("2026/07" not in prefix for prefix in fake_client.list_prefixes)
    assert all("2026/07" not in key for key in fake_client.get_keys)


def test_s3_query_fetches_objects_concurrently_and_assembles_correctly(monkeypatch) -> None:
    class ConcurrentFakeS3Client:
        def __init__(self) -> None:
            self.objects: dict[str, bytes] = {}
            self._lock = threading.Lock()
            self.get_object_threads: set[int] = set()

        def head_bucket(self, *, Bucket: str) -> None:  # noqa: N803
            pass

        def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:  # noqa: N803
            self.objects[Key] = Body

        def list_objects_v2(
            self,
            *,
            Bucket: str,
            Prefix: str,
            ContinuationToken: str | None = None,
            Delimiter: str | None = None,
        ) -> dict[str, object]:  # noqa: N803
            return {
                "Contents": [{"Key": key} for key in sorted(self.objects) if key.startswith(Prefix)],
                "IsTruncated": False,
            }

        def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:  # noqa: N803
            with self._lock:
                self.get_object_threads.add(threading.get_ident())
            time.sleep(0.05)
            return {"Body": BytesIO(self.objects[Key])}

    fake_client = ConcurrentFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake_client)
    store = S3AuditStore(bucket="audit-bucket", prefix="audit", region="us-east-1")

    expected_ids = set()
    for minute in range(8):
        corr_id = f"corr-{minute}"
        expected_ids.add(corr_id)
        store.write_batch(
            [
                {
                    "ts": f"2026-06-20T01:{minute:02d}:00Z",
                    "type": "auth",
                    "outcome": "allow",
                    "correlation_id": corr_id,
                }
            ]
        )

    start = time.monotonic()
    result = store.query(
        AuditQuery(
            since=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
            until=datetime(2026, 6, 20, 1, 10, tzinfo=timezone.utc),
            limit=100,
        )
    )
    elapsed = time.monotonic() - start

    assert result.total == 8
    assert {record["correlation_id"] for record in result.records} == expected_ids
    # Fetches ran concurrently across multiple worker threads...
    assert len(fake_client.get_object_threads) > 1
    # ...so total time is well under the fully-serial 8 * 0.05s baseline.
    assert elapsed < 0.3


def test_verbosity_filters_ingest(tmp_path: Path) -> None:
    # assisted-by claude code claude-sonnet-4-6
    settings = _settings(tmp_path, verbosity="minimal")
    app = create_app(settings)
    with TestClient(app) as client:
        response = client.post(
            "/v1/audit/events",
            json={
                "events": [
                    {"type": "cas_grant", "outcome": "success"},
                    {"type": "auth", "outcome": "deny"},
                    {"type": "tool_action", "outcome": "allow"},
                ]
            },
        )
        assert response.status_code == 202
        # minimal only allows cas_grant and cas_reconcile
        assert response.json()["accepted"] == 1

    verbosity_response = TestClient(app).get("/v1/audit/verbosity")
    assert verbosity_response.status_code == 200
    data = verbosity_response.json()
    assert data["verbosity"] == "minimal"
    assert "cas_grant" in data["allowed_types"]
    assert data["allow_all"] is False


def test_verbosity_endpoint_verbose(tmp_path: Path) -> None:
    # assisted-by claude code claude-sonnet-4-6
    settings = _settings(tmp_path, verbosity="verbose")
    app = create_app(settings)
    with TestClient(app) as client:
        data = client.get("/v1/audit/verbosity").json()
    assert data["verbosity"] == "verbose"
    assert data["allow_all"] is True
    assert data["allowed_types"] == []


# ============================================================
# New tests — verbosity, storage, S3 retention, main endpoints
# assisted-by claude code claude-sonnet-4-6
# ============================================================


# ---------------------------------------------------------------------------
# verbosity.py tests
# ---------------------------------------------------------------------------


def test_verbosity_allowed_types_minimal() -> None:
    types = allowed_types("minimal")
    assert types == frozenset({"cas_grant", "cas_reconcile"})


def test_verbosity_allowed_types_standard() -> None:
    types = allowed_types("standard")
    assert types == frozenset(
        {"auth", "cas_grant", "cas_reconcile", "cas_decision", "credential_action", "openfga_rebac"}
    )


def test_verbosity_allowed_types_il2() -> None:
    types = allowed_types("il2")
    assert "auth" in types
    assert "cas_grant" in types
    assert "cas_decision" in types
    assert "credential_action" in types
    assert "cas_reconcile" not in types


def test_verbosity_allowed_types_soc2() -> None:
    types = allowed_types("soc2")
    assert "agent_delegation" in types


def test_verbosity_allow_all_presets() -> None:
    assert allowed_types("verbose") == frozenset()
    assert allowed_types("il5") == frozenset()


def test_verbosity_unknown_preset_allows_all() -> None:
    assert allowed_types("nonexistent_preset") == frozenset()


def test_is_event_allowed_passes_and_blocks() -> None:
    assert is_event_allowed("cas_grant", "minimal") is True
    assert is_event_allowed("tool_action", "minimal") is False
    assert is_event_allowed(None, "minimal") is False


def test_is_event_allowed_openfga_rebac_standard_not_minimal() -> None:
    assert is_event_allowed("openfga_rebac", "standard") is True
    assert is_event_allowed("openfga_rebac", "minimal") is False


def test_filter_records_removes_disallowed() -> None:
    records = [
        {"type": "cas_grant"},
        {"type": "auth"},
        {"type": "tool_action"},
    ]
    result = filter_records(records, "minimal")
    assert len(result) == 1
    assert result[0]["type"] == "cas_grant"


def test_filter_records_verbose_passes_all() -> None:
    records = [
        {"type": "cas_grant"},
        {"type": "tool_action"},
        {"type": "unknown_future_type"},
    ]
    result = filter_records(records, "verbose")
    assert len(result) == 3


# ---------------------------------------------------------------------------
# LocalAuditStore.audit_dir_bytes tests
# ---------------------------------------------------------------------------


def test_local_store_audit_dir_bytes_empty(tmp_path: Path) -> None:
    store = LocalAuditStore(str(tmp_path), gzip_enabled=False)
    assert store.audit_dir_bytes() == 0


def test_local_store_audit_dir_bytes_sums_files(tmp_path: Path) -> None:
    store = LocalAuditStore(str(tmp_path), gzip_enabled=False)
    day_dir = tmp_path / "2026" / "06" / "20"
    day_dir.mkdir(parents=True)
    (day_dir / "audit-20260620T000000Z-aaa.ndjson").write_bytes(b"x" * 100)
    (day_dir / "audit-20260620T010000Z-bbb.ndjson").write_bytes(b"y" * 200)
    assert store.audit_dir_bytes() == 300


# ---------------------------------------------------------------------------
# S3AuditStore — retention + usage (standalone LifecycleFakeS3Client)
# ---------------------------------------------------------------------------


class LifecycleFakeS3Client:
    """Fake S3 client with lifecycle and list support for retention/usage tests."""

    def __init__(self) -> None:
        self.objects: dict[str, int] = {}  # key → size in bytes
        self._rules: list[dict] = []
        self.delete_lifecycle_called = False
        self.put_lifecycle_error: Exception | None = None

    def head_bucket(self, *, Bucket: str) -> None:  # noqa: N803
        pass

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:  # noqa: N803
        self.objects[Key] = len(Body)

    def get_bucket_lifecycle_configuration(self, *, Bucket: str) -> dict:  # noqa: N803
        if not self._rules:
            exc = Exception("NoSuchLifecycleConfiguration")
            exc.response = {"Error": {"Code": "NoSuchLifecycleConfiguration"}}  # type: ignore[attr-defined]
            raise exc
        return {"Rules": list(self._rules)}

    def put_bucket_lifecycle_configuration(self, *, Bucket: str, LifecycleConfiguration: dict) -> None:  # noqa: N803
        if self.put_lifecycle_error is not None:
            raise self.put_lifecycle_error
        self._rules = list(LifecycleConfiguration.get("Rules", []))

    def delete_bucket_lifecycle(self, *, Bucket: str) -> None:  # noqa: N803
        self._rules = []
        self.delete_lifecycle_called = True

    def list_objects_v2(
        self,
        *,
        Bucket: str,
        Prefix: str = "",
        ContinuationToken: str | None = None,
        Delimiter: str | None = None,
    ) -> dict:  # noqa: N803
        all_keys = sorted(k for k in self.objects if k.startswith(Prefix))
        contents = [{"Key": k, "Size": self.objects[k]} for k in all_keys]
        return {"Contents": contents, "IsTruncated": False}


def test_s3_get_retention_no_rule(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    assert store.get_s3_retention_days() == 0


def test_s3_get_retention_with_rule(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    fake._rules = [{"ID": "caipe-audit-retention", "Status": "Enabled", "Expiration": {"Days": 30}}]
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    assert store.get_s3_retention_days() == 30


def test_s3_set_retention_creates_rule(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    store.set_s3_retention_days(30)
    assert len(fake._rules) == 1
    rule = fake._rules[0]
    assert rule["ID"] == "caipe-audit-retention"
    assert rule["Status"] == "Enabled"
    assert rule["Expiration"]["Days"] == 30
    assert rule["Filter"]["Prefix"] == "audit/"


def test_s3_set_retention_zero_deletes_rule(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    fake._rules = [
        {"ID": "caipe-audit-retention", "Status": "Enabled", "Expiration": {"Days": 30}},
        {"ID": "other-rule", "Status": "Enabled"},
    ]
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    store.set_s3_retention_days(0)
    # caipe-audit-retention should be removed; other-rule should remain
    remaining_ids = [r["ID"] for r in fake._rules]
    assert "caipe-audit-retention" not in remaining_ids
    assert "other-rule" in remaining_ids
    # delete_bucket_lifecycle NOT called because other-rule remains
    assert not fake.delete_lifecycle_called


def test_s3_set_retention_zero_calls_delete_when_no_rules_remain(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    fake._rules = [{"ID": "caipe-audit-retention", "Status": "Enabled", "Expiration": {"Days": 30}}]
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    store.set_s3_retention_days(0)
    assert fake.delete_lifecycle_called


def test_s3_set_retention_raises_clean_error_on_access_denied(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    access_denied = Exception(
        "An error occurred (AccessDenied) when calling the PutBucketLifecycleConfiguration operation: "
        "not authorized to perform: s3:PutLifecycleConfiguration"
    )
    access_denied.response = {  # type: ignore[attr-defined]
        "Error": {
            "Code": "AccessDenied",
            "Message": "not authorized to perform: s3:PutLifecycleConfiguration",
        }
    }
    fake.put_lifecycle_error = access_denied
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    with pytest.raises(S3RetentionError, match="s3:PutLifecycleConfiguration"):
        store.set_s3_retention_days(30)


def test_s3_storage_usage_empty(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    usage = store.storage_usage()
    assert usage["object_count"] == 0
    assert usage["total_bytes"] == 0
    assert usage["capped"] is False


def test_s3_storage_usage_sums_objects(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    fake.objects = {
        "audit/2026/06/20/file1.parquet": 1000,
        "audit/2026/06/20/file2.parquet": 2000,
        "audit/2026/06/21/file3.parquet": 500,
    }
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    usage = store.storage_usage()
    assert usage["object_count"] == 3
    assert usage["total_bytes"] == 3500
    assert usage["capped"] is False


def test_s3_storage_usage_caps_at_max(monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    max_objects = 5
    fake.objects = {f"audit/file{i}.parquet": 100 for i in range(max_objects + 1)}
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    store = S3AuditStore(bucket="test-bucket", prefix="audit", region="us-east-1")
    usage = store.storage_usage(max_objects=max_objects)
    assert usage["capped"] is True
    assert usage["object_count"] == max_objects


# ---------------------------------------------------------------------------
# main.py endpoint tests — /v1/audit/verbosity, /v1/audit/storage,
# /v1/audit/retention, PUT /v1/audit/retention
# ---------------------------------------------------------------------------


def test_get_verbosity_minimal(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path, verbosity="minimal"))
    with TestClient(app) as client:
        response = client.get("/v1/audit/verbosity")
    assert response.status_code == 200
    data = response.json()
    assert data["verbosity"] == "minimal"
    assert "cas_grant" in data["allowed_types"]
    assert "cas_reconcile" in data["allowed_types"]
    assert data["allow_all"] is False


def test_get_verbosity_verbose(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path, verbosity="verbose"))
    with TestClient(app) as client:
        response = client.get("/v1/audit/verbosity")
    assert response.status_code == 200
    data = response.json()
    assert data["verbosity"] == "verbose"
    assert data["allow_all"] is True
    assert data["allowed_types"] == []


def test_get_storage_local(tmp_path: Path) -> None:
    # Use local_retention_days=90 so the pre-seeded file is not purged on startup
    app = create_app(_settings(tmp_path, local_retention_days=90))
    # Write a real file into the store directory so audit_bytes > 0
    day_dir = tmp_path / "2026" / "06" / "20"
    day_dir.mkdir(parents=True)
    (day_dir / "audit-20260620T000000Z-abc.ndjson").write_bytes(b"x" * 512)
    with TestClient(app) as client:
        response = client.get("/v1/audit/storage")
    assert response.status_code == 200
    data = response.json()
    assert data["backend"] == "local"
    assert data["audit_bytes"] > 0


def test_get_storage_s3(tmp_path: Path, monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    fake.objects = {
        "audit/2026/06/20/file1.parquet": 1000,
        "audit/2026/06/20/file2.parquet": 2000,
    }
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    app = create_app(_settings(tmp_path, backend="s3", s3_bucket="test-bucket"))
    with TestClient(app) as client:
        response = client.get("/v1/audit/storage")
    assert response.status_code == 200
    data = response.json()
    assert data["backend"] == "s3"
    assert "object_count" in data
    assert "total_bytes" in data


def test_get_retention_local(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path, local_retention_days=7))
    with TestClient(app) as client:
        response = client.get("/v1/audit/retention")
    assert response.status_code == 200
    data = response.json()
    assert data["backend"] == "local"
    assert data["configurable"] is False
    assert data["retention_days"] == 7


def test_get_retention_s3(tmp_path: Path, monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    fake._rules = [{"ID": "caipe-audit-retention", "Status": "Enabled", "Expiration": {"Days": 30}}]
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    app = create_app(_settings(tmp_path, backend="s3", s3_bucket="test-bucket"))
    with TestClient(app) as client:
        response = client.get("/v1/audit/retention")
    assert response.status_code == 200
    data = response.json()
    assert data["backend"] == "s3"
    assert data["configurable"] is True
    assert data["retention_days"] == 30


def test_put_retention_local_returns_400(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path))
    with TestClient(app) as client:
        response = client.put("/v1/audit/retention", json={"days": 14})
    assert response.status_code == 400


def test_put_retention_s3_sets_days(tmp_path: Path, monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    app = create_app(_settings(tmp_path, backend="s3", s3_bucket="test-bucket"))
    with TestClient(app) as client:
        response = client.put("/v1/audit/retention", json={"days": 14})
    assert response.status_code == 200
    data = response.json()
    assert data["retention_days"] == 14


def test_put_retention_invalid_body(tmp_path: Path, monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    app = create_app(_settings(tmp_path, backend="s3", s3_bucket="test-bucket"))
    with TestClient(app) as client:
        response = client.put("/v1/audit/retention", json={"not_days": 5})
    assert response.status_code == 400


def test_put_retention_negative_days(tmp_path: Path, monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    app = create_app(_settings(tmp_path, backend="s3", s3_bucket="test-bucket"))
    with TestClient(app) as client:
        response = client.put("/v1/audit/retention", json={"days": -1})
    assert response.status_code == 400


def test_put_retention_s3_access_denied_returns_clean_error(tmp_path: Path, monkeypatch) -> None:
    fake = LifecycleFakeS3Client()
    access_denied = Exception(
        "An error occurred (AccessDenied) when calling the PutBucketLifecycleConfiguration operation: "
        "not authorized to perform: s3:PutLifecycleConfiguration"
    )
    access_denied.response = {  # type: ignore[attr-defined]
        "Error": {
            "Code": "AccessDenied",
            "Message": "not authorized to perform: s3:PutLifecycleConfiguration",
        }
    }
    fake.put_lifecycle_error = access_denied
    monkeypatch.setattr(S3AuditStore, "_build_client", lambda self: fake)
    app = create_app(_settings(tmp_path, backend="s3", s3_bucket="test-bucket"))
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.put("/v1/audit/retention", json={"days": 30})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "s3:PutLifecycleConfiguration" in detail
    assert "not authorized" in detail

"""Verify the reusable migration Job without contacting Kubernetes or storage."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

SERVICE = Path(__file__).parent
MIGRATION = SERVICE / "scripts" / "cas_migration"


@pytest.fixture
def job() -> dict[str, Any]:
    return yaml.safe_load((MIGRATION / "cas-migration-job.yaml").read_text())


def test_job_is_a_bounded_standalone_run(job: dict[str, Any]) -> None:
    assert job["apiVersion"] == "batch/v1" and job["kind"] == "Job"
    assert job["metadata"] == {"name": "cas-migration-job"}
    assert job["spec"]["backoffLimit"] == 0
    assert job["spec"]["activeDeadlineSeconds"] == 7200
    assert "ttlSecondsAfterFinished" not in job["spec"]  # Retain inspection evidence.
    pod = job["spec"]["template"]["spec"]
    assert pod["restartPolicy"] == "Never" and pod["automountServiceAccountToken"] is False
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert pod["securityContext"]["runAsUser"] == 1001
    assert job["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/name"] == "cas-migration-job"


def test_job_overrides_the_standard_image_command_and_defaults_to_dry_run(job: dict[str, Any]) -> None:
    container = job["spec"]["template"]["spec"]["containers"][0]
    assert container["image"] == "ghcr.io/caipe-io/caipe-audit-service:REPLACE_WITH_CAS_RELEASE@sha256:REPLACE_WITH_DIGEST"
    assert container["command"] == ["python", "-m", "ai_platform_engineering.audit_service.scripts.cas_migration.migrate_query_store"]
    assert container["args"] == ["--since", "REPLACE_WITH_UTC_START", "--until", "REPLACE_WITH_UTC_END"]
    assert "livenessProbe" not in container and "readinessProbe" not in container


def test_job_references_existing_credentials_and_normal_service_settings(job: dict[str, Any]) -> None:
    pod = job["spec"]["template"]["spec"]
    assert pod["serviceAccountName"] == "REPLACE_WITH_ARCHIVE_READER_SERVICE_ACCOUNT"
    env = {entry["name"]: entry for entry in pod["containers"][0]["env"]}
    assert env["AUDIT_SERVICE_MONGODB_URI"] == {
        "name": "AUDIT_SERVICE_MONGODB_URI",
        "valueFrom": {"secretKeyRef": {"name": "REPLACE_WITH_MONGODB_SECRET", "key": "MONGODB_URI"}},
    }
    assert env["AUDIT_SERVICE_BACKEND"]["value"] == "s3"
    assert env["AUDIT_SERVICE_QUERY_RETENTION_DAYS"]["value"] == "7"
    for name in ("MONGODB_DATABASE", "S3_BUCKET", "S3_PREFIX", "S3_REGION"):
        assert env[f"AUDIT_SERVICE_{name}"]["value"].startswith("REPLACE_WITH_")


def test_standard_image_includes_the_migration_and_job_manifest() -> None:
    dockerfile = (SERVICE.parents[1] / "build" / "Dockerfile.audit-service").read_text()
    assert "COPY --chown=appuser:appuser ai_platform_engineering/audit_service ./ai_platform_engineering/audit_service" in dockerfile
    assert (MIGRATION / "migrate_query_store.py").is_file()
    assert (MIGRATION / "cas-migration-job.yaml").is_file()


def test_job_module_command_is_runnable(job: dict[str, Any]) -> None:
    command = job["spec"]["template"]["spec"]["containers"][0]["command"]
    result = subprocess.run(
        [sys.executable, *command[1:], "--help"],
        cwd=SERVICE.parents[1], env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, text=True, check=False, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert all(option in result.stdout for option in ("--since", "--until", "--apply"))

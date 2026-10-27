"""The migrate pre-install hook must not depend on resources created after hooks run."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts/ai-platform-engineering/charts/openfga"
POSTGRES = ("datastore.engine=postgres", "datastore.uri=postgres://example.test/openfga")


def render(*settings: str, upgrade: bool = False) -> list[dict[str, Any]]:
    if not shutil.which("helm"):
        pytest.skip("helm is required")
    command = ["helm", "template", "example", str(CHART)]
    if upgrade:
        command.append("--is-upgrade")
    for setting in settings:
        command.extend(["--set", setting])
    output = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    return [document for document in yaml.safe_load_all(output) if document]


def named(documents: list[dict[str, Any]], kind: str, name: str) -> dict[str, Any] | None:
    return next(
        (d for d in documents if d["kind"] == kind and d["metadata"]["name"] == name),
        None,
    )


def hook_weight(document: dict[str, Any]) -> int:
    return int(document["metadata"]["annotations"]["helm.sh/hook-weight"])


def test_migrate_job_uses_service_account_created_by_an_earlier_hook() -> None:
    documents = render(*POSTGRES)
    job = named(documents, "Job", "example-openfga-migrate")
    assert job is not None
    account_name = job["spec"]["template"]["spec"]["serviceAccountName"]
    assert account_name == "example-openfga-migrate"

    account = named(documents, "ServiceAccount", account_name)
    assert account is not None
    annotations = account["metadata"]["annotations"]
    assert annotations["helm.sh/hook"] == "pre-install"
    assert hook_weight(account) < hook_weight(job)


def test_upgrade_renders_migrate_job_unchanged() -> None:
    documents = render(*POSTGRES, upgrade=True)
    job = named(documents, "Job", "example-openfga-migrate")
    assert job is not None
    assert job["spec"]["template"]["spec"]["serviceAccountName"] == "example-openfga"
    assert named(documents, "ServiceAccount", "example-openfga-migrate") is None


def test_main_workload_service_account_is_unchanged() -> None:
    documents = render(*POSTGRES)
    deployment = named(documents, "Deployment", "example-openfga")
    assert deployment is not None
    assert deployment["spec"]["template"]["spec"]["serviceAccountName"] == "example-openfga"
    account = named(documents, "ServiceAccount", "example-openfga")
    assert account is not None
    assert "helm.sh/hook" not in (account["metadata"].get("annotations") or {})


def test_existing_service_account_is_used_as_is() -> None:
    documents = render(*POSTGRES, "serviceAccount.create=false", "serviceAccount.name=existing")
    job = named(documents, "Job", "example-openfga-migrate")
    assert job is not None
    assert job["spec"]["template"]["spec"]["serviceAccountName"] == "existing"
    assert not [d for d in documents if d["kind"] == "ServiceAccount"]


def test_memory_datastore_renders_no_migrate_resources() -> None:
    documents = render("datastore.engine=memory")
    assert named(documents, "Job", "example-openfga-migrate") is None
    assert named(documents, "ServiceAccount", "example-openfga-migrate") is None

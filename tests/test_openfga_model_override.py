"""The optional model source must not replace the chart's initialization code."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts/ai-platform-engineering/charts/openfga"


def render(*settings: str) -> list[dict[str, Any]]:
    if not shutil.which("helm"):
        pytest.skip("helm is required")
    command = ["helm", "template", "example", str(CHART)]
    for setting in settings:
        command.extend(["--set", setting])
    output = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    return [document for document in yaml.safe_load_all(output) if document]


def resource(documents: list[dict[str, Any]], kind: str, suffix: str) -> dict[str, Any]:
    return next(
        document for document in documents
        if document["kind"] == kind and document["metadata"]["name"].endswith(suffix)
    )


def test_default_model_and_mount_are_unchanged() -> None:
    documents = render()
    config = resource(documents, "ConfigMap", "-model")
    assert json.loads(config["data"]["authorization-model.json"]) == json.loads(
        (CHART / "authorization-model.json").read_text()
    )
    job = resource(documents, "Job", "-init")
    assert job["spec"]["template"]["spec"]["volumes"] == [{
        "name": "openfga-model", "configMap": {"name": "example-openfga-model"},
    }]


def test_override_projects_only_model_and_keeps_chart_owned_seed() -> None:
    default = render()
    override = render("init.existingModelConfigMap=example-authorization-model")
    config = resource(override, "ConfigMap", "-model")
    assert set(config["data"]) == {"seed.py"}
    assert config["data"]["seed.py"] == resource(default, "ConfigMap", "-model")["data"]["seed.py"]
    job = resource(override, "Job", "-init")
    pod = job["spec"]["template"]["spec"]
    assert pod["volumes"] == [{
        "name": "openfga-model",
        "projected": {"sources": [
            {"configMap": {"name": "example-openfga-model", "items": [
                {"key": "seed.py", "path": "seed.py"},
            ]}},
            {"configMap": {"name": "example-authorization-model", "items": [
                {"key": "authorization-model.json", "path": "authorization-model.json"},
            ]}},
        ]},
    }]
    default_job = resource(default, "Job", "-init")
    default_job["spec"]["template"]["spec"]["volumes"] = pod["volumes"]
    assert job == default_job, "Only the model volume source may change"


def test_seed_tuple_and_platform_client_configuration_are_preserved() -> None:
    documents = render(
        "init.existingModelConfigMap=example-authorization-model",
        "init.seedTuples[0].user=user:test-user",
        "init.seedTuples[0].relation=reader",
        "init.seedTuples[0].object=document:example",
        "init.platformClient.enabled=true",
        "init.platformClient.clientSecretRef.name=example-platform-secret",
    )
    job = resource(documents, "Job", "-init")
    container = job["spec"]["template"]["spec"]["containers"][0]
    env = {entry["name"]: entry for entry in container["env"]}
    assert json.loads(env["OPENFGA_SEED_TUPLES"]["value"]) == [{
        "user": "user:test-user", "relation": "reader", "object": "document:example",
    }]
    assert env["KEYCLOAK_PLATFORM_CLIENT_SECRET"]["valueFrom"]["secretKeyRef"]["name"] == "example-platform-secret"
    assert container["command"] == ["python", "/model/seed.py"]
    assert job["metadata"]["annotations"]["helm.sh/hook"] == "post-install,post-upgrade"


def test_disabled_init_does_not_create_model_config_or_job() -> None:
    documents = render("init.enabled=false", "init.existingModelConfigMap=example-authorization-model")
    assert not any(
        document["kind"] == "ConfigMap" and document["metadata"]["name"].endswith("-model")
        or document["kind"] == "Job" and document["metadata"]["name"].endswith("-init")
        for document in documents
    )


def test_override_cannot_shadow_chart_owned_configmap() -> None:
    if not shutil.which("helm"):
        pytest.skip("helm is required")
    result = subprocess.run(
        ["helm", "template", "example", str(CHART), "--set",
         "init.existingModelConfigMap=example-openfga-model"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode != 0
    assert "must not refer to the chart-owned" in result.stderr

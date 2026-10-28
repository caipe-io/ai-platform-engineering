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
    assert set(config["data"]) == {"seed.py", "publish_model.py", "core-authorization-model.json"}
    assert config["data"]["seed.py"] == resource(default, "ConfigMap", "-model")["data"]["seed.py"]
    job = resource(override, "Job", "-init")
    pod = job["spec"]["template"]["spec"]
    assert pod["volumes"] == [{
        "name": "openfga-model",
        "projected": {"sources": [
            {"configMap": {"name": "example-openfga-model", "items": [
                {"key": "seed.py", "path": "seed.py"},
                {"key": "publish_model.py", "path": "publish_model.py"},
                {"key": "core-authorization-model.json", "path": "core-authorization-model.json"},
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


def test_bundled_image_supplies_model_and_module_registry_to_initializer() -> None:
    documents = render("global.caipeUiImage=registry.example.test/host:policy-1",
                       "global.imagePullSecrets[0].name=example-registry")
    pod = resource(documents, "Job", "-init")["spec"]["template"]["spec"]
    exporter = pod["initContainers"][0]
    assert exporter["image"] == "registry.example.test/host:policy-1"
    assert exporter["command"] == ["node", "-e", "require('fs').cpSync('/app/authorization', '/bundled', {recursive:true});"]
    assert exporter["securityContext"]["runAsNonRoot"] is True
    assert pod["securityContext"]["fsGroup"] == 1001
    assert pod["imagePullSecrets"] == [{"name": "example-registry"}]
    assert {"name": "bundled-model", "emptyDir": {}} in pod["volumes"]
    initializer = pod["containers"][0]
    assert {"name": "OPENFGA_BUNDLE_PATH", "value": "/bundled"} in initializer["env"]
    assert {"name": "bundled-model", "mountPath": "/bundled", "readOnly": True} in initializer["volumeMounts"]
    source = resource(documents, "ConfigMap", "-model")["data"]["seed.py"]
    compile(source, "seed.py", "exec")
    assert 'entry["module"]' in source and '"bundle.json"' in source


def test_parent_image_selection_is_shared_by_ui_and_model_exporter(tmp_path: Path) -> None:
    if not shutil.which("helm"):
        pytest.skip("helm is required")
    # Exercise actual subcharts/global inheritance without fetching unrelated RAG dependencies.
    parent = tmp_path / "host"
    (parent / "charts").mkdir(parents=True)
    for name in ["caipe-ui", "openfga"]:
        shutil.copytree(CHART.parent / name, parent / "charts" / name)
    shutil.copy(CHART.parents[1] / "values.yaml", parent / "values.yaml")
    (parent / "Chart.yaml").write_text(yaml.safe_dump({
        "apiVersion": "v2", "name": "host", "version": "1.0.0", "dependencies": [
            {"name": name, "version": yaml.safe_load((CHART.parent / name / "Chart.yaml").read_text())["version"]}
            for name in ["caipe-ui", "openfga"]],
    }))
    output = subprocess.run([
        "helm", "template", "example", str(parent),
        "--set", "tags.caipe-ui=true", "--set", "openfga.enabled=true",
        "--set", "global.caipeUiImage=registry.example.test/host:policy-1",
        "--set", "global.imagePullSecrets[0].name=example-registry",
    ], check=True, capture_output=True, text=True).stdout
    documents = [doc for doc in yaml.safe_load_all(output) if doc]
    ui = resource(documents, "Deployment", "-caipe-ui")["spec"]["template"]["spec"]
    exporter = resource(documents, "Job", "-openfga-init")["spec"]["template"]["spec"]
    assert ui["containers"][0]["image"] == exporter["initContainers"][0]["image"]
    assert ui["imagePullSecrets"] == exporter["imagePullSecrets"]

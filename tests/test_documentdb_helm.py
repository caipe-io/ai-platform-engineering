"""Helm rendering coverage for the opt-in DocumentDB provider."""

from __future__ import annotations

import subprocess
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
CHART = REPO_ROOT / "charts/ai-platform-engineering/charts/caipe-ui-mongodb"
PARENT_VALUES = REPO_ROOT / "charts/ai-platform-engineering/values.yaml"
DOCUMENTDB_EXAMPLE = REPO_ROOT / "charts/ai-platform-engineering/values-documentdb.yaml.example"


def _render(*values: str) -> list[dict[str, object]]:
    command = [
        "helm",
        "template",
        "test",
        str(CHART),
        "--set",
        "global.vpa.enabled=false",
        "--set-string",
        "global.image.tag=",
        "--set-string",
        "auth.rootPassword=test-password",
    ]
    for value in values:
        command.extend(("--set-string", value))
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return [document for document in yaml.safe_load_all(result.stdout) if document]


def _kind(documents: list[dict[str, object]], kind: str) -> dict[str, object]:
    return next(document for document in documents if document["kind"] == kind)


def test_documentdb_provider_renders_pinned_gateway_and_data_volume() -> None:
    documents = _render("provider=documentdb", "fullnameOverride=caipe-documentdb")
    service = _kind(documents, "Service")
    statefulset = _kind(documents, "StatefulSet")

    assert service["spec"]["ports"][0]["port"] == 10260

    pod_spec = statefulset["spec"]["template"]["spec"]
    container = pod_spec["containers"][0]
    assert container["image"].endswith("documentdb-local:pg17-0.113.0")
    assert container["ports"][0]["containerPort"] == 10260
    assert container["volumeMounts"][0]["mountPath"] == "/data"
    assert "--tlsMode" in container["args"]
    assert pod_spec["securityContext"] == {"fsGroup": 1000, "runAsNonRoot": True}


def test_mongodb_remains_the_default_provider() -> None:
    documents = _render()
    service = _kind(documents, "Service")
    statefulset = _kind(documents, "StatefulSet")
    container = statefulset["spec"]["template"]["spec"]["containers"][0]

    assert service["spec"]["ports"][0]["port"] == 27017
    assert container["image"] == "mongo:7.0"
    assert container["volumeMounts"][0]["mountPath"] == "/data/db"


def test_unknown_provider_fails_helm_render() -> None:
    result = subprocess.run(
        [
            "helm",
            "template",
            "test",
            str(CHART),
            "--set",
            "global.vpa.enabled=false",
            "--set-string",
            "provider=unknown",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "provider must be mongodb or documentdb" in result.stderr


def test_umbrella_values_keep_mongodb_default_and_documentdb_opt_in() -> None:
    parent = yaml.safe_load(PARENT_VALUES.read_text())
    example = yaml.safe_load(DOCUMENTDB_EXAMPLE.read_text())

    assert parent["caipe-ui"]["mongodb"]["enabled"] is False
    assert parent["mongodb"]["provider"] == "mongodb"
    assert parent["mongodb"]["documentdb"]["image"]["tag"] == "pg17-0.113.0"
    assert example["caipe-ui"]["mongodb"]["enabled"] is True
    assert example["mongodb"]["provider"] == "documentdb"

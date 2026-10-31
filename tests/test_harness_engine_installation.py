"""Cross-component contracts for portable runtime installation defaults."""

from pathlib import Path
import shutil
import subprocess

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("filename", ["docker-compose.yaml", "docker-compose.dev.yaml"])
def test_standard_agent_profile_includes_private_engine_and_ui_gateway(filename: str) -> None:
    services = yaml.safe_load((ROOT / filename).read_text())["services"]
    engine = services["harness-engine"]
    assert "dynamic-agents" in engine["profiles"]
    assert not engine.get("ports")
    assert engine["environment"]["HARNESS_ENGINE_STORAGE_BACKEND"] == "mongodb"
    for name in ("caipe-ui", "caipe-ui-prod"):
        if name not in services:
            continue
        env = services[name]["environment"]
        assert any(item.startswith("HARNESS_ENGINE_URL=") for item in env)
        assert any(item.startswith("HARNESS_ENGINE_INTERNAL_TOKEN=") for item in env)


def _render(tmp_path: Path, *overrides: str) -> list[dict]:
    """Render the actual parent and UI templates without unrelated chart downloads."""
    chart = tmp_path / "chart"
    chart.mkdir()
    source = ROOT / "charts/ai-platform-engineering"
    shutil.copy(source / "values.yaml", chart / "values.yaml")
    metadata = yaml.safe_load((source / "Chart.yaml").read_text())
    metadata["dependencies"] = [item for item in metadata["dependencies"] if item["name"] == "caipe-ui"]
    (chart / "Chart.yaml").write_text(yaml.safe_dump(metadata))
    templates = chart / "templates"
    templates.mkdir()
    for filename in ("harness-engine.yaml", "_helpers.tpl"):
        shutil.copy(source / "templates" / filename, templates / filename)
    shutil.copytree(source / "charts/caipe-ui", chart / "charts/caipe-ui")
    command = ["helm", "template", "example", str(chart), "--set", "tags.caipe-ui=true"]
    for override in overrides:
        command += ["--set", override]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def test_helm_ui_and_engine_share_existing_token_and_database_secret(tmp_path: Path) -> None:
    docs = _render(
        tmp_path,
        "global.harnessEngine.tokenSecretName=example-token",
        "harnessEngine.mongodbSecretName=example-db",
        "harnessEngine.providerSecrets[0]=example-provider",
    )
    deployments = {doc["metadata"]["name"]: doc for doc in docs if doc["kind"] == "Deployment"}
    engine = deployments["example-harness-engine"]["spec"]["template"]["spec"]["containers"][0]
    ui = deployments["example-caipe-ui"]["spec"]["template"]["spec"]["containers"][0]
    engine_env = {item["name"]: item for item in engine["env"]}
    ui_env = {item["name"]: item for item in ui["env"]}
    assert engine_env["HARNESS_ENGINE_INTERNAL_TOKEN"]["valueFrom"] == ui_env["HARNESS_ENGINE_INTERNAL_TOKEN"]["valueFrom"]
    assert engine_env["HARNESS_ENGINE_MONGODB_URI"]["valueFrom"]["secretKeyRef"]["name"] == "example-db"
    assert ui_env["HARNESS_ENGINE_URL"]["value"] == "http://example-harness-engine:8010"
    assert engine["envFrom"] == [{"secretRef": {"name": "example-provider"}}]
    assert not any(doc["kind"] == "Secret" and doc["metadata"]["name"] == "example-token" for doc in docs)


def test_disabling_engine_removes_service_and_gateway_token_dependency(tmp_path: Path) -> None:
    docs = _render(tmp_path, "global.harnessEngine.enabled=false")
    assert not any(doc["metadata"]["name"].startswith("example-harness-engine") for doc in docs)
    ui = next(doc for doc in docs if doc["kind"] == "Deployment")
    assert not any(item["name"].startswith("HARNESS_ENGINE_") for item in ui["spec"]["template"]["spec"]["containers"][0]["env"])


def test_helm_default_without_database_secret_uses_ephemeral_storage(tmp_path: Path) -> None:
    docs = _render(tmp_path)
    engine = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["metadata"]["name"] == "example-harness-engine")
    env = {item["name"]: item for item in engine["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["HARNESS_ENGINE_STORAGE_BACKEND"]["value"] == "memory"
    assert "HARNESS_ENGINE_MONGODB_URI" not in env
    token = next(doc for doc in docs if doc["kind"] == "Secret" and doc["metadata"]["name"] == "example-harness-engine-token")
    assert token["data"]["HARNESS_ENGINE_INTERNAL_TOKEN"]

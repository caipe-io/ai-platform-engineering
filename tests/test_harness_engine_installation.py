"""Cross-component contracts for portable runtime installation defaults."""

import runpy
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("filename", ["docker-compose.yaml", "docker-compose.dev.yaml"])
def test_standard_agent_profile_includes_private_engine_and_ui_gateway(filename: str) -> None:
    services = yaml.safe_load((ROOT / filename).read_text())["services"]
    engine = services["harness-engine"]
    assert "dynamic-agents" in engine["profiles"]
    assert not engine.get("ports")
    assert engine["read_only"] is True
    assert "harness_workspace:/workspace" in engine["volumes"]
    assert engine["depends_on"]["harness-token-init"]["condition"] == "service_completed_successfully"
    assert "harness_token:/run/harness-engine:ro" in engine["volumes"]
    assert "local-development-only" not in str(engine["environment"])
    assert engine["environment"]["HARNESS_ENGINE_STORAGE_BACKEND"] == "mongodb"
    for name in ("caipe-ui", "caipe-ui-prod"):
        if name not in services:
            continue
        env = services[name]["environment"]
        assert any(item.startswith("HARNESS_ENGINE_URL=") for item in env)
        assert any(item.startswith("HARNESS_ENGINE_INTERNAL_TOKEN=") for item in env)


def _render(tmp_path: Path, *overrides: str, name: str = "example") -> list[dict]:
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
    for filename in ("harness-engine.yaml", "_helpers.tpl", "_harness.tpl"):
        shutil.copy(source / "templates" / filename, templates / filename)
    shutil.copytree(source / "charts/caipe-ui", chart / "charts/caipe-ui")
    shutil.copytree(source / "files", chart / "files")
    command = ["helm", "template", name, str(chart), "--set", "tags.caipe-ui=true",
               "--set", "global.harnessEngine.enabled=true",
               "--set", "global.harnessEngine.tokenSecret.name=example-token",
               "--set", "harnessEngine.mongodbSecret.name=example-db"]
    for override in overrides:
        command += ["--set", override]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def test_helm_ui_and_engine_share_existing_token_and_database_secret(tmp_path: Path) -> None:
    docs = _render(
        tmp_path,
        "harnessEngine.engine.envFromSecrets[0]=example-provider",
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


@pytest.mark.parametrize("setting", ["harnessEngine.mongodbSecret.name=", "global.harnessEngine.tokenSecret.name="])
def test_helm_requires_explicit_existing_credentials(tmp_path: Path, setting: str) -> None:
    with pytest.raises(subprocess.CalledProcessError):
        _render(tmp_path, setting)


def test_long_release_name_uses_same_engine_service_in_ui(tmp_path: Path) -> None:
    docs = _render(tmp_path, name="example-" + "a" * 45)
    service = next(doc for doc in docs if doc["kind"] == "Service" and doc["spec"].get("selector", {}).get("app.kubernetes.io/component") == "harness-engine")
    ui = next(doc for doc in docs if doc["kind"] == "Deployment" and doc["spec"]["template"]["spec"]["containers"][0]["name"] == "caipe-ui")
    env = {item["name"]: item for item in ui["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["HARNESS_ENGINE_URL"]["value"] == f"http://{service['metadata']['name']}:8010"
    assert len(service["metadata"]["name"]) <= 63


def test_token_is_private_persistent_and_rotates_only_explicitly(tmp_path: Path) -> None:
    initialize = runpy.run_path(str(ROOT / "deploy/harness-engine/init-token.py"))["initialize_token"]
    path = tmp_path / "token"
    initialize(path)
    original = path.read_text()
    assert len(original.strip()) >= 48
    initialize(path)
    assert path.read_text() == original
    with pytest.raises(ValueError):
        initialize(path, "local-development-only")
    with pytest.raises(ValueError):
        initialize(path, "another-private-service-token")
    assert path.read_text() == original
    initialize(path, "another-private-service-token", rotate=True)
    assert path.read_text().strip() == "another-private-service-token"

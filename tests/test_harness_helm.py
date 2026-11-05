"""Render the opt-in runtimes with real Helm, including unsafe configuration denials."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts/ai-platform-engineering"


@pytest.fixture
def chart(tmp_path: Path) -> Path:
    # Keep this fixture independent of downloading unrelated RAG dependencies.
    dest = tmp_path / "chart"
    (dest / "templates").mkdir(parents=True)
    for name in ["_helpers.tpl", "_harness.tpl", "harness-engine.yaml", "harness-network.yaml"]:
        shutil.copyfile(CHART / "templates" / name, dest / "templates" / name)
    shutil.copytree(CHART / "files", dest / "files")
    shutil.copyfile(CHART / "values.yaml", dest / "values.yaml")
    (dest / "Chart.yaml").write_text("apiVersion: v2\nname: example\nversion: 1.0.0\nappVersion: 1.0.0\n")
    return dest


def render(chart: Path, *settings: str, name: str = "example") -> subprocess.CompletedProcess[str]:
    args = ["helm", "template", name, str(chart), "--set", "global.harnessEngine.enabled=true",
            "--set", "global.harnessEngine.tokenSecret.name=example-token",
            "--set", "harnessEngine.mongodbSecret.name=example-database"]
    for value in settings:
        args += ["--set-json" if value.endswith("=[]") else "--set", value]
    return subprocess.run(args, capture_output=True, text=True, check=False)


def docs(result: subprocess.CompletedProcess[str]) -> list[dict]:
    assert result.returncode == 0, result.stderr
    return [d for d in yaml.safe_load_all(result.stdout) if d]


def test_disabled_defaults_create_no_runtime(chart: Path) -> None:
    assert not docs(render(chart, "global.harnessEngine.enabled=false"))


def test_render_is_stable_and_requires_existing_credentials(chart: Path) -> None:
    first = render(chart)
    second = render(chart)
    assert first.stdout == second.stdout
    resources = docs(first)
    assert not any(d["kind"] == "Secret" for d in resources)
    assert {d["kind"] for d in resources} == {"Deployment", "Service", "PersistentVolumeClaim"}


@pytest.mark.parametrize("setting,error", [
    ("global.harnessEngine.tokenSecret.name=", "tokenSecret.name"),
    ("harnessEngine.mongodbSecret.name=", "mongodbSecret.name"),
    ("harnessEngine.engine.persistence.enabled=false", "persistent workspace"),
    ("global.harnessEngine.deepAgentsEnabled=true", "shared with Dynamic Agents"),
])
def test_missing_persistence_or_secrets_fail_render(chart: Path, setting: str, error: str) -> None:
    result = render(chart, setting)
    assert result.returncode != 0
    assert error in result.stderr


def test_long_names_remain_distinct_and_bounded(chart: Path) -> None:
    resources = docs(render(chart, name="example-" + "a" * 45))
    names = {(d["kind"], d["metadata"]["name"]) for d in resources}
    assert len(names) == len(resources)
    assert all(len(n) <= 63 for _, n in names)
    deployment = next(d for d in resources if d["kind"] == "Deployment")
    service = next(d for d in resources if d["kind"] == "Service")
    claim = next(d for d in resources if d["kind"] == "PersistentVolumeClaim")
    assert deployment["metadata"]["name"] == service["metadata"]["name"] == claim["metadata"]["name"]


def test_runtime_hardening_and_existing_workspace(chart: Path) -> None:
    resources = docs(render(chart, "harnessEngine.engine.persistence.existingClaim=example-workspace",
                            "harnessEngine.engine.image.digest=sha256:" + "a" * 64))
    assert not any(d["kind"] == "PersistentVolumeClaim" for d in resources)
    deployment = next(d for d in resources if d["kind"] == "Deployment")
    pod = deployment["spec"]["template"]["spec"]
    container = pod["containers"][0]
    assert deployment["spec"]["strategy"]["type"] == "Recreate"
    assert pod["automountServiceAccountToken"] is False
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert container["securityContext"] == {"readOnlyRootFilesystem": True,
                                           "allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}}
    assert container["image"].endswith("@sha256:" + "a" * 64)
    assert pod["volumes"][0]["persistentVolumeClaim"]["claimName"] == "example-workspace"
    assert container["resources"]["limits"]["memory"]
    env = {e["name"]: e for e in container["env"]}
    assert "valueFrom" in env["HARNESS_ENGINE_INTERNAL_TOKEN"]
    assert env["HARNESS_ENGINE_STORAGE_BACKEND"]["value"] == "mongodb"


@pytest.mark.parametrize("setting,error", [
    ("harnessEngine.egress.enabled=false", "egress.enabled"),
    ("harnessEngine.networkPolicy.enabled=false", "networkPolicy.enabled"),
    ("harnessEngine.networkPolicy.databaseEgress=[]", "databaseEgress"),
    ("harnessEngine.egress.allowedDomains=[]", "allowedDomains"),
    ("harnessEngine.egress.allowedDomains[0]=*.example.com", "exact hostnames"),
])
def test_workers_require_an_explicit_network_boundary(chart: Path, setting: str, error: str) -> None:
    options = ["harnessEngine.workers.sdk.enabled=true",
               "harnessEngine.workers.sdk.tokenSecret.name=example-worker-token"]
    if not setting.startswith("harnessEngine.egress.allowedDomains"):
        options.append("harnessEngine.egress.allowedDomains[0]=model.example.com")
    if not setting.startswith("harnessEngine.networkPolicy.databaseEgress"):
        options.append("harnessEngine.networkPolicy.databaseEgress[0].to[0].ipBlock.cidr=192.0.2.0/24")
        options.append("harnessEngine.networkPolicy.databaseEgress[0].ports[0].port=27017")
    result = render(chart, *options, setting)
    assert result.returncode != 0
    assert error in result.stderr


def test_squid_policy_matches_the_tested_image_policy() -> None:
    assert (CHART / "files/harness-squid.conf").read_bytes() == (ROOT / "deploy/harness-engine/squid.conf").read_bytes()


def test_workers_have_distinct_storage_and_no_direct_external_rule(chart: Path) -> None:
    settings = ["harnessEngine.egress.allowedDomains[0]=model.example.com",
                "harnessEngine.networkPolicy.databaseEgress[0].to[0].ipBlock.cidr=192.0.2.0/24",
                "harnessEngine.networkPolicy.databaseEgress[0].ports[0].port=27017"]
    for worker in ["sdk", "sdk-acp", "cli-acp"]:
        settings += [f"harnessEngine.workers.{worker}.enabled=true",
                     f"harnessEngine.workers.{worker}.tokenSecret.name=example-{worker}-token"]
    resources = docs(render(chart, *settings))
    assert len([d for d in resources if d["kind"] == "PersistentVolumeClaim"]) == 4
    deployments = [d for d in resources if d["kind"] == "Deployment"]
    assert len(deployments) == 5
    for d in deployments:
        if d["spec"]["template"]["metadata"]["labels"].get("caipe.io/harness-worker") == "true":
            env = {e["name"]: e for e in d["spec"]["template"]["spec"]["containers"][0]["env"]}
            assert env["HTTPS_PROXY"]["value"] == "http://example-harness-egress:3128"
            assert env["AWS_EC2_METADATA_DISABLED"]["value"] == "true"
    policy = next(d for d in resources if d["kind"] == "NetworkPolicy" and d["metadata"]["name"].endswith("-workers"))
    assert {p["port"] for rule in policy["spec"]["egress"] for p in rule["ports"]} == {53, 3000, 3128, 27017}

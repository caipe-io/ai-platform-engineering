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
    shutil.copyfile(CHART / "charts/caipe-ui/templates/_helpers.tpl", dest / "templates/_caipe-ui.tpl")
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


def worker_settings() -> list[str]:
    return ["harnessEngine.workers.sdk.enabled=true",
            "harnessEngine.workers.sdk.tokenSecret.name=example-worker-token",
            "harnessEngine.egress.allowedDomains[0]=model.example.com",
            "harnessEngine.networkPolicy.databaseEgress[0].to[0].ipBlock.cidr=192.0.2.0/24",
            "harnessEngine.networkPolicy.databaseEgress[0].ports[0].port=27017"]


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
    resources = docs(render(chart, *worker_settings(), name="example-" + "a" * 45))
    names = {(d["kind"], d["metadata"]["name"]) for d in resources}
    assert len(names) == len(resources)
    assert all(len(n) <= 63 for _, n in names)
    deployments = [d for d in resources if d["kind"] == "Deployment"]
    assert len(deployments) == 3
    for deployment in deployments:
        name = deployment["metadata"]["name"]
        assert ("Service", name) in names
        if deployment["spec"]["template"]["metadata"]["labels"].get("app.kubernetes.io/component") != "harness-egress":
            assert ("PersistentVolumeClaim", name) in names


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
    assert all(rule.get("to") for rule in policy["spec"]["egress"])


@pytest.mark.parametrize("section", ["commonEnv", "engine.env", "engine.secretEnv"])
@pytest.mark.parametrize("key", ["HARNESS_ENGINE_INTERNAL_TOKEN", "HARNESS_ENGINE_MONGODB_URI",
                                 "HARNESS_ENGINE_MONGODB_DATABASE", "HARNESS_ENGINE_STORAGE_BACKEND"])
def test_reserved_environment_cannot_override_dedicated_settings(chart: Path, section: str, key: str) -> None:
    field = f"{key}.name" if section.endswith("secretEnv") else key
    result = render(chart, f"harnessEngine.{section}.{field}=example")
    assert result.returncode != 0
    assert f"{key} must use its dedicated setting" in result.stderr


def test_engine_local_token_setting_is_not_silently_ignored(chart: Path) -> None:
    result = render(chart, "harnessEngine.engine.tokenSecret.name=example")
    assert result.returncode != 0
    assert "Use global.harnessEngine.tokenSecret" in result.stderr


def test_worker_database_rules_cannot_allow_a_port_range(chart: Path) -> None:
    result = render(chart, *worker_settings(),
                    "harnessEngine.networkPolicy.databaseEgress[0].ports[0].endPort=65535")
    assert result.returncode != 0
    assert "must not include an endPort range" in result.stderr


def test_custom_dns_and_bff_routes_follow_the_workloads(chart: Path) -> None:
    resources = docs(render(chart, *worker_settings(), "harnessEngine.networkPolicy.dnsNamespace=example-dns",
                            "harnessEngine.networkPolicy.dnsPodSelector.k8s-app=example-dns",
                            "caipe-ui.nameOverride=example-web", "caipe-ui.fullnameOverride=example-bff",
                            "caipe-ui.service.port=3100"))
    policies = [d for d in resources if d["kind"] == "NetworkPolicy"]
    for policy in policies:
        dns = policy["spec"]["egress"][0]["to"][0]
        assert dns["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] == "example-dns"
        assert dns["podSelector"]["matchLabels"] == {"k8s-app": "example-dns"}
    worker = next(d for d in resources if d["kind"] == "Deployment" and d["metadata"]["name"].endswith("-sdk"))
    env = {e["name"]: e.get("value") for e in worker["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert "example-bff" in env["NO_PROXY"].split(",")
    assert env["NO_PROXY"] == env["no_proxy"]
    rule = next(rule for rule in policies[0]["spec"]["egress"] if rule["ports"] == [{"protocol": "TCP", "port": 3100}])
    assert rule["to"][0]["podSelector"]["matchLabels"]["app.kubernetes.io/name"] == "example-web"


def test_public_proxy_egress_excludes_the_squid_private_ranges(chart: Path) -> None:
    resources = docs(render(chart, *worker_settings()))
    proxy = next(d for d in resources if d["kind"] == "NetworkPolicy" and d["metadata"]["name"].endswith("-egress"))
    rule = proxy["spec"]["egress"][1]
    assert rule["ports"] == [{"protocol": "TCP", "port": 443}]
    assert {p["ipBlock"]["cidr"] for p in rule["to"]} == {"0.0.0.0/0", "::/0"}
    blocked = {cidr for peer in rule["to"] for cidr in peer["ipBlock"]["except"]}
    acl = next(line for line in (CHART / "files/harness-squid.conf").read_text().splitlines()
               if line.startswith("acl private_address dst "))
    assert blocked == set(acl.split()[3:])


@pytest.mark.parametrize("deep", [False, True])
def test_ui_uses_the_same_engine_url_and_secret(tmp_path: Path, deep: bool) -> None:
    ui = tmp_path / "ui"
    shutil.copytree(CHART / "charts/caipe-ui", ui)
    shutil.copyfile(CHART / "templates/_harness.tpl", ui / "templates/_harness.tpl")
    command = ["helm", "template", "example", str(ui), "--set", "global.image.tag=test",
               "--set", "global.agentgateway.enabled=false", "--set", "global.vpa.enabled=false",
               "--set", "oktaSync.enabled=false", "--set", "global.harnessEngine.enabled=true",
               "--set", "global.harnessEngine.tokenSecret.name=example-token",
               "--set", "global.harnessEngine.tokenSecret.key=example-key",
               "--set", f"global.harnessEngine.deepAgentsEnabled={str(deep).lower()}"]
    resources = docs(subprocess.run(command, capture_output=True, text=True, check=False))
    deployment = next(d for d in resources if d["kind"] == "Deployment" and d["metadata"]["name"] == "example-caipe-ui")
    env = {e["name"]: e for e in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["HARNESS_ENGINE_URL"]["value"] == "http://example-harness-engine:8010"
    assert env["HARNESS_ENGINE_INTERNAL_TOKEN"]["valueFrom"]["secretKeyRef"] == {"name": "example-token", "key": "example-key"}
    assert env["HARNESS_ENGINE_DEEP_AGENTS_ENABLED"]["value"] == str(deep).lower()


@pytest.mark.parametrize("target,expected", [(None, "http"), ("dynamic-api", "dynamic-api"), ("8001", 8001)])
def test_compatibility_service_routes_to_its_own_port(tmp_path: Path, target: str | None, expected: str | int) -> None:
    source = CHART / "charts/dynamic-agents"
    (tmp_path / "templates").mkdir()
    for name in ["Chart.yaml", "values.yaml", "templates/_helpers.tpl", "templates/service.yaml"]:
        shutil.copyfile(source / name, tmp_path / name)
    args = ["helm", "template", "example", str(tmp_path),
            "--show-only", "templates/service.yaml"]
    if target is not None:
        args += ["--set", f"service.targetPort={target}"]
    service = docs(subprocess.run(args, capture_output=True, text=True, check=False))[0]
    assert service["spec"]["ports"][0]["targetPort"] == expected

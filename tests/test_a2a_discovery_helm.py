"""Opt-in Kubernetes discovery permissions stay namespace-scoped and read-only."""

import subprocess
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1] / "charts/ai-platform-engineering/charts/dynamic-agents"


def render(*settings: str) -> list[dict]:
    result = subprocess.run(["helm", "template", "example", str(CHART), "--namespace", "primary", "--set-json",
        'global={"image":{"tag":"test"}}', *settings], capture_output=True, text=True, check=True)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def test_discovery_default_does_not_mount_a_cluster_credential_or_grant_permissions():
    docs = render()
    assert not any(doc["kind"] in {"Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"} for doc in docs)
    deployment = next(doc for doc in docs if doc["kind"] == "Deployment")
    assert deployment["spec"]["template"]["spec"]["automountServiceAccountToken"] is False
    assert not any(v["name"] == "a2a-discovery-api" for v in deployment["spec"]["template"]["spec"].get("volumes", []))


def test_discovery_projects_a_short_lived_token_and_grants_only_scoped_lists():
    docs = render("--set", "a2aDiscovery.enabled=true", "--set-json", 'a2aDiscovery.namespaces=["primary","secondary","primary"]')
    roles = [doc for doc in docs if doc["kind"] == "Role"]
    assert len(roles) == 2
    assert {role["metadata"]["namespace"] for role in roles} == {"primary", "secondary"}
    for role in roles:
        assert {resource for rule in role["rules"] for resource in rule["resources"]} == {"services", "endpointslices"}
        assert all(rule["verbs"] == ["list"] for rule in role["rules"])
    assert not any(doc["kind"] in {"ClusterRole", "ClusterRoleBinding"} for doc in docs)
    bindings = [doc for doc in docs if doc["kind"] == "RoleBinding"]
    assert all(binding["subjects"][0]["namespace"] == "primary" for binding in bindings)
    assert all(binding["metadata"]["name"].endswith("-primary-a2a-discovery") for binding in bindings)
    deployment = next(doc for doc in docs if doc["kind"] == "Deployment")
    spec = deployment["spec"]["template"]["spec"]
    assert spec["automountServiceAccountToken"] is False
    projection = next(volume for volume in spec["volumes"] if volume["name"] == "a2a-discovery-api")
    assert projection["projected"]["sources"][0]["serviceAccountToken"]["expirationSeconds"] == 3600
    config = next(doc for doc in docs if doc["kind"] == "ConfigMap")["data"]
    assert config["REMOTE_A2A_DISCOVERY_NAMESPACES"] == '["primary","secondary","primary"]'

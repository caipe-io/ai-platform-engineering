"""Coordinated, opt-in CAS cutover across the gateway and context producers."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1] / "charts" / "ai-platform-engineering"
CAS_VALUES = [
    "global.agentgateway.cas.enabled=true",
    "global.agentgateway.cas.existingSecret.name=example-gateway-auth",
    "global.agentgateway.cas.contextSecret.name=example-execution-context",
    "global.agentgateway.static.jwtAuth.enabled=true",
    "global.agentgateway.static.jwtAuth.issuer=https://issuer.example.test/realms/example",
    "global.agentgateway.static.jwtAuth.jwksUrl=http://example-keycloak:8080/realms/example/protocol/openid-connect/certs",
    "global.agentgateway.static.configBridge.enabled=true",
    "tags.caipe-ui=true",
    "tags.dynamic-agents=true",
]


def render(*values: str) -> subprocess.CompletedProcess[str]:
    if not shutil.which("helm"):
        pytest.skip("Helm is required for chart contract tests")
    command = ["helm", "template", "test", str(CHART)]
    for value in values:
        command.extend(["--set", value])
    return subprocess.run(command, capture_output=True, text=True, check=False)


def container_env(container: dict[str, Any]) -> dict[str, Any]:
    return {entry["name"]: entry for entry in container.get("env", [])}


def test_cas_wires_all_producers_and_keeps_workload_key_out_of_config() -> None:
    result = render(*CAS_VALUES)
    assert result.returncode == 0, result.stderr
    docs = list(yaml.safe_load_all(result.stdout))
    deployments = {doc["metadata"]["name"]: doc["spec"]["template"]["spec"]
                   for doc in docs if doc and doc["kind"] == "Deployment"}
    gateway = deployments["test-agentgateway"]
    containers = {container["name"]: container for container in gateway["containers"]}
    assert container_env(containers["config-bridge"])["CAIPE_GATEWAY_CAS_ENABLED"]["value"] == "true"
    assert container_env(containers["config-bridge"])["CAIPE_GATEWAY_CAS_HOST"]["value"] == "test-caipe-ui:3000"
    assert "CAIPE_GATEWAY_AUTHZ_TOKEN" not in container_env(containers["config-bridge"])
    volume = next(volume for volume in gateway["volumes"] if volume["name"] == "cas-credential")
    assert volume["secret"]["secretName"] == "example-gateway-auth"
    assert volume["secret"]["items"] == [{"key": "CAIPE_GATEWAY_AUTHZ_TOKEN", "path": "token"}]
    for name in ("test-caipe-ui", "test-dynamic-agents"):
        env = container_env(deployments[name]["containers"][0])
        assert env["CAIPE_GATEWAY_CAS_ENABLED"]["value"] == "true"
        assert env["CAIPE_AGENT_CONTEXT_HMAC_SECRET"]["valueFrom"]["secretKeyRef"]["name"] == "example-execution-context"
    ui_env = container_env(deployments["test-caipe-ui"]["containers"][0])
    assert ui_env["CAIPE_GATEWAY_AUTHZ_TOKEN"]["valueFrom"]["secretKeyRef"]["name"] == "example-gateway-auth"
    configmap = next(doc for doc in docs if doc and doc["kind"] == "ConfigMap"
                     and doc["metadata"]["name"] == "test-agentgateway-static-config")
    config = yaml.safe_load(configmap["data"]["config.yaml"])
    assert config["backends"][0]["policies"]["backendAuth"]["key"] == {"file": "/etc/caipe-gateway-auth/token"}
    for route in config["binds"][0]["listeners"][0]["routes"]:
        assert route["policies"]["extAuthz"]["backend"] == "/caipe-cas"
    assert "example-gateway-auth" not in configmap["data"]["config.yaml"]


@pytest.mark.parametrize("override,message", [
    ("global.agentgateway.routingMode=gateway-api", "static routing"),
    ("global.agentgateway.enabled=false", "static routing"),
    ("global.agentgateway.static.jwtAuth.enabled=false", "strict static.jwtAuth"),
    ("global.agentgateway.cas.existingSecret.name=", "cas.existingSecret.name"),
    ("global.agentgateway.cas.contextSecret.name=", "cas.contextSecret.name"),
])
def test_cas_rejects_incomplete_or_unsupported_cutover(override: str, message: str) -> None:
    result = render(*CAS_VALUES, override)
    assert result.returncode != 0
    assert message in result.stderr


def test_cas_off_does_not_inject_new_auth_or_context_settings() -> None:
    result = render("tags.caipe-ui=true", "tags.dynamic-agents=true")
    assert result.returncode == 0, result.stderr
    assert "CAIPE_GATEWAY_CAS_ENABLED" not in result.stdout
    assert "cas-credential" not in result.stdout
    assert "backend: /caipe-cas" not in result.stdout

# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""
Helm template unit tests for readiness/liveness/startup probe configuration.

Runs `helm template` for each subchart and asserts that the rendered
Deployment manifests contain the correct probe types, paths, and thresholds.
No cluster required.
"""

import subprocess
from pathlib import Path
import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CHARTS = REPO_ROOT / "charts"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _helm_template(chart_path: Path, set_values: dict[str, str] | None = None) -> list[dict]:
    """Run helm template and return parsed YAML documents."""
    cmd = ["helm", "template", "test", str(chart_path)]
    for k, v in (set_values or {}).items():
        cmd += ["--set", f"{k}={v}"]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _deployments(docs: list[dict]) -> list[dict]:
    return [d for d in docs if d.get("kind") == "Deployment"]


def _main_container(deployment: dict) -> dict:
    return deployment["spec"]["template"]["spec"]["containers"][0]


def _deployment_named(docs: list[dict], suffix: str) -> dict:
    """Find a deployment whose name ends with the given suffix."""
    for d in _deployments(docs):
        if d["metadata"]["name"].endswith(suffix):
            return d
    raise AssertionError(f"No Deployment with name suffix {suffix!r} found")


# Shorthand probe extractors
def _startup(container: dict) -> dict:
    return container["startupProbe"]

def _liveness(container: dict) -> dict:
    return container["livenessProbe"]

def _readiness(container: dict) -> dict:
    return container["readinessProbe"]


# Common --set flags needed to satisfy subchart templates
_GLOBAL_BASE = {
    "global.vpa.enabled": "false",
    "global.image.tag": "",
}


# ---------------------------------------------------------------------------
# mcp-server subchart (renders one agent's MCP server: Deployment + Service)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def agent_mcp_container():
    docs = _helm_template(
        CHARTS / "ai-platform-engineering/charts/mcp-server",
        {
            **_GLOBAL_BASE,
            "global.mcp.vpa.enabled": "false",
            "mcp.image.repository": "ghcr.io/cnoe-io/mcp-test",
        },
    )
    dep = _deployment_named(docs, "-mcp")
    return _main_container(dep)


class TestMcpServerProbes:
    def test_mcp_startup_uses_tcpsocket(self, agent_mcp_container):
        assert "tcpSocket" in _startup(agent_mcp_container)

    def test_mcp_startup_failure_threshold_is_30(self, agent_mcp_container):
        assert _startup(agent_mcp_container)["failureThreshold"] == 30

    def test_mcp_liveness_uses_tcpsocket(self, agent_mcp_container):
        assert "tcpSocket" in _liveness(agent_mcp_container)

    def test_mcp_readiness_uses_tcpsocket(self, agent_mcp_container):
        assert "tcpSocket" in _readiness(agent_mcp_container)

    def test_mcp_no_httpget(self, agent_mcp_container):
        assert "httpGet" not in _startup(agent_mcp_container)
        assert "httpGet" not in _liveness(agent_mcp_container)
        assert "httpGet" not in _readiness(agent_mcp_container)


# ---------------------------------------------------------------------------
# dynamic-agents subchart
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def dynamic_agents_container():
    docs = _helm_template(
        CHARTS / "ai-platform-engineering/charts/dynamic-agents",
        _GLOBAL_BASE,
    )
    return _main_container(_deployments(docs)[0])


class TestDynamicAgentsProbes:
    def test_startup_path_is_health(self, dynamic_agents_container):
        # startup/liveness use /health (process-only); /healthz checks MongoDB
        assert _startup(dynamic_agents_container)["httpGet"]["path"] == "/health"

    def test_startup_failure_threshold_is_30(self, dynamic_agents_container):
        assert _startup(dynamic_agents_container)["failureThreshold"] == 30

    def test_liveness_path_is_health(self, dynamic_agents_container):
        # liveness must not check dependencies (pod restart cannot fix a down MongoDB)
        assert _liveness(dynamic_agents_container)["httpGet"]["path"] == "/health"

    def test_readiness_path_is_readyz(self, dynamic_agents_container):
        # readiness uses /readyz which checks MongoDB connectivity
        assert _readiness(dynamic_agents_container)["httpGet"]["path"] == "/readyz"

    def test_liveness_and_readiness_use_different_paths(self, dynamic_agents_container):
        liveness_path = _liveness(dynamic_agents_container)["httpGet"]["path"]
        readiness_path = _readiness(dynamic_agents_container)["httpGet"]["path"]
        assert liveness_path != readiness_path


# ---------------------------------------------------------------------------
# caipe-ui subchart
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def caipe_ui_container():
    docs = _helm_template(
        CHARTS / "ai-platform-engineering/charts/caipe-ui",
        _GLOBAL_BASE,
    )
    return _main_container(_deployments(docs)[0])


class TestCaipeUiProbes:
    def test_startup_path_is_api_health(self, caipe_ui_container):
        assert _startup(caipe_ui_container)["httpGet"]["path"] == "/api/health"

    def test_startup_failure_threshold_is_30(self, caipe_ui_container):
        assert _startup(caipe_ui_container)["failureThreshold"] == 30

    def test_liveness_path_is_api_health(self, caipe_ui_container):
        assert _liveness(caipe_ui_container)["httpGet"]["path"] == "/api/health"

    def test_readiness_path_is_api_health(self, caipe_ui_container):
        assert _readiness(caipe_ui_container)["httpGet"]["path"] == "/api/health"


# ---------------------------------------------------------------------------
# autonomous-agents subchart service authentication
# ---------------------------------------------------------------------------

def _env_by_name(container: dict) -> dict[str, dict]:
    return {item["name"]: item for item in container.get("env", [])}


class TestAutonomousAgentsDynamicAgentsAuth:
    def test_umbrella_chart_enables_platform_client_auth(self):
        values = yaml.safe_load((CHARTS / "ai-platform-engineering/values.yaml").read_text())
        auth = values["autonomous-agents"]["dynamicAgentsAuth"]

        assert auth["enabled"] is True
        assert auth["clientId"] == "caipe-platform"
        assert auth["clientSecretRef"] == {
            "name": "caipe-platform-secret",
            "key": "OIDC_CLIENT_SECRET",
        }

    def test_auth_is_opt_in_for_standalone_chart(self):
        docs = _helm_template(CHARTS / "ai-platform-engineering/charts/autonomous-agents")
        container = _main_container(_deployments(docs)[0])
        assert _env_by_name(container) == {}

    def test_auth_uses_default_in_release_token_url_and_secret_ref(self):
        docs = _helm_template(
            CHARTS / "ai-platform-engineering/charts/autonomous-agents",
            {
                "dynamicAgentsAuth.enabled": "true",
                "dynamicAgentsAuth.clientSecretRef.name": "platform-client",
            },
        )
        env = _env_by_name(_main_container(_deployments(docs)[0]))

        assert env["DYNAMIC_AGENTS_OAUTH2_TOKEN_URL"]["value"] == (
            "http://test-keycloak:8080/realms/caipe/protocol/openid-connect/token"
        )
        assert env["DYNAMIC_AGENTS_OAUTH2_CLIENT_ID"]["value"] == "caipe-platform"
        assert env["DYNAMIC_AGENTS_OAUTH2_SCOPE"]["value"] == "openid profile email"
        assert env["DYNAMIC_AGENTS_OAUTH2_CLIENT_SECRET"]["valueFrom"] == {
            "secretKeyRef": {"name": "platform-client", "key": "OIDC_CLIENT_SECRET"}
        }

    def test_auth_supports_external_identity_provider(self):
        docs = _helm_template(
            CHARTS / "ai-platform-engineering/charts/autonomous-agents",
            {
                "dynamicAgentsAuth.enabled": "true",
                "dynamicAgentsAuth.tokenUrl": "https://sso.example.com/oauth/token",
                "dynamicAgentsAuth.clientId": "autonomous-runner",
                "dynamicAgentsAuth.clientSecretRef.name": "autonomous-runner-secret",
                "dynamicAgentsAuth.clientSecretRef.key": "client-secret",
            },
        )
        env = _env_by_name(_main_container(_deployments(docs)[0]))

        assert env["DYNAMIC_AGENTS_OAUTH2_TOKEN_URL"]["value"] == "https://sso.example.com/oauth/token"
        assert env["DYNAMIC_AGENTS_OAUTH2_CLIENT_ID"]["value"] == "autonomous-runner"
        assert env["DYNAMIC_AGENTS_OAUTH2_CLIENT_SECRET"]["valueFrom"] == {
            "secretKeyRef": {"name": "autonomous-runner-secret", "key": "client-secret"}
        }

    def test_client_secret_is_not_rendered_in_configmap(self):
        docs = _helm_template(
            CHARTS / "ai-platform-engineering/charts/autonomous-agents",
            {
                "dynamicAgentsAuth.enabled": "true",
                "dynamicAgentsAuth.clientSecretRef.name": "platform-client",
            },
        )
        configmap = next(doc for doc in docs if doc.get("kind") == "ConfigMap")

        assert "DYNAMIC_AGENTS_OAUTH2_CLIENT_SECRET" not in configmap["data"]


# ---------------------------------------------------------------------------
# rag-server subchart
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def rag_server_container():
    docs = _helm_template(
        CHARTS / "rag-stack/charts/rag-server",
        _GLOBAL_BASE,
    )
    return _main_container(_deployments(docs)[0])


class TestRagServerProbes:
    def test_startup_path_is_health(self, rag_server_container):
        # startup/liveness use /health (process-only); /healthz checks all deps
        assert _startup(rag_server_container)["httpGet"]["path"] == "/health"

    def test_startup_failure_threshold_is_30(self, rag_server_container):
        assert _startup(rag_server_container)["failureThreshold"] == 30

    def test_liveness_path_is_health(self, rag_server_container):
        # liveness must not check deps (pod restart cannot fix a down Milvus/Redis/Neo4j)
        assert _liveness(rag_server_container)["httpGet"]["path"] == "/health"

    def test_readiness_path_is_healthz(self, rag_server_container):
        # readiness uses /healthz which checks all dependency connectivity
        assert _readiness(rag_server_container)["httpGet"]["path"] == "/healthz"


# ---------------------------------------------------------------------------
# agent-ontology subchart
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def agent_ontology_container():
    docs = _helm_template(
        CHARTS / "rag-stack/charts/agent-ontology",
        _GLOBAL_BASE,
    )
    return _main_container(_deployments(docs)[0])


class TestAgentOntologyProbes:
    def test_startup_path_is_status_endpoint(self, agent_ontology_container):
        assert _startup(agent_ontology_container)["httpGet"]["path"] == "/v1/graph/ontology/agent/status"

    def test_startup_failure_threshold_is_30(self, agent_ontology_container):
        assert _startup(agent_ontology_container)["failureThreshold"] == 30

    def test_liveness_path_is_status_endpoint(self, agent_ontology_container):
        assert _liveness(agent_ontology_container)["httpGet"]["path"] == "/v1/graph/ontology/agent/status"

    def test_readiness_path_is_status_endpoint(self, agent_ontology_container):
        assert _readiness(agent_ontology_container)["httpGet"]["path"] == "/v1/graph/ontology/agent/status"

    def test_no_tcpsocket(self, agent_ontology_container):
        assert "tcpSocket" not in _startup(agent_ontology_container)


# ---------------------------------------------------------------------------
# rag-redis subchart
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def rag_redis_container():
    docs = _helm_template(
        CHARTS / "rag-stack/charts/rag-redis",
        {"global.image.tag": ""},
    )
    return _main_container(_deployments(docs)[0])


class TestRagRedisProbes:
    def test_startup_uses_exec(self, rag_redis_container):
        assert "exec" in _startup(rag_redis_container)

    def test_startup_command_is_redis_cli_ping(self, rag_redis_container):
        cmd = _startup(rag_redis_container)["exec"]["command"]
        assert "redis-cli" in cmd
        assert "ping" in cmd

    def test_startup_failure_threshold_is_12(self, rag_redis_container):
        # Redis starts quickly (12×5s = 60s window is sufficient)
        assert _startup(rag_redis_container)["failureThreshold"] == 12

    def test_liveness_uses_exec(self, rag_redis_container):
        assert "exec" in _liveness(rag_redis_container)

    def test_readiness_uses_exec(self, rag_redis_container):
        assert "exec" in _readiness(rag_redis_container)

    def test_no_httpget(self, rag_redis_container):
        assert "httpGet" not in _startup(rag_redis_container)
        assert "httpGet" not in _liveness(rag_redis_container)
        assert "httpGet" not in _readiness(rag_redis_container)


# ---------------------------------------------------------------------------
# skill-scanner subchart
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def skill_scanner_container():
    docs = _helm_template(
        CHARTS / "ai-platform-engineering/charts/skill-scanner",
        _GLOBAL_BASE,
    )
    return _main_container(_deployments(docs)[0])


class TestSkillScannerProbes:
    def test_startup_uses_httpget(self, skill_scanner_container):
        assert "httpGet" in _startup(skill_scanner_container)

    def test_startup_path_is_health(self, skill_scanner_container):
        assert _startup(skill_scanner_container)["httpGet"]["path"] == "/health"

    def test_startup_failure_threshold_is_18(self, skill_scanner_container):
        # 18×10s = 180s startup window
        assert _startup(skill_scanner_container)["failureThreshold"] == 18

    def test_liveness_path_is_health(self, skill_scanner_container):
        assert _liveness(skill_scanner_container)["httpGet"]["path"] == "/health"

    def test_readiness_path_is_health(self, skill_scanner_container):
        assert _readiness(skill_scanner_container)["httpGet"]["path"] == "/health"

    def test_no_tcpsocket(self, skill_scanner_container):
        assert "tcpSocket" not in _startup(skill_scanner_container)
        assert "tcpSocket" not in _liveness(skill_scanner_container)
        assert "tcpSocket" not in _readiness(skill_scanner_container)

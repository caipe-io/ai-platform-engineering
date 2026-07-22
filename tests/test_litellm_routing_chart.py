# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""
Helm template unit tests for the default-off litellm routing subchart.

Runs `helm template` on the subchart and asserts the rendered manifests honour
the routing contract: a proxy-only upstream secret separate from the shared
credential, transparent error passthrough (no retries), and the master key
sourced only from a Secret. No cluster required.
"""

import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
LITELLM_CHART = REPO_ROOT / "charts" / "ai-platform-engineering" / "charts" / "litellm"


def _template(set_values: dict[str, str] | None = None) -> list[dict]:
    cmd = ["helm", "template", "rel", str(LITELLM_CHART)]
    for k, v in (set_values or {}).items():
        cmd += ["--set", f"{k}={v}"]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _kind(docs: list[dict], kind: str) -> list[dict]:
    return [d for d in docs if d.get("kind") == kind]


def _container(docs: list[dict]) -> dict:
    return _kind(docs, "Deployment")[0]["spec"]["template"]["spec"]["containers"][0]


def _proxy_config(docs: list[dict]) -> str:
    return _kind(docs, "ConfigMap")[0]["data"]["config.yaml"]


def _env_from_names(container: dict) -> list[str]:
    return [
        e["secretRef"]["name"]
        for e in container.get("envFrom", [])
        if "secretRef" in e
    ]


class TestUpstreamSecret:
    """The proxy-only upstream secret, separate from the agent-facing credential."""

    def test_default_renders_no_upstream_secret_or_envfrom(self):
        docs = _template()
        assert not [
            s for s in _kind(docs, "Secret")
            if s["metadata"]["name"].endswith("-upstream")
        ]
        assert _env_from_names(_container(docs)) == []

    def test_create_generates_secret_and_references_it(self):
        docs = _template({
            "upstreamSecret.create": "true",
            "upstreamSecret.data.ANTHROPIC_API_KEY": "sk-test",
        })
        secrets = [
            s for s in _kind(docs, "Secret")
            if s["metadata"]["name"] == "rel-litellm-upstream"
        ]
        assert len(secrets) == 1
        assert "ANTHROPIC_API_KEY" in secrets[0]["data"]
        assert "rel-litellm-upstream" in _env_from_names(_container(docs))

    def test_referenced_name_is_used_without_generating_a_secret(self):
        docs = _template({"upstreamSecret.name": "my-upstream"})
        assert "my-upstream" in _env_from_names(_container(docs))
        assert not [
            s for s in _kind(docs, "Secret")
            if s["metadata"]["name"].endswith("-upstream")
        ]


class TestRoutingContract:
    def test_master_key_sourced_only_from_secret(self):
        env = {e["name"]: e for e in _container(_template()).get("env", [])}
        assert "LITELLM_MASTER_KEY" in env
        assert "secretKeyRef" in env["LITELLM_MASTER_KEY"]["valueFrom"]

    def test_config_disables_retries_for_transparent_passthrough(self):
        assert "num_retries: 0" in _proxy_config(_template())

    def test_config_master_key_from_env(self):
        assert "os.environ/LITELLM_MASTER_KEY" in _proxy_config(_template())

    def test_networkpolicy_enabled_by_default(self):
        assert _kind(_template(), "NetworkPolicy"), "expected a NetworkPolicy by default"

    def test_health_probes_present(self):
        container = _container(_template())
        assert container["readinessProbe"]["httpGet"]["path"].startswith("/health")
        assert container["livenessProbe"]["httpGet"]["path"].startswith("/health")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))

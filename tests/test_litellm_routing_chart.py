# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Helm template checks for central LLM routing through upstream LiteLLM."""

import subprocess
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
CHART = REPO_ROOT / "charts" / "ai-platform-engineering"


def _template(*set_values: str) -> list[dict]:
    cmd = [
        "helm",
        "template",
        "routing",
        str(CHART),
        "--set",
        "tags.dynamic-agents=true",
        "--set",
        "tags.mcp-argocd=true",
    ]
    cmd.extend(item for value in set_values for item in ("--set", value))
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _named(docs: list[dict], kind: str, name: str) -> dict:
    return next(
        doc
        for doc in docs
        if doc.get("kind") == kind and doc["metadata"]["name"] == name
    )


def _llm_checksum(docs: list[dict]) -> str:
    deployment = _named(docs, "Deployment", "routing-dynamic-agents")
    return deployment["spec"]["template"]["metadata"]["annotations"]["checksum/llm-config"]


def test_litellm_is_disabled_by_default():
    docs = _template("global.createLlmSecret=true", "global.llmSecrets.data.OPENAI_API_KEY=example")
    assert not any(doc["metadata"]["name"] == "routing-litellm" for doc in docs)
    secret = _named(docs, "Secret", "llm-secret")
    assert "OPENAI_ENDPOINT" not in secret.get("data", {})


def test_upstream_chart_routes_agents_and_uses_shared_secret():
    docs = _template(
        "global.createLlmSecret=true",
        "global.llmSecrets.data.OPENAI_API_KEY=example",
        "global.llmRouting.litellm.enabled=true",
        "litellm.environmentSecrets[0]=provider-credentials",
        "litellm.proxy_config.model_list[0].model_name=gpt-4o",
        "litellm.proxy_config.model_list[0].litellm_params.model=openai/gpt-4o",
        "litellm.proxy_config.model_list[0].litellm_params.api_key="
        "os.environ/UPSTREAM_OPENAI_API_KEY",
    )

    secret = _named(docs, "Secret", "llm-secret")
    assert secret["data"]["LLM_PROVIDER"]
    assert secret["data"]["OPENAI_ENDPOINT"]

    proxy = _named(docs, "Deployment", "routing-litellm")
    container = proxy["spec"]["template"]["spec"]["containers"][0]
    env = {item["name"]: item for item in container["env"]}
    assert env["PROXY_MASTER_KEY"]["valueFrom"]["secretKeyRef"] == {
        "name": "llm-secret",
        "key": "OPENAI_API_KEY",
    }
    assert {item["secretRef"]["name"] for item in container["envFrom"]} >= {
        "provider-credentials"
    }

    agents = _named(docs, "Deployment", "routing-dynamic-agents")
    assert "checksum/llm-config" in agents["spec"]["template"]["metadata"]["annotations"]
    dynamic_env = {
        item["name"]: item.get("value")
        for item in agents["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert dynamic_env["LLM_PROVIDER"] == "openai"
    assert dynamic_env["OPENAI_ENDPOINT"] == "http://routing-litellm:4000/v1"

    mcp = _named(docs, "Deployment", "routing-argocd-mcp")
    mcp_env = {
        item["name"]: item.get("value")
        for item in mcp["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert mcp_env["LLM_PROVIDER"] == "openai"
    assert mcp_env["OPENAI_ENDPOINT"] == "http://routing-litellm:4000/v1"
    policy = _named(docs, "NetworkPolicy", "routing-litellm")
    assert policy["spec"]["podSelector"]["matchLabels"]["app.kubernetes.io/name"] == "litellm"


def test_llm_secret_changes_restart_dynamic_agents():
    before = _template(
        "global.createLlmSecret=true",
        "global.llmSecrets.data.OPENAI_API_KEY=example",
        "global.llmRouting.litellm.enabled=true",
    )
    after = _template(
        "global.createLlmSecret=true",
        "global.llmSecrets.data.OPENAI_API_KEY=example",
        "global.llmSecrets.data.CAIPE_ROUTING_REVISION=changed",
        "global.llmRouting.litellm.enabled=true",
    )
    assert _llm_checksum(before) != _llm_checksum(after)

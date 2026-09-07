"""Helm coverage for declarative CAIPE UI OAuth connectors."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
CHART = REPO_ROOT / "charts" / "ai-platform-engineering" / "charts" / "caipe-ui"


def _render(values: dict) -> subprocess.CompletedProcess[str]:
    base_values = {
        "global": {
            "vpa": {"enabled": False},
            "agentgateway": {"enabled": False},
            "image": {"tag": "test"},
        },
        "oktaSync": {"enabled": False},
    }
    base_values.update(values)
    return subprocess.run(
        ["helm", "template", "oauth-test", str(CHART), "-f", "-"],
        input=yaml.safe_dump(base_values),
        text=True,
        capture_output=True,
        check=False,
    )


def _documents(rendered: str) -> list[dict]:
    return [document for document in yaml.safe_load_all(rendered) if document]


def test_renders_declarative_oauth_connectors_without_secret_values() -> None:
    connector = {
        "provider": "acme",
        "name": "Acme Cloud",
        "clientIdEnv": "ACME_OAUTH_CLIENT_ID",
        "clientSecretEnv": "ACME_OAUTH_CLIENT_SECRET",
        "authorizationUrl": "https://identity.acme.example.com/oauth/authorize",
        "tokenUrl": "https://identity.acme.example.com/oauth/token",
        "scopes": ["projects.read", "projects.write"],
    }
    result = _render(
        {
            "existingSecret": "caipe-ui-secrets",
            "oauthConnectors": [connector],
        }
    )

    assert result.returncode == 0, result.stderr
    documents = _documents(result.stdout)
    config_map = next(
        document
        for document in documents
        if document["kind"] == "ConfigMap"
        and document["metadata"]["name"].endswith("-caipe-ui-config")
    )
    assert json.loads(
        config_map["data"]["CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS_JSON"]
    ) == [connector]
    assert "ACME_OAUTH_CLIENT_SECRET" in result.stdout
    assert "acme-secret-value" not in result.stdout

    deployment = next(document for document in documents if document["kind"] == "Deployment")
    assert {"secretRef": {"name": "caipe-ui-secrets"}} in deployment["spec"]["template"][
        "spec"
    ]["containers"][0]["envFrom"]


def test_rejects_inline_oauth_client_secrets() -> None:
    result = _render(
        {
            "oauthConnectors": [
                {
                    "provider": "acme",
                    "name": "Acme Cloud",
                    "clientId": "acme-client",
                    "clientSecret": "acme-secret-value",
                    "authorizationUrl": "https://identity.acme.example.com/oauth/authorize",
                    "tokenUrl": "https://identity.acme.example.com/oauth/token",
                    "scopes": ["projects.read"],
                }
            ]
        }
    )

    assert result.returncode != 0
    assert ".clientSecret is not allowed" in result.stderr

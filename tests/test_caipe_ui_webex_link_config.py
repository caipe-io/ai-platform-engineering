"""Helm coverage for self-service Webex identity linking config wiring."""

from __future__ import annotations

import subprocess
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
CHART = REPO_ROOT / "charts" / "ai-platform-engineering" / "charts" / "caipe-ui"
EXTERNAL_SECRETS_VALUES = CHART / "values-external-secrets.yaml"


def _render(values: dict, extra_args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
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
        ["helm", "template", "webex-link-test", str(CHART), *(extra_args or []), "-f", "-"],
        input=yaml.safe_dump(base_values),
        text=True,
        capture_output=True,
        check=False,
    )


def _documents(rendered: str) -> list[dict]:
    return [document for document in yaml.safe_load_all(rendered) if document]


def test_webex_link_config_lands_in_configmap_and_deployment() -> None:
    result = _render(
        {
            "config": {
                "WEBEX_LINK_CLIENT_ID": "webex-link-client-id",
                "WEBEX_LINK_REDIRECT_URI": "https://caipe.example.com/api/auth/webex-link/callback",
                "WEBEX_LINK_ALLOWED_ORG_ID": "webex-link-org-id",
            }
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
    assert config_map["data"]["WEBEX_LINK_CLIENT_ID"] == "webex-link-client-id"
    assert (
        config_map["data"]["WEBEX_LINK_REDIRECT_URI"]
        == "https://caipe.example.com/api/auth/webex-link/callback"
    )
    assert config_map["data"]["WEBEX_LINK_ALLOWED_ORG_ID"] == "webex-link-org-id"

    deployment = next(document for document in documents if document["kind"] == "Deployment")
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    assert any(
        env_from.get("configMapRef", {}).get("name", "").endswith("-caipe-ui-config")
        for env_from in container.get("envFrom", [])
    )


def test_webex_link_client_secret_renders_external_secret_data_entry() -> None:
    result = _render(
        {},
        extra_args=["-f", str(EXTERNAL_SECRETS_VALUES), "--set", "externalSecrets.enabled=true"],
    )

    assert result.returncode == 0, result.stderr
    external_secret = next(
        document
        for document in _documents(result.stdout)
        if document["kind"] == "ExternalSecret"
    )
    data_entries = external_secret["spec"]["data"]
    webex_link_secret = next(
        entry for entry in data_entries if entry["secretKey"] == "WEBEX_LINK_CLIENT_SECRET"
    )
    assert webex_link_secret["remoteRef"]["property"] == "WEBEX_LINK_CLIENT_SECRET"

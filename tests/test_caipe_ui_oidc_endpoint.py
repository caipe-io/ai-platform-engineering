"""Render real UI deployment configuration to verify refresh-provider routing."""

import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts/ai-platform-engineering/charts/caipe-ui"


@pytest.mark.parametrize(
    ("overrides", "discovery", "endpoint"),
    [
        ({}, "http://example-keycloak:8080/realms/example", ""),
        (
            {"OIDC_DISCOVERY_URL": "https://identity.example.test/oauth2/default"},
            "https://identity.example.test/oauth2/default",
            "",
        ),
        (
            {"OIDC_DISCOVERY_URL": "http://identity.example.test/realms/secondary"},
            "http://identity.example.test/realms/secondary",
            "",
        ),
        (
            {"OIDC_DISCOVERY_URL": "https://identity.example.test/oauth2/default",
             "OIDC_TOKEN_ENDPOINT": "https://tokens.example.test/custom/token"},
            "https://identity.example.test/oauth2/default",
            "https://tokens.example.test/custom/token",
        ),
    ],
)
def test_refresh_endpoint_preserves_selected_provider(
    overrides: dict[str, str], discovery: str, endpoint: str,
) -> None:
    """An empty override must never replace the selected provider with local Keycloak."""
    if shutil.which("helm") is None:
        pytest.skip("helm is required for UI chart rendering")
    command = ["helm", "template", "example", str(CHART),
               "--set", "global.image.tag=test", "--set", "global.agentgateway.enabled=false",
               "--set", "global.vpa.enabled=false", "--set", "oktaSync.enabled=false",
               "--set-string", "config.KEYCLOAK_REALM=example"]
    for key, value in overrides.items():
        command.extend(["--set-string", f"config.{key}={value}"])
    rendered = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    documents: list[dict[str, Any]] = [doc for doc in yaml.safe_load_all(rendered) if doc]
    deployment = next(doc for doc in documents if doc["kind"] == "Deployment")
    env = {entry["name"]: entry.get("value")
           for entry in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["OIDC_DISCOVERY_URL"] == discovery
    assert env["OIDC_TOKEN_ENDPOINT"] == endpoint

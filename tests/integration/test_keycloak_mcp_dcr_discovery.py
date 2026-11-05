"""Opt-in DCR reconciliation checks using disposable realms on Keycloak 26.8+."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
import requests

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "charts/ai-platform-engineering/charts/keycloak/scripts/mcp-dcr.sh"
)
BASE = os.environ.get("KEYCLOAK_DCR_TEST_BASE_URL", "").rstrip("/")
TOKEN = os.environ.get("KEYCLOAK_DCR_TEST_ADMIN_TOKEN", "")
pytestmark = pytest.mark.skipif(
    not BASE or not TOKEN, reason="Requires an approved disposable-realm Keycloak test target"
)


@pytest.mark.parametrize("existing_scope", [False, True], ids=["new-realm", "existing-scope"])
def test_first_party_scope_is_hidden_but_remains_restricted(existing_scope: bool) -> None:
    realm = f"example-dcr-{uuid4().hex[:12]}"
    headers = {"Authorization": f"Bearer {TOKEN}"}
    admin = f"{BASE}/admin/realms/{realm}"
    response = requests.post(
        f"{BASE}/admin/realms",
        headers=headers,
        json={
            "realm": realm,
            "enabled": True,
            "clients": [{"clientId": name, "enabled": True} for name in ("caipe-ui", "caipe-platform")],
        },
        timeout=20,
    )
    response.raise_for_status()

    def reconcile() -> None:
        result = subprocess.run(
            ["sh", "-c", '. "$DCR_TEST_SCRIPT"; _reconcile_mcp_dynamic_client_registration "$DCR_TEST_AUTH"'],
            env={
                **os.environ,
                "DCR_TEST_SCRIPT": str(SCRIPT),
                "DCR_TEST_AUTH": f"Authorization: Bearer {TOKEN}",
                "KC_URL": BASE,
                "REALM": realm,
                "MCP_DCR_RESOURCE_URL": "https://mcp.example.test/api/mcp",
                "MCP_DCR_PLATFORM_CLIENT_IDS": "caipe-ui,caipe-platform",
            },
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert result.returncode == 0, result.stderr

    try:
        # The fixture isolates scope policy from registration-origin policy.
        components = requests.get(f"{admin}/components", headers=headers, timeout=20).json()
        for component in components:
            if component.get("providerId") == "trusted-hosts" and component.get("subType") == "anonymous":
                requests.delete(
                    f"{admin}/components/{component['id']}", headers=headers, timeout=20
                ).raise_for_status()
        # These identity scopes are part of the CAIPE realm contract.
        scopes = requests.get(f"{admin}/client-scopes", headers=headers, timeout=20).json()
        for name in ("groups", "org"):
            if not any(scope["name"] == name for scope in scopes):
                requests.post(
                    f"{admin}/client-scopes",
                    headers=headers,
                    json={"name": name, "protocol": "openid-connect"},
                    timeout=20,
                ).raise_for_status()
        reconcile()
        scopes = requests.get(f"{admin}/client-scopes", headers=headers, timeout=20).json()
        scope = next(item for item in scopes if item["name"] == "caipe-platform-api")
        url = f"{admin}/client-scopes/{scope['id']}"
        if existing_scope:
            scope["attributes"]["include.in.openid.provider.metadata"] = "true"
            scope["attributes"]["example.setting"] = "preserve"
            requests.put(url, headers=headers, json=scope, timeout=20).raise_for_status()
            reconcile()
        updated = requests.get(url, headers=headers, timeout=20).json()
        assert updated["attributes"]["include.in.openid.provider.metadata"] == "false"
        assert updated["protocolMappers"] == scope["protocolMappers"]
        if existing_scope:
            assert updated["attributes"]["example.setting"] == "preserve"
        metadata = requests.get(
            f"{BASE}/realms/{realm}/.well-known/openid-configuration", timeout=20
        ).json()
        assert "caipe-platform-api" not in metadata["scopes_supported"]
        assert "caipe-mcp-dcr" in metadata["scopes_supported"]
        for client in requests.get(f"{admin}/clients", headers=headers, timeout=20).json():
            if client["clientId"] in ("caipe-ui", "caipe-platform"):
                assigned = requests.get(
                    f"{admin}/clients/{client['id']}/default-client-scopes", headers=headers, timeout=20
                ).json()
                assert any(item["name"] == "caipe-platform-api" for item in assigned)
        for scope_request, expected in [
            ("openid profile caipe-mcp-dcr", 201),
            ("openid caipe-platform-api", 403),
        ]:
            registration = requests.post(
                metadata["registration_endpoint"],
                json={
                    "client_name": "Example DCR validation",
                    "redirect_uris": ["http://127.0.0.1:52818/callback"],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                    "scope": scope_request,
                },
                timeout=20,
            )
            assert registration.status_code == expected, registration.json().get("error_description")
            if expected == 403:
                assert registration.json()["error"] == "insufficient_scope"
    finally:
        requests.delete(admin, headers=headers, timeout=20).raise_for_status()
        assert requests.get(admin, headers=headers, timeout=20).status_code == 404

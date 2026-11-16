# assisted-by Claude:claude-opus-4-7
"""Helm template tests for the production hardening flag
``keycloak.strictClientSecrets``.

When the operator sets ``strictClientSecrets=true`` the chart MUST inject
``KEYCLOAK_STRICT_CLIENT_SECRETS=true`` into all three init-/reconcile-Jobs:

  * ``-init-idp``               (post-install / post-upgrade)
  * ``-auth-reconcile``          (Argo PreSync / Helm pre-upgrade)
  * ``-init-token-exchange``     (post-install / post-upgrade)

When ``strictClientSecrets`` is left at the default (``false``), the env var
MUST NOT appear in any of the three Jobs — that keeps the docker-compose dev
flow and CI matrix runs (which intentionally use dev placeholder secrets)
working unchanged.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
CHART_PATH = REPO_ROOT / "charts" / "ai-platform-engineering" / "charts" / "keycloak"
REALM_CONFIG_PATH = CHART_PATH / "realm-config.json"
INIT_IDP_PATH = CHART_PATH / "scripts" / "init-idp.sh"
INIT_TOKEN_EXCHANGE_PATH = CHART_PATH / "scripts" / "init-token-exchange.sh"
CAIPE_PLATFORM_ADMIN_ROLES = {
    "view-users",
    "query-users",
    "manage-users",
    "query-clients",
    "view-clients",
    "manage-clients",
    "view-authorization",
    "manage-authorization",
}


def _helm_template(*extra_set_args: str) -> list[dict[str, Any]]:
    if shutil.which("helm") is None:
        pytest.fail("helm is required for keycloak chart tests")

    cmd = [
        "helm",
        "template",
        "test",
        str(CHART_PATH),
        # Minimal set of values so all three target Jobs render.
        "--set", "admin.secretRef=caipe-keycloak-admin",
        "--set", "idp.enabled=true",
        "--set", "idp.alias=okta",
        "--set", "idp.displayName=Okta",
        "--set", "idp.issuer=https://idp.example.com",
        "--set", "idp.clientId=okta-client",
        "--set", "idp.secretRef=caipe-keycloak-idp",
        "--set", "tokenExchange.enabled=true",
        "--set", "webexTokenExchange.enabled=true",
    ]
    for arg in extra_set_args:
        cmd.extend(["--set", arg])

    rendered = subprocess.run(cmd, check=True, text=True, capture_output=True).stdout
    return [doc for doc in yaml.safe_load_all(rendered) if doc]


def _find_job(docs: list[dict[str, Any]], suffix: str) -> dict[str, Any]:
    for doc in docs:
        if doc.get("kind") == "Job" and doc.get("metadata", {}).get("name", "").endswith(suffix):
            return doc
    raise AssertionError(f"job ending with {suffix!r} not found")


def _env_value(job: dict[str, Any], name: str) -> str | None:
    env = job["spec"]["template"]["spec"]["containers"][0]["env"]
    for item in env:
        if item.get("name") == name:
            return item.get("value")
    return None


def _env_missing(job: dict[str, Any], name: str) -> bool:
    env = job["spec"]["template"]["spec"]["containers"][0]["env"]
    return all(item.get("name") != name for item in env)


def _realm_config(docs: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    configmap = next(
        doc
        for doc in docs
        if doc.get("kind") == "ConfigMap" and doc["metadata"]["name"].endswith("-realm")
    )
    raw = configmap["data"]["realm-config.json"]
    return raw, json.loads(raw)


# The three Jobs that consume the strict flag.
_TARGET_JOB_SUFFIXES = ("-init-idp", "-auth-reconcile", "-init-token-exchange")


def test_strict_mode_enabled_injects_env_var_into_all_three_jobs() -> None:
    """strictClientSecrets=true must wire KEYCLOAK_STRICT_CLIENT_SECRETS=true
    into init-idp, auth-reconcile, and init-token-exchange Jobs."""
    docs = _helm_template("strictClientSecrets=true")

    for suffix in _TARGET_JOB_SUFFIXES:
        job = _find_job(docs, suffix)
        value = _env_value(job, "KEYCLOAK_STRICT_CLIENT_SECRETS")
        assert value == "true", (
            f"job {suffix!r} must receive KEYCLOAK_STRICT_CLIENT_SECRETS=true; "
            f"got {value!r}"
        )


def test_strict_mode_disabled_omits_env_var() -> None:
    """Default (strictClientSecrets=false) must NOT inject the env var so the
    dev/CI flow that still uses placeholder secrets keeps working."""
    docs = _helm_template()  # No override → uses values.yaml default (false)

    for suffix in _TARGET_JOB_SUFFIXES:
        job = _find_job(docs, suffix)
        assert _env_missing(job, "KEYCLOAK_STRICT_CLIENT_SECRETS"), (
            f"job {suffix!r} must NOT inject KEYCLOAK_STRICT_CLIENT_SECRETS "
            "when strictClientSecrets is left at the default (false)"
        )


def test_strict_mode_explicit_false_omits_env_var() -> None:
    """Explicit ``strictClientSecrets=false`` behaves identically to the
    default — no env var injected — to guard against a future template bug
    that would auto-promote any non-empty value to truthy."""
    docs = _helm_template("strictClientSecrets=false")

    for suffix in _TARGET_JOB_SUFFIXES:
        job = _find_job(docs, suffix)
        assert _env_missing(job, "KEYCLOAK_STRICT_CLIENT_SECRETS"), (
            f"job {suffix!r} must NOT inject KEYCLOAK_STRICT_CLIENT_SECRETS "
            "when strictClientSecrets=false"
        )


def test_realm_import_follows_configured_realm_name() -> None:
    """The Keycloak import JSON must serve the same realm probed by the chart."""
    docs = _helm_template("realm.name=forge")

    raw, realm = _realm_config(docs)

    assert realm["realm"] == "forge"
    assert realm["defaultRole"]["name"] == "default-roles-forge"
    assert "default-roles-caipe" not in raw
    for role in realm["roles"]["realm"]:
        if "containerId" in role:
            assert role["containerId"] == "forge"


def test_realm_config_grants_caipe_platform_admin_client_roles() -> None:
    """Fresh realms must let the BFF migration inspect and repair clients."""
    realm = json.loads(REALM_CONFIG_PATH.read_text())
    service_account = next(
        user
        for user in realm["users"]
        if user.get("serviceAccountClientId") == "caipe-platform"
    )

    roles = set(service_account["clientRoles"]["realm-management"])

    assert CAIPE_PLATFORM_ADMIN_ROLES <= roles


def test_init_idp_reconciles_caipe_platform_admin_client_roles() -> None:
    """Existing realms must be upgraded, not only fresh-imported."""
    script = INIT_IDP_PATH.read_text()

    missing = [role for role in CAIPE_PLATFORM_ADMIN_ROLES if role not in script]

    assert missing == []


def test_init_idp_uses_configured_realm_default_role_name() -> None:
    """Existing realms must patch default-roles-${KC_REALM}, not caipe only."""
    script = INIT_IDP_PATH.read_text()

    assert 'DEFAULT_REALM_ROLE="default-roles-${REALM}"' in script


def test_init_token_exchange_reconciles_webex_impersonation_role() -> None:
    """The privileged init hook must repair Webex before the BFF migration runs."""
    script = INIT_TOKEN_EXCHANGE_PATH.read_text()

    assert 'ensure_service_account_impersonation_role "${WEBEX_BOT_CLIENT_ID}"' in script

"""Regression tests for unconditional Keycloak user-profile reconciliation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
CHART_PATH = REPO_ROOT / "charts" / "ai-platform-engineering" / "charts" / "keycloak"


def _render_with_conditional_reconcilers_disabled(
    *extra_arguments: str,
) -> list[dict[str, Any]]:
    if shutil.which("helm") is None:
        pytest.fail("helm is required for keycloak chart tests")

    rendered = subprocess.run(
        [
            "helm",
            "template",
            "test",
            str(CHART_PATH),
            "--set",
            "admin.secretRef=example-admin",
            "--set",
            "idp.enabled=false",
            "--set",
            "tokenExchange.enabled=false",
            "--set",
            "authReconcile.enabled=false",
            *extra_arguments,
        ],
        check=True,
        text=True,
        capture_output=True,
    ).stdout
    return [document for document in yaml.safe_load_all(rendered) if document]


def test_user_profile_reconcile_job_is_unconditional_and_upgrade_safe() -> None:
    documents = _render_with_conditional_reconcilers_disabled()
    job = next(
        document
        for document in documents
        if document.get("kind") == "Job"
        and document["metadata"]["name"] == "test-keycloak-secondary-auth-profile"
    )

    annotations = job["metadata"]["annotations"]
    assert annotations["helm.sh/hook"] == "post-install,post-upgrade"
    assert annotations["argocd.argoproj.io/hook"] == "PostSync"

    container = job["spec"]["template"]["spec"]["containers"][0]
    assert container["command"] == ["/bin/sh", "/scripts/reconcile-secondary-auth.sh"]
    environment = {item["name"]: item for item in container["env"]}
    assert environment["KC_REALM"]["value"] == "caipe"
    attributes = json.loads(environment["KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON"]["value"])
    assert {attribute["name"] for attribute in attributes} == {"slack_user_id", "webex_user_id"}



def test_user_profile_reconcile_script_is_packaged_and_fail_closed() -> None:
    documents = _render_with_conditional_reconcilers_disabled()
    config_map = next(
        document
        for document in documents
        if document.get("kind") == "ConfigMap"
        and document["metadata"]["name"] == "test-keycloak-init-scripts"
    )
    script = config_map["data"]["reconcile-secondary-auth.sh"]

    assert "/users/profile" in script
    assert 'curl -sf -X PUT' in script
    assert 'exit 1' in script
    assert 'Secondary auth attributes protected successfully.' in script


@pytest.fixture
def profile_reconciler(
    tmp_path: Path,
) -> tuple[Path, dict[str, str]]:
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(
        json.dumps(
            {
                "attributes": [
                    {
                        "name": "existing_attribute",
                        "displayName": "Existing Attribute",
                    }
                ],
                "unmanagedAttributePolicy": "DISABLED",
            }
        )
    )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
profile_path = Path(os.environ["FAKE_PROFILE_PATH"])
if any("/protocol/openid-connect/token" in arg for arg in args):
    encoded = [
        args[index + 1]
        for index, argument in enumerate(args)
        if argument == "--data-urlencode"
    ]
    required = {
        "grant_type=password",
        "client_id=admin-cli",
        f"username={os.environ['EXPECTED_ADMIN_USER']}",
        f"password={os.environ['EXPECTED_ADMIN_PASSWORD']}",
    }
    if not required <= set(encoded):
        sys.exit(22)
    print(json.dumps({"access_token": "admin-token"}))
elif "-X" in args and args[args.index("-X") + 1] == "PUT":
    profile_path.with_suffix(".put").write_text("1")
    profile_path.write_text(args[args.index("-d") + 1])
else:
    print(profile_path.read_text())
"""
    )
    fake_curl.chmod(0o755)

    environment = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "FAKE_PROFILE_PATH": str(profile_path),
        "KEYCLOAK_ADMIN": "admin+user@example.test",
        "KEYCLOAK_ADMIN_PASSWORD": "alpha&beta+gamma%delta",
        "EXPECTED_ADMIN_USER": "admin+user@example.test",
        "EXPECTED_ADMIN_PASSWORD": "alpha&beta+gamma%delta",
    }
    return profile_path, environment


@pytest.mark.parametrize("custom_attributes", [
    [{"name": "example_attribute", "displayName": "Example Attribute"},
     {"name": "caipe_secondary_oidc_identity_key", "permissions": {"view": ["user"], "edit": ["user"]}}],
    {"name": "invalid_object"},
    [{"name": ""}],
    [{"displayName": "Missing name"}],
])
def test_user_profile_reconcile_script_merges_idempotently_with_symbolic_admin_password(
    profile_reconciler: tuple[Path, dict[str, str]],
    custom_attributes: Any,
) -> None:
    profile_path, environment = profile_reconciler
    environment["KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON"] = json.dumps(custom_attributes)
    script = CHART_PATH / "scripts" / "reconcile-secondary-auth.sh"

    if not isinstance(custom_attributes, list) or not custom_attributes[0].get("name"):
        result = subprocess.run(
            ["/bin/sh", str(script)], text=True, capture_output=True, env=environment,
        )
        assert result.returncode != 0
        assert not profile_path.with_suffix(".put").exists()
        assert json.loads(profile_path.read_text())["attributes"] == [
            {"name": "existing_attribute", "displayName": "Existing Attribute"}
        ]
        return

    for _ in range(2):
        subprocess.run(
            ["/bin/sh", str(script)],
            check=True,
            text=True,
            capture_output=True,
            env=environment,
        )

    reconciled = json.loads(profile_path.read_text())
    names = [attribute["name"] for attribute in reconciled["attributes"]]
    assert names.count("existing_attribute") == 1
    assert names.count("caipe_secondary_oidc_identity_key") == 1
    assert names.count("example_attribute") == 1
    by_name = {attribute["name"]: attribute for attribute in reconciled["attributes"]}
    assert by_name["example_attribute"]["displayName"] == "Example Attribute"
    assert reconciled["unmanagedAttributePolicy"] == "DISABLED"
    for attribute in reconciled["attributes"]:
        if attribute["name"].startswith("caipe_secondary_oidc_"):
            assert attribute["permissions"] == {"view": ["admin"], "edit": ["admin"]}
    assert len([name for name in names if name.startswith("caipe_secondary_oidc_")]) == 6


@pytest.mark.parametrize("custom_attributes", [{}, False, 0, ""])
def test_rendered_non_list_custom_attributes_fail_before_put(
    profile_reconciler: tuple[Path, dict[str, str]],
    custom_attributes: Any,
) -> None:
    documents = _render_with_conditional_reconcilers_disabled(
        "--set-json", f"userProfile.customAttributes={json.dumps(custom_attributes)}",
    )
    job = next(
        document for document in documents
        if document.get("kind") == "Job"
        and document["metadata"]["name"] == "test-keycloak-secondary-auth-profile"
    )
    environment = {
        item["name"]: item for item in job["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    rendered = environment["KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON"]["value"]
    assert json.loads(rendered) == custom_attributes

    profile_path, script_environment = profile_reconciler
    original_profile = profile_path.read_text()
    script_environment["KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON"] = rendered
    result = subprocess.run(
        ["/bin/sh", str(CHART_PATH / "scripts" / "reconcile-secondary-auth.sh")],
        text=True, capture_output=True, env=script_environment,
    )
    assert result.returncode != 0
    assert not profile_path.with_suffix(".put").exists()
    assert profile_path.read_text() == original_profile


@pytest.mark.parametrize("custom_attributes", [None, []])
def test_rendered_null_and_empty_custom_attributes_use_empty_array(
    custom_attributes: Any,
) -> None:
    documents = _render_with_conditional_reconcilers_disabled(
        "--set-json", f"userProfile.customAttributes={json.dumps(custom_attributes)}",
    )
    job = next(
        document for document in documents
        if document.get("kind") == "Job"
        and document["metadata"]["name"] == "test-keycloak-secondary-auth-profile"
    )
    environment = {
        item["name"]: item for item in job["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert json.loads(environment["KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON"]["value"]) == []


def test_empty_custom_attributes_preserve_profile_and_protect_secondary_identity(
    profile_reconciler: tuple[Path, dict[str, str]],
) -> None:
    profile_path, environment = profile_reconciler
    environment["KEYCLOAK_USER_PROFILE_ATTRIBUTES_JSON"] = "[]"
    for _ in range(2):
        subprocess.run(
            ["/bin/sh", str(CHART_PATH / "scripts" / "reconcile-secondary-auth.sh")],
            check=True, text=True, capture_output=True, env=environment,
        )

    reconciled = json.loads(profile_path.read_text())
    attributes = {attribute["name"]: attribute for attribute in reconciled["attributes"]}
    assert attributes["existing_attribute"] == {
        "name": "existing_attribute", "displayName": "Existing Attribute",
    }
    protected = [attribute for name, attribute in attributes.items() if name.startswith("caipe_secondary_oidc_")]
    assert len(protected) == 6
    assert len(reconciled["attributes"]) == len(attributes) == 7
    assert all(attribute["permissions"] == {"view": ["admin"], "edit": ["admin"]} for attribute in protected)
    assert reconciled["unmanagedAttributePolicy"] == "DISABLED"

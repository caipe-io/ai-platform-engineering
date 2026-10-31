"""Unit tests for `scripts/validate-rbac-matrix.py` (T012).

Spec 102, Phase 2. We test the linter the way it will run in CI: as a subprocess
that exits non-zero on drift. Each test points the linter at a temporary tree
that mimics the repository layout (a `ui/src/app/api/.../route.ts` file and a
`tests/rbac/rbac-matrix.yaml`) and asserts the expected exit code + stderr.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT = REPO_ROOT / "scripts" / "validate-rbac-matrix.py"

# Empty realm-config.json with the bare-minimum shape so the validator's
# realm-resource cross-check can run without aborting.
_REALM_CONFIG = {
    "clients": [
        {
            "clientId": "caipe-test",
            "authorizationSettings": {
                "resources": [
                    {"name": "admin_ui", "scopes": [{"name": "view"}, {"name": "manage"}]},
                ]
            },
        }
    ],
    "roles": {"realm": [{"name": "admin"}]},
}

# Six-persona expectations block, used as a building block by every fixture.
_OK_EXPECTATIONS = {
    "alice_admin": {"status": 200},
    "bob_chat_user": {"status": 403, "reason": "DENY_NO_CAPABILITY"},
    "carol_kb_ingestor": {"status": 403, "reason": "DENY_NO_CAPABILITY"},
    "dave_no_role": {"status": 403, "reason": "DENY_NO_CAPABILITY"},
    "eve_dynamic_agent_user": {"status": 403, "reason": "DENY_NO_CAPABILITY"},
    "frank_service_account": {"status": 403, "reason": "DENY_NO_CAPABILITY"},
}


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """Build a synthetic repo tree the validator can scan."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / "validate-rbac-matrix.py")

    (tmp_path / "tests" / "rbac").mkdir(parents=True)

    (tmp_path / "deploy" / "keycloak").mkdir(parents=True)
    (tmp_path / "deploy" / "keycloak" / "realm-config.json").write_text(json.dumps(_REALM_CONFIG))

    routes_dir = tmp_path / "ui" / "src" / "app" / "api" / "admin" / "users"
    routes_dir.mkdir(parents=True)
    (routes_dir / "route.ts").write_text(
        textwrap.dedent(
            """
            import { requireRbacPermission } from "@/lib/rbac/keycloak-authz";

            export async function GET(req) {
              const auth = await requireRbacPermission(req, "admin_ui", "view");
              return new Response(JSON.stringify({ ok: auth.allowed }));
            }
            """
        )
    )

    return tmp_path


def _write_matrix(repo: Path, body: dict) -> None:
    import yaml  # PyYAML is a transitive dep we install in the repo env

    (repo / "tests" / "rbac" / "rbac-matrix.yaml").write_text(yaml.safe_dump(body, sort_keys=False))


def _run(repo: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / "validate-rbac-matrix.py")],
        capture_output=True,
        text=True,
        cwd=str(repo),
        check=False,
    )


def test_lint_passes_when_matrix_matches_call_site(fake_repo: Path) -> None:
    _write_matrix(
        fake_repo,
        {
            "version": 1,
            "routes": [
                {
                    "id": "admin-users-list",
                    "surface": "ui_bff",
                    "method": "GET",
                    "path": "/api/admin/users",
                    "resource": "admin_ui",
                    "scope": "view",
                    "expectations": _OK_EXPECTATIONS,
                }
            ],
        },
    )
    result = _run(fake_repo)
    assert result.returncode == 0, f"expected pass, got:\n{result.stdout}\n{result.stderr}"


def test_lint_fails_when_call_site_has_no_matrix_entry(fake_repo: Path) -> None:
    """T061 — Linter smoke test (validates SC-006).

    Point the validator at a fixture route directory containing a route with
    no matrix entry. The validator MUST exit non-zero AND its stderr MUST
    name the offending route path so a developer can find it in seconds
    without running additional commands. This is the exact failure mode
    spec 102 §SC-006 requires us to catch in CI.
    """
    _write_matrix(fake_repo, {"version": 1, "routes": []})
    result = _run(fake_repo)
    assert result.returncode == 1, (
        "expected non-zero exit when a call site has no matrix entry"
    )
    assert "missing_in_matrix" in result.stderr, (
        "stderr must classify the violation as missing_in_matrix"
    )
    assert "admin_ui" in result.stderr and "view" in result.stderr, (
        "stderr must name the (resource, scope) pair"
    )
    assert "ui/src/app/api/admin/users/route.ts" in result.stderr, (
        "stderr must name the offending route path so devs can locate it"
    )


@pytest.mark.parametrize("shared_helper", [False, True])
@pytest.mark.parametrize(
    ("handler_method", "declared_method", "passes"),
    [("GET", "GET", True), ("POST", "POST", True), ("GET", "POST", False)],
)
def test_openfga_gate_matches_its_handler_method(
    fake_repo: Path, handler_method: str, declared_method: str, passes: bool, shared_helper: bool,
) -> None:
    route = fake_repo / "ui/src/app/api/admin/users/route.ts"
    gate = "await requireAgentUsePermission({ subject: 'test-user' });"
    helper = f"async function authorize() {{ {gate} }}\n" if shared_helper else ""
    body = "await authorize();" if shared_helper else gate
    route.write_text(helper + f"export async function {handler_method}(request) {{ {body} }}")
    _write_matrix(fake_repo, {
        "version": 1,
        "routes": [{
            "id": "example-agent-use",
            "surface": "ui_bff",
            "method": declared_method,
            "path": "/api/admin/users",
            "resource": "agent",
            "scope": "use",
            "authorization_system": "openfga",
            "relation": "can_use",
            "object_type": "agent",
            "expectations": _OK_EXPECTATIONS,
        }],
    })
    result = _run(fake_repo)
    assert (result.returncode == 0) is passes, result.stdout + result.stderr
    if not passes:
        assert f"gate on {handler_method} /api/admin/users" in result.stderr


def test_lint_fails_when_matrix_omits_a_persona(fake_repo: Path) -> None:
    bad = dict(_OK_EXPECTATIONS)
    bad.pop("dave_no_role")
    _write_matrix(
        fake_repo,
        {
            "version": 1,
            "routes": [
                {
                    "id": "admin-users-list",
                    "surface": "ui_bff",
                    "method": "GET",
                    "path": "/api/admin/users",
                    "resource": "admin_ui",
                    "scope": "view",
                    "expectations": bad,
                }
            ],
        },
    )
    result = _run(fake_repo)
    assert result.returncode == 1
    assert "missing_persona" in result.stderr
    assert "dave_no_role" in result.stderr


def test_lint_fails_when_resource_unknown_to_realm(fake_repo: Path) -> None:
    _write_matrix(
        fake_repo,
        {
            "version": 1,
            "routes": [
                {
                    "id": "admin-users-list",
                    "surface": "ui_bff",
                    "method": "GET",
                    "path": "/api/admin/users",
                    "resource": "admin_ui",
                    "scope": "view",
                    "expectations": _OK_EXPECTATIONS,
                },
                {
                    "id": "phantom-route",
                    "surface": "ui_bff",
                    "method": "GET",
                    "path": "/api/phantom",
                    "resource": "totally_made_up",
                    "scope": "view",
                    "expectations": _OK_EXPECTATIONS,
                },
            ],
        },
    )
    # The phantom call site is NOT in any TS file, so missing_in_matrix won't
    # fire — but the unknown_resource check should.
    result = _run(fake_repo)
    assert result.returncode == 1
    assert "unknown_resource" in result.stderr
    assert "totally_made_up" in result.stderr


def test_lint_fails_when_matrix_version_wrong(fake_repo: Path) -> None:
    _write_matrix(
        fake_repo,
        {
            "version": 2,
            "routes": [
                {
                    "id": "admin-users-list",
                    "surface": "ui_bff",
                    "method": "GET",
                    "path": "/api/admin/users",
                    "resource": "admin_ui",
                    "scope": "view",
                    "expectations": _OK_EXPECTATIONS,
                }
            ],
        },
    )
    result = _run(fake_repo)
    assert result.returncode == 1
    assert "schema" in result.stderr
    assert "version must be 1" in result.stderr

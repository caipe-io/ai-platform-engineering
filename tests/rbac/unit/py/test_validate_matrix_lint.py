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


def _gate_matrix(repo: Path, method: str | None) -> dict:
    entries = [{
        "id": "admin-users-list", "surface": "ui_bff", "method": "GET", "path": "/api/admin/users",
        "resource": "admin_ui", "scope": "view", "expectations": _OK_EXPECTATIONS,
    }]
    if method is not None:
        entries.append({
            "id": "example-agent-use", "surface": "ui_bff", "method": method, "path": "/api/example",
            "authorization_system": "openfga", "resource": "agent", "scope": "use",
            "object_type": "agent", "relation": "can_use", "expectations": _OK_EXPECTATIONS,
        })
    matrix = {"version": 1, "routes": entries}
    _write_matrix(repo, matrix)
    return matrix


def _example_route(repo: Path, source: str) -> Path:
    directory = repo / "ui" / "src" / "app" / "api" / "example"
    directory.mkdir(parents=True)
    (directory / "route.ts").write_text(source)
    return directory


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_openfga_inventory_uses_the_exported_handler_method(fake_repo: Path, method: str) -> None:
    _example_route(fake_repo, f"export async function {method}(request) {{ await requireAgentUsePermission(request); }}")
    _gate_matrix(fake_repo, method)
    result = _run(fake_repo)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("method,declared", [("GET", "POST"), ("POST", "GET")])
def test_another_http_method_cannot_satisfy_an_openfga_gate(fake_repo: Path, method: str, declared: str) -> None:
    _example_route(fake_repo, f"export async function {method}(request) {{ await requireAgentUsePermission(request); }}")
    _gate_matrix(fake_repo, declared)
    result = _run(fake_repo)
    assert result.returncode == 1 and f"gate on {method} /api/example" in result.stderr


def test_called_shared_reader_helper_is_attributed_to_its_get_handler(fake_repo: Path) -> None:
    directory = _example_route(fake_repo, '''
        import { authorizeRunReadRequest as authorizeRead } from "./_authorization";
        export async function GET(request) { return await authorizeRead(request); }
    ''')
    (directory / "_authorization.ts").write_text('''
        export async function authorizeRunReadRequest(request) {
            return await requireAgentUsePermission(request);
        }
    ''')
    _gate_matrix(fake_repo, "GET")
    result = _run(fake_repo)
    assert result.returncode == 0, result.stderr
    _gate_matrix(fake_repo, "POST")
    result = _run(fake_repo)
    assert result.returncode == 1 and "gate on GET /api/example" in result.stderr


def test_an_unused_helper_gate_is_not_assigned_to_an_ungated_get(fake_repo: Path) -> None:
    directory = _example_route(fake_repo, '''
        import { readPublic, authorizePrivate } from "./_authorization";
        export async function GET(request) { return await readPublic(request); }
    ''')
    (directory / "_authorization.ts").write_text('''
        export async function readPublic(request) { return new Response("public"); }
        export async function authorizePrivate(request) { return await requireAgentUsePermission(request); }
    ''')
    _gate_matrix(fake_repo, None)
    result = _run(fake_repo)
    assert result.returncode == 0, result.stderr


def test_a_post_gate_does_not_invent_a_gate_for_another_exported_method(fake_repo: Path) -> None:
    _example_route(fake_repo, '''
        export async function GET(request) { return new Response("public"); }
        export const POST = async (request) => { return await requireAgentUsePermission(request); };
    ''')
    _gate_matrix(fake_repo, "POST")
    result = _run(fake_repo)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("relation,status", [("can_write", 0), ("can_use", 1)])
def test_conversation_write_matrix_gate_has_its_own_approved_relation(fake_repo: Path, relation: str, status: int) -> None:
    matrix = _gate_matrix(fake_repo, None)
    matrix["routes"].append({
        "id": "example-stop", "surface": "ui_bff", "method": "POST", "path": "/api/example/stop",
        "authorization_system": "openfga", "resource": "conversation", "scope": "write",
        "object_type": "conversation", "relation": relation, "expectations": _OK_EXPECTATIONS,
    })
    _write_matrix(fake_repo, matrix)
    result = _run(fake_repo)
    assert result.returncode == status, result.stderr

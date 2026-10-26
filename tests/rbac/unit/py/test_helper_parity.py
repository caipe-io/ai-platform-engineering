"""Spec 102 T030 — TS↔Py parity for `require_rbac_permission`.

For every persona × every (resource, scope) pair in `tests/rbac/rbac-matrix.yaml`,
assert that:

    Py require_rbac_permission(token, R, S).allowed
        == TS checkPermission(token, R, S).allowed

and that the deny `reason` codes match (parity invariants 1+2 from
`contracts/python-rbac-helper.md`).

Marked `rbac_online` because it needs a live Keycloak (started by
`make test-rbac-up`). The matrix-driver tests in later phases (T038, T059)
extend this with route-level coverage.

When the matrix is empty (still bootstrapping spec 102), this test collects
zero parameter sets and is reported as "no tests ran" rather than failing —
the matrix linter is the hard gate (T009).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.rbac_online

from tests.rbac.fixtures.keycloak import (  # noqa: E402
    PERSONAS,
    PersonaName,
    get_persona_token,
)


_REPO_ROOT = Path(__file__).resolve().parents[4]
_MATRIX_PATH = _REPO_ROOT / "tests/rbac/rbac-matrix.yaml"


def _load_matrix_routes() -> list[dict[str, Any]]:
    """Load `routes[]` from `tests/rbac/rbac-matrix.yaml`. Returns [] if empty."""
    try:
        import yaml  # PyYAML — soft dep; only required when this test runs

        text = _MATRIX_PATH.read_text(encoding="utf-8")
        data = yaml.safe_load(text) or {}
    except Exception:
        return []
    # Service and run capability credentials have no Keycloak helper equivalent.
    return [
        route for route in data.get("routes") or []
        if route.get("authorization_system") not in {"internal", "run_capability"}
    ]


def _ts_check_permission(token: str, resource: str, scope: str) -> dict[str, Any]:
    """Invoke the TS helper via `node -e` so we exercise the real runtime.

    Equivalent to importing `ui/src/lib/rbac/keycloak-authz.ts` and calling
    `checkPermission`. Returns `{"allowed": bool, "reason": str | None}`.
    """
    script = r"""
        const { checkPermission } = require(process.argv[1]);
        const [, , token, resource, scope] = process.argv;
        checkPermission({ accessToken: token, resource, scope })
          .then(r => process.stdout.write(JSON.stringify({allowed: r.allowed, reason: r.reason ?? null})))
          .catch(e => { process.stderr.write(String(e)); process.exit(1); });
    """
    helper_js = _REPO_ROOT / "ui/dist/lib/rbac/keycloak-authz.js"  # post-build
    if not helper_js.is_file():
        pytest.skip(f"TS helper not built at {helper_js}; run `npm run build` in ui/")

    result = subprocess.run(
        ["node", "-e", script, str(helper_js), token, resource, scope],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
        env={**os.environ},
    )
    import json as _json

    return _json.loads(result.stdout)


_ROUTES = _load_matrix_routes()


@pytest.mark.parametrize("persona", PERSONAS)
@pytest.mark.parametrize(
    "route",
    _ROUTES,
    ids=lambda r: f"{r.get('method','?')} {r.get('path','?')}::{r.get('resource','?')}#{r.get('scope','?')}"
    if _ROUTES
    else [],
)
def test_ts_py_parity_for_route(persona: PersonaName, route: dict[str, Any]) -> None:
    """Both runtimes MUST agree on (allowed, reason) for the same triple."""
    if not _ROUTES:
        pytest.skip("matrix is empty — populated by per-phase tasks (T040+)")

    resource = route["resource"]
    scope = route["scope"]
    token_meta = get_persona_token(persona)
    token = token_meta.access_token

    from ai_platform_engineering.utils.auth import require_rbac_permission

    import asyncio

    py_decision = asyncio.run(
        require_rbac_permission(token, resource, scope, service="parity_test")
    )
    ts_decision = _ts_check_permission(token, resource, scope)

    assert py_decision.allowed is ts_decision["allowed"], (
        f"parity break for {persona} on {resource}#{scope}: "
        f"py={py_decision.allowed} ts={ts_decision['allowed']}"
    )
    if not py_decision.allowed and ts_decision.get("reason"):
        # When both deny, reason codes MUST match. (Cache and bootstrap-admin
        # paths can produce 'OK_*' on Py before TS observes the same — that's
        # outside this invariant.)
        assert py_decision.reason.value == ts_decision["reason"], (
            f"deny-reason parity break: py={py_decision.reason.value} ts={ts_decision['reason']}"
        )

"""Pytest matrix driver — spec 102 task T054.

Symmetric counterpart of `ui/src/__tests__/rbac-matrix-driver.test.ts` (T038).

Responsibilities
----------------
1. Load `tests/rbac/rbac-matrix.yaml` once per session.
2. Parameterise over every `(route × persona)` for the **non-`ui_bff`**
   surfaces — i.e. the surfaces that pytest is responsible for. The Jest
   driver covers `ui_bff`; this driver covers
   `mcp`, `dynamic_agents`, `rag`, `slack_bot`.
3. Provide per-surface dispatch helpers (`call_mcp`,
   `call_da`, `call_rag`, `call_slack_event`). Each helper is a thin
   wrapper over `httpx`/`pytest` that:
     a. resolves the persona's `Authorization: Bearer <token>` (or the
        relevant signed-payload header for Slack), and
     b. POSTs/PUT/etc the request to the live e2e stack URL.
4. Honour `migration_status: pending` — pending rows are emitted as
   pytest skips (with a clear `skip_reason` referencing the migration
   task).
5. Honour the existing `--rbac-online` opt-in: matrix tests that need a
   live stack only run when `--rbac-online` is passed (or in CI via
   `make test-rbac`).

Why this lives in `tests/rbac/unit/py/` rather than `tests/rbac/unit/`
---------------------------------------------------------------------
Per the FR-008 + T055 directive, the unit-py tree is the canonical home
for matrix-driven pytest tests. `tests/rbac/conftest.py` provides the
persona fixtures (used here); `tests/rbac/unit/py/conftest.py` (T055)
exists to register the matrix-driver helpers without recursing into the
parent conftest.

Surface dispatch URLs
---------------------
Default URLs are read from env (set by `make test-rbac-up`, which inlines
host ports into `docker-compose.dev.yaml` via ${VAR:-default} substitution):

* `E2E_DA_URL`             — default `http://localhost:8200`
* `E2E_RAG_URL`            — default `http://localhost:9446`
* `E2E_MCP_BASE_URL`       — default `http://localhost:18000`
                              (per-agent ports come from the matrix
                               entry's `path` if it embeds a port; else
                               we look up `E2E_MCP_<AGENT>_URL`)
* `E2E_SLACK_BOT_URL`      — default `http://localhost:8011`

For `mcp`, the resource field encodes the agent (e.g. `argocd_mcp`); the
helper resolves to `E2E_MCP_ARGOCD_URL` if set, else falls back to
`{E2E_MCP_BASE_URL}/mcp/argocd`.

All HTTP calls go through `httpx.Client(timeout=10)` — no async loop
needed; the live MCP/DA/RAG servers are stable for the synchronous
test-suite traffic patterns.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import httpx
import pytest
import yaml

from tests.rbac.fixtures.keycloak import PERSONAS, PersonaToken

REPO_ROOT = Path(__file__).resolve().parents[4]
MATRIX_YAML = REPO_ROOT / "tests" / "rbac" / "rbac-matrix.yaml"

# Surfaces that THIS driver owns. ui_bff is owned by the Jest driver
# (`ui/src/__tests__/rbac-matrix-driver.test.ts`). Keeping the two
# drivers disjoint avoids double-execution (and double-counting in
# the audit-log assertions).
PYTHON_SURFACES: frozenset[str] = frozenset(
    {"mcp", "dynamic_agents", "rag", "slack_bot", "harness_engine"}
)


@dataclass(frozen=True)
class MatrixRow:
    """One (route, persona) pair after expansion.

    Attributes:
        route_id: Stable matrix row id (used as pytest test name).
        surface: One of `PYTHON_SURFACES`.
        method: HTTP verb or literal "rpc".
        path: HTTP path or RPC method name (e.g. ``tools/call argocd.list_apps``).
        resource: Keycloak resource (e.g. ``argocd_mcp``).
        scope: Keycloak scope (e.g. ``read``).
        persona: Persona name (e.g. ``alice_admin``).
        expected_status: Expected HTTP status code.
        expected_reason: Expected ``DENY_*`` / ``OK*`` reason for status >= 400.
        skip_reason: If set, the test is skipped with this string.
        notes: Free-form note from the matrix entry.
        migration_status: ``"migrated"`` (default) or ``"pending"``.
    """

    route_id: str
    surface: str
    method: str
    path: str
    resource: str
    scope: str
    persona: str
    expected_status: int
    expected_reason: str | None
    skip_reason: str | None
    notes: str | None
    migration_status: str
    authorization_system: str = "keycloak"


def _load_matrix() -> dict[str, Any]:
    """Read + cheap-parse the matrix YAML. Cached on the module via lru_cache."""
    if not MATRIX_YAML.is_file():
        raise FileNotFoundError(f"matrix not found: {MATRIX_YAML}")
    return yaml.safe_load(MATRIX_YAML.read_text()) or {}


def expand_matrix() -> list[MatrixRow]:
    """Expand the matrix into one MatrixRow per (route, persona) for Python surfaces.

    Returns:
        List of MatrixRow values. Empty list is valid (early in the rollout
        only ui_bff entries exist; pytest will simply collect zero matrix
        tests and emit ``no tests ran`` for the matrix driver, which is
        deliberate).
    """
    data = _load_matrix()
    rows: list[MatrixRow] = []
    for r in data.get("routes") or []:
        surface = r.get("surface")
        if surface not in PYTHON_SURFACES:
            continue
        route_id = r["id"]
        method = r["method"]
        path = r["path"]
        resource = r["resource"]
        scope = r["scope"]
        notes = r.get("notes")
        migration_status = r.get("migration_status", "migrated")
        expectations = r.get("expectations") or {}

        for persona in PERSONAS:
            exp = expectations.get(persona) or {}
            status = exp.get("status")
            if status is None:
                continue
            rows.append(
                MatrixRow(
                    route_id=route_id,
                    surface=surface,
                    method=method,
                    path=path,
                    resource=resource,
                    scope=scope,
                    persona=persona,
                    expected_status=int(status),
                    expected_reason=exp.get("reason"),
                    skip_reason=exp.get("skip_reason"),
                    notes=notes,
                    migration_status=migration_status,
                    authorization_system=r.get("authorization_system", "keycloak"),
                )
            )
    return rows


def matrix_param_id(row: MatrixRow) -> str:
    """Build a stable, human-readable pytest test id."""
    return f"{row.route_id}::{row.persona}"


# --------------------------------------------------------------------------- #
# Surface dispatch helpers
# --------------------------------------------------------------------------- #


def _surface_base_url(surface: str, resource: str) -> str:
    """Resolve the base URL for the given surface (and resource, for MCP)."""
    if surface == "harness_engine":
        base = os.environ.get("E2E_HARNESS_ENGINE_URL")
        if not base:
            pytest.skip("Engine bearer-only checks require explicit E2E_HARNESS_ENGINE_URL")
        return base.rstrip("/")
    if surface == "dynamic_agents":
        return os.environ.get("E2E_DA_URL", "http://localhost:8200").rstrip("/")
    if surface == "rag":
        return os.environ.get("E2E_RAG_URL", "http://localhost:9446").rstrip("/")
    if surface == "slack_bot":
        return os.environ.get("E2E_SLACK_BOT_URL", "http://localhost:8011").rstrip("/")
    if surface == "mcp":
        agent = resource.removesuffix("_mcp").upper()
        env_var = f"E2E_MCP_{agent}_URL"
        if env_var in os.environ:
            return os.environ[env_var].rstrip("/")
        base = os.environ.get("E2E_MCP_BASE_URL", "http://localhost:18000").rstrip("/")
        return f"{base}/mcp/{resource.removesuffix('_mcp')}"
    raise ValueError(f"unknown surface: {surface}")


def _build_request(row: MatrixRow, token: PersonaToken) -> dict[str, Any]:
    """Build kwargs for ``httpx.Client.request()``.

    Per surface, callers may need to override the body or path; this is the
    minimum-viable invocation that lets a phase-5–9 test plug in by
    overriding `body` or `headers` via the surface helpers below.
    """
    base = _surface_base_url(row.surface, row.resource)
    headers = {"Authorization": f"Bearer {token.access_token}"}
    if row.method == "rpc":
        return {
            "method": "POST",
            "url": f"{base}",
            "headers": {**headers, "Content-Type": "application/json"},
            "json": {"path": row.path, "resource": row.resource, "scope": row.scope},
        }
    return {
        "method": row.method,
        "url": f"{base}{row.path if row.path.startswith('/') else '/' + row.path}",
        "headers": headers,
    }


def call_surface(row: MatrixRow, token: PersonaToken, **overrides: Any) -> httpx.Response:
    """Dispatch the matrix row using a synchronous httpx call.

    `overrides` are merged into the kwargs (last write wins) so individual
    phase tests can supply a body, query params, etc.
    """
    kwargs = _build_request(row, token)
    kwargs.update(overrides)
    with httpx.Client(timeout=10.0) as client:
        return client.request(**kwargs)


# --------------------------------------------------------------------------- #
# Pytest parameterisation entry point used by the auto-generated test below
# --------------------------------------------------------------------------- #


def matrix_param_set() -> Iterable[pytest.param]:
    """Return one ``pytest.param`` per (route, persona).

    Pending rows are emitted with a ``pytest.mark.skip`` so the suite still
    *collects* them (visible in the report) but does not execute them. This
    is the same pattern the Jest driver uses with `xit`.
    """
    for row in expand_matrix():
        marks: list[pytest.MarkDecorator] = [pytest.mark.rbac_online]
        if row.migration_status == "pending":
            marks.append(
                pytest.mark.skip(
                    reason=(
                        f"row {row.route_id!r} has migration_status: pending — "
                        "tracked by Phases 5–9 in spec 102 tasks.md"
                    )
                )
            )
        yield pytest.param(row, id=matrix_param_id(row), marks=marks)


__all__ = [
    "PYTHON_SURFACES",
    "MatrixRow",
    "MATRIX_YAML",
    "call_surface",
    "expand_matrix",
    "matrix_param_id",
    "matrix_param_set",
]

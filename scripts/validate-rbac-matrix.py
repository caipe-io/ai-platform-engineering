#!/usr/bin/env python3
"""Validate tests/rbac/rbac-matrix.yaml against authoritative call sites.

Spec 102 (FR-010, SC-006). Hard-gate run in CI; non-zero exit on drift.

What it checks:
  1. The matrix file parses against the JSON schema in
     ``docs/docs/specs/102-comprehensive-rbac-tests-and-completion/contracts/rbac-matrix.schema.json``.
  2. Every `requireRbacPermission(req, "<resource>", "<scope>")` call in
     `ui/src/app/api/**/route.ts` (TS surface) is represented by a route entry.
  3. Every `require_rbac_permission(token, "<resource>", "<scope>")` call in
     `ai_platform_engineering/**/server.py` and `ai_platform_engineering/**/__main__.py`
     (Python surface) is represented by a route entry.
  4. Every Dynamic Agent execution route that calls the OpenFGA agent-use helper is
     represented by an OpenFGA matrix entry.
     Engine and DA resource routes are also inventoried by exact HTTP method,
     path, surface and internal/run-capability/OpenFGA authorization boundary.
  5. Each entry has expectations for ALL six personas (the JSON schema enforces this,
     but we double-check after parse for nicer errors).
  6. The set of Keycloak resources referenced by the matrix is a subset of the resources we can
     find in `deploy/keycloak/realm-config.json` `authorizationSettings.resources[]`
     (defence in depth — `validate-realm-config.py` is the authoritative check).

Usage:
  python3 scripts/validate-rbac-matrix.py            # validate, exit non-zero on drift
  python3 scripts/validate-rbac-matrix.py --print    # also print the discovered (resource, scope) inventory

Why bare-bones (no jsonschema dependency)? The repo's CI image is minimal; we use a
hand-rolled checker that mirrors the schema. T012 validates this script with fixtures.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
MATRIX_PATH = REPO_ROOT / "tests" / "rbac" / "rbac-matrix.yaml"
REALM_CONFIG_PATH = REPO_ROOT / "deploy" / "keycloak" / "realm-config.json"

UI_ROUTES_GLOB = "ui/src/app/api/**/route.ts"
PY_SERVER_GLOBS = (
    "ai_platform_engineering/**/server.py",
    "ai_platform_engineering/**/__main__.py",
)

REQUIRED_PERSONAS = {
    "alice_admin",
    "bob_chat_user",
    "carol_kb_ingestor",
    "dave_no_role",
    "eve_dynamic_agent_user",
    "frank_service_account",
}

# requireRbacPermission(req, "resource", "scope") — accepts single or double quotes,
# possibly broken across lines; we extract the (resource, scope) literal pair.
TS_CALL_RE = re.compile(
    r"requireRbacPermission\s*\(\s*[^,]+?,\s*[\"']([a-z0-9_]+(?::[A-Za-z0-9_-]+)?)[\"']\s*,\s*[\"']([a-z_]+)[\"']",
    re.MULTILINE | re.DOTALL,
)
# BFF data-plane OpenFGA route gate. The concrete object is request-specific
# (`agent:<agent_id>`), so validation tracks route coverage rather than realm
# resource inventory.
TS_OPENFGA_AGENT_USE_RE = re.compile(r"requireAgentUsePermission\s*\(", re.MULTILINE)
# require_rbac_permission(token, "resource", "scope")
PY_CALL_RE = re.compile(
    r"require_rbac_permission\s*\(\s*[^,]+?,\s*[\"']([a-z0-9_]+(?::[A-Za-z0-9_-]+)?)[\"']\s*,\s*[\"']([a-z_]+)[\"']",
    re.MULTILINE | re.DOTALL,
)


@dataclass(frozen=True)
class Violation:
    kind: str          # "missing_in_matrix" | "missing_persona" | "unknown_resource" | "schema"
    where: str         # file:line OR matrix entry id
    message: str

    def __str__(self) -> str:
        return f"  [{self.kind}] {self.where}: {self.message}"


def load_matrix() -> dict:
    """Tiny YAML reader that handles the subset of YAML our matrix uses.

    We intentionally avoid depending on PyYAML at validator time. The matrix file
    is structured (no anchors / no flow style), so we re-emit through json after a
    minimal transformation. For full power we fall back to PyYAML if available.
    """
    try:
        import yaml  # type: ignore
        return yaml.safe_load(MATRIX_PATH.read_text())
    except ImportError:
        pass

    # Minimal hand-roll: support only `key: scalar` and `key: []` until PyYAML lands.
    txt = MATRIX_PATH.read_text()
    # Strip front-matter `---` and comments
    lines = [ln for ln in txt.splitlines() if not ln.lstrip().startswith("#") and ln.strip() != "---"]
    body = "\n".join(lines).strip()
    if body.startswith("version:") and "routes: []" in body:
        return {"version": 1, "routes": []}
    raise RuntimeError(
        "validate-rbac-matrix.py needs PyYAML to parse non-empty matrices. "
        "Install with `uv add pyyaml` or `pip install pyyaml`."
    )


def load_realm_resources() -> set[str]:
    """Return the set of resource names declared in deploy/keycloak/realm-config.json."""
    if not REALM_CONFIG_PATH.is_file():
        # Soft-skip: validate-realm-config.py is the hard gate (T011).
        return set()
    cfg = json.loads(REALM_CONFIG_PATH.read_text())
    resources: set[str] = set()
    for client in cfg.get("clients", []):
        authz = client.get("authorizationSettings") or {}
        for res in authz.get("resources", []) or []:
            name = res.get("name")
            if name:
                resources.add(name)
    return resources


def find_call_sites(globs: Iterable[str], pattern: re.Pattern[str]) -> dict[tuple[str, str], list[str]]:
    """Return {(resource, scope): [file:line, ...]} for every regex match across ``globs``."""
    sites: dict[tuple[str, str], list[str]] = {}
    for glob in globs:
        for path in REPO_ROOT.glob(glob):
            try:
                content = path.read_text()
            except (UnicodeDecodeError, PermissionError):
                continue
            for match in pattern.finditer(content):
                resource, scope = match.group(1), match.group(2)
                line_no = content[: match.start()].count("\n") + 1
                where = f"{path.relative_to(REPO_ROOT)}:{line_no}"
                sites.setdefault((resource, scope), []).append(where)
    return sites


_ALLOWED_ROUTE_KEYS = frozenset({
    "id", "surface", "method", "path", "resource", "scope",
    "expectations", "notes", "migration_status", "authorization_system",
    "relation", "object_type",
})
_VALID_MIGRATION_STATUSES = frozenset({"migrated", "pending"})
_VALID_AUTHORIZATION_SYSTEMS = frozenset({"keycloak", "openfga", "internal", "run_capability"})
_VALID_SURFACES = frozenset({"ui_bff", "mcp", "dynamic_agents", "rag", "slack_bot", "webex_bot", "harness_engine"})
_HARNESS_ROUTE_FILES = (
    ("harness_engine", "ai_platform_engineering/harness_engine/src/harness_engine/main.py", ""),
    ("harness_engine", "ai_platform_engineering/harness_engine/src/harness_engine/coding/routes.py", ""),
    ("dynamic_agents", "ai_platform_engineering/dynamic_agents/src/dynamic_agents/routes/harness_resources.py", "/api/v1"),
)
_CAPABILITY_HANDLERS = frozenset({"mcp", "git_capability", "git_proxy"})


def find_harness_route_sites() -> dict[tuple[str, str, str], tuple[str, str]]:
    """Inventory literal Engine and DA resource routes, including GET/POST api_route."""
    sites: dict[tuple[str, str, str], tuple[str, str]] = {}
    for surface, relative, prefix in _HARNESS_ROUTE_FILES:
        path = REPO_ROOT / relative
        if not path.is_file():
            continue
        tree = ast.parse(path.read_text())
        router_prefix = ""
        if surface == "dynamic_agents":
            for item in tree.body:
                if isinstance(item, ast.Assign) and isinstance(item.value, ast.Call) and any(
                    isinstance(target, ast.Name) and target.id == "router" for target in item.targets
                ):
                    router_prefix = next(
                        (ast.literal_eval(keyword.value) for keyword in item.value.keywords if keyword.arg == "prefix"), ""
                    )
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and isinstance(decorator.func.value, ast.Name)
                    and decorator.func.value.id in {"app", "router"}
                    and decorator.func.attr in {"get", "post", "put", "patch", "delete", "api_route"}
                    and decorator.args
                    and isinstance(decorator.args[0], ast.Constant)
                    and isinstance(decorator.args[0].value, str)
                ):
                    continue
                route = prefix + router_prefix + decorator.args[0].value
                if route == "/healthz":
                    continue
                methods = [decorator.func.attr.upper()]
                if decorator.func.attr == "api_route":
                    methods = next(ast.literal_eval(item.value) for item in decorator.keywords if item.arg == "methods")
                authz = "openfga" if surface == "dynamic_agents" else "run_capability" if node.name in _CAPABILITY_HANDLERS else "internal"
                for method in methods:
                    sites[(surface, method, route)] = (authz, f"{relative}:{decorator.lineno}")
    return sites


def route_path_from_ui_file(path: Path) -> str:
    """Convert a Next.js app route file path into its API route path."""
    rel = path.relative_to(REPO_ROOT / "ui" / "src" / "app")
    without_route = rel.parent
    return "/" + "/".join(without_route.parts)


def find_openfga_agent_use_route_sites() -> dict[str, list[str]]:
    """Return {route_path: [file:line, ...]} for BFF OpenFGA agent-use gates."""
    sites: dict[str, list[str]] = {}
    for path in REPO_ROOT.glob(UI_ROUTES_GLOB):
        try:
            content = path.read_text()
        except (UnicodeDecodeError, PermissionError):
            continue
        for match in TS_OPENFGA_AGENT_USE_RE.finditer(content):
            line_no = content[: match.start()].count("\n") + 1
            where = f"{path.relative_to(REPO_ROOT)}:{line_no}"
            sites.setdefault(route_path_from_ui_file(path), []).append(where)
    return sites


def validate_schema_shape(matrix: dict) -> list[Violation]:
    """Hand-rolled subset of rbac-matrix.schema.json validation."""
    violations: list[Violation] = []
    if matrix.get("version") != 1:
        violations.append(Violation("schema", "<root>", f"version must be 1, got {matrix.get('version')!r}"))
    routes = matrix.get("routes")
    if not isinstance(routes, list):
        violations.append(Violation("schema", "<root>", "routes must be a list"))
        return violations
    seen_ids: set[str] = set()
    for entry in routes:
        rid = entry.get("id", "<no-id>")
        if rid in seen_ids:
            violations.append(Violation("schema", rid, "duplicate id"))
        seen_ids.add(rid)
        for required in ("id", "surface", "method", "path", "resource", "scope", "expectations"):
            if required not in entry:
                violations.append(Violation("schema", rid, f"missing required field {required!r}"))
        if entry.get("surface") not in _VALID_SURFACES:
            violations.append(Violation("schema", rid, f"unknown surface {entry.get('surface')!r}"))
        unknown = set(entry.keys()) - _ALLOWED_ROUTE_KEYS
        for key in sorted(unknown):
            violations.append(Violation("schema", rid, f"unknown field {key!r}"))
        ms = entry.get("migration_status")
        if ms is not None and ms not in _VALID_MIGRATION_STATUSES:
            violations.append(
                Violation(
                    "schema",
                    rid,
                    f"migration_status must be one of {sorted(_VALID_MIGRATION_STATUSES)}, got {ms!r}",
                )
            )
        authz = entry.get("authorization_system", "keycloak")
        if authz not in _VALID_AUTHORIZATION_SYSTEMS:
            violations.append(
                Violation(
                    "schema",
                    rid,
                    f"authorization_system must be one of {sorted(_VALID_AUTHORIZATION_SYSTEMS)}, got {authz!r}",
                )
            )
        if authz == "openfga":
            if entry.get("relation") != "can_use":
                violations.append(Violation("schema", rid, "OpenFGA agent-use entries must set relation: can_use"))
            if entry.get("object_type") != "agent":
                violations.append(Violation("schema", rid, "OpenFGA agent-use entries must set object_type: agent"))
        expectations = entry.get("expectations") or {}
        if authz in {"internal", "run_capability"}:
            if entry.get("surface") != "harness_engine":
                violations.append(Violation("schema", rid, f"{authz} entries require surface: harness_engine"))
            if "relation" in entry or "object_type" in entry:
                violations.append(Violation("schema", rid, f"{authz} entries must not declare an OpenFGA relation"))
            for persona, expectation in expectations.items():
                if expectation.get("status") not in {401, 403}:
                    violations.append(Violation("schema", rid, f"bearer-only {persona} must be denied by {authz}"))
        missing = REQUIRED_PERSONAS - set(expectations.keys())
        if missing:
            violations.append(
                Violation("missing_persona", rid, f"missing expectations for: {sorted(missing)}")
            )
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print", action="store_true", help="print discovered call sites")
    args = parser.parse_args()

    print(f"[validate-rbac-matrix] reading {MATRIX_PATH.relative_to(REPO_ROOT)}")
    matrix = load_matrix()
    schema_violations = validate_schema_shape(matrix)

    declared_pairs: set[tuple[str, str]] = {
        (e["resource"], e["scope"]) for e in matrix.get("routes", [])
        if "resource" in e and "scope" in e and e.get("authorization_system", "keycloak") == "keycloak"
    }
    declared_keycloak_resources: set[str] = {
        e["resource"]
        for e in matrix.get("routes", [])
        if "resource" in e and e.get("authorization_system", "keycloak") == "keycloak"
    }
    declared_openfga_routes: set[tuple[str, str]] = {
        (e["method"], e["path"])
        for e in matrix.get("routes", [])
        if e.get("authorization_system") == "openfga"
    }

    print("[validate-rbac-matrix] scanning TS call sites…")
    ts_sites = find_call_sites([UI_ROUTES_GLOB], TS_CALL_RE)
    print(f"[validate-rbac-matrix]   found {len(ts_sites)} unique (resource, scope) pairs in TS")

    print("[validate-rbac-matrix] scanning Python call sites…")
    py_sites = find_call_sites(PY_SERVER_GLOBS, PY_CALL_RE)
    print(f"[validate-rbac-matrix]   found {len(py_sites)} unique (resource, scope) pairs in Python")

    print("[validate-rbac-matrix] scanning OpenFGA agent-use route gates…")
    openfga_sites = find_openfga_agent_use_route_sites()
    print(f"[validate-rbac-matrix]   found {len(openfga_sites)} OpenFGA-gated BFF route(s)")
    harness_sites = find_harness_route_sites()
    print(f"[validate-rbac-matrix]   found {len(harness_sites)} Engine/DA resource route gate(s)")

    if args.print:
        for (res, scope), wheres in sorted({**ts_sites, **py_sites}.items()):
            print(f"  - ({res}, {scope}): {wheres[0]}{' (+%d more)' % (len(wheres)-1) if len(wheres) > 1 else ''}")
        for route_path, wheres in sorted(openfga_sites.items()):
            print(f"  - (openfga, POST {route_path}, agent#use): {wheres[0]}{' (+%d more)' % (len(wheres)-1) if len(wheres) > 1 else ''}")

    matrix_violations: list[Violation] = []
    declared_harness_routes = {
        (e["surface"], e["method"], e["path"]): e.get("authorization_system", "keycloak")
        for e in matrix.get("routes", [])
        if all(key in e for key in ("surface", "method", "path"))
    }
    for gate, (authz, where) in harness_sites.items():
        if declared_harness_routes.get(gate) != authz:
            matrix_violations.append(Violation(
                "missing_in_matrix", where,
                f"{gate[0]} {gate[1]} {gate[2]} requires authorization_system={authz}",
            ))
    for pair, wheres in {**ts_sites, **py_sites}.items():
        if pair not in declared_pairs:
            matrix_violations.append(
                Violation(
                    "missing_in_matrix",
                    wheres[0],
                    f"call site uses ({pair[0]!r}, {pair[1]!r}) but no entry in tests/rbac/rbac-matrix.yaml",
                )
            )
    for route_path, wheres in openfga_sites.items():
        if ("POST", route_path) not in declared_openfga_routes:
            matrix_violations.append(
                Violation(
                    "missing_in_matrix",
                    wheres[0],
                    f"OpenFGA agent-use gate on POST {route_path} has no authorization_system=openfga entry",
                )
            )

    realm_resources = load_realm_resources()
    realm_violations: list[Violation] = []
    if realm_resources:
        unknown = declared_keycloak_resources - realm_resources
        for res in sorted(unknown):
            realm_violations.append(
                Violation(
                    "unknown_resource",
                    res,
                    f"resource {res!r} appears in matrix but not in realm-config.json (run validate-realm-config.py for details)",
                )
            )

    all_violations = schema_violations + matrix_violations + realm_violations
    if all_violations:
        print(
            f"\n[validate-rbac-matrix] FAIL — {len(all_violations)} violation(s):",
            file=sys.stderr,
        )
        for v in all_violations:
            print(str(v), file=sys.stderr)
        print(
            "\nFix: add the missing entries to tests/rbac/rbac-matrix.yaml or remove the dead call sites.",
            file=sys.stderr,
        )
        return 1

    print("[validate-rbac-matrix] OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Validate that the tracked Keycloak realm seed matches the runtime catalog.

This is a hard CI gate and exits non-zero on drift.

Checks:
  1. ``ui/src/lib/rbac/resource-catalog.generated.ts`` (produced by
     ``scripts/extract-rbac-resources.py``) is up-to-date — every (resource, scope)
     pair the runtime references is declared in
     ``deploy/keycloak/realm-config.example.json`` ``authorizationSettings.resources[].scopes``.
  2. ``deploy/keycloak/realm-config-extras.json`` validates against
     ``tests/rbac/contracts/realm-config-extras.schema.json``:
       - `version: 1`
       - keys under `pdp_unavailable_fallback` MUST match a resource in realm-config.json
       - if `mode == "realm_role"`, the named role MUST exist in realm-config.json `roles.realm[]`

Usage:
  python3 scripts/validate-realm-config.py            # validate, exit non-zero on drift
  python3 scripts/validate-realm-config.py --print    # also dump the parsed catalog/extras
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REALM_PATH = REPO_ROOT / "deploy" / "keycloak" / "realm-config.example.json"
EXTRAS_PATH = REPO_ROOT / "deploy" / "keycloak" / "realm-config-extras.json"
CATALOG_TS = REPO_ROOT / "ui" / "src" / "lib" / "rbac" / "resource-catalog.generated.ts"

CATALOG_LINE_RE = re.compile(
    r"^\s*([a-z0-9_]+):\s*\{\s*scopes:\s*\[([^\]]*)\]\s*as\s+const\s*\}\s*,?\s*$"
)
SCOPE_RE = re.compile(r"\"([a-z_]+)\"")


def load_realm_resources() -> tuple[dict[str, set[str]], set[str]]:
    """Return (resources_with_scopes, realm_roles)."""
    if not REALM_PATH.exists():
        print(f"[validate-realm-config] FAIL — {REALM_PATH} does not exist", file=sys.stderr)
        return {}, set()
    cfg = json.loads(REALM_PATH.read_text())

    res_to_scopes: dict[str, set[str]] = {}
    for client in cfg.get("clients", []):
        authz = client.get("authorizationSettings") or {}
        for res in authz.get("resources", []) or []:
            name = res.get("name")
            if not name:
                continue
            scopes = {s.get("name") for s in res.get("scopes", []) if s.get("name")}
            res_to_scopes.setdefault(name, set()).update(scopes)

    realm_roles: set[str] = set()
    for role in (cfg.get("roles") or {}).get("realm", []) or []:
        if name := role.get("name"):
            realm_roles.add(name)

    return res_to_scopes, realm_roles


def load_runtime_catalog() -> dict[str, set[str]]:
    """Parse the auto-generated TS file. We intentionally don't depend on a TS toolchain."""
    if not CATALOG_TS.exists():
        return {}
    catalog: dict[str, set[str]] = {}
    for line in CATALOG_TS.read_text().splitlines():
        m = CATALOG_LINE_RE.match(line)
        if not m:
            continue
        resource = m.group(1)
        scopes = set(SCOPE_RE.findall(m.group(2)))
        catalog[resource] = scopes
    return catalog


def validate_extras(extras: dict, realm_resources: set[str], realm_roles: set[str]) -> list[str]:
    """Hand-rolled subset of realm-config-extras.schema.json validation."""
    violations: list[str] = []
    if extras.get("version") != 1:
        violations.append(f"version must be 1, got {extras.get('version')!r}")

    fallback = extras.get("pdp_unavailable_fallback") or {}
    if not isinstance(fallback, dict):
        violations.append("pdp_unavailable_fallback must be an object")
        return violations

    for resource, rule in fallback.items():
        if not re.fullmatch(r"[a-z0-9_]+", resource):
            violations.append(f"resource key {resource!r} must match ^[a-z0-9_]+$")
            continue
        if realm_resources and resource not in realm_resources:
            violations.append(
                f"pdp_unavailable_fallback.{resource}: resource not declared in realm-config.json"
            )
        if not isinstance(rule, dict):
            violations.append(f"pdp_unavailable_fallback.{resource}: rule must be an object")
            continue
        mode = rule.get("mode")
        if mode == "deny_all":
            extra_keys = set(rule.keys()) - {"mode"}
            if extra_keys:
                violations.append(
                    f"pdp_unavailable_fallback.{resource}: deny_all rule has unexpected keys: {sorted(extra_keys)}"
                )
        elif mode == "realm_role":
            extra_keys = set(rule.keys()) - {"mode", "role"}
            if extra_keys:
                violations.append(
                    f"pdp_unavailable_fallback.{resource}: realm_role rule has unexpected keys: {sorted(extra_keys)}"
                )
            role = rule.get("role")
            if not isinstance(role, str) or not role:
                violations.append(f"pdp_unavailable_fallback.{resource}: realm_role rule missing 'role'")
            elif realm_roles and role not in realm_roles:
                violations.append(
                    f"pdp_unavailable_fallback.{resource}: realm role {role!r} not declared in realm-config.json"
                )
        else:
            violations.append(
                f"pdp_unavailable_fallback.{resource}: mode must be 'deny_all' or 'realm_role', got {mode!r}"
            )
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print", action="store_true", help="print parsed inventory")
    args = parser.parse_args()

    print(f"[validate-realm-config] reading {REALM_PATH.relative_to(REPO_ROOT)}")
    realm_resources, realm_roles = load_realm_resources()
    print(
        f"[validate-realm-config]   {len(realm_resources)} resource(s), "
        f"{len(realm_roles)} realm role(s) discovered"
    )

    catalog = load_runtime_catalog()
    print(
        f"[validate-realm-config] reading {CATALOG_TS.relative_to(REPO_ROOT)} "
        f"({len(catalog)} resource(s))"
    )

    if args.print:
        print("[validate-realm-config] runtime catalog:")
        for r in sorted(catalog):
            print(f"  - {r}: {sorted(catalog[r])}")
        print(f"[validate-realm-config] realm-config.json resources: {sorted(realm_resources)}")
        print(f"[validate-realm-config] realm-config.json realm roles: {sorted(realm_roles)}")

    drift: list[str] = []
    for resource, scopes in catalog.items():
        if resource not in realm_resources:
            drift.append(
                f"runtime references resource {resource!r} but it is missing from realm-config.json"
            )
            continue
        missing_scopes = scopes - realm_resources[resource]
        for scope in sorted(missing_scopes):
            drift.append(
                f"runtime references ({resource!r}, {scope!r}) but realm-config.json does not declare scope {scope!r} on resource {resource!r}"
            )

    extras_violations: list[str] = []
    if EXTRAS_PATH.exists():
        print(f"[validate-realm-config] reading {EXTRAS_PATH.relative_to(REPO_ROOT)}")
        try:
            extras = json.loads(EXTRAS_PATH.read_text())
        except json.JSONDecodeError as exc:
            extras_violations.append(f"realm-config-extras.json is not valid JSON: {exc}")
        else:
            extras_violations.extend(validate_extras(extras, set(realm_resources.keys()), realm_roles))
    else:
        print(
            f"[validate-realm-config] WARN — {EXTRAS_PATH.relative_to(REPO_ROOT)} does not exist; no fallback overrides will be validated",
            file=sys.stderr,
        )

    all_violations = drift + extras_violations
    if all_violations:
        print(
            f"\n[validate-realm-config] FAIL — {len(all_violations)} violation(s):",
            file=sys.stderr,
        )
        for v in all_violations:
            print(f"  - {v}", file=sys.stderr)
        print(
            "\nFix: update deploy/keycloak/realm-config.json (or realm-config-extras.json) to match the runtime catalog,"
            " or remove the dead runtime call sites and re-run scripts/extract-rbac-resources.py.",
            file=sys.stderr,
        )
        return 1

    print("[validate-realm-config] OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

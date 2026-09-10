#!/usr/bin/env python3
"""CI validator: RBAC code changes must update how-rbac-works.md.

Spec 102 — User Story 8 (Living Documentation).

This script is intended to run on a pull request. It looks at the diff
between the PR branch and its merge base, classifies each changed file,
and fails if RBAC-relevant code changed without a matching update to
the canonical reference doc:

    docs/docs/specs/098-enterprise-rbac-slack-ui/how-rbac-works.md

A change is considered RBAC-relevant if it touches one of the
``RBAC_PATHS`` entries below (Python or TypeScript). The matcher uses
prefix matching, so any file under e.g. ``ai_platform_engineering/utils/auth/``
counts.

Trivial-change carve-outs (so we don't fail PRs that legitimately
don't need a doc update):

  - Pure formatting / whitespace changes (rare in practice).
  - Copyright and SPDX license-header-only changes.
  - Test files (``tests/`` or ``__tests__/`` segment in the path).
  - Markdown files anywhere in the repo (including ADRs).
  - The `BLOCKERS.md` and `CHECKLIST.md` files (operator notes, not docs).

If any non-trivial RBAC code file changed, the validator requires
``how-rbac-works.md`` to also appear in the diff. Otherwise it exits
with code 1 and prints a clear message naming the offending files.

Usage:
  # In CI (GitHub Actions): the workflow checks out enough history,
  # then runs:
  python scripts/validate_rbac_docs.py --base origin/main --head HEAD

  # Locally during development:
  python scripts/validate_rbac_docs.py
  # (auto-detects merge-base against ``main`` if --base is omitted)

Exit codes:
  0  - All good (either no RBAC code changed, or doc was updated)
  1  - RBAC code changed but doc untouched
  2  - Internal error (bad git invocation, missing base, etc.)
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

# Files / directories considered "RBAC code". Prefix-matched.
# Keep this list short and high-signal; broad globs (e.g. all of ui/src)
# would create false positives and train developers to ignore the check.
RBAC_PATHS: tuple[str, ...] = (
    # Shared Python auth + PDP helpers
    "ai_platform_engineering/utils/auth/",
    # Dynamic Agents auth surface
    "ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/",
    # Slack bot Keycloak / JIT path
    "ai_platform_engineering/integrations/slack_bot/utils/keycloak_admin.py",
    "ai_platform_engineering/integrations/slack_bot/utils/identity_linker.py",
    # Agent Gateway ext_authz configuration
    "deploy/agentgateway/config.yaml.j2",
    # BFF auth surface
    "ui/src/lib/api-middleware.ts",
    "ui/src/lib/da-proxy.ts",
    "ui/src/lib/auth/",
    # Keycloak realm bootstrap
    "deploy/keycloak/init-idp.sh",
    "deploy/keycloak/Dockerfile.keycloak-init",
    # RAG server RBAC (datasource scope + hybrid ACL doc-tag filter)
    "ai_platform_engineering/knowledge_bases/rag/server/src/server/rbac.py",
    "ai_platform_engineering/knowledge_bases/rag/server/src/server/doc_acl.py",
)

# Canonical doc(s) — accept any of these. The original single-file
# `how-rbac-works.md` was split into a stub + four sibling files
# under `docs/docs/security/rbac/` (see commit
# `docs(security): split how-rbac-works.md`). Touching any of them
# satisfies the gate.
CANONICAL_DOCS: tuple[str, ...] = (
    "docs/docs/specs/098-enterprise-rbac-slack-ui/how-rbac-works.md",
    "docs/docs/security/rbac/index.md",
    "docs/docs/security/rbac/architecture.md",
    "docs/docs/security/rbac/workflows.md",
    "docs/docs/security/rbac/usage.md",
    "docs/docs/security/rbac/file-map.md",
)
# Backwards-compat alias used in user-facing log lines.
CANONICAL_DOC = CANONICAL_DOCS[0]


def _is_trivial(path: str) -> bool:
    """Return True for changes that don't require a doc update.

    Trivial = tests, markdown, and the operator-notes files. Everything
    else is gated by the doc requirement.
    """
    p = path.lower()
    if p.endswith(".md"):
        return True
    if "/tests/" in p or "/__tests__/" in p or p.startswith("tests/"):
        return True
    if p in ("blockers.md", "checklist.md"):
        return True
    if p.endswith(".test.ts") or p.endswith(".test.tsx") or p.endswith(".spec.ts"):
        return True
    if "_test.py" in p or p.endswith("_test.py"):
        return True
    return False


def _is_rbac_code(path: str) -> bool:
    """Prefix-match a path against ``RBAC_PATHS``."""
    return any(path.startswith(prefix) for prefix in RBAC_PATHS)


class _GitInvocationError(RuntimeError):
    """Raised when a git command we depend on fails.

    Kept internal so this script stays dependency-free. The top-level
    ``__main__`` block translates it into ``sys.exit(2)`` (internal
    error), preserving the original CLI contract while letting the
    helpers below stay pure ``-> str`` functions with no implicit
    ``None`` return path.
    """


def _git(args: list[str]) -> str:
    """Run a git command and return stdout.

    Raises ``_GitInvocationError`` on non-zero exit. The caller (or the
    top-level entrypoint) is responsible for converting the error into
    a process exit code.
    """
    try:
        out = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise _GitInvocationError(
            f"git {' '.join(args)} failed: {exc.stderr or exc.stdout}"
        ) from exc
    return out.stdout


def _resolve_base(base: str | None) -> str:
    """Resolve the comparison base ref.

    If --base is given, use it verbatim. Otherwise try ``origin/main``,
    then ``main``. Raises ``_GitInvocationError`` if none resolve.
    """
    if base:
        return base
    for candidate in ("origin/main", "main"):
        try:
            subprocess.run(
                ["git", "rev-parse", "--verify", candidate],
                capture_output=True,
                check=True,
            )
        except subprocess.CalledProcessError:
            continue
        return candidate
    raise _GitInvocationError(
        "Could not resolve a base ref (tried origin/main, main). "
        "Pass --base explicitly."
    )


def _changed_files(base: str, head: str) -> list[str]:
    """Return the list of files changed between base and head."""
    raw = _git(["diff", "--name-only", f"{base}...{head}"])
    return [line.strip() for line in raw.splitlines() if line.strip()]


def _is_license_header_line(line: str) -> bool:
    """Return whether a changed line is copyright/SPDX metadata."""
    stripped = line.lstrip()
    for marker in ("//", "/*", "#", "*", ";"):
        if stripped.startswith(marker):
            content = stripped.removeprefix(marker).strip().lower()
            break
    else:
        return False
    return content.startswith(
        (
            "copyright ",
            "spdx-filecopyrighttext:",
            "spdx-license-identifier:",
        )
    )


def _has_substantive_change(base: str, head: str, path: str) -> bool:
    """Return whether a file diff changes more than license metadata."""
    raw = _git(
        [
            "diff",
            "--unified=0",
            "--no-ext-diff",
            f"{base}...{head}",
            "--",
            path,
        ]
    )
    for line in raw.splitlines():
        if line.startswith(("+++", "---")) or not line.startswith(("+", "-")):
            continue
        content = line[1:].strip()
        if content and not _is_license_header_line(content):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail if RBAC code changed but how-rbac-works.md didn't."
    )
    parser.add_argument(
        "--base",
        help="Base ref for diff (default: origin/main, falling back to main).",
    )
    parser.add_argument(
        "--head",
        default="HEAD",
        help="Head ref for diff (default: HEAD).",
    )
    parser.add_argument(
        "--repo-root",
        default=os.getcwd(),
        help="Repo root to chdir into before running git (default: cwd).",
    )
    args = parser.parse_args()

    os.chdir(args.repo_root)

    base = _resolve_base(args.base)
    files = _changed_files(base, args.head)

    if not files:
        print("validate_rbac_docs: no files changed; nothing to check.")
        return 0

    rbac_candidates = [
        f for f in files if _is_rbac_code(f) and not _is_trivial(f)
    ]
    rbac_changes = [
        f
        for f in rbac_candidates
        if _has_substantive_change(base, args.head, f)
    ]
    doc_updated = any(d in files for d in CANONICAL_DOCS)

    if not rbac_changes:
        print(
            "validate_rbac_docs: no RBAC-relevant code changes; "
            "doc update not required."
        )
        return 0

    if doc_updated:
        touched = [d for d in CANONICAL_DOCS if d in files]
        print(
            "validate_rbac_docs: RBAC code changed AND a canonical "
            f"RBAC doc was updated ({', '.join(touched)}). \u2713"
        )
        for f in rbac_changes:
            print(f"  - {f}")
        return 0

    sys.stderr.write(
        "\nvalidate_rbac_docs: RBAC code changed but no canonical RBAC "
        "doc was updated.\n\n"
    )
    sys.stderr.write("Canonical docs (touch any one):\n")
    for d in CANONICAL_DOCS:
        sys.stderr.write(f"  - {d}\n")
    sys.stderr.write("\n")
    sys.stderr.write("Files that triggered the check:\n")
    for f in rbac_changes:
        sys.stderr.write(f"  - {f}\n")
    sys.stderr.write(
        "\nPlease update how-rbac-works.md to reflect the change "
        "(see CLAUDE.md > 'RBAC Living Documentation Rule'). If the "
        "change is genuinely doc-irrelevant, justify it in the PR "
        "description and add the path to RBAC_PATHS' carve-out list.\n"
    )
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except _GitInvocationError as err:
        sys.stderr.write(f"{err}\n")
        sys.exit(2)

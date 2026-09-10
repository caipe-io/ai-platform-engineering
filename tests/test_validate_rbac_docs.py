"""Unit tests for scripts/validate_rbac_docs.py (Spec 102 US8).

We test the pure helpers (path classification) directly, and we exercise
the full main() entry point against a temp git repo to verify the
end-to-end CI behaviour without needing GitHub Actions.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

# Load the script as a module without making it importable as a package.
SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "validate_rbac_docs.py"
)
spec = importlib.util.spec_from_file_location("validate_rbac_docs", SCRIPT)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


# ── _is_rbac_code / _is_trivial ────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "ai_platform_engineering/utils/auth/keycloak_authz.py",
        "ai_platform_engineering/utils/auth/audit.py",
        "ai_platform_engineering/dynamic_agents/src/dynamic_agents/auth/jwt_middleware.py",
        "deploy/agentgateway/config.yaml.j2",
        "ui/src/lib/api-middleware.ts",
        "ui/src/lib/da-proxy.ts",
        "ui/src/lib/auth/session.ts",  # nested
    ],
)
def test_is_rbac_code_matches_known_rbac_paths(path: str) -> None:
    assert mod._is_rbac_code(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "ai_platform_engineering/legacy/runtime/router.py",
        "ui/src/components/Toast.tsx",
        "README.md",
        "docs/docs/index.md",
    ],
)
def test_is_rbac_code_ignores_unrelated_paths(path: str) -> None:
    assert mod._is_rbac_code(path) is False


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_rbac_pdp_metrics.py",
        "ai_platform_engineering/dynamic_agents/tests/test_jwt_middleware.py",
        "ui/src/lib/__tests__/auth-error.test.ts",
        "BLOCKERS.md",
        "CHECKLIST.md",
        "docs/docs/specs/098-enterprise-rbac-slack-ui/how-rbac-works.md",
    ],
)
def test_is_trivial_exempts_tests_and_markdown(path: str) -> None:
    assert mod._is_trivial(path) is True


def test_is_trivial_does_not_exempt_real_code() -> None:
    assert mod._is_trivial("ai_platform_engineering/utils/auth/audit.py") is False


@pytest.mark.parametrize(
    "line",
    [
        "# Copyright 2025 CAIPE Contributors",
        "// Copyright CAIPE Contributors (https://caipe.io)",
        "# SPDX-FileCopyrightText: 2025 CAIPE Contributors",
        "# SPDX-License-Identifier: Apache-2.0",
    ],
)
def test_is_license_header_line_matches_supported_metadata(line: str) -> None:
    assert mod._is_license_header_line(line) is True


@pytest.mark.parametrize(
    "line",
    [
        "# Verify copyright ownership",
        "Copyright = True",
    ],
)
def test_is_license_header_line_rejects_non_metadata(line: str) -> None:
    assert mod._is_license_header_line(line) is False


# ── End-to-end main() against a temp git repo ──────────────────────────


def _git_init_repo(repo: Path) -> None:
    """Init a tiny git repo with one base commit on `main`."""
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.name", "Test"],
        check=True,
    )
    (repo / "README.md").write_text("# test\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True
    )


def _git_branch_and_commit(
    repo: Path, branch: str, files: dict[str, str]
) -> None:
    """Create a feature branch and commit the given files."""
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-q", "-b", branch], check=True
    )
    for rel, content in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-q", "-m", "feat"], check=True
    )


def _run_validator(repo: Path) -> tuple[int, str, str]:
    """Run the validator inside the temp repo; return (rc, stdout, stderr)."""
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--base", "main", "--head", "HEAD",
         "--repo-root", str(repo)],
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def test_e2e_no_rbac_changes_passes(tmp_path: Path) -> None:
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(repo, "feat", {"ui/src/components/Foo.tsx": "x\n"})

    rc, out, err = _run_validator(repo)
    assert rc == 0, err
    assert "doc update not required" in out


def test_e2e_rbac_change_without_doc_fails(tmp_path: Path) -> None:
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(
        repo,
        "feat",
        {"ai_platform_engineering/utils/auth/audit.py": "x\n"},
    )

    rc, out, err = _run_validator(repo)
    assert rc == 1
    # The validator now lists multiple canonical docs; assert one is mentioned.
    assert "how-rbac-works.md" in err or "security/rbac" in err
    assert "ai_platform_engineering/utils/auth/audit.py" in err


def test_e2e_rbac_license_header_only_change_passes(tmp_path: Path) -> None:
    """Ownership metadata changes must not require RBAC documentation."""
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    auth_file = repo / "ai_platform_engineering/utils/auth/audit.py"
    auth_file.parent.mkdir(parents=True)
    auth_file.write_text(
        "# Copyright 2025 CNOE Contributors\n"
        "# SPDX-License-Identifier: Apache-2.0\n"
        "VALUE = 1\n"
    )
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-q", "-m", "add auth"],
        check=True,
    )
    _git_branch_and_commit(
        repo,
        "feat",
        {
            "ai_platform_engineering/utils/auth/audit.py": (
                "# Copyright 2025 CAIPE Contributors\n"
                "# SPDX-License-Identifier: Apache-2.0\n"
                "VALUE = 1\n"
            )
        },
    )

    rc, out, err = _run_validator(repo)
    assert rc == 0, err
    assert "doc update not required" in out


def test_e2e_rbac_change_with_doc_passes(tmp_path: Path) -> None:
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(
        repo,
        "feat",
        {
            "ai_platform_engineering/utils/auth/audit.py": "x\n",
            "docs/docs/specs/098-enterprise-rbac-slack-ui/how-rbac-works.md": "updated\n",
        },
    )

    rc, out, err = _run_validator(repo)
    assert rc == 0, err
    assert "\u2713" in out or "OK" in out.upper()


def test_e2e_rbac_test_only_change_passes(tmp_path: Path) -> None:
    """Adding a test for an RBAC module shouldn't require a doc update."""
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(
        repo,
        "feat",
        {"tests/test_audit_stdout_sink.py": "def test_x(): pass\n"},
    )
    rc, out, err = _run_validator(repo)
    assert rc == 0, err


def test_e2e_blockers_only_change_passes(tmp_path: Path) -> None:
    """Updating BLOCKERS.md alone shouldn't require how-rbac-works update."""
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(repo, "feat", {"BLOCKERS.md": "notes\n"})
    rc, out, err = _run_validator(repo)
    assert rc == 0, err


def test_e2e_rag_doc_acl_change_requires_doc_update(tmp_path: Path) -> None:
    """RAG doc_acl.py is RBAC code — bare change must trip the gate."""
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(
        repo,
        "feat",
        {
            "ai_platform_engineering/knowledge_bases/rag/server/src/server/doc_acl.py": "x\n"
        },
    )
    rc, _out, err = _run_validator(repo)
    assert rc == 1
    assert "doc_acl.py" in err


def test_e2e_split_doc_file_map_satisfies_gate(tmp_path: Path) -> None:
    """Touching the split file-map.md should satisfy the doc gate."""
    repo = tmp_path / "r"
    repo.mkdir()
    _git_init_repo(repo)
    _git_branch_and_commit(
        repo,
        "feat",
        {
            "ai_platform_engineering/knowledge_bases/rag/server/src/server/doc_acl.py": "x\n",
            "docs/docs/security/rbac/file-map.md": "updated\n",
        },
    )
    rc, out, err = _run_validator(repo)
    assert rc == 0, err
    assert "\u2713" in out

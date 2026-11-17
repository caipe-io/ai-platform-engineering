#!/usr/bin/env python3
"""Lint: fail if any Python or Node dependency is not pinned to an exact version.

Python (pyproject.toml):
  - All entries under [project].dependencies, [project.optional-dependencies],
    and [dependency-groups] must use == specifier.
  - Workspace dependencies (declared in [tool.uv.sources] with a path) are
    exempt — they have no PyPI version to pin.
  - Skips: requires-python, build-system.requires, [tool.*] sections,
    Poetry-managed files, template packages.

Node (package.json):
  - All entries under dependencies / devDependencies / peerDependencies /
    optionalDependencies must be exact versions (no ^, ~, >, <, *, x).
  - Skips: node_modules, .next, dist, build directories.

Go (go.mod): skipped entirely.
"""

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Sections in pyproject.toml we care about
DEP_SECTION_HEADERS = (
    "[project]",
    "[project.optional-dependencies]",
    "[dependency-groups]",
)

# Non-dep array keys that can appear inside [project] and must be skipped
NON_DEP_ARRAY_KEYS = {
    "dynamic",
    "keywords",
    "classifiers",
    "authors",
    "maintainers",
    "urls",
}

# Template packages intentionally use flexible ranges — skip entirely
TEMPLATE_PATH_FRAGMENTS = (
    "/agents/template/",
    "/agents/template-claude-agent-sdk/",
)

# Unpinned Node version prefixes / patterns
UNPINNED_NODE_RE = re.compile(r"^[\^~><=*]|^\d+\.[xX*]|\|\|")

errors: list[str] = []


# ---------------------------------------------------------------------------
# Python helpers
# ---------------------------------------------------------------------------

def get_workspace_dep_names(content: str) -> set[str]:
    """Return package names that are local workspace deps (path = ...) — no version needed."""
    names: set[str] = set()
    in_sources = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped == "[tool.uv.sources]":
            in_sources = True
            continue
        if in_sources:
            if stripped.startswith("["):
                break  # next section
            m = re.match(r'^([A-Za-z0-9_\-\.]+)\s*=\s*\{.*path\s*=', stripped)
            if m:
                names.add(m.group(1).lower().replace("_", "-"))
    return names


def extract_dep_values(content: str) -> list[tuple[int, str]]:
    """Return (lineno, dep_value) for every dep string in the relevant sections."""
    lines = content.splitlines()
    results: list[tuple[int, str]] = []

    in_relevant_section = False
    in_dep_block = False
    current_array_key = ""

    for lineno, raw in enumerate(lines, start=1):
        stripped = raw.strip()

        # Section header
        if stripped.startswith("["):
            in_relevant_section = any(stripped.startswith(h) for h in DEP_SECTION_HEADERS)
            in_dep_block = False
            current_array_key = ""
            continue

        if not in_relevant_section:
            continue

        # Start of an array: key = [
        kv_match = re.match(r'^([a-zA-Z_\-]+)\s*=\s*\[', stripped)
        if kv_match:
            current_array_key = kv_match.group(1).lower().replace("-", "_")
            if current_array_key in NON_DEP_ARRAY_KEYS:
                in_dep_block = False  # skip this array
                if "]" in stripped:
                    current_array_key = ""
            else:
                in_dep_block = True
                if "]" in stripped:
                    # Single-line array
                    in_dep_block = False
                    inner = re.search(r'\[([^\]]*)\]', stripped)
                    if inner:
                        for item in inner.group(1).split(","):
                            val = item.split("#", 1)[0].strip().strip('"').strip("'").strip()
                            if val:
                                results.append((lineno, val))
                    current_array_key = ""
            continue

        # End of array
        if in_dep_block and stripped == "]":
            in_dep_block = False
            current_array_key = ""
            continue

        # Dep entry inside array
        if in_dep_block and stripped.startswith('"'):
            val = stripped.split("#", 1)[0].strip().strip('",').strip("'").strip()
            if val:
                results.append((lineno, val))

    return results


def check_pyproject(path: Path) -> None:
    content = path.read_text()

    # Skip Poetry-managed files
    if "poetry.core.masonry.api" in content:
        return

    workspace_deps = get_workspace_dep_names(content)

    for lineno, value in extract_dep_values(content):
        if not value or value.startswith("#"):
            continue

        # Environment markers constrain installation, not the package version.
        requirement = value.split(";", 1)[0].strip()
        pkg_name = re.split(r"[><=~^!(\s\[]", requirement)[0].strip().lower().replace("_", "-")

        # Skip workspace / path dependencies
        if pkg_name in workspace_deps:
            continue

        # Must be pinned with ==
        if "==" in requirement and not re.search(r"[><!~^](?!=)", requirement.replace("==", "")):
            continue  # properly pinned

        if re.search(r">=|>|~=|!=|\^", requirement):
            errors.append(f"{path}:{lineno}: unpinned specifier: {value!r}")
        elif re.search(r"[<>]", requirement):
            errors.append(f"{path}:{lineno}: unpinned range specifier: {value!r}")
        elif "==" not in requirement:
            # Bare name with no specifier
            errors.append(f"{path}:{lineno}: no version specifier: {value!r}")


# ---------------------------------------------------------------------------
# Node helpers
# ---------------------------------------------------------------------------

def check_package_json(path: Path) -> None:
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        errors.append(f"{path}: invalid JSON: {e}")
        return

    for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        for pkg, version in (data.get(section) or {}).items():
            if UNPINNED_NODE_RE.search(str(version)):
                errors.append(f"{path}: [{section}] {pkg!r}: unpinned: {version!r}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    repo_root = Path(__file__).parent.parent

    # --- Python ---
    for pyproject in sorted(repo_root.rglob("pyproject.toml")):
        if any(p in pyproject.parts for p in (".venv", "venv", "dist", "build", "__pycache__")):
            continue
        rel = str(pyproject.relative_to(repo_root))
        if any(frag in f"/{rel}" for frag in TEMPLATE_PATH_FRAGMENTS):
            continue
        check_pyproject(pyproject)

    # --- Node ---
    for package_json in sorted(repo_root.rglob("package.json")):
        if any(p in package_json.parts for p in ("node_modules", ".next", "dist", "build")):
            continue
        check_package_json(package_json)

    # --- Report ---
    if errors:
        print(f"\n❌  {len(errors)} unpinned dependenc{'y' if len(errors) == 1 else 'ies'} found:\n")
        for err in errors:
            print(f"  {err}")
        print(
            "\nAll Python deps must use ==, e.g.  \"httpx==0.28.1\"\n"
            "All Node deps must be exact,      e.g.  \"react\": \"19.0.0\"\n"
            "Workspace path deps are exempt.\n"
        )
        sys.exit(1)
    else:
        print("✅  All Python and Node dependencies are pinned.")


if __name__ == "__main__":
    main()

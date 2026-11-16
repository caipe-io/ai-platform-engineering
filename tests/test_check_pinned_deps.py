"""Environment markers must not change dependency pinning decisions."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "requirement,expected_success",
    [
        ("example-local; python_version >= '3.14'", True),
        ("example-local[extra]; python_version >= '3.14'", True),
        ("example-package==1.2.3; python_version >= '3.14'", True),
        ("example-package; python_version == '3.14'", False),
        ("example-package>=1.2.3; python_version == '3.14'", False),
    ],
)
def test_dependency_markers_do_not_override_pinning(
    tmp_path: Path, requirement: str, expected_success: bool,
) -> None:
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    checker = scripts / "check_pinned_deps.py"
    shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/check_pinned_deps.py", checker)
    (tmp_path / "pyproject.toml").write_text(
        '[project.optional-dependencies]\n'
        f'example = ["{requirement}"]\n'
        '[tool.uv.sources]\n'
        'example-local = { path = "../local", editable = true }\n'
    )
    result = subprocess.run([sys.executable, str(checker)], capture_output=True, text=True, check=False)
    assert (result.returncode == 0) is expected_success, result.stdout + result.stderr

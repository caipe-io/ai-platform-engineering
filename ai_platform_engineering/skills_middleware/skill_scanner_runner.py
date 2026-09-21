# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Wrapper for Cisco AI Defense **skill-scanner** CLI (T055, FR-023).

Uses the same invocation shape as ``scripts/scan-packaged-skills.sh``:
``skill-scanner scan-all <dir> --recursive --policy … [--fail-on-severity …]``.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# assisted-by Codex Codex-sonnet-4-6
_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}


def _skill_scanner_executable() -> str | None:
    override = (os.getenv("SKILL_SCANNER_BIN") or "").strip()
    if override:
        return override if Path(override).is_file() or shutil.which(override) else None
    return shutil.which("skill-scanner")


def run_scan_all_on_directory(target_dir: Path) -> dict[str, Any]:
    """Run ``skill-scanner scan-all`` on a directory tree. Best-effort if CLI missing.

    Returns:
        Dict with ``skipped``, ``exit_code``, ``stdout``, ``stderr``, ``duration_sec``,
        and ``max_severity`` (heuristic from output when exit non-zero).
    """
    exe = _skill_scanner_executable()
    t0 = time.time()
    if exe is None:
        return {
            "skipped": True,
            "exit_code": None,
            "stdout": "",
            "stderr": "skill-scanner not on PATH",
            "duration_sec": 0.0,
            "max_severity": None,
        }

    policy = os.getenv("SKILL_SCANNER_POLICY", "balanced").strip() or "balanced"
    # Use the shared gate so behaviour matches the loaders. Default
    # is "strict" — see ``scan_gate.py`` for the policy table.
    from ai_platform_engineering.skills_middleware.scan_gate import get_scan_gate
    gate = get_scan_gate()
    fail_on = (os.getenv("SKILL_SCANNER_FAIL_ON") or "").strip()
    if gate == "strict" and not fail_on:
        fail_on = "high"

    cmd: list[str] = [exe, "scan-all", str(target_dir), "--recursive", "--policy", policy]
    if fail_on:
        cmd.extend(["--fail-on-severity", fail_on])

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=int(os.getenv("SKILL_SCANNER_TIMEOUT_SEC", "180")),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "skipped": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": "skill-scanner timed out",
            "duration_sec": time.time() - t0,
            "max_severity": "high",
        }
    except Exception as exc:
        logger.warning("skill-scanner execution failed: %s", type(exc).__name__)
        return {
            "skipped": False,
            "exit_code": -2,
            "stdout": "",
            "stderr": "skill-scanner execution failed",
            "duration_sec": time.time() - t0,
            "max_severity": None,
        }

    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    max_sev = _infer_max_severity(out)
    return {
        "skipped": False,
        "exit_code": proc.returncode,
        "stdout": (proc.stdout or "")[:12000],
        "stderr": (proc.stderr or "")[:8000],
        "duration_sec": time.time() - t0,
        "max_severity": max_sev,
    }


def _infer_max_severity(text: str) -> str | None:
    tl = text.lower()
    for sev in ("critical", "high", "medium", "low", "info"):
        if sev in tl:
            return sev
    return None


def severity_meets_threshold(max_severity: str | None, threshold: str) -> bool:
    """Return True if ``max_severity`` is at least as bad as ``threshold``."""
    if not max_severity:
        return False
    return _SEVERITY_RANK.get(max_severity, 0) >= _SEVERITY_RANK.get(threshold.lower(), 0)


def write_single_skill_to_temp_tree(name: str, content: str) -> Path:
    """Materialize one skill body under a fixed temp path for scanning."""
    root = Path(tempfile.mkdtemp(prefix="config-scan-")).resolve()
    d = root / "skill"
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(content, encoding="utf-8")
    return root


def write_skills_to_temp_tree(skills: list[dict[str, Any]], hub_id: str) -> Path:
    """Materialize hub skills as ``<tmp>/<sanitized>/SKILL.md`` for scanning."""
    import re

    root = Path(tempfile.mkdtemp(prefix=f"hub-scan-{hub_id}-"))
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "-", hub_id).strip("-") or "hub"

    for s in skills:
        name = str(s.get("name") or "skill")
        sub = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-") or "skill"
        body = s.get("content") if isinstance(s.get("content"), str) else ""
        if not body.strip():
            body = f"---\nname: {name}\ndescription: {s.get('description', '')}\n---\n"
        d = root / safe / sub
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(body, encoding="utf-8")

    return root / safe

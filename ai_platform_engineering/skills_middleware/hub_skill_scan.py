# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Hub ingest skill-scanner hook + Mongo ``skill_scan_findings`` (T056, SC-009)."""

from __future__ import annotations

import logging
import os
import shutil
import time
from typing import Any

logger = logging.getLogger(__name__)

_FINDINGS_COLLECTION = "skill_scan_findings"


def _findings_collection():
    try:
        from ai_platform_engineering.utils.mongodb_client import get_mongodb_client
    except ImportError:
        return None
    client = get_mongodb_client()
    if client is None:
        return None
    database = os.getenv("MONGODB_DATABASE", "caipe")
    return client[database][_FINDINGS_COLLECTION]


def _persist_scan_run(
    hub_id: str,
    result: dict[str, Any],
    *,
    blocked: bool,
    source_type: str = "hub",
    source_id: str | None = None,
) -> None:
    coll = _findings_collection()
    if coll is None:
        return
    doc: dict[str, Any] = {
        "source_type": source_type,
        "source_id": source_id or hub_id,
        "hub_id": hub_id if source_type == "hub" else None,
        "created_at": time.time(),
        "scan_type": "skill-scanner",
        "exit_code": result.get("exit_code"),
        "skipped": bool(result.get("skipped")),
        "duration_sec": result.get("duration_sec"),
        "max_severity": result.get("max_severity"),
        "blocked_merge": blocked,
        "summary": (result.get("stdout") or "")[:6000],
        "stderr_snippet": (result.get("stderr") or "")[:2000],
    }
    try:
        coll.insert_one(doc)
    except Exception as e:
        logger.warning("skill_scan_findings insert failed: %s", e)


def _update_hub_scan_fields(hub_id: str, result: dict[str, Any], blocked: bool) -> None:
    try:
        from ai_platform_engineering.utils.mongodb_client import get_mongodb_client
    except ImportError:
        return
    client = get_mongodb_client()
    if client is None:
        return
    database = os.getenv("MONGODB_DATABASE", "caipe")
    try:
        client[database]["skill_hubs"].update_one(
            {"id": hub_id},
            {
                "$set": {
                    "last_skill_scan_at": time.time(),
                    "last_skill_scan_exit_code": result.get("exit_code"),
                    "last_skill_scan_max_severity": result.get("max_severity"),
                    "last_skill_scan_blocked": blocked,
                }
            },
        )
    except Exception as e:
        logger.warning("skill_hubs scan field update failed: %s", e)


def hub_scan_should_block_merge(hub_id: str, skills: list[dict[str, Any]]) -> bool:
    """Run scanner after hub fetch; persist findings; return True to skip merging hub skills.

    Honor ``SKILL_SCANNER_GATE`` / ``SKILL_SCANNER_FAIL_ON`` (see ``skill-scanner-pipeline.md``).
    """
    if not skills:
        return False

    from ai_platform_engineering.skills_middleware.scan_gate import get_scan_gate
    gate = get_scan_gate()
    fail_on = (os.getenv("SKILL_SCANNER_FAIL_ON") or "").strip().lower()
    if gate == "strict" and not fail_on:
        fail_on = "high"

    from ai_platform_engineering.skills_middleware.skill_scanner_runner import (
        run_scan_all_on_directory,
        severity_meets_threshold,
        write_skills_to_temp_tree,
    )

    tmp_parent = None
    try:
        tree = write_skills_to_temp_tree(skills, hub_id)
        tmp_parent = tree.parent
        result = run_scan_all_on_directory(tree)
    except Exception as e:
        logger.warning("hub skill scan failed for %s: %s", hub_id, e)
        return False
    finally:
        if tmp_parent and tmp_parent.exists():
            try:
                shutil.rmtree(tmp_parent, ignore_errors=True)
            except Exception:
                pass

    blocked = False
    if not result.get("skipped") and result.get("exit_code") not in (0, None):
        if gate == "strict" and fail_on:
            max_sev = result.get("max_severity")
            blocked = severity_meets_threshold(max_sev, fail_on)
        elif gate == "strict":
            blocked = True

    _persist_scan_run(hub_id, result, blocked=blocked)
    _update_hub_scan_fields(hub_id, result, blocked)

    if blocked:
        logger.error(
            "Hub %s: skill-scanner blocked merge (gate=%s, exit=%s)",
            hub_id,
            gate,
            result.get("exit_code"),
        )
    return blocked

# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6

"""Tests for the temporary skill-scanner API router patch."""

from __future__ import annotations

import importlib.util
from pathlib import Path


PATCHER_PATH = (
    Path(__file__).resolve().parents[3]
    / "build"
    / "skill-scanner-patches"
    / "patch_router_validation_errors.py"
)


ROUTER_SOURCE = '''from ..core.scanner import SkillScanner

router = APIRouter()
scan_results_cache = _BoundedCache()

@router.post("/scan", response_model=ScanResponse)
async def scan_skill(request):
    try:
        result = await loop.run_in_executor(executor, run_scan)
        return ScanResponse(findings=[])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("Scan failed")
        raise HTTPException(status_code=500, detail="Internal scan error")
'''


def _load_patcher():
    spec = importlib.util.spec_from_file_location("patch_router_validation_errors", PATCHER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_patch_maps_skill_load_error_to_validation_response() -> None:
    patcher = _load_patcher()

    patched = patcher.patch_router_source(ROUTER_SOURCE)

    assert "from ..core.exceptions import SkillLoadError" in patched
    assert "except SkillLoadError as e:" in patched
    assert "status_code=422" in patched
    assert "detail=_sanitize_validation_detail(str(e))" in patched
    assert patched.index("except SkillLoadError as e:") < patched.index("except Exception:")


def test_validation_detail_is_sanitized_and_bounded() -> None:
    patcher = _load_patcher()
    detail = "bad\nTraceback (most recent call last):\nsecret-token=" + ("x" * 1000)

    sanitized = patcher._sanitize_validation_detail(detail)

    assert sanitized == "bad"
    assert "Traceback" not in sanitized
    assert "secret-token" not in sanitized
    assert "\n" not in sanitized
    assert len(sanitized) <= 240


def test_patch_preserves_generic_internal_error_handler() -> None:
    patcher = _load_patcher()

    patched = patcher.patch_router_source(ROUTER_SOURCE)

    assert 'logger.exception("Scan failed")' in patched
    assert 'raise HTTPException(status_code=500, detail="Internal scan error")' in patched


def test_patch_preserves_existing_bad_request_handler() -> None:
    patcher = _load_patcher()

    patched = patcher.patch_router_source(ROUTER_SOURCE)

    assert "except ValueError as e:" in patched
    assert "raise HTTPException(status_code=400, detail=str(e))" in patched


def test_patch_is_idempotent() -> None:
    patcher = _load_patcher()

    patched_once = patcher.patch_router_source(ROUTER_SOURCE)
    patched_twice = patcher.patch_router_source(patched_once)

    assert patched_once == patched_twice


def test_patch_router_file_updates_source(tmp_path: Path) -> None:
    patcher = _load_patcher()
    router_path = tmp_path / "router.py"
    router_path.write_text(ROUTER_SOURCE, encoding="utf-8")

    changed = patcher.patch_router_file(router_path)

    assert changed is True
    assert "except SkillLoadError as e:" in router_path.read_text(encoding="utf-8")

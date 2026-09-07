# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
# assisted-by Codex Codex-sonnet-4-6

"""Patch upstream skill-scanner API validation error handling.

This is a temporary image-local patch for cisco-ai-skill-scanner 2.0.11.
Remove it once the upstream package maps SkillLoadError to an HTTP
validation response itself.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


_SKILL_LOAD_ERROR_IMPORT = "from ..core.exceptions import SkillLoadError\n"
_SCANNER_IMPORT = "from ..core.scanner import SkillScanner\n"
_CACHE_SENTINEL = "scan_results_cache = _BoundedCache()\n"
_VALIDATION_HELPER = '''

def _sanitize_validation_detail(detail: str) -> str:
    """Return a single-line validation message safe for API callers."""
    normalized = " ".join(str(detail).split())
    if "Traceback (most recent call last):" in normalized:
        normalized = normalized.split("Traceback (most recent call last):", 1)[0].strip()

    lowered = normalized.lower()
    sensitive_markers = (
        "secret",
        "token",
        "password",
        "api_key",
        "apikey",
        "credential",
        "authorization",
        "bearer ",
    )
    runtime_markers = ("/app/", "/usr/", "site-packages", ".venv")
    if any(marker in lowered for marker in sensitive_markers) or any(
        marker in normalized for marker in runtime_markers
    ):
        return "Invalid skill definition"

    return (normalized or "Invalid skill definition")[:240]
'''
_ORIGINAL_HANDLER = '''    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("Scan failed")
        raise HTTPException(status_code=500, detail="Internal scan error")
'''
_PATCHED_HANDLER = '''    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SkillLoadError as e:
        raise HTTPException(status_code=422, detail=_sanitize_validation_detail(str(e))) from e
    except Exception:
        logger.exception("Scan failed")
        raise HTTPException(status_code=500, detail="Internal scan error")
'''


def _sanitize_validation_detail(detail: str) -> str:
    """Return a single-line validation message safe for API callers."""
    normalized = " ".join(str(detail).split())
    if "Traceback (most recent call last):" in normalized:
        normalized = normalized.split("Traceback (most recent call last):", 1)[0].strip()

    lowered = normalized.lower()
    sensitive_markers = (
        "secret",
        "token",
        "password",
        "api_key",
        "apikey",
        "credential",
        "authorization",
        "bearer ",
    )
    runtime_markers = ("/app/", "/usr/", "site-packages", ".venv")
    if any(marker in lowered for marker in sensitive_markers) or any(
        marker in normalized for marker in runtime_markers
    ):
        return "Invalid skill definition"

    return (normalized or "Invalid skill definition")[:240]


def patch_router_source(source: str) -> str:
    """Return router.py source with SkillLoadError mapped to HTTP 422."""
    if "except SkillLoadError as e:" in source:
        return source

    patched = source
    if _SKILL_LOAD_ERROR_IMPORT not in patched:
        if _SCANNER_IMPORT not in patched:
            raise RuntimeError("Cannot patch skill-scanner router: scanner import sentinel not found")
        patched = patched.replace(
            _SCANNER_IMPORT,
            f"{_SCANNER_IMPORT}{_SKILL_LOAD_ERROR_IMPORT}",
            1,
        )

    if "_sanitize_validation_detail" not in patched:
        if _CACHE_SENTINEL not in patched:
            raise RuntimeError("Cannot patch skill-scanner router: cache sentinel not found")
        patched = patched.replace(_CACHE_SENTINEL, f"{_CACHE_SENTINEL}{_VALIDATION_HELPER}", 1)

    if _ORIGINAL_HANDLER not in patched:
        raise RuntimeError("Cannot patch skill-scanner router: exception handler sentinel not found")
    return patched.replace(_ORIGINAL_HANDLER, _PATCHED_HANDLER, 1)


def patch_router_file(router_path: Path) -> bool:
    """Patch a router.py file in place and return True when it changed."""
    source = router_path.read_text(encoding="utf-8")
    patched = patch_router_source(source)
    if patched == source:
        return False
    router_path.write_text(patched, encoding="utf-8")
    return True


def _find_installed_router() -> Path:
    spec = importlib.util.find_spec("skill_scanner.api.router")
    if not spec or not spec.origin:
        raise RuntimeError("Cannot locate installed skill_scanner.api.router")
    return Path(spec.origin)


def main() -> None:
    """Patch the installed skill-scanner router."""
    router_path = _find_installed_router()
    changed = patch_router_file(router_path)
    state = "patched" if changed else "already patched"
    print(f"skill-scanner router validation errors: {state} ({router_path})")


if __name__ == "__main__":
    main()

"""Loader for `realm-config-extras.json`.

The extras file declares per-resource PDP-unavailable fallback rules. Schema:
`tests/rbac/contracts/realm-config-extras.schema.json`.

Path resolution order:
    1. `RBAC_FALLBACK_CONFIG_PATH` env var, if set.
    2. `/etc/keycloak/realm-config-extras.json` (production default — mounted by
       compose / helm).
    3. `deploy/keycloak/realm-config-extras.json` (development default, walked
       up from cwd).

Returns an empty dict when the file is missing or invalid — so callers default
to deny-all (`mode: "deny_all"`), matching the TS behaviour.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


_DEFAULT_PROD_PATH = Path("/etc/keycloak/realm-config-extras.json")
_REPO_RELATIVE_PATH = Path("deploy/keycloak/realm-config-extras.json")

_cache: dict[str, dict[str, Any]] | None = None


def _resolve_path() -> Path | None:
    explicit = os.environ.get("RBAC_FALLBACK_CONFIG_PATH")
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    if _DEFAULT_PROD_PATH.is_file():
        return _DEFAULT_PROD_PATH
    here = Path.cwd()
    for parent in [here, *here.parents]:
        candidate = parent / _REPO_RELATIVE_PATH
        if candidate.is_file():
            return candidate
    return None


def _load() -> dict[str, dict[str, Any]]:
    """Return the `pdp_unavailable_fallback` sub-document, or empty dict."""
    global _cache
    if _cache is not None:
        return _cache

    path = _resolve_path()
    if path is None:
        logger.info("realm_extras: no extras file found; defaulting to deny-all on PDP unavailable")
        _cache = {}
        return _cache

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("realm_extras: failed to load %s: %s", path, exc)
        _cache = {}
        return _cache

    if not isinstance(raw, dict) or raw.get("version") != 1:
        logger.warning("realm_extras: %s missing 'version: 1', ignoring", path)
        _cache = {}
        return _cache

    fallback = raw.get("pdp_unavailable_fallback")
    if not isinstance(fallback, dict):
        _cache = {}
        return _cache

    _cache = {k: v for k, v in fallback.items() if isinstance(v, dict)}
    logger.info("realm_extras: loaded %d fallback rule(s) from %s", len(_cache), path)
    return _cache


def get_fallback_rule(resource: str) -> dict[str, Any] | None:
    """Return the fallback rule for `resource`, or None."""
    return _load().get(resource)


def reset_cache_for_tests() -> None:
    """Drop the in-memory cache. Tests use this between scenarios."""
    global _cache
    _cache = None


__all__ = ["get_fallback_rule", "reset_cache_for_tests"]

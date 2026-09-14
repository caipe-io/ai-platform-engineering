# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Authentication utilities.

Spec 102 (T021): re-exports the canonical Python RBAC helper so call sites can
write ``from ai_platform_engineering.utils.auth import require_rbac_permission``.

Why lazy ``__getattr__`` (PEP 562)?
-----------------------------------
The eager form ``from .jwks_validate import …`` triggers ``import jwt`` (PyJWT)
at *package* import time. Some sibling packages pull this package in just to get
``token_context`` (which has no PyJWT dependency). When pytest collects under
``--import-mode=prepend`` (the project default) with multiple ``pytest.ini``
files in the tree, that eager chain reaches a state where Python's namespace
package resolution flips ``jwt`` to ``unknown location`` and raises
``ImportError: cannot import name 'InvalidTokenError' from 'jwt'``.

Lazy ``__getattr__`` defers the heavy imports until a caller actually
references one of the symbols, so ``from … .token_context import …`` continues
to work even in the broken-pytest-collection scenario.

The public API is unchanged — both ``from ai_platform_engineering.utils.auth
import require_rbac_permission`` and the explicit submodule path keep working.
"""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ai_platform_engineering.utils.auth.audit import log_authz_decision
    from ai_platform_engineering.utils.auth.jwks_validate import (
        InvalidTokenError,
        validate_bearer_jwt,
    )
    from ai_platform_engineering.utils.auth.keycloak_authz import (
        AuthzDecision,
        AuthzReason,
        current_bearer_token,
        require_rbac_permission,
        require_rbac_permission_dep,
    )
    from ai_platform_engineering.utils.auth.realm_extras import get_fallback_rule


__all__ = [
    "AuthzDecision",
    "AuthzReason",
    "InvalidTokenError",
    "current_bearer_token",
    "get_fallback_rule",
    "log_authz_decision",
    "require_rbac_permission",
    "require_rbac_permission_dep",
    "validate_bearer_jwt",
]


_LAZY_MAP = {
    "log_authz_decision": "ai_platform_engineering.utils.auth.audit",
    "InvalidTokenError": "ai_platform_engineering.utils.auth.jwks_validate",
    "validate_bearer_jwt": "ai_platform_engineering.utils.auth.jwks_validate",
    "AuthzDecision": "ai_platform_engineering.utils.auth.keycloak_authz",
    "AuthzReason": "ai_platform_engineering.utils.auth.keycloak_authz",
    "current_bearer_token": "ai_platform_engineering.utils.auth.keycloak_authz",
    "require_rbac_permission": "ai_platform_engineering.utils.auth.keycloak_authz",
    "require_rbac_permission_dep": "ai_platform_engineering.utils.auth.keycloak_authz",
    "get_fallback_rule": "ai_platform_engineering.utils.auth.realm_extras",
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute resolution for the package.

    Only the symbols listed in ``__all__`` are surfaced; everything else raises
    the standard ``AttributeError`` so typo-detection still works.
    """
    module_path = _LAZY_MAP.get(name)
    if module_path is None:
        raise AttributeError(
            f"module 'ai_platform_engineering.utils.auth' has no attribute {name!r}"
        )
    import importlib

    module = importlib.import_module(module_path)
    value = getattr(module, name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))

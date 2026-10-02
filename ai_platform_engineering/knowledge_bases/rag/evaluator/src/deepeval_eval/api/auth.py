"""Authentication & Access Control module for CAIPE DeepEval service.

Provides token verification, OIDC JWKS fetching, user identity context,
client-credentials machine detection, OpenFGA ReBAC evaluation/question_set
checks, tuple creation, and FastAPI route protection.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import time
from enum import Enum
from typing import Any

import httpx
import jwt
from fastapi import Depends, HTTPException, Request
from jwt import PyJWK
from jwt.exceptions import PyJWTError as JWTError
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from deepeval_eval.core.config import AuthSettings

logger = logging.getLogger(__name__)

OPENFGA_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
DEFAULT_OPENFGA_STORE_NAME = "caipe-openfga"
DEFAULT_ORG_KEY = "caipe"

# Default role for machine-to-machine client credentials tokens in evaluator
RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE = os.getenv(
    "RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE", "evaluator"
)
AUTH_SERVICE_UNAVAILABLE_DETAIL = "Authorization service is temporarily unavailable"
OPENFGA_WILDCARD_USER = "user:*"


def _load_monorepo_auth() -> tuple[bool, Any, Any]:
    """Compatibility stub for monorepo auth detection."""
    return (False, None, None)


MONOREPO_AUTH_AVAILABLE = False
caipe_rbac_bypass_enabled = None
caipe_require_authenticated_user = None


class Role:
    """Hierarchical roles matching CAIPE platform RBAC definitions."""

    READONLY = "readonly"
    EVALUATOR = "evaluator"
    INGESTONLY = "ingestonly"
    ADMIN = "admin"


class ResourceVisibility(str, Enum):
    """Resource visibility modes matching OpenFGA ReBAC models."""

    PRIVATE = "private"
    TEAM = "team"
    PUBLIC = "public"


class ResourceType(str, Enum):
    """Shareable resource types in DeepEval evaluator."""

    EVALUATION = "evaluation"
    QUESTION_SET = "question_set"


_ROLE_HIERARCHY = {
    Role.READONLY: 1,
    Role.EVALUATOR: 2,
    Role.INGESTONLY: 2,
    Role.ADMIN: 3,
}


def has_permission(user_role: str, required_role: str) -> bool:
    """Check if user_role satisfies required_role via hierarchy."""
    user_level = _ROLE_HIERARCHY.get(user_role, 0)
    required_level = _ROLE_HIERARCHY.get(required_role, 0)
    return user_level >= required_level


def is_unsafe_rbac_bypass_enabled() -> bool:
    """Return True when emergency RBAC bypass is explicitly enabled."""
    return os.getenv("CAIPE_UNSAFE_RBAC_BYPASS", "").strip().lower() in (
        "true",
        "1",
        "yes",
        "on",
    )


def is_client_credentials_token(claims: dict[str, Any]) -> bool:
    """Detect machine-to-machine client credentials tokens."""
    if claims.get("gty") == "client-credentials":
        return True
    if claims.get("grant_type") == "client-credentials":
        return True
    sub = claims.get("sub", "")
    client_id = claims.get("client_id") or claims.get("azp")
    if client_id and sub == client_id:
        return True
    pref_username = claims.get("preferred_username", "")
    if pref_username.startswith("service-account-") or pref_username.startswith(
        "client-"
    ):
        return True
    if (
        "email" not in claims
        and "preferred_username" not in claims
        and claims.get("client_id")
    ):
        return True
    return False


def extract_client_id_from_claims(claims: dict[str, Any]) -> str:
    """Extract client_id / app identifier from JWT claims."""
    cid = claims.get("client_id") or claims.get("azp")
    if cid:
        return str(cid)
    pref = claims.get("preferred_username", "")
    if pref.startswith("service-account-"):
        return pref[len("service-account-") :]
    if pref.startswith("client-"):
        return pref[len("client-") :]
    sub = claims.get("sub", "")
    if sub:
        return str(sub)
    return "unknown-client"


class UserContext(BaseModel):
    """Authenticated user context matching CAIPE identity model."""

    model_config = ConfigDict(frozen=True)

    subject: str | None = None
    email: str
    role: str = Role.READONLY
    is_authenticated: bool = True
    client_id: str | None = None
    groups: list[str] = Field(default_factory=list)


def allow_unauthenticated_access(settings: AuthSettings | None = None) -> bool:
    """Check if unauthenticated access is allowed for local dev/testing."""
    if is_unsafe_rbac_bypass_enabled():
        return True
    auth_settings = settings or AuthSettings()
    return auth_settings.allow_unauthenticated_access


class OIDCProvider:
    """Represents an OIDC provider with cached JWKS validation."""

    def __init__(
        self,
        issuer: str,
        audience: str,
        name: str = "default",
        discovery_url: str | None = None,
        jwks_url: str | None = None,
        verify_ssl: bool = True,
        strict_claims: bool = False,
    ):
        self.issuer = issuer.rstrip("/") if issuer else ""
        self.audience = audience
        self.name = name
        self.discovery_url = discovery_url
        self.jwks_uri: str | None = jwks_url.strip() if jwks_url else None
        self.jwks_cache: dict[str, Any] = {}
        self.jwks_cache_time: float = 0.0
        self.jwks_cache_ttl: int = 3600
        self.verify_ssl = verify_ssl
        self.strict_claims = strict_claims

    def _http_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=10.0, follow_redirects=True, verify=self.verify_ssl
        )

    async def get_jwks(self) -> dict[str, Any]:
        now = time.time()
        if self.jwks_cache and (now - self.jwks_cache_time) < self.jwks_cache_ttl:
            return self.jwks_cache

        if not self.jwks_uri:
            disc_url = (
                self.discovery_url or f"{self.issuer}/.well-known/openid-configuration"
            )
            async with self._http_client() as client:
                resp = await client.get(disc_url)
                resp.raise_for_status()
                data = resp.json()
                self.jwks_uri = data.get("jwks_uri")

        if not self.jwks_uri:
            raise ValueError(f"Could not determine JWKS URI for provider '{self.name}'")

        async with self._http_client() as client:
            resp = await client.get(self.jwks_uri)
            resp.raise_for_status()
            self.jwks_cache = resp.json()
            self.jwks_cache_time = now
            return self.jwks_cache

    async def validate_token(self, token: str) -> dict[str, Any]:
        jwks = await self.get_jwks()
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        if not kid:
            raise JWTError("Token header missing 'kid'")

        key_dict = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
        if not key_dict:
            raise JWTError(f"Key ID '{kid}' not found in JWKS")

        jwk = PyJWK.from_dict(key_dict)
        try:
            claims = jwt.decode(
                token,
                jwk.key,
                algorithms=[jwk.algorithm_name],
                audience=self.audience if self.audience else None,
                issuer=self.issuer if self.issuer else None,
                options={
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_nbf": True,
                    "verify_iat": True,
                    "verify_aud": bool(self.audience),
                    "verify_iss": bool(self.issuer),
                },
            )
            logger.debug(f"Token validated successfully for provider '{self.name}'")
            return claims
        except jwt.PyJWTError as err:
            logger.warning(
                f"OIDC JWT validation failed for provider '{self.name}': {err}"
            )
            raise JWTError(f"JWT validation failed: {err}") from err


class AuthManager:
    """Manages static API keys and OIDC token validation."""

    def __init__(self, settings: AuthSettings | None = None) -> None:
        self._explicit_settings = settings
        self.providers: dict[str, OIDCProvider] = {}
        self._load_providers()

    @property
    def settings(self) -> AuthSettings:
        return self._explicit_settings or AuthSettings()

    def _load_providers(self) -> None:
        issuer = self.settings.oidc_issuer_url
        audience = self.settings.oidc_audience or ""
        if issuer:
            self.providers["default"] = OIDCProvider(
                issuer=issuer,
                audience=audience,
                discovery_url=self.settings.oidc_discovery_url,
                jwks_url=self.settings.oidc_jwks_url,
                verify_ssl=self.settings.oidc_verify_ssl,
                strict_claims=self.settings.oidc_strict_claims,
            )

    async def validate_token(self, token: str) -> UserContext:
        expected_key = (
            self.settings.api_key.get_secret_value()
            if isinstance(self.settings.api_key, SecretStr)
            else self.settings.api_key
        )
        if expected_key and secrets.compare_digest(token, expected_key):
            return UserContext(
                subject="service-account-key",
                email="service-account@deepeval",
                role=Role.ADMIN,
                is_authenticated=True,
            )

        if not self.providers:
            self._load_providers()

        if not self.providers:
            if expected_key and not secrets.compare_digest(token, expected_key):
                raise JWTError("Invalid API key")
            raise JWTError("No OIDC providers configured and static key mismatch")

        errors = []
        for provider in self.providers.values():
            try:
                claims = await provider.validate_token(token)
                is_m2m = is_client_credentials_token(claims)
                client_id = extract_client_id_from_claims(claims) if is_m2m else None

                if is_m2m:
                    email = f"client:{client_id}"
                    role = RBAC_EVALUATOR_CLIENT_CREDENTIALS_ROLE
                else:
                    email = (
                        claims.get("email")
                        or claims.get("preferred_username")
                        or claims.get("sub")
                        or "user"
                    )
                    role = Role.READONLY

                groups_claim = claims.get("groups") or claims.get("roles") or []
                if isinstance(groups_claim, str):
                    groups_claim = [groups_claim]
                user_groups = (
                    [str(g) for g in groups_claim]
                    if isinstance(groups_claim, list)
                    else []
                )

                realm_roles = (
                    claims.get("realm_access", {}).get("roles", [])
                    if isinstance(claims.get("realm_access"), dict)
                    else []
                )
                all_roles = set(user_groups) | set(realm_roles)

                if not is_m2m:
                    if any(
                        r.lower() in ("admin", "realm-admin", "caipe-admin")
                        for r in all_roles
                    ):
                        role = Role.ADMIN
                    elif any(
                        r.lower() in ("evaluator", "evaluators") for r in all_roles
                    ):
                        role = Role.EVALUATOR

                return UserContext(
                    subject=claims.get("sub"),
                    email=email,
                    role=role,
                    is_authenticated=True,
                    client_id=client_id,
                    groups=user_groups,
                )
            except Exception as e:
                errors.append(str(e))

        raise JWTError(f"Token validation failed: {'; '.join(errors)}")


_auth_manager: AuthManager | None = None


def get_auth_manager() -> AuthManager:
    global _auth_manager
    if _auth_manager is None:
        _auth_manager = AuthManager()
    return _auth_manager


async def require_authenticated_user(
    request: Request,
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> UserContext:
    """FastAPI dependency to require authentication on protected endpoints."""
    auth_header = request.headers.get("Authorization")
    api_key_header = request.headers.get("X-API-Key")

    token = None
    if auth_header:
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        else:
            token = auth_header.strip()
    elif api_key_header:
        token = api_key_header.strip()

    if token:
        try:
            return await auth_manager.validate_token(token)
        except Exception as exc:
            logger.warning(f"Authentication failed for token: {exc}")
            raise HTTPException(
                status_code=401,
                detail=f"Invalid authentication token: {exc}",
            )

    settings = auth_manager.settings if hasattr(auth_manager, "settings") else None
    if allow_unauthenticated_access(settings):
        return UserContext(
            subject="anonymous-local-dev",
            email="anonymous@local",
            role=Role.ADMIN,
            is_authenticated=True,
        )

    raise HTTPException(
        status_code=401,
        detail="Missing authentication credentials. Provide a valid Bearer token or API key.",
    )


get_current_user = require_authenticated_user


def require_role(required_role: str):
    """Dependency factory checking coarse role + OpenFGA org-admin fallback for ADMIN."""

    async def role_checker(
        user: UserContext = Depends(require_authenticated_user),
    ) -> UserContext:
        if not has_permission(user.role, required_role):
            if required_role == Role.ADMIN and await _openfga_check_org_admin(user):
                return UserContext(
                    subject=user.subject,
                    email=user.email,
                    role=Role.ADMIN,
                    is_authenticated=True,
                    client_id=user.client_id,
                    groups=user.groups,
                )
            if required_role == Role.EVALUATOR and (
                await _openfga_check_object(
                    user, "can_evaluate", "organization", _caipe_org_key()
                )
                or await _openfga_check_org_admin(user)
            ):
                return UserContext(
                    subject=user.subject,
                    email=user.email,
                    role=Role.EVALUATOR,
                    is_authenticated=True,
                    client_id=user.client_id,
                    groups=user.groups,
                )
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required '{required_role}' role, but you have '{user.role}'.",
            )
        return user

    role_checker.__name__ = f"require_{required_role}"
    return role_checker


# ============================================================================
# OpenFGA ReBAC Integration for Evaluator
# ============================================================================


def _openfga_http_url() -> str | None:
    value = os.getenv("OPENFGA_HTTP", "").strip().rstrip("/")
    return value or None


def _openfga_store_name() -> str:
    return os.getenv("OPENFGA_STORE_NAME", "").strip() or DEFAULT_OPENFGA_STORE_NAME


def _caipe_org_key() -> str:
    value = os.getenv("CAIPE_ORG_KEY", "").strip()
    return value if OPENFGA_ID_PATTERN.fullmatch(value) else DEFAULT_ORG_KEY


def _openfga_user(user_context: UserContext) -> str | None:
    if user_context.client_id and OPENFGA_ID_PATTERN.fullmatch(user_context.client_id):
        return f"service_account:{user_context.client_id}"
    subject = getattr(user_context, "subject", None)
    if isinstance(subject, str) and OPENFGA_ID_PATTERN.fullmatch(subject):
        return f"user:{subject}"
    return None


def _has_unrestricted_eval_access(user_context: UserContext) -> bool:
    if is_unsafe_rbac_bypass_enabled():
        return True
    return False


def _openfga_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    host_header = (
        os.getenv("OPENFGA_HOST_HEADER", "").strip()
        or os.getenv("OPENFGA_HOST", "").strip()
    )
    if host_header and not host_header.startswith("http"):
        headers["Host"] = host_header
    return headers


_OPENFGA_STORE_ID_CACHE: dict[str, str] = {}


async def _get_openfga_store_id(client: httpx.AsyncClient, base_url: str) -> str:
    explicit_store_id = os.getenv("OPENFGA_STORE_ID", "").strip()
    if explicit_store_id:
        return explicit_store_id

    if base_url in _OPENFGA_STORE_ID_CACHE:
        return _OPENFGA_STORE_ID_CACHE[base_url]

    response = await client.get(f"{base_url}/stores", headers=_openfga_headers())
    response.raise_for_status()
    body = response.json()
    store_name = _openfga_store_name()
    for store in body.get("stores", []):
        if store.get("name") == store_name and store.get("id"):
            store_id = str(store["id"])
            _OPENFGA_STORE_ID_CACHE[base_url] = store_id
            return store_id
    raise RuntimeError(f"OpenFGA store {store_name} was not found")


async def _openfga_check_object(
    user_context: UserContext,
    relation: str,
    object_type: str,
    object_id: str,
) -> bool:
    base_url = _openfga_http_url()
    user = _openfga_user(user_context)
    if not base_url or not user:
        return False

    async with httpx.AsyncClient(timeout=5.0) as client:
        store_id = await _get_openfga_store_id(client, base_url)
        response = await client.post(
            f"{base_url}/stores/{store_id}/check",
            headers=_openfga_headers(),
            json={
                "tuple_key": {
                    "user": user,
                    "relation": relation,
                    "object": f"{object_type}:{object_id}",
                }
            },
        )
        response.raise_for_status()
        return bool(response.json().get("allowed"))


def _sync_get_openfga_store_id(client: httpx.Client, base_url: str) -> str:
    explicit_store_id = os.getenv("OPENFGA_STORE_ID", "").strip()
    if explicit_store_id:
        return explicit_store_id

    if base_url in _OPENFGA_STORE_ID_CACHE:
        return _OPENFGA_STORE_ID_CACHE[base_url]

    response = client.get(f"{base_url}/stores", headers=_openfga_headers())
    response.raise_for_status()
    body = response.json()
    store_name = _openfga_store_name()
    for store in body.get("stores", []):
        if store.get("name") == store_name and store.get("id"):
            store_id = str(store["id"])
            _OPENFGA_STORE_ID_CACHE[base_url] = store_id
            return store_id
    raise RuntimeError(f"OpenFGA store {store_name} was not found")


def sync_openfga_check_object(
    user: str,
    relation: str,
    object_type: str,
    object_id: str,
) -> bool:
    """Synchronously check OpenFGA object permissions for background worker threads."""
    base_url = _openfga_http_url()
    if not base_url or not user:
        return False

    with httpx.Client(timeout=5.0) as client:
        store_id = _sync_get_openfga_store_id(client, base_url)
        response = client.post(
            f"{base_url}/stores/{store_id}/check",
            headers=_openfga_headers(),
            json={
                "tuple_key": {
                    "user": user,
                    "relation": relation,
                    "object": f"{object_type}:{object_id}",
                }
            },
        )
        response.raise_for_status()
        return bool(response.json().get("allowed"))


def sync_authorize_evaluate_subject(
    subject: str,
    role: str | None = None,
) -> bool:
    """Synchronous JIT check verifying whether user subject still holds can_evaluate on org."""
    if is_unsafe_rbac_bypass_enabled():
        return True
    if role and has_permission(role, Role.ADMIN):
        return True
    if not _openfga_http_url():
        return True

    user_str = f"user:{subject}" if OPENFGA_ID_PATTERN.fullmatch(subject) else subject
    try:
        if sync_openfga_check_object(
            user_str, "can_manage", "organization", _caipe_org_key()
        ):
            return True
        if sync_openfga_check_object(
            user_str, "can_evaluate", "organization", _caipe_org_key()
        ):
            return True
    except Exception as exc:
        logger.warning(f"Sync OpenFGA evaluate check failed: {exc}")
        return False
    return False


def sync_authorize_agent_subject(
    subject: str,
    agent_id: str,
    role: str | None = None,
    scope: str = "read",
) -> bool:
    """Synchronous JIT check verifying whether subject still holds access to target agent."""
    if is_unsafe_rbac_bypass_enabled():
        return True
    if role and has_permission(role, Role.ADMIN):
        return True
    if not _openfga_http_url():
        return True

    user_str = f"user:{subject}" if OPENFGA_ID_PATTERN.fullmatch(subject) else subject
    relation = (
        "can_manage"
        if scope == "manage"
        else ("can_use" if scope == "use" else "can_read")
    )
    try:
        if sync_openfga_check_object(
            user_str, "can_manage", "organization", _caipe_org_key()
        ):
            return True
        if sync_openfga_check_object(user_str, relation, "agent", str(agent_id)):
            return True
    except Exception as exc:
        logger.warning(f"Sync OpenFGA agent check failed for {agent_id}: {exc}")
        return False
    return False


def sync_authorize_datasource_subject(
    subject: str,
    datasource_id: str,
    role: str | None = None,
    scope: str = "read",
) -> bool:
    """Synchronous JIT check verifying whether subject still holds access to target datasource."""
    if is_unsafe_rbac_bypass_enabled():
        return True
    if role and has_permission(role, Role.ADMIN):
        return True
    if not _openfga_http_url():
        return True

    user_str = f"user:{subject}" if OPENFGA_ID_PATTERN.fullmatch(subject) else subject
    relation = "can_manage" if scope == "manage" else "can_read"
    try:
        if sync_openfga_check_object(
            user_str, "can_manage", "organization", _caipe_org_key()
        ):
            return True
        if sync_openfga_check_object(
            user_str, relation, "data_source", str(datasource_id)
        ):
            return True
    except Exception as exc:
        logger.warning(
            f"Sync OpenFGA datasource check failed for {datasource_id}: {exc}"
        )
        return False
    return False


def sync_authorize_question_set_subject(
    subject: str,
    question_set_id: str | int,
    role: str | None = None,
    scope: str = "read",
) -> bool:
    """Synchronous JIT check verifying whether subject still holds access to target question set."""
    if is_unsafe_rbac_bypass_enabled():
        return True
    if role and has_permission(role, Role.ADMIN):
        return True
    if not _openfga_http_url():
        return True

    user_str = f"user:{subject}" if OPENFGA_ID_PATTERN.fullmatch(subject) else subject
    relation = "can_manage" if scope == "manage" else "can_read"
    try:
        if sync_openfga_check_object(
            user_str, "can_manage", "organization", _caipe_org_key()
        ):
            return True
        if sync_openfga_check_object(
            user_str, relation, "question_set", str(question_set_id)
        ):
            return True
    except Exception as exc:
        logger.warning(
            f"Sync OpenFGA question set check failed for {question_set_id}: {exc}"
        )
        return False
    return False


async def _openfga_check_org_admin(user_context: UserContext) -> bool:
    return await _openfga_check_object(
        user_context, "can_manage", "organization", _caipe_org_key()
    )


async def _openfga_write_tuples(
    writes: list[dict[str, str]] | None = None,
    deletes: list[dict[str, str]] | None = None,
) -> None:
    base_url = _openfga_http_url()
    if not base_url or (not writes and not deletes):
        return
    payload: dict[str, Any] = {}
    if writes:
        payload["writes"] = {"tuple_keys": writes}
    if deletes:
        payload["deletes"] = {"tuple_keys": deletes}

    async with httpx.AsyncClient(timeout=5.0) as client:
        store_id = await _get_openfga_store_id(client, base_url)
        response = await client.post(
            f"{base_url}/stores/{store_id}/write",
            headers=_openfga_headers(),
            json=payload,
        )
        response.raise_for_status()


async def _openfga_list_objects(
    user_context: UserContext,
    relation: str,
    object_type: str,
) -> list[str]:
    base_url = _openfga_http_url()
    user = _openfga_user(user_context)
    if not base_url or not user:
        return []

    async with httpx.AsyncClient(timeout=5.0) as client:
        store_id = await _get_openfga_store_id(client, base_url)
        response = await client.post(
            f"{base_url}/stores/{store_id}/list-objects",
            headers=_openfga_headers(),
            json={
                "user": user,
                "relation": relation,
                "type": object_type,
            },
        )
        response.raise_for_status()
        body = response.json()
        return [str(obj) for obj in body.get("objects", []) if isinstance(obj, str)]


async def authorize_evaluate(user_context: UserContext) -> None:
    """Authorize submitting evaluation jobs (organization#can_evaluate capability)."""
    if _has_unrestricted_eval_access(user_context):
        return
    if has_permission(user_context.role, Role.ADMIN):
        return
    if not _openfga_http_url() or not _openfga_user(user_context):
        return

    try:
        if await _openfga_check_org_admin(user_context):
            return
        if await _openfga_check_object(
            user_context, "can_evaluate", "organization", _caipe_org_key()
        ):
            return
    except Exception as exc:
        logger.warning(f"OpenFGA evaluate check failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail=AUTH_SERVICE_UNAVAILABLE_DETAIL,
        ) from exc

    raise HTTPException(
        status_code=403,
        detail="You do not have permission to submit evaluation jobs. Request the evaluator capability for your team.",
    )


async def authorize_evaluation_access(
    user_context: UserContext, evaluation_id: str, scope: str = "read"
) -> None:
    """Authorize access to a specific evaluation resource (type: evaluation)."""
    if _has_unrestricted_eval_access(user_context):
        return
    if has_permission(user_context.role, Role.ADMIN):
        return
    if not _openfga_http_url() or not _openfga_user(user_context):
        return

    relation = "can_manage" if scope == "manage" else "can_read"
    try:
        if await _openfga_check_org_admin(user_context):
            return
        if await _openfga_check_object(
            user_context, relation, "evaluation", evaluation_id
        ):
            return
    except Exception as exc:
        logger.warning(f"OpenFGA evaluation check failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail=AUTH_SERVICE_UNAVAILABLE_DETAIL,
        ) from exc

    raise HTTPException(
        status_code=403,
        detail=f"Access denied for evaluation '{evaluation_id}'.",
    )


async def authorize_question_set_access(
    user_context: UserContext, set_id: str, scope: str = "read"
) -> None:
    """Authorize access to a specific question_set resource (type: question_set)."""
    if _has_unrestricted_eval_access(user_context):
        return
    if has_permission(user_context.role, Role.ADMIN):
        return
    if not _openfga_http_url() or not _openfga_user(user_context):
        return

    relation = "can_manage" if scope == "manage" else "can_read"
    try:
        if await _openfga_check_org_admin(user_context):
            return
        if await _openfga_check_object(
            user_context, relation, "question_set", str(set_id)
        ):
            return
    except Exception as exc:
        logger.warning(f"OpenFGA question_set check failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail=AUTH_SERVICE_UNAVAILABLE_DETAIL,
        ) from exc

    raise HTTPException(
        status_code=403,
        detail=f"Access denied for question set '{set_id}'.",
    )


async def authorize_datasource_access(
    user_context: UserContext, datasource_id: str, scope: str = "read"
) -> None:
    """Authorize access to a target CAIPE data_source resource (type: data_source)."""
    if _has_unrestricted_eval_access(user_context):
        return
    if has_permission(user_context.role, Role.ADMIN):
        return
    if not _openfga_http_url() or not _openfga_user(user_context):
        return

    relation = "can_manage" if scope == "manage" else "can_read"
    try:
        if await _openfga_check_org_admin(user_context):
            return
        if await _openfga_check_object(
            user_context, relation, "data_source", str(datasource_id)
        ):
            return
    except Exception as exc:
        logger.warning(f"OpenFGA data_source check failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail=AUTH_SERVICE_UNAVAILABLE_DETAIL,
        ) from exc

    raise HTTPException(
        status_code=403,
        detail=f"Access denied for data source '{datasource_id}'. Request access to this data source from your administrator.",
    )


async def authorize_agent_access(
    user_context: UserContext, agent_id: str, scope: str = "read"
) -> None:
    """Authorize access to a target dynamic agent resource (type: agent)."""
    if _has_unrestricted_eval_access(user_context):
        return
    if has_permission(user_context.role, Role.ADMIN):
        return
    if not _openfga_http_url() or not _openfga_user(user_context):
        return

    relation = (
        "can_manage"
        if scope == "manage"
        else ("can_use" if scope == "use" else "can_read")
    )
    try:
        if await _openfga_check_org_admin(user_context):
            return
        if await _openfga_check_object(user_context, relation, "agent", str(agent_id)):
            return
    except Exception as exc:
        logger.warning(f"OpenFGA agent check failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail=AUTH_SERVICE_UNAVAILABLE_DETAIL,
        ) from exc

    raise HTTPException(
        status_code=403,
        detail=f"Access denied for agent '{agent_id}'. Request access to this agent from your administrator.",
    )


async def get_allowed_resource_ids(
    user_context: UserContext, object_type: str, relation: str = "can_read"
) -> list[str] | None:
    """Get list of allowed object IDs for a user via OpenFGA list-objects.

    Returns None if the user has admin / unrestricted access (no ID filtering needed).
    Returns a list of ID strings if filtered by ReBAC permissions.
    """
    if _has_unrestricted_eval_access(user_context):
        return None
    if has_permission(user_context.role, Role.ADMIN) or has_permission(
        user_context.role, Role.EVALUATOR
    ):
        return None
    if not _openfga_http_url() or not _openfga_user(user_context):
        return None

    try:
        if await _openfga_check_org_admin(user_context) or await _openfga_check_object(
            user_context, "can_evaluate", "organization", _caipe_org_key()
        ):
            return None

        objects = await _openfga_list_objects(user_context, relation, object_type)
        prefix = f"{object_type}:"
        return [obj[len(prefix) :] for obj in objects if obj.startswith(prefix)]
    except Exception as exc:
        logger.warning(f"OpenFGA list_objects check failed for {object_type}: {exc}")
        return []


async def write_evaluation_ownership(
    job_id: str,
    owner_team_slug: str | None,
    visibility: str | None,
    user_context: UserContext,
) -> None:
    """Best-effort writing of OpenFGA tuples for newly created evaluation jobs."""
    if not _openfga_http_url():
        return

    eval_obj = f"evaluation:{job_id}"
    author = _openfga_user(user_context)
    writes: list[dict[str, str]] = []

    if author:
        writes.append({"user": author, "relation": "creator", "object": eval_obj})

    normalized_owner = (
        owner_team_slug.strip()
        if isinstance(owner_team_slug, str) and owner_team_slug.strip()
        else (user_context.groups[0] if user_context.groups else None)
    )

    if normalized_owner:
        writes.append(
            {
                "user": f"team:{normalized_owner}#member",
                "relation": "reader",
                "object": eval_obj,
            }
        )
        writes.append(
            {
                "user": f"team:{normalized_owner}#admin",
                "relation": "manager",
                "object": eval_obj,
            }
        )
    elif author:
        writes.append({"user": author, "relation": "owner", "object": eval_obj})

    if visibility == "public":
        writes.append(
            {"user": OPENFGA_WILDCARD_USER, "relation": "reader", "object": eval_obj}
        )

    try:
        await _openfga_write_tuples(writes)
        logger.info(f"Wrote ownership tuples for evaluation {job_id}")
    except Exception as exc:
        logger.warning(f"Failed to write OpenFGA tuples for evaluation {job_id}: {exc}")


async def write_question_set_ownership(
    set_id: str | int,
    owner_team_slug: str | None,
    visibility: str | None,
    user_context: UserContext,
) -> None:
    """Best-effort writing of OpenFGA tuples for newly created question sets."""
    if not _openfga_http_url():
        return

    qs_obj = f"question_set:{set_id}"
    author = _openfga_user(user_context)
    writes: list[dict[str, str]] = []

    if author:
        writes.append({"user": author, "relation": "creator", "object": qs_obj})

    normalized_owner = (
        owner_team_slug.strip()
        if isinstance(owner_team_slug, str) and owner_team_slug.strip()
        else (user_context.groups[0] if user_context.groups else None)
    )

    if normalized_owner:
        writes.append(
            {
                "user": f"team:{normalized_owner}#member",
                "relation": "reader",
                "object": qs_obj,
            }
        )
        writes.append(
            {
                "user": f"team:{normalized_owner}#admin",
                "relation": "manager",
                "object": qs_obj,
            }
        )
    elif author:
        writes.append({"user": author, "relation": "owner", "object": qs_obj})

    if visibility == "public":
        writes.append(
            {"user": OPENFGA_WILDCARD_USER, "relation": "reader", "object": qs_obj}
        )

    try:
        await _openfga_write_tuples(writes)
        logger.info(f"Wrote ownership tuples for question set {set_id}")
    except Exception as exc:
        logger.warning(
            f"Failed to write OpenFGA tuples for question set {set_id}: {exc}"
        )


async def update_resource_visibility(
    object_type: ResourceType | str,
    object_id: str | int,
    visibility: ResourceVisibility | str,
    owner_team_slug: str | None,
    user_context: UserContext,
) -> None:
    """Update OpenFGA ownership and visibility tuples for an evaluation or question set."""
    if not _openfga_http_url():
        return

    obj_type_str = (
        object_type.value if hasattr(object_type, "value") else str(object_type)
    )
    vis_str = visibility.value if hasattr(visibility, "value") else str(visibility)
    target_obj = f"{obj_type_str}:{object_id}"
    writes: list[dict[str, str]] = []
    deletes: list[dict[str, str]] = []

    normalized_owner = (
        owner_team_slug.strip()
        if isinstance(owner_team_slug, str) and owner_team_slug.strip()
        else (user_context.groups[0] if user_context.groups else None)
    )

    if normalized_owner:
        writes.append(
            {
                "user": f"team:{normalized_owner}#member",
                "relation": "reader",
                "object": target_obj,
            }
        )
        writes.append(
            {
                "user": f"team:{normalized_owner}#admin",
                "relation": "manager",
                "object": target_obj,
            }
        )

    if vis_str in (ResourceVisibility.PUBLIC.value, "public"):
        writes.append(
            {"user": OPENFGA_WILDCARD_USER, "relation": "reader", "object": target_obj}
        )
    else:
        deletes.append(
            {"user": OPENFGA_WILDCARD_USER, "relation": "reader", "object": target_obj}
        )

    safe_id = (
        str(object_id)
        if OPENFGA_ID_PATTERN.fullmatch(str(object_id))
        else str(object_id).replace("\n", "").replace("\r", "")[:128]
    )
    safe_owner = (
        normalized_owner
        if normalized_owner and OPENFGA_ID_PATTERN.fullmatch(normalized_owner)
        else (
            str(normalized_owner).replace("\n", "").replace("\r", "")[:64]
            if normalized_owner
            else "none"
        )
    )

    try:
        await _openfga_write_tuples(writes=writes, deletes=deletes)
        logger.info(
            f"Updated visibility tuples for {obj_type_str} {safe_id} (visibility={vis_str}, owner={safe_owner})"
        )
    except Exception as exc:
        logger.warning(
            f"Failed to update OpenFGA visibility tuples for {obj_type_str} {safe_id}: {exc}"
        )


def RequirePermission(permission: str) -> Any:
    """Permission guard helper matching CAIPE platform security dependencies."""

    def _permission_guard(
        user: UserContext = Depends(require_authenticated_user),
    ) -> UserContext:
        if permission == "admin" and user.role != Role.ADMIN:
            raise HTTPException(
                status_code=403,
                detail=f"User lacks required '{permission}' permission",
            )
        return user

    return _permission_guard


def check_resource_visibility(
    resource_visibility: str | None,
    owner_id: str | None,
    owner_team: str | None,
    user_id: str | None,
    user_teams: set[str] | list[str] | None,
    is_admin: bool = False,
    is_system: bool = False,
) -> bool:
    """App-Level Visibility Filtering without OpenFGA ReBAC dependencies.

    Access Matrix:
      1. System built-in records or Admin role -> ALLOW ALL
      2. visibility == 'public' -> ALLOW ALL
      3. visibility == 'team' -> ALLOW if owner_team matches any of user's teams/groups
      4. visibility == 'private' -> ALLOW if owner_id matches user's sub/user_id
    """
    if is_system or is_admin:
        return True

    vis = (resource_visibility or "private").strip().lower()

    if vis == "public":
        return True

    teams_set = set(user_teams) if user_teams else set()
    if vis == "team":
        return bool(owner_team and owner_team in teams_set)

    if vis == "private":
        return bool(owner_id and user_id and owner_id == user_id)

    return False


def authorize_prompt_style_access(
    user_context: UserContext,
    prompt_style: dict[str, Any],
    scope: str = "read",
) -> None:
    """Authorize access to a prompt style resource via App-Level Visibility filtering."""
    if is_unsafe_rbac_bypass_enabled():
        return

    is_admin = has_permission(user_context.role, Role.ADMIN)
    if is_admin:
        return

    is_system = bool(prompt_style.get("is_system"))
    if scope == "read" and is_system:
        return

    if scope == "manage" and is_system:
        raise HTTPException(
            status_code=403,
            detail="System prompt styles are read-only and cannot be modified or deleted.",
        )

    user_id = getattr(user_context, "subject", None) or getattr(
        user_context, "client_id", None
    )
    user_teams = getattr(user_context, "groups", None) or []

    has_access = check_resource_visibility(
        resource_visibility=prompt_style.get("visibility"),
        owner_id=prompt_style.get("owner_id"),
        owner_team=prompt_style.get("owner_team"),
        user_id=user_id,
        user_teams=user_teams,
        is_admin=is_admin,
        is_system=is_system,
    )

    if not has_access:
        style_name = prompt_style.get("name", "unknown")
        raise HTTPException(
            status_code=403,
            detail=f"Access denied for prompt style '{style_name}'.",
        )


def authorize_metric_access(
    user_context: UserContext,
    metric_record: dict[str, Any],
    scope: str = "read",
) -> None:
    """Authorize access to a metric definition via Admin-Managed policy."""
    if is_unsafe_rbac_bypass_enabled():
        return

    if scope == "read":
        # Public read-only access for all authenticated users
        return

    is_admin = has_permission(user_context.role, Role.ADMIN)
    if not is_admin:
        metric_name = metric_record.get("name", "unknown")
        raise HTTPException(
            status_code=403,
            detail=f"Only administrators can modify or delete metric '{metric_name}'.",
        )

    is_system = bool(metric_record.get("is_system"))
    if scope == "delete" and is_system:
        raise HTTPException(
            status_code=403,
            detail="System metrics are read-only and cannot be deleted.",
        )


def authorize_metric_set_access(
    user_context: UserContext,
    metric_set_record: dict[str, Any],
    scope: str = "read",
) -> None:
    """Authorize access to a metric set bundle via Admin-Managed policy."""
    if is_unsafe_rbac_bypass_enabled():
        return

    if scope == "read":
        # Public read-only access for all authenticated users
        return

    is_admin = has_permission(user_context.role, Role.ADMIN)
    if not is_admin:
        set_name = metric_set_record.get("name", "unknown")
        raise HTTPException(
            status_code=403,
            detail=f"Only administrators can modify or delete metric set '{set_name}'.",
        )

    is_system = bool(metric_set_record.get("is_system"))
    if scope == "delete" and is_system:
        raise HTTPException(
            status_code=403,
            detail="System metric sets are read-only and cannot be deleted.",
        )

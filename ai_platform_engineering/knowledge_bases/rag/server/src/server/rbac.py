"""
Role-Based Access Control (RBAC) implementation for the RAG API.

Role Hierarchy:
- READONLY: Authenticated human users and read-only service clients
- INGESTONLY: Ingestor service clients
- ADMIN: Administrative service clients

This module provides:
- User context extraction from JWT tokens (Bearer authentication)
- Service role determination for client-credentials tokens
- Fine-grained knowledge-base and datasource authorization via OpenFGA
- FastAPI dependencies for role-based endpoint protection
"""

import os
import re
import hashlib
from typing import List, Dict, Any, Optional
from fastapi import Depends, HTTPException, Request
from jwt.exceptions import PyJWTError as JWTError
import httpx
from common.models.rbac import Role, UserContext
from common.models.server import QueryRequest
from common import utils
from server.auth import get_auth_manager, AuthManager

logger = utils.get_logger(__name__)

# Email validation regex (RFC 5322 simplified)
EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
OPENFGA_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
DEFAULT_OPENFGA_STORE_NAME = "caipe-openfga"
DEFAULT_ORG_KEY = "caipe"

# ============================================================================
# Configuration
# ============================================================================

# Default role for client credentials tokens (machine-to-machine)
# These tokens don't have user/group information, so we assign a fixed role
RBAC_CLIENT_CREDENTIALS_ROLE = os.getenv("RBAC_CLIENT_CREDENTIALS_ROLE", Role.INGESTONLY)

# Validate roles at startup
VALID_ROLES = {Role.READONLY, Role.INGESTONLY, Role.ADMIN}

if RBAC_CLIENT_CREDENTIALS_ROLE not in VALID_ROLES:
  logger.error(f"Invalid RBAC_CLIENT_CREDENTIALS_ROLE: '{RBAC_CLIENT_CREDENTIALS_ROLE}'. Must be one of: {VALID_ROLES}")
  raise ValueError(f"Invalid RBAC_CLIENT_CREDENTIALS_ROLE: '{RBAC_CLIENT_CREDENTIALS_ROLE}'. Valid values are: {', '.join(VALID_ROLES)}")

logger.info("RBAC Configuration:")
logger.info("  Human coarse roles: authenticated identity only")
logger.info("  RAG authorization: OpenFGA ReBAC")
logger.info(f"  RBAC_CLIENT_CREDENTIALS_ROLE: {RBAC_CLIENT_CREDENTIALS_ROLE}")


def _unsafe_rbac_bypass_enabled() -> bool:
  return os.getenv("CAIPE_UNSAFE_RBAC_BYPASS", "").strip().lower() in ("1", "true", "yes", "on")

# ============================================================================
# Role Hierarchy and Permission Logic
# ============================================================================

# Define role hierarchy (higher number = more permissions, inherits lower)
_ROLE_HIERARCHY = {
  Role.READONLY: 1,
  Role.INGESTONLY: 2,
  Role.ADMIN: 3,
}


def has_permission(user_role: str, required_role: str) -> bool:
  """
  Check if a user's role has sufficient permissions for the required role.

  Roles are hierarchical - higher roles inherit permissions from lower roles.

  Args:
      user_role: The user's current role
      required_role: The minimum required role for the operation

  Returns:
      True if user has sufficient permissions, False otherwise

  Examples:
      has_permission(Role.ADMIN, Role.READONLY) -> True
      has_permission(Role.INGESTONLY, Role.READONLY) -> True
      has_permission(Role.READONLY, Role.ADMIN) -> False
  """
  user_level = _ROLE_HIERARCHY.get(user_role, 0)
  required_level = _ROLE_HIERARCHY.get(required_role, 0)
  return user_level >= required_level


def get_permissions(user_role: str) -> List[str]:
  """
  Get all permissions the user has based on their role.

  Permissions are hierarchical based on role:
  - READONLY: ["read"]
  - INGESTONLY: ["read", "ingest"]
  - ADMIN: ["read", "ingest", "delete"]

  Args:
      user_role: The user's current role

  Returns:
      List of permission strings (without "can_" prefix)

  Examples:
      get_permissions(Role.READONLY) -> ["read"]
      get_permissions(Role.INGESTONLY) -> ["read", "ingest"]
      get_permissions(Role.ADMIN) -> ["read", "ingest", "delete"]
  """
  permissions = []

  # All authenticated roles can read
  if has_permission(user_role, Role.READONLY):
    permissions.append("read")

  # INGESTONLY and ADMIN can ingest
  if has_permission(user_role, Role.INGESTONLY):
    permissions.append("ingest")

  # Only ADMIN can delete
  if has_permission(user_role, Role.ADMIN):
    permissions.append("delete")

  return permissions


_KB_SCOPE_RANK = {"read": 1, "ingest": 2, "admin": 3}


def kb_scope_satisfies(perm_scope: str, required: str) -> bool:
  """Return True if a KB permission scope meets the required access level."""
  return _KB_SCOPE_RANK.get(perm_scope, 0) >= _KB_SCOPE_RANK.get(required, 0)


# ============================================================================
# Claim Extraction (matches UI logic)
# ============================================================================


def is_client_credentials_token(claims: Dict[str, Any]) -> bool:
  """
  Detect if a token is a client credentials token (machine-to-machine).

  Client credentials tokens typically:
  - Have client_id but no user-specific claims (email, preferred_username)
  - May have grant_type or token_use indicating client credentials
  - Subject (sub) is often a client ID (UUID or client identifier)

  Args:
      claims: JWT token claims

  Returns:
      True if token appears to be client credentials, False otherwise
  """
  # Check for explicit grant type
  grant_type = claims.get("grant_type")
  if grant_type == "client_credentials":
    logger.debug(f"Client credentials detected via grant_type: {grant_type}")
    return True

  # Keycloak client-credentials tokens include `preferred_username` in the
  # form `service-account-<client_id>`, which is not a human user claim.
  has_client_id = bool(claims.get("client_id") or claims.get("azp") or claims.get("clientId"))
  preferred_username = claims.get("preferred_username")
  if has_client_id and isinstance(preferred_username, str) and preferred_username.startswith("service-account-"):
    logger.debug("Client credentials detected: Keycloak service account token")
    return True

  # Check for client_id without typical user claims
  has_user_claims = bool(claims.get("email") or claims.get("preferred_username") or claims.get("upn") or claims.get("name"))

  logger.debug(f"Client credentials check: has_client_id={has_client_id}, has_user_claims={has_user_claims}")

  # If has client_id but no user claims, likely client credentials
  if has_client_id and not has_user_claims:
    logger.debug("Client credentials detected: has client_id but no user claims")
    return True

  # Check token_use claim (some providers include this)
  token_use = claims.get("token_use")
  if token_use == "client_credentials":
    logger.debug(f"Client credentials detected via token_use: {token_use}")
    return True

  # Check if sub is a UUID (common for client credentials) and no user claims
  sub = claims.get("sub", "")
  if not has_user_claims and len(sub) == 36 and sub.count("-") == 4:
    # Looks like a UUID format
    logger.debug("Client credentials detected: UUID-like sub with no user claims")
    return True

  logger.debug("Not detected as client credentials token")
  return False
def extract_client_id_from_claims(claims: Dict[str, Any]) -> str:
  """
  Extract client ID from JWT claims for client credentials tokens.

  Args:
      claims: JWT token claims

  Returns:
      Client ID string
  """
  return (
    claims.get("client_id")
    or claims.get("azp")  # Authorized party (Google, Keycloak)
    or claims.get("clientId")
    or claims.get("appid")  # Azure AD
    or claims.get("sub")  # Fallback to subject
    or "unknown-client"
  )


def extract_email_from_claims(claims: Dict[str, Any]) -> str:
  """
  Extract email from JWT claims with fallback chain.
  Matches the logic used in UI for consistency.

  Priority order:
  1. email claim (standard OIDC)
  2. preferred_username (common in Keycloak, Azure AD)
  3. upn (User Principal Name - Microsoft)
  4. sub (subject - last resort, usually opaque ID)

  Args:
      claims: JWT token claims

  Returns:
      Email or user identifier string
  """
  return claims.get("email") or claims.get("preferred_username") or claims.get("upn") or claims.get("sub") or "unknown"


# ============================================================================
# FastAPI Dependencies
# ============================================================================


async def _authenticate_from_token(request: Request, auth_manager: AuthManager) -> Optional[UserContext]:
  """
  Internal helper to authenticate user from JWT token.

  For user tokens, extracts identity from the already-validated OIDC access
  token. Knowledge-base authorization is enforced later through OpenFGA.

  Flow:
  1. Validate access_token (signature, expiry, audience, issuer)
  2. Check if client credentials token (machine-to-machine) → return immediately
  3. Extract 'sub', email, and realm roles from access_token for audit context
  4. Assign the authenticated human baseline role; resource grants come from OpenFGA

  Returns:
      UserContext if authentication successful, None if no auth or invalid
  """
  # Extract Bearer token
  auth_header = request.headers.get("Authorization")
  if not auth_header or not auth_header.startswith("Bearer "):
    return None

  token = auth_header[7:]  # Remove "Bearer " prefix

  # Extract optional ingestor identification headers
  ingestor_type = request.headers.get("X-Ingestor-Type")
  ingestor_name = request.headers.get("X-Ingestor-Name")

  # Validate token against configured providers
  try:
    provider, access_claims = await auth_manager.validate_token(token)
    logger.debug(f"Access token validated by provider '{provider.name}'")
    logger.debug(f"Access token claims keys: {list(access_claims.keys())}")

    # Check if this is a client credentials token (machine-to-machine)
    if is_client_credentials_token(access_claims):
      client_id = extract_client_id_from_claims(access_claims)

      # Enrich logging with ingestor info if provided
      if ingestor_type and ingestor_name:
        logger.info(f"Client credentials token detected: client_id={client_id}, ingestor_type={ingestor_type}, ingestor_name={ingestor_name}, provider={provider.name}, assigning role={RBAC_CLIENT_CREDENTIALS_ROLE}")
        email = f"client:{ingestor_type}:{ingestor_name}"
      else:
        logger.info(f"Client credentials token detected: client_id={client_id}, provider={provider.name}, assigning role={RBAC_CLIENT_CREDENTIALS_ROLE}")
        email = f"client:{client_id}"

      user_context = UserContext(
        subject=access_claims.get("sub") if isinstance(access_claims.get("sub"), str) else client_id,
        subject_type="service_account",
        client_id=client_id,
        email=email,
        role=RBAC_CLIENT_CREDENTIALS_ROLE,
        is_authenticated=True,
      )

      logger.debug(f"Client authenticated: {email}, role: {RBAC_CLIENT_CREDENTIALS_ROLE}")
      return user_context
    else:
      logger.debug("Regular user token detected (not client credentials)")

    # Extract user identity from the validated Keycloak token.
    sub = access_claims.get("sub")
    if not sub:
      logger.warning("Access token missing 'sub' claim")
      sub = "unknown"
    else:
      logger.debug(f"Extracted sub from access_token: {sub[:16]}...")

    email = extract_email_from_claims(access_claims)

    # Validate email format for human tokens. Service-account tokens return
    # before this branch, and KB authz is OpenFGA-based instead of email-based.
    if email and email != "unknown" and not EMAIL_REGEX.match(email):
      logger.warning(f"Invalid email format in claims: {email[:50]}")

    role = Role.READONLY

    user_context = UserContext(
      subject=sub if sub != "unknown" else None,
      email=email,
      role=role,
      is_authenticated=True,
    )

    logger.info(
      "User authenticated successfully: email=%s, source=access_token, authorization=openfga",
      email,
    )
    return user_context

  except JWTError as e:
    logger.warning(f"Token validation failed: {e}")
    return None


async def require_authenticated_user(request: Request, auth_manager: AuthManager = Depends(get_auth_manager)) -> UserContext:
  """
  Require authentication and extract user context from a JWT token.

  This dependency REQUIRES valid authentication. If authentication is missing or invalid,
  it raises HTTPException(401). Use this for protected endpoints that need authentication.

  Authentication flow:
  1. If Bearer token present, validate JWT and extract user context
  2. Otherwise raise 401

  Args:
      request: FastAPI request object
      auth_manager: Auth manager with OIDC providers

  Returns:
      UserContext with authentication and role information

  Raises:
      HTTPException(401): If authentication fails or is missing
  """
  # If an Authorization header is present, always authenticate via JWT
  auth_header = request.headers.get("Authorization")
  if auth_header:
    if not auth_header.startswith("Bearer "):
      raise HTTPException(status_code=401, detail="Invalid Authorization header format. Expected 'Bearer <token>'.")

    user = await _authenticate_from_token(request, auth_manager)
    if user:
      return user

    raise HTTPException(status_code=401, detail="Invalid or expired token.")

  if _unsafe_rbac_bypass_enabled():
    logger.warning("CAIPE_UNSAFE_RBAC_BYPASS=true: allowing unauthenticated RAG request as local admin")
    return UserContext(
      subject="anonymous-local-dev",
      email="anonymous@local",
      role=Role.ADMIN,
      is_authenticated=True,
    )

  # No token
  raise HTTPException(status_code=401, detail="Missing Authorization header. Please provide a valid Bearer token.")


def require_role(required_role: str):
  """
  Factory function to create role-checking dependencies.

  This is the recommended way to protect endpoints with role requirements.

  Usage:
      @app.get("/protected")
      async def protected_endpoint(user: UserContext = Depends(require_role(Role.READONLY))):
          # Only users with READONLY or higher can access
          pass

      @app.post("/ingest")
      async def ingest_endpoint(user: UserContext = Depends(require_role(Role.INGESTONLY))):
          # Only INGESTONLY or ADMIN can access
          pass

      @app.delete("/resource")
      async def delete_endpoint(user: UserContext = Depends(require_role(Role.ADMIN))):
          # Only ADMIN can access
          pass

  Args:
      required_role: The minimum role required (Role.READONLY, Role.INGESTONLY, or Role.ADMIN)

  Returns:
      FastAPI dependency function that validates user has required role
  """

  async def role_checker(user: UserContext = Depends(require_authenticated_user)) -> UserContext:
    # ADMIN is always an OpenFGA organization decision. A configurable coarse
    # role on a client-credentials token must not turn every service account
    # into a RAG superuser.
    if required_role == Role.ADMIN:
      if is_unsafe_rbac_bypass_enabled():
        return user
      if not _openfga_http_url() or not _openfga_user(user):
        raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
      try:
        allowed = await _openfga_check_org_admin(user)
      except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
        logger.warning("OpenFGA organization admin check failed: %s", exc)
        raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
      if allowed:
        logger.debug(f"OpenFGA org-admin grant elevated {user.email} to admin for this request")
        return UserContext(
          subject=user.subject,
          subject_type=user.subject_type,
          client_id=user.client_id,
          email=user.email,
          role=Role.ADMIN,
          is_authenticated=True,
        )
      logger.warning("Access denied for %s: missing organization#can_manage", user.email)
      raise HTTPException(status_code=403, detail="This operation requires organization administrator access")

    if not has_permission(user.role, required_role):
      logger.warning(f"Access denied for {user.email}: required {required_role}, has {user.role}")
      raise HTTPException(status_code=403, detail=(f"Insufficient permissions. This operation requires '{required_role}' role, but you have '{user.role}' role. Please contact your administrator to request the appropriate access level."))
    return user

  # Set a descriptive name for better debugging
  role_checker.__name__ = f"require_{required_role}"
  return role_checker


# ============================================================================
# OpenFGA-backed RAG authorization
# ============================================================================


def _openfga_http_url() -> Optional[str]:
  """Return the configured OpenFGA HTTP base URL, if enabled."""
  value = os.getenv("OPENFGA_HTTP", "").strip().rstrip("/")
  return value or None


def _openfga_store_name() -> str:
  return os.getenv("OPENFGA_STORE_NAME", "").strip() or DEFAULT_OPENFGA_STORE_NAME


def _scope_to_openfga_relation(scope: str) -> str:
  if scope == "admin":
    return "can_manage"
  if scope == "ingest":
    return "can_ingest"
  return "can_read"


def is_unsafe_rbac_bypass_enabled() -> bool:
  """Return True when the shared emergency RBAC bypass is explicitly enabled."""
  return os.getenv("CAIPE_UNSAFE_RBAC_BYPASS", "").strip().lower() in ("true", "1", "yes")


def is_trusted_ingestor_service(user_context: UserContext) -> bool:
  """Return True for the explicitly configured first-party ingestor client.

  This is a narrow transport identity used only by heartbeat, job mutation,
  and document-push endpoints. It never bypasses datasource search/read RBAC.
  """
  if user_context.subject_type != "service_account" or not user_context.client_id:
    return False
  configured = os.getenv("RAG_TRUSTED_INGESTOR_CLIENT_IDS", "").strip()
  if not configured:
    configured = os.getenv("INGESTOR_OIDC_CLIENT_ID", "").strip()
  allowed = {value.strip() for value in configured.split(",") if value.strip()}
  return user_context.client_id in allowed


def is_org_admin_bypass_disabled() -> bool:
  """Return True when the RAG org-admin OpenFGA super-grant is disabled."""
  return os.getenv("RAG_ADMIN_BYPASS_DISABLED", "").strip().lower() in ("true", "1", "yes")


def _caipe_org_key() -> str:
  """Return the configured CAIPE organization key for OpenFGA checks."""
  value = os.getenv("CAIPE_ORG_KEY", "").strip()
  return value if OPENFGA_ID_PATTERN.fullmatch(value) else DEFAULT_ORG_KEY


def _has_unrestricted_kb_access(user_context: UserContext) -> bool:
  """Return True only for the explicit emergency RBAC bypass.

  Client-credentials tokens are authenticated service accounts, not trusted
  superusers. Their grants live under ``service_account:<sub>`` in OpenFGA and
  must be evaluated exactly like human resource grants.
  """
  if is_unsafe_rbac_bypass_enabled():
    logger.warning("CAIPE_UNSAFE_RBAC_BYPASS=true: allowing unrestricted RAG KB access")
    return True
  return False


def _openfga_user(user_context: UserContext) -> Optional[str]:
  subject = getattr(user_context, "subject", None)
  if isinstance(subject, str) and OPENFGA_ID_PATTERN.fullmatch(subject):
    namespace = "service_account" if user_context.subject_type == "service_account" else "user"
    return f"{namespace}:{subject}"
  return None


async def _get_openfga_store_id(client: httpx.AsyncClient, base_url: str) -> str:
  explicit_store_id = os.getenv("OPENFGA_STORE_ID", "").strip()
  if explicit_store_id:
    return explicit_store_id

  response = await client.get(f"{base_url}/stores", headers={"Content-Type": "application/json"})
  response.raise_for_status()
  body = response.json()
  store_name = _openfga_store_name()
  for store in body.get("stores", []):
    if store.get("name") == store_name and store.get("id"):
      return str(store["id"])
  raise RuntimeError(f"OpenFGA store {store_name} was not found")


async def _openfga_check_object(
  user_context: UserContext,
  relation: str,
  object_type: str,
  object_id: str,
) -> bool:
  """Check a user's derived relation on an OpenFGA object."""
  base_url = _openfga_http_url()
  user = _openfga_user(user_context)
  if not base_url or not user:
    return False

  async with httpx.AsyncClient(timeout=5.0) as client:
    store_id = await _get_openfga_store_id(client, base_url)
    response = await client.post(
      f"{base_url}/stores/{store_id}/check",
      headers={"Content-Type": "application/json"},
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


async def _openfga_check_data_source(
  user_context: UserContext,
  relation: str,
  object_id: str,
) -> bool:
  """Check a user's derived relation on a data_source object in OpenFGA."""
  return await _openfga_check_object(user_context, relation, "data_source", object_id)


async def _openfga_check_org_admin(user_context: UserContext) -> bool:
  """Check whether the user has the organization admin super-grant."""
  if is_org_admin_bypass_disabled():
    return False
  return await _openfga_check_object(user_context, "can_manage", "organization", _caipe_org_key())


def _publication_policy_prefix(resource_kind: str, resource_id: str) -> str:
  """Return the request-policy prefix bound to one resource.

  The UI creates a short-lived ``policy#approver`` tuple only while an
  approval adapter is applying a decision. Binding that policy id to a hash
  of the datasource prevents it from being replayed against another source.
  """
  resource_hash = hashlib.sha256(resource_id.encode("utf-8")).hexdigest()[:24]
  return f"publication.{resource_kind}.{resource_hash}."


async def check_publication_request_apply_access(
  user_context: UserContext,
  authorization_policy_id: Optional[str],
  resource_kind: str,
  resource_id: str,
) -> None:
  """Authorize a narrowly scoped, in-progress publication adapter call.

  Normal source owners and organization admins never need this path. The BFF
  issues the request-scoped OpenFGA tuple only after atomically moving a
  pending request to ``applying`` and removes it before completing or retrying
  the request.
  """
  policy_id = authorization_policy_id.strip() if authorization_policy_id else ""
  expected_prefix = _publication_policy_prefix(resource_kind, resource_id)
  if (
    not policy_id.startswith(expected_prefix)
    or not OPENFGA_ID_PATTERN.fullmatch(policy_id)
  ):
    raise HTTPException(status_code=403, detail="A valid publication approval is required")
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    if await _openfga_check_object(user_context, "can_approve", "policy", policy_id):
      return
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA publication request check failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
  raise HTTPException(status_code=403, detail="A valid publication approval is required")


async def authorize_org_admin(user_context: UserContext) -> None:
  """Require the OpenFGA organization-management grant.

  This is the imperative equivalent of ``require_role(Role.ADMIN)`` for code
  paths that cannot use a FastAPI dependency. Coarse service-account roles
  never satisfy this check.
  """
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    if await _openfga_check_org_admin(user_context):
      return
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA organization admin check failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
  raise HTTPException(status_code=403, detail="This operation requires organization administrator access")


# ============================================================================
# Explicit "search" capability (spec 2026-06-03-explicit-search-capability)
# ============================================================================
#
# Using search (the `/v1/query` retrieval path and the `/v1/mcp/invoke` tool
# path, for BOTH built-in `search`/`fetch_document` AND custom search tools) is
# a dedicated organization-level capability (`organization#can_search`). Human
# access is granted through teams by org admins; scoped service accounts receive
# the same coarse capability automatically while they hold datasource scopes.
# It is the FEATURE-level gate, layered
# above the narrower per-tool `mcp_tool#can_call` and per-datasource
# `data_source#can_read` checks: holding `can_call` on a shared tool does NOT,
# by itself, permit search. The BFF enforces the same capability for the UI
# path; this server-side check is defense-in-depth for direct/agent callers.
# assisted-by Cursor claude-opus-4.8


async def authorize_search(user_context: UserContext) -> None:
  """Authorize use of the search data path (`/v1/query`, `/v1/mcp/invoke`).

  Authorization is the explicit org-level "search" capability:

  - The explicit ``CAIPE_UNSAFE_RBAC_BYPASS`` emergency switch is allowed.
  - Org admins (`organization#can_manage`) are allowed.
  - Everyone else MUST hold `organization#can_search` (through an enabled
    search team, or the hidden baseline attached to a scoped service account).

  Fails CLOSED: 403 (capability missing) or 503 (PDP unavailable).
  """
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")

  try:
    if await _openfga_check_org_admin(user_context):
      return
    if await _openfga_check_object(user_context, "can_search", "organization", _caipe_org_key()):
      return
  except HTTPException:
    raise
  except Exception as exc:  # noqa: BLE001 — fail closed on PDP errors
    logger.warning("OpenFGA search authorization failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc

  raise HTTPException(
    status_code=403,
    detail="You do not have permission to search. Ask an administrator to enable search access.",
  )


# ============================================================================
# Explicit "data source author" capability (spec 2026-06-03-explicit-ingest-capability)
# ============================================================================
#
# Authoring a NEW data source is a dedicated organization-level capability
# (`organization#can_ingest`), granted to teams only and only by org admins.
# This is intentionally separate from per-knowledge_base `ingestor` (which only
# means "push into KB X"). Creation is authorized iff the caller is a member of
# an opted-in owning team (or an OpenFGA org admin). On success the server
# writes source-management ownership independently from any Search audience.
# assisted-by Cursor claude-opus-4.8


async def _openfga_read_tuple_exists(user: str, relation: str, object_ref: str) -> bool:
  """Return True if the exact ``(user, relation, object)`` tuple exists.

  Uses the OpenFGA ``/read`` endpoint with a fully-specified tuple filter so we
  can deterministically verify a *userset* grant (e.g. whether
  ``team:<slug>#member`` holds ``ingestor`` on the organization) without relying
  on Check's transitive resolution.
  """
  base_url = _openfga_http_url()
  if not base_url:
    return False
  async with httpx.AsyncClient(timeout=5.0) as client:
    store_id = await _get_openfga_store_id(client, base_url)
    response = await client.post(
      f"{base_url}/stores/{store_id}/read",
      headers={"Content-Type": "application/json"},
      json={"tuple_key": {"user": user, "relation": relation, "object": object_ref}},
    )
    response.raise_for_status()
    tuples = response.json().get("tuples", [])
    for entry in tuples:
      key = entry.get("key", {})
      if (
        key.get("user") == user
        and key.get("relation") == relation
        and key.get("object") == object_ref
      ):
        return True
    return False


def _team_holds_ingest_capability_filter(team_slug: str) -> tuple[str, str, str]:
  return (f"team:{team_slug}#member", "ingestor", f"organization:{_caipe_org_key()}")


async def _openfga_write_tuples(writes: List[Dict[str, str]]) -> None:
  """Idempotently write exact ownership tuples to OpenFGA.

  Each entry is ``{"user", "relation", "object"}``. Callers decide whether a
  failure is fatal. Exact reads are required before the write because OpenFGA
  rejects attempts to write a tuple that already exists. This also makes a
  retry safe when a previous request committed at OpenFGA but lost its HTTP
  response before the RAG server persisted local state.
  """
  base_url = _openfga_http_url()
  if not base_url or not writes:
    return
  async with httpx.AsyncClient(timeout=5.0) as client:
    store_id = await _get_openfga_store_id(client, base_url)
    missing: List[Dict[str, str]] = []
    for tuple_key in writes:
      read_response = await client.post(
        f"{base_url}/stores/{store_id}/read",
        headers={"Content-Type": "application/json"},
        json={"tuple_key": tuple_key},
      )
      read_response.raise_for_status()
      exists = any(
        entry.get("key", {}) == tuple_key
        for entry in read_response.json().get("tuples", [])
      )
      if not exists:
        missing.append(tuple_key)

    if not missing:
      return
    response = await client.post(
      f"{base_url}/stores/{store_id}/write",
      headers={"Content-Type": "application/json"},
      json={"writes": {"tuple_keys": missing}},
    )
    response.raise_for_status()


# ============================================================================
# Custom MCP tool authorization (spec 2026-06-03-unified-shareable-resource-rbac)
# ============================================================================
#
# Custom MCP tool management (POST/PUT/DELETE /v1/mcp/custom-tools) is a
# group-owned, shareable resource. Authorization for human callers is resolved
# through OpenFGA on the `mcp_tool` type — NOT the legacy coarse `require_role`
# gate, which can never elevate a human above READONLY (see `rbac.py` role
# assignment and `rag/README.md`: "tool authorization comes from OpenFGA
# relationships"). A client-credentials role is never a super-grant; service
# accounts need the same explicit OpenFGA relationship as other callers.
# assisted-by Cursor claude-opus-4.8


async def authorize_mcp_tool_manage(user_context: UserContext, tool_id: str) -> None:
  """Authorize an update/delete of an existing custom MCP tool.

  Allowed when the caller:
  - uses the explicit emergency CAIPE_UNSAFE_RBAC_BYPASS; OR
  - is an organization admin in OpenFGA (`organization#can_manage`); OR
  - can manage this tool in OpenFGA (`mcp_tool:<tool_id>#can_manage` — i.e. the
    tool owner, an owner-team admin, or an org admin).

  Fails CLOSED: raises ``HTTPException(403)`` when the caller is not authorized
  and ``HTTPException(503)`` when the OpenFGA PDP is unavailable or not
  configured, so a PDP outage can never silently grant a write.
  """
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    )
  try:
    if await _openfga_check_org_admin(user_context):
      return
    if await _openfga_check_object(user_context, "can_manage", "mcp_tool", tool_id):
      return
  except Exception as exc:  # noqa: BLE001 — fail closed on PDP errors
    logger.warning("OpenFGA mcp_tool can_manage check failed: %s", exc)
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    ) from exc
  raise HTTPException(
    status_code=403,
    detail="You do not have permission to manage this MCP tool. Only the tool's owner, an owner-team admin, or an organization admin may modify it.",
  )


async def authorize_mcp_tool_create(user_context: UserContext, owner_team_slug: Optional[str]) -> None:
  """Authorize creation of a new custom MCP tool.

  The tool does not exist yet, so there are no per-resource tuples to check.
  Authorization mirrors the BFF first-set rule (spec US6): the caller must be
  an organization admin OR a member of the team they are assigning as owner
  (``team:<owner_team_slug>#can_use``). Service principals must hold one of
  those same explicit OpenFGA grants.

  Fails CLOSED with 403 (not authorized) / 503 (PDP unavailable).
  """
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    )
  normalized_owner = owner_team_slug.strip() if isinstance(owner_team_slug, str) else None
  try:
    if await _openfga_check_org_admin(user_context):
      return
    if normalized_owner and await _openfga_check_object(
      user_context, "can_use", "team", normalized_owner
    ):
      return
  except Exception as exc:  # noqa: BLE001 — fail closed on PDP errors
    logger.warning("OpenFGA mcp_tool create authorization failed: %s", exc)
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    ) from exc
  raise HTTPException(
    status_code=403,
    detail="You must be an organization admin or a member of the owner team to create this MCP tool.",
  )


async def authorize_mcp_tool_call(user_context: UserContext, tool_id: str) -> None:
  """Require ``mcp_tool:<tool_id>#can_call`` for a custom RAG tool.

  Built-in tools are feature capabilities and are intentionally handled by
  ``authorize_search`` instead. Callers must invoke this helper only for a
  stored custom tool id.
  """
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    if await _openfga_check_org_admin(user_context):
      return
    if await _openfga_check_object(user_context, "can_call", "mcp_tool", tool_id):
      return
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA mcp_tool can_call check failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
  raise HTTPException(status_code=403, detail="You do not have permission to call this MCP tool")


async def _openfga_list_objects(
  user_context: UserContext,
  relation: str,
  object_type: str,
) -> List[str]:
  """List OpenFGA objects of a type that the authenticated user can access."""
  base_url = _openfga_http_url()
  user = _openfga_user(user_context)
  if not base_url or not user:
    return []

  async with httpx.AsyncClient(timeout=5.0) as client:
    store_id = await _get_openfga_store_id(client, base_url)
    response = await client.post(
      f"{base_url}/stores/{store_id}/list-objects",
      headers={"Content-Type": "application/json"},
      json={
        "user": user,
        "relation": relation,
        "type": object_type,
      },
    )
    response.raise_for_status()
    body = response.json()
    return [str(obj) for obj in body.get("objects", []) if isinstance(obj, str)]


def _strip_openfga_object_prefix(value: str, object_type: str) -> str:
  prefix = f"{object_type}:"
  return value[len(prefix):] if value.startswith(prefix) else value


async def _openfga_read_related_objects(
  object_type: str,
  relation: str,
  user: str,
) -> List[str]:
  """Return every ``object_type`` id with a direct ``(user, relation, object)`` tuple.

  Unlike ``_openfga_list_objects`` (a caller-centric ``list-objects`` call), this
  walks the raw ``/read`` endpoint with a partial tuple filter. It resolves a
  structural edge — e.g. "which knowledge_base objects point at this
  rag_collection via parent_collection" — rather than a user's effective
  permissions, so it intentionally takes no ``UserContext``.
  """
  base_url = _openfga_http_url()
  if not base_url:
    return []

  ids: List[str] = []
  continuation_token = ""
  async with httpx.AsyncClient(timeout=5.0) as client:
    store_id = await _get_openfga_store_id(client, base_url)
    while True:
      body: Dict[str, Any] = {
        "tuple_key": {"object": f"{object_type}:", "relation": relation, "user": user},
        "page_size": 100,
      }
      if continuation_token:
        body["continuation_token"] = continuation_token
      response = await client.post(
        f"{base_url}/stores/{store_id}/read",
        headers={"Content-Type": "application/json"},
        json=body,
      )
      response.raise_for_status()
      payload = response.json()
      for entry in payload.get("tuples", []):
        obj = entry.get("key", {}).get("object", "")
        if obj.startswith(f"{object_type}:"):
          ids.append(_strip_openfga_object_prefix(obj, object_type))
      continuation_token = payload.get("continuation_token", "")
      if not continuation_token:
        break
  return ids


async def get_datasource_ids_for_collection(collection_id: str) -> List[str]:
  """Resolve the datasource ids that belong to ``rag_collection:<collection_id>``.

  A source's ``knowledge_base:<id>`` object records the ``parent_collection``
  edge (see ``deploy/openfga/model.fga``), and ``data_source`` shares its id
  with its ``knowledge_base`` (``data_source.parent_kb`` is a 1:1, same-id
  edge), so the resolved knowledge_base ids double as the collection's
  datasource ids. Returns an empty list for an unknown or empty collection —
  callers should treat that as "narrows to nothing", not an error.
  """
  if not collection_id:
    return []
  try:
    return await _openfga_read_related_objects(
      "knowledge_base", "parent_collection", f"rag_collection:{collection_id}"
    )
  except Exception as exc:
    logger.warning("OpenFGA parent_collection read failed for collection %s: %s", collection_id, exc)
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    ) from exc


async def get_accessible_datasource_ids(
  user_context: UserContext,
  scope: str,
) -> List[str]:
  """
  Resolve datasource-component identifiers the caller may use for the given scope.

  Knowledge bases remain the parent RAG feature resource. This helper is for
  operations that target the data sources inside that feature, where read and
  ingest/write grants may differ per datasource.
  """
  if _has_unrestricted_kb_access(user_context):
    return ["*"]

  ids: set[str] = set()

  if _openfga_http_url() and user_context.is_authenticated:
    relation = _scope_to_openfga_relation(scope)
    try:
      if await _openfga_check_org_admin(user_context):
        return ["*"]
      objects = await _openfga_list_objects(user_context, relation, "data_source")
    except Exception as exc:
      logger.warning("OpenFGA data_source list-objects failed: %s", exc)
      raise HTTPException(
        status_code=503,
        detail="Authorization service is temporarily unavailable",
      ) from exc
    for obj in objects:
      ids.add(_strip_openfga_object_prefix(obj, "data_source"))
  elif user_context.is_authenticated:
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    )

  if "*" in ids:
    return ["*"]
  return list(ids)


async def get_accessible_mcp_tool_ids(
  user_context: UserContext,
  relation: str = "can_read",
) -> List[str]:
  """Return custom MCP tool ids visible to the caller."""
  if _has_unrestricted_kb_access(user_context):
    return ["*"]
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    if await _openfga_check_org_admin(user_context):
      return ["*"]
    objects = await _openfga_list_objects(user_context, relation, "mcp_tool")
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA mcp_tool list-objects failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
  return [_strip_openfga_object_prefix(obj, "mcp_tool") for obj in objects]


async def get_accessible_ingestion_source_ids(
  user_context: UserContext,
  relation: str = "can_read",
) -> List[str]:
  """Return source-management ids visible to the caller."""
  if _has_unrestricted_kb_access(user_context):
    return ["*"]
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    if await _openfga_check_org_admin(user_context):
      return ["*"]
    objects = await _openfga_list_objects(user_context, relation, "ingestion_source")
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA ingestion_source list-objects failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
  return [_strip_openfga_object_prefix(obj, "ingestion_source") for obj in objects]


async def check_ingestion_source_access(
  user_context: UserContext,
  source_id: str,
  relation: str = "can_manage",
) -> None:
  """Authorize source lifecycle access without granting indexed-data access."""
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    if await _openfga_check_object(user_context, relation, "ingestion_source", source_id):
      return
    if await _openfga_check_org_admin(user_context):
      return
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA ingestion_source %s check failed: %s", relation, exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc
  raise HTTPException(status_code=403, detail="Access denied for this ingestion source")


async def check_datasource_or_source_access(
  user_context: UserContext,
  datasource_id: str,
  datasource_scope: str,
  source_relation: str = "can_manage",
) -> None:
  """Allow a lifecycle operation through either independent grant graph.

  This helper must never be used for search, document, chunk, or graph reads:
  source-management authority does not imply access to indexed content.
  """
  try:
    await check_datasource_access(user_context, datasource_id, datasource_scope)
    return
  except HTTPException as exc:
    if exc.status_code != 403:
      raise
  await check_ingestion_source_access(user_context, datasource_id, source_relation)


async def _openfga_object_has_tuples(object_type: str, object_id: str) -> bool:
  """Return whether an OpenFGA object has any explicit relationship state."""
  base_url = _openfga_http_url()
  if not base_url:
    raise RuntimeError("OpenFGA is not configured")
  async with httpx.AsyncClient(timeout=5.0) as client:
    store_id = await _get_openfga_store_id(client, base_url)
    response = await client.post(
      f"{base_url}/stores/{store_id}/read",
      headers={"Content-Type": "application/json"},
      json={
        "tuple_key": {"object": f"{object_type}:{object_id}"},
        "page_size": 1,
      },
    )
    response.raise_for_status()
    return bool(response.json().get("tuples"))


async def _check_authoritative_ingestion_source_access(
  user_context: UserContext,
  datasource_id: str,
  *,
  source_relation: str,
  legacy_datasource_scope: str,
) -> None:
  """Use ingestion_source policy when present, otherwise a legacy DS grant."""
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")
  try:
    has_source_policy = await _openfga_object_has_tuples(
      "ingestion_source",
      datasource_id,
    )
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning("OpenFGA ingestion_source existence check failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc

  if has_source_policy:
    await check_ingestion_source_access(user_context, datasource_id, source_relation)
  else:
    await check_datasource_access(user_context, datasource_id, legacy_datasource_scope)


async def check_datasource_management_access(
  user_context: UserContext,
  datasource_id: str,
) -> None:
  """Authorize editing or deleting source configuration and indexed data.

  A self-service or migrated source has an independent ``ingestion_source``
  policy object. Once that object exists it is authoritative: query-policy
  administration on ``data_source`` must not also grant source management.
  Legacy/direct sources created before this policy exists retain their prior
  ``data_source#can_manage`` fallback.
  """
  await _check_authoritative_ingestion_source_access(
    user_context,
    datasource_id,
    source_relation="can_manage",
    legacy_datasource_scope="admin",
  )


async def check_connector_configuration_access(
  user_context: UserContext,
  datasource_id: str,
) -> None:
  """Authorize connector requests that can replace stored source settings.

  Only the source Owner may replace stored connector settings. Legacy
  datasources without an ingestion_source policy retain their historical
  data_source#can_ingest fallback.
  """
  await _check_authoritative_ingestion_source_access(
    user_context,
    datasource_id,
    source_relation="can_manage",
    legacy_datasource_scope="ingest",
  )


async def check_datasource_access(
  user_context: UserContext,
  datasource_id: str,
  scope: str,
) -> None:
  """Raise ``HTTPException(403)`` if the user cannot use this datasource component for ``scope``."""
  if _has_unrestricted_kb_access(user_context):
    return
  if _openfga_http_url() and user_context.is_authenticated:
    relation = _scope_to_openfga_relation(scope)
    try:
      allowed = await _openfga_check_data_source(user_context, relation, datasource_id)
    except Exception as exc:
      logger.warning("OpenFGA data_source check failed: %s", exc)
      raise HTTPException(
        status_code=503,
        detail="Authorization service is temporarily unavailable",
      ) from exc
    if allowed:
      return
    try:
      if await _openfga_check_org_admin(user_context):
        return
    except Exception as exc:
      logger.warning("OpenFGA organization admin check failed: %s", exc)
      raise HTTPException(
        status_code=503,
        detail="Authorization service is temporarily unavailable",
      ) from exc
    raise HTTPException(status_code=403, detail="Access denied for this datasource")

  if user_context.is_authenticated:
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    )

  accessible = await get_accessible_datasource_ids(user_context, scope)
  if "*" in accessible:
    return
  if not accessible:
    raise HTTPException(
      status_code=403,
      detail="No accessible datasources for this operation",
    )
  if datasource_id in accessible:
    return
  raise HTTPException(status_code=403, detail="Access denied for this datasource")


async def authorize_datasource_create(
  request: Request,
  user_context: UserContext,
  datasource_id: str,  # noqa: ARG001 — kept for signature parity / future per-id rules
  owner_team_slug: Optional[str],
) -> None:
  """Authorize creation of a NEW data source (spec 2026-06-03).

  The data source does not exist yet, so there are no per-resource tuples to
  check. Authorization is the explicit org-level "data source author"
  capability, with an optional owning-team assignment:

  - The explicit emergency RBAC bypass is allowed.
  - Org admins (`organization#can_manage`) are allowed.
  - A personal source (no ``owner_team_slug``) is allowed when the caller has
    the organization-level ``can_ingest`` capability. That capability is still
    derived from an administrator-enabled authoring team, so personal
    ownership never bypasses the platform feature gate.
  - A team-owned source additionally requires membership in the selected team
    (`team:<slug>#can_use`) and that exact team must hold the org author
    capability (`team:<slug>#member -> ingestor -> organization`).

  Fails CLOSED: 403 (not authorized / missing owning team) or 503 (PDP down).
  """
  if _has_unrestricted_kb_access(user_context):
    return
  if not _openfga_http_url() or not _openfga_user(user_context):
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable")

  normalized_owner = owner_team_slug.strip() if isinstance(owner_team_slug, str) else None
  try:
    if await _openfga_check_org_admin(user_context):
      return
    if not normalized_owner:
      can_ingest = await _openfga_check_object(
        user_context,
        "can_ingest",
        "organization",
        _caipe_org_key(),
      )
      if can_ingest:
        return
      raise HTTPException(
        status_code=403,
        detail="Creating data sources requires the organization data-source author capability.",
      )
    is_member = await _openfga_check_object(user_context, "can_use", "team", normalized_owner)
    cap_user, cap_rel, cap_obj = _team_holds_ingest_capability_filter(normalized_owner)
    team_opted_in = await _openfga_read_tuple_exists(cap_user, cap_rel, cap_obj)
  except HTTPException:
    raise
  except Exception as exc:  # noqa: BLE001 — fail closed on PDP errors
    logger.warning("OpenFGA data_source create authorization failed: %s", exc)
    raise HTTPException(status_code=503, detail="Authorization service is temporarily unavailable") from exc

  if is_member and team_opted_in:
    return
  raise HTTPException(
    status_code=403,
    detail="You are not allowed to create a data source for this team. You must be a member of a team that has the data-source author capability.",
  )


async def write_datasource_ownership(
  datasource_id: str,
  owner_team_slug: Optional[str],
  user_context: UserContext,
  shared_team_slugs: Optional[List[str]] = None,
  shared_user_subjects: Optional[List[str]] = None,
) -> None:
  """Write ownership tuples for a freshly-created data source (spec 2026-06-03).

  Management and indexed-data access are separate graphs. An owning team's
  members can view ``ingestion_source:<id>`` configuration and its admins can
  manage it, but the team receives no implicit knowledge-base access. A
  personal source is owned by the author in both graphs, so only that user can
  view/manage the configuration and query it. Optional Search Access teams
  receive knowledge-base read access, but never ingestion or management.

  This projection is required for a direct/legacy create. Callers invoke it
  before persisting datasource metadata or creating an ingestion job, so a
  policy outage cannot create indexed data that nobody can subsequently read
  or manage. No-op only for the explicit unsafe local bypass where OpenFGA is
  not configured.
  """
  if not _openfga_http_url():
    return

  kb_obj = f"knowledge_base:{datasource_id}"
  ds_obj = f"data_source:{datasource_id}"
  writes: List[Dict[str, str]] = [
    {"user": kb_obj, "relation": "parent_kb", "object": ds_obj},
  ]
  source_obj = f"ingestion_source:{datasource_id}"

  author = _openfga_user(user_context)
  creator = author if author and author.startswith("user:") else None
  normalized_owner = owner_team_slug.strip() if isinstance(owner_team_slug, str) else None
  normalized_shared: List[str] = []
  seen_shared: set[str] = set()
  for raw_slug in shared_team_slugs or []:
    slug = raw_slug.strip() if isinstance(raw_slug, str) else ""
    if not slug or not OPENFGA_ID_PATTERN.fullmatch(slug):
      raise HTTPException(status_code=400, detail="search_team_slugs must contain valid team slugs")
    # Management ownership and Search Access are independent. The same team
    # may intentionally be selected for both, so do not dedupe the search
    # team against ``owner_team_slug``.
    if slug in seen_shared:
      continue
    seen_shared.add(slug)
    normalized_shared.append(slug)
  if len(normalized_shared) > 50:
    raise HTTPException(status_code=400, detail="A data source cannot grant search access to more than 50 teams")

  normalized_users: List[str] = []
  seen_users: set[str] = set()
  for raw_subject in shared_user_subjects or []:
    subject = raw_subject.strip() if isinstance(raw_subject, str) else ""
    if not subject or not OPENFGA_ID_PATTERN.fullmatch(subject):
      raise HTTPException(status_code=400, detail="search_user_subjects must contain valid user subjects")
    if subject in seen_users:
      continue
    seen_users.add(subject)
    normalized_users.append(subject)
  if len(normalized_users) > 50:
    raise HTTPException(status_code=400, detail="A data source cannot grant search access to more than 50 people")

  if normalized_owner:
    writes.append({"user": f"team:{normalized_owner}#member", "relation": "reader", "object": source_obj})
    writes.append({"user": f"team:{normalized_owner}#admin", "relation": "manager", "object": source_obj})
    if creator:
      writes.append({"user": creator, "relation": "creator", "object": kb_obj})
      writes.append({"user": creator, "relation": "creator", "object": source_obj})
  elif author:
    # A personal source is creator-only in both independent graphs.
    writes.append({"user": author, "relation": "owner", "object": kb_obj})
    writes.append({"user": author, "relation": "owner", "object": source_obj})
    if creator:
      writes.append({"user": creator, "relation": "creator", "object": kb_obj})
      writes.append({"user": creator, "relation": "creator", "object": source_obj})

  for team_slug in normalized_shared:
    writes.append({"user": f"team:{team_slug}#member", "relation": "reader", "object": kb_obj})
  for subject in normalized_users:
    # Personal owners already receive read through ``owner``.
    if author == f"user:{subject}" and not normalized_owner:
      continue
    writes.append({"user": f"user:{subject}", "relation": "reader", "object": kb_obj})

  try:
    await _openfga_write_tuples(writes)
  except Exception as exc:  # noqa: BLE001 - fail closed on PDP errors
    logger.warning(
      "Failed to write ownership tuples for data source %s (owner_team=%s): %s",
      datasource_id,
      normalized_owner or "<personal>",
      exc,
    )
    raise HTTPException(
      status_code=503,
      detail="Authorization service is temporarily unavailable",
    ) from exc

  logger.info(
    "Wrote ownership tuples for new data source %s (owner_team=%s search_teams=%s search_users=%s)",
    datasource_id,
    normalized_owner or "<personal>",
    normalized_shared,
    normalized_users,
  )


def require_kb_access(kb_id: str, scope: str):
  """FastAPI dependency factory for routes whose path id addresses a datasource component."""

  async def _dep(
    request: Request,
    user: UserContext = Depends(require_authenticated_user),
  ) -> UserContext:
    await check_datasource_access(user, kb_id, scope)
    return user

  _dep.__name__ = f"require_kb_access_{kb_id}_{scope}"
  return _dep


async def inject_kb_filter(
  query_request: QueryRequest,
  user_context: UserContext,
) -> bool:
  """
  Restrict vector search to accessible datasources by mutating ``query_request.filters``.

  Returns:
      True if the handler should return an empty result set without querying the vector DB.
  """
  # Hybrid ACL (per-doc acl_tags) — opt-in via RBAC_DOC_ACL_TAGS_ENABLED.
  # Apply BEFORE datasource scoping so both independent layers stack. Any ACL
  # helper failure is authorization failure, never a reason to widen results.
  try:
    from .doc_acl import apply_doc_acl_filter

    apply_doc_acl_filter(query_request, user_context)
  except Exception as exc:  # noqa: BLE001 - fail closed
    logger.warning("doc_acl: apply_doc_acl_filter failed: %s", exc)
    raise HTTPException(status_code=503, detail="Document authorization is temporarily unavailable") from exc

  accessible = await get_accessible_datasource_ids(user_context, "read")
  if "*" in accessible:
    return False
  if not accessible:
    return True

  filters: Dict[str, Any] = dict(query_request.filters) if query_request.filters else {}
  existing = filters.get("datasource_id")

  if existing is None:
    filters["datasource_id"] = accessible if len(accessible) > 1 else accessible[0]
    query_request.filters = filters
    return False

  if isinstance(existing, str):
    if existing not in accessible:
      return True
    return False

  if isinstance(existing, list):
    inter = [x for x in existing if x in accessible]
    if not inter:
      return True
    filters["datasource_id"] = inter
    query_request.filters = filters
    return False

  # A non-string/non-list datasource constraint cannot be safely intersected
  # with the caller's allow-list. Never pass an attacker-controlled shape to
  # the vector backend without also applying the authoritative scope.
  return True

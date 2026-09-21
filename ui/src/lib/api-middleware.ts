// API middleware for Next.js API routes
// Provides authentication, error handling, and validation

import { createHash } from 'crypto';
import type { Collection, Document } from 'mongodb';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, isBootstrapAdmin } from '@/lib/auth-config';
import { getConfig } from '@/lib/config';
import { getCollection } from '@/lib/mongodb';
import type { Conversation, User } from '@/types/mongodb';
import type { TeamMembershipSource } from '@/types/identity-group-sync';
import {
  LocalSkillsJWTValidationError,
  validateBearerJWT,
  validateLocalSkillsJWT,
} from '@/lib/jwt-validation';
import { verifyCatalogApiKey } from '@/lib/catalog-api-keys';
import { ApiError } from '@/lib/api-error';
import type { AuthFailureAction, AuthFailureReason } from '@/lib/auth-error';
import { CredentialError } from '@/lib/credentials/errors';
import { getRbacCollection } from '@/lib/rbac/mongo-collections';
import {
  getDevAnonymousSession,
  getDevAnonymousUser,
  isDevAnonymousAuthEnabled,
} from '@/lib/auth/dev-auth-provider';

// Re-export so existing `import { ApiError } from "@/lib/api-middleware"`
// call sites keep working — see ./api-error.ts for why the class lives
// in its own server-runtime-free module now.
export { ApiError };

// ============================================================================
// Helpers
// ============================================================================

function decodeJwtPayloadForAuth(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split('.');
  if (parts.length < 2) return {};
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

function isBootstrapAdminEmail(email: string | undefined): boolean {
  return typeof isBootstrapAdmin === 'function' && isBootstrapAdmin(email);
}

function jwtHasRealmRole(accessToken: string | undefined, role: string): boolean {
  if (!accessToken) return false;
  try {
    const payload = decodeJwtPayloadForAuth(accessToken);
    const roles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    return Array.isArray(roles) && roles.includes(role);
  } catch {
    return false;
  }
}

/**
 * Translate a Bearer JWT validation error (from `jose` / OIDC discovery /
 * network) into a structured {@link ApiError} with a stable
 * {@link AuthFailureReason}.
 *
 * The `jose` library attaches a stable `code` property to its errors
 * (`ERR_JWT_EXPIRED`, `ERR_JWT_CLAIM_VALIDATION_FAILED`, `ERR_JWS_*`, etc.).
 * Claim-validation errors additionally carry a `claim` property identifying
 * which claim failed (most commonly `aud`, `iss`, `exp`, `nbf`).
 *
 * Returning a structured error here is what lets the web UI distinguish
 * "your session expired, click sign in" from "your token is for the wrong
 * service, contact admin" — both surface as HTTP 401 today but require
 * different recovery paths.
 */
function classifyBearerError(err: unknown): ApiError {
  const e = err as { code?: string; claim?: string; message?: string };
  const code = typeof e?.code === 'string' ? e.code : '';
  const claim = typeof e?.claim === 'string' ? e.claim : '';
  if (code === 'ERR_JWT_EXPIRED') {
    return new ApiError(
      'Your session has expired. Please sign in again.',
      401,
      'BEARER_EXPIRED',
      'session_expired',
      'sign_in'
    );
  }

  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'aud') {
    // Most operationally common: token issued for a different client / audience.
    // Surface a contact-admin hint because the user can't fix this themselves.
    return new ApiError(
      'Your sign-in token is not authorized for this service. Contact your admin.',
      401,
      'BEARER_AUDIENCE_MISMATCH',
      'audience_mismatch',
      'contact_admin'
    );
  }

  if (
    code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' ||
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWS_INVALID' ||
    code === 'ERR_JWT_INVALID' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY'
  ) {
    return new ApiError(
      'Your sign-in token could not be verified. Please sign in again.',
      401,
      'BEARER_INVALID',
      'bearer_invalid',
      'sign_in'
    );
  }

  // Discovery / network / config errors — not the user's fault.
  return new ApiError(
    'Authentication service is temporarily unavailable.',
    503,
    'AUTH_BACKEND_ERROR',
    'pdp_unavailable',
    'retry'
  );
}

// ============================================================================
// Authentication Middleware
// ============================================================================

export interface AuthenticatedRequest extends NextRequest {
  user?: {
    email: string;
    name: string;
    role: string;
  };
}

export interface GetAuthenticatedUserOptions {
  /**
   * When true and SSO is disabled, no session returns a fallback anonymous user
   * (for local dev / no-SSO). When false (default), no session always throws 401.
   */
  allowAnonymous?: boolean;
}

type SessionAuthSession = {
  accessToken?: string;
  authScopes?: string[];
  canViewAdmin?: boolean;
  isAuthorized?: boolean;
  isServiceAccount?: boolean;
  org?: string;
  principalType?: 'oidc_user' | 'service_account' | 'catalog_api_key' | 'skills_api_key';
  /**
   * Which literal auth path the request took, per getAuthFromBearerOrSession.
   * NOT derivable from principalType: an OBO-exchanged Bearer token (Slack,
   * Webex, external scripts) and a genuine browser session cookie both yield
   * principalType 'oidc_user'. A real browser session NEVER sends an
   * Authorization header for its own first-party requests, so 'bearer' here
   * is a caller-authenticated-via-Bearer signal a caller cannot fake.
   */
  authMethod?: 'bearer' | 'session';
  role?: string;
  sub?: string;
  user?: {
    email?: string;
    name?: string;
  } | null;
};

type SessionAuthPayload = {
  user: {
    email: string;
    name: string;
    role: string;
  };
  session: SessionAuthSession;
};

type SessionAuthCacheEntry = SessionAuthPayload & {
  expiresAt: number;
};

const DEFAULT_SESSION_AUTH_CACHE_TTL_MS = 10_000;
const MAX_SESSION_AUTH_CACHE_ENTRIES = 500;
const sessionAuthCache = new Map<string, SessionAuthCacheEntry>();

function getSessionAuthCacheTtlMs(): number {
  const raw = process.env.CAIPE_SESSION_AUTH_CACHE_TTL_MS;
  if (!raw) {
    return DEFAULT_SESSION_AUTH_CACHE_TTL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SESSION_AUTH_CACHE_TTL_MS;
  }

  return Math.min(parsed, 60_000);
}

function getSessionAuthCacheKey(request: NextRequest): string | null {
  const cookie = request.headers.get('cookie')?.trim();
  if (!cookie) {
    return null;
  }

  return createHash('sha256').update(cookie).digest('hex');
}

function cloneSessionAuthPayload(value: SessionAuthPayload): SessionAuthPayload {
  const sessionUser = value.session.user;
  return {
    user: { ...value.user },
    session: {
      ...value.session,
      user: sessionUser ? { ...sessionUser } : sessionUser,
    },
  };
}

// assisted-by Codex Codex-sonnet-4-6
function readCachedSessionAuth(request: NextRequest): SessionAuthPayload | null {
  const key = getSessionAuthCacheKey(request);
  if (!key) {
    return null;
  }

  const entry = sessionAuthCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    sessionAuthCache.delete(key);
    return null;
  }

  sessionAuthCache.delete(key);
  sessionAuthCache.set(key, entry);
  return cloneSessionAuthPayload(entry);
}

function writeCachedSessionAuth(request: NextRequest, value: SessionAuthPayload): void {
  const ttlMs = getSessionAuthCacheTtlMs();
  if (ttlMs === 0) {
    return;
  }

  const key = getSessionAuthCacheKey(request);
  if (!key) {
    return;
  }

  while (sessionAuthCache.size >= MAX_SESSION_AUTH_CACHE_ENTRIES) {
    const oldestKey = sessionAuthCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionAuthCache.delete(oldestKey);
  }

  sessionAuthCache.set(key, {
    ...cloneSessionAuthPayload(value),
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearSessionAuthCacheForTests(): void {
  sessionAuthCache.clear();
}

export function resolveKeycloakSubFromSession(session: { sub?: unknown; accessToken?: unknown }): string | null {
  if (typeof session.sub === 'string' && session.sub.trim()) {
    return session.sub.trim();
  }

  if (typeof session.accessToken !== 'string' || !session.accessToken.trim()) {
    return null;
  }

  try {
    const payload = decodeJwtPayloadForAuth(session.accessToken);
    return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

async function persistKeycloakSubMapping(
  session: { sub?: unknown; accessToken?: unknown; user?: { email?: string; name?: string } },
  user: { email: string; name: string; role: string }
): Promise<void> {
  const keycloakSub = resolveKeycloakSubFromSession(session);
  if (!keycloakSub) return;

  const now = new Date();
  try {
    const users = await getCollection<User>('users');
    await users.updateOne(
      { email: user.email },
      {
        $set: {
          keycloak_sub: keycloakSub,
          'metadata.keycloak_sub': keycloakSub,
          updated_at: now,
        },
        $setOnInsert: {
          email: user.email,
          name: user.name,
          created_at: now,
          last_login: now,
          'metadata.sso_provider': 'keycloak',
          'metadata.sso_id': keycloakSub,
          'metadata.role': user.role === 'admin' ? 'admin' : 'user',
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn('[Auth] Could not persist Keycloak subject mapping:', error);
  }
}

/**
 * Get authenticated user from session
 * Returns user info and full session, or throws 401 error
 *
 * Protected routes (via withAuth) require a real session: no session → 401.
 * Optional allowAnonymous allows a fallback user when SSO is disabled for
 * routes that explicitly permit unauthenticated access in local dev.
 *
 * Admin display role is only the bootstrap hint. Durable authorization is
 * evaluated in requireRbacPermission through OpenFGA organization relations.
 */
export async function getAuthenticatedUser(
  request: NextRequest,
  options: GetAuthenticatedUserOptions = {}
) {
  const cached = readCachedSessionAuth(request);
  if (cached) {
    return cached;
  }

  const session = await getServerSession(authOptions);

  if (!session || !session.user?.email) {
    const { allowAnonymous = false } = options;
    if (allowAnonymous && isDevAnonymousAuthEnabled()) {
      return {
        user: getDevAnonymousUser(),
        session: getDevAnonymousSession(),
      };
    }
    throw new ApiError(
      'You are not signed in. Please sign in to continue.',
      401,
      'NOT_SIGNED_IN',
      'not_signed_in',
      'sign_in'
    );
  }

  if (getConfig('ssoEnabled') && session.isAuthorized === false) {
    throw new ApiError(
      'Your account is not authorized to access this application. Contact an administrator if you need access.',
      403,
      'WEB_UI_ACCESS_DENIED',
      'missing_required_group',
      'contact_admin'
    );
  }

  let role = 'user';
  if (isBootstrapAdminEmail(session.user.email) || session.role === 'admin') {
    role = 'admin';
  }

  const user = {
    email: session.user.email,
    name: session.user.name || session.user.email,
    role,
  };

  await persistKeycloakSubMapping(session, user);

  const authenticated = {
    user,
    session: { ...session, role, principalType: 'oidc_user' as const },
  };
  writeCachedSessionAuth(request, authenticated);
  return cloneSessionAuthPayload(authenticated);
}

/**
 * Require authentication for API route
 * Use this as a wrapper for protected endpoints.
 * allowAnonymous is set to !ssoEnabled: anonymous fallback only fires when SSO is off.
 * When SSO is enabled, no session → 401.
 */
interface RouteRbacPolicy {
  resource: RbacResource;
  scope: RbacScope;
}

// LEGACY: this function maps every `/api/*` URL that goes through
// `withAuth(...)` (i.e. doesn't call a fine-grained `require*Permission`
// helper itself) to a `{ resource, scope }` PDP pair. Keep adding explicit
// capability mappings here while older routes are migrated off the wrapper.
// Unknown routes fail toward admin UI capabilities so audit rows stay explicit.
//
// See `docs/docs/specs/2026-05-27-fine-grained-rbac-for-withauth-routes/plan.md`
// for the migration plan that replaces this resolver with a per-route
// capability map and adds dedicated OpenFGA relations
// (`self_profile#read`, `chat#invoke`, `feedback#submit`, etc.).
// New routes should call the appropriate `require*Permission` helper
// directly rather than relying on this legacy gate.
function resolveLegacyWithAuthRbacPolicy(request: NextRequest): RouteRbacPolicy {
  const pathname = new URL(request.url).pathname;
  const method = request.method.toUpperCase();

  if (pathname.startsWith('/api/users/debug')) {
    return { resource: 'admin_ui', scope: 'view' };
  }
  // Read-only admin endpoints that any signed-in user is allowed to read
  // (so the Settings panel can render the configured default agent for
  // read-only viewers). Each route still enforces its own fine-grained
  // resource permission in the handler — e.g. platform-config requires
  // `system_config:platform_settings#read` and PATCH still requires
  // `admin_ui#manage` plus `system_config#admin`.
  if (pathname === '/api/admin/platform-config' && method === 'GET') {
    return { resource: 'system_config', scope: 'read' };
  }
  if (pathname.startsWith('/api/admin')) {
    return method === 'GET'
      ? { resource: 'admin_ui', scope: 'view' }
      : { resource: 'admin_ui', scope: 'manage' };
  }
  if (pathname.startsWith('/api/users/search')) {
    return { resource: 'user_directory', scope: 'read' };
  }
  if (pathname.startsWith('/api/users/me')) {
    return method === 'GET'
      ? { resource: 'self_profile', scope: 'read' }
      : { resource: 'self_profile', scope: 'write' };
  }
  if (pathname === '/api/auth/my-roles' || pathname === '/api/auth/role') {
    return { resource: 'self_profile', scope: 'read' };
  }
  if (pathname.startsWith('/api/settings')) {
    return method === 'GET'
      ? { resource: 'user_settings', scope: 'read' }
      : { resource: 'user_settings', scope: 'write' };
  }
  if (pathname.startsWith('/api/feedback')) {
    return { resource: 'feedback', scope: 'submit' };
  }
  if (
    pathname.startsWith('/api/chat') ||
    pathname === '/api/dynamic-agents/models' ||
    pathname === '/api/dynamic-agents/available'
  ) {
    return { resource: 'chat', scope: 'invoke' };
  }
  if (pathname.startsWith('/api/files')) {
    return method === 'GET'
      ? { resource: 'user_files', scope: 'read' }
      : { resource: 'user_files', scope: 'write' };
  }
  if (pathname.startsWith('/api/ai')) {
    return { resource: 'ai_assist', scope: 'invoke' };
  }
  if (pathname.startsWith('/api/credentials')) {
    return { resource: 'credential_vault', scope: 'use' };
  }

  if (pathname.startsWith('/api/workflow-configs')) {
    // Workflow CRUD is gated in route handlers (owner / task#write). The legacy
    // gate only requires workflow discovery access so non-admin users can create
    // and edit their own private workflows without dynamic_agent#manage.
    return { resource: 'dynamic_agent', scope: 'view' };
  }
  if (pathname.startsWith('/api/workflow-runs')) {
    return method === 'GET'
      ? { resource: 'dynamic_agent', scope: 'view' }
      : { resource: 'dynamic_agent', scope: 'invoke' };
  }
  if (pathname.startsWith('/api/schedules')) {
    return method === 'GET'
      ? { resource: 'dynamic_agent', scope: 'view' }
      : { resource: 'dynamic_agent', scope: 'invoke' };
  }
  if (pathname.startsWith('/api/catalog-api-keys')) {
    return { resource: 'skill', scope: 'configure' };
  }
  // Autonomous-agents proxy is intentionally per-user, NOT admin-gated (see
  // app/api/autonomous/[...path]/route.ts): any chat-capable user may manage
  // their OWN tasks — per-task ownership is enforced by the autonomous
  // service (`_assert_task_access`) and per-agent authorization by
  // dynamic-agents/CAS (`can_use` / organization `can_automate`). Without this mapping the
  // default below admin-gates every non-GET call, 403ing regular users before
  // the request ever reaches the backend.
  if (pathname.startsWith('/api/autonomous')) {
    return { resource: 'chat', scope: 'invoke' };
  }

  if (pathname.startsWith('/api/skills/seed')) {
    return { resource: 'admin_ui', scope: 'admin' };
  }
  if (pathname.startsWith('/api/skills/token')) {
    return { resource: 'skill', scope: 'invoke' };
  }
  if (
    pathname.startsWith('/api/skills/scan') ||
    (
      (pathname.startsWith('/api/skills') || pathname.startsWith('/api/skill-templates')) &&
      (
        pathname.includes('/scan') ||
        pathname.includes('/restore') ||
        pathname.includes('/clone') ||
        pathname.includes('/import-zip')
      )
    )
  ) {
    return method === 'GET'
      ? { resource: 'skill', scope: 'view' }
      : { resource: 'skill', scope: 'configure' };
  }
  if (pathname.startsWith('/api/skills') || pathname.startsWith('/api/skill-templates')) {
    if (method === 'GET') return { resource: 'skill', scope: 'view' };
    if (method === 'DELETE') return { resource: 'skill', scope: 'delete' };
    return { resource: 'skill', scope: 'configure' };
  }

  return method === 'GET'
    ? { resource: 'admin_ui', scope: 'view' }
    : { resource: 'admin_ui', scope: 'manage' };
}

export async function withAuth<T>(
  request: NextRequest,
  handler: (
    request: NextRequest,
    user: { email: string; name: string; role: string },
    session: SessionAuthSession
  ) => Promise<T>
): Promise<T> {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const policy = resolveLegacyWithAuthRbacPolicy(request);
  if (session.principalType === 'catalog_api_key' || session.principalType === 'skills_api_key') {
    throw new ApiError(
      'Scoped catalog credentials are not authorized for this route.',
      403,
      'SCOPED_CREDENTIAL_NOT_ALLOWED',
      'pdp_denied',
      'contact_admin'
    );
  }
  if (process.env.NODE_ENV !== 'test' || session.accessToken) {
    await requireRbacPermission(session, policy.resource, policy.scope);
  }
  return handler(request, user, session);
}

/**
 * Authenticate via Bearer JWT token or NextAuth session (dual-auth).
 *
 * 1. If `Authorization: Bearer <token>` header is present, validate the JWT.
 * 2. Otherwise fall back to `getServerSession(authOptions)` (cookie auth).
 * 3. If neither succeeds, throws 401.
 *
 * Returns a minimal user object compatible with the existing withAuth handler
 * signature, plus the raw session when available.
 */
export async function getAuthFromBearerOrSession(
  request: NextRequest,
): Promise<{ user: { email: string; name: string; role: string }; session: SessionAuthSession }> {
  const authHeader = request.headers.get('Authorization');
  const catalogKey = request.headers.get('X-Caipe-Catalog-Key');

  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const isCatalogRead = request.method.toUpperCase() === 'GET' && pathname === '/api/skills';

  // Path 0: Catalog API key (database-verified, read-only skills access)
  if (catalogKey) {
    const ownerSub = await verifyCatalogApiKey(catalogKey);
    if (!ownerSub) {
      throw new ApiError(
        'The catalog API key is invalid, expired, or revoked.',
        401,
        'CATALOG_KEY_INVALID',
        'bearer_invalid',
        'sign_in'
      );
    }
    if (!isCatalogRead) {
      throw new ApiError(
        'Catalog API keys are only authorized for catalog reads.',
        403,
        'CATALOG_KEY_NOT_ALLOWED',
        'pdp_denied',
        'contact_admin'
      );
    }
    return {
      user: { email: ownerSub, name: 'Catalog API Key', role: 'user' },
      session: {
        role: 'user',
        canViewAdmin: false,
        sub: ownerSub,
        principalType: 'catalog_api_key',
        authMethod: 'bearer',
        authScopes: ['catalog:read'],
      },
    };
  }

  // Path 1: Bearer JWT
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // Try local skills API token first (fast HS256, no network)
    let localIdentity: Awaited<ReturnType<typeof validateLocalSkillsJWT>>;
    try {
      localIdentity = await validateLocalSkillsJWT(token);
    } catch (err) {
      if (err instanceof LocalSkillsJWTValidationError) {
        throw new ApiError(
          err.reason === 'expired'
            ? 'The skills API token has expired.'
            : 'The bearer token could not be verified.',
          401,
          err.reason === 'expired' ? 'SKILLS_TOKEN_EXPIRED' : 'BEARER_INVALID',
          err.reason === 'expired' ? 'session_expired' : 'bearer_invalid',
          'sign_in'
        );
      }
      throw err;
    }
    if (localIdentity) {
      if (!isCatalogRead) {
        throw new ApiError(
          'Skills API tokens are only authorized for catalog reads.',
          403,
          'SKILLS_TOKEN_NOT_ALLOWED',
          'pdp_denied',
          'contact_admin'
        );
      }
      return {
        user: { email: localIdentity.email, name: localIdentity.name, role: 'user' },
        session: {
          role: 'user',
          sub: localIdentity.sub,
          principalType: 'skills_api_key',
          authMethod: 'bearer',
          authScopes: localIdentity.scopes,
        },
      };
    }

    // Fall through to OIDC JWKS validation. Translate jose / fetch errors
    // into structured ApiError so the client receives a stable {reason, action}
    // instead of a generic 500 / "Unauthorized" with no actionable hint.
    let identity: Awaited<ReturnType<typeof validateBearerJWT>>;
    try {
      identity = await validateBearerJWT(token);
    } catch (err) {
      throw classifyBearerError(err);
    }
    // Bearer users get 'user' role by default; admin escalation is session-only.
    // The validated bearer token MUST be propagated into the session so that
    // downstream `requireRbacPermission(session, ...)` can present it to
    // Keycloak's UMA ticket grant for AuthZ. Without `accessToken` here, the
    // PDP path silently 401s with "Authentication required" even though the
    // bearer was validated, breaking Slack-bot / first-party service callers
    // that authenticate exclusively via Bearer JWT.
    const user = { email: identity.email, name: identity.name, role: 'user' };
    const bearerSession = {
      role: 'user',
      accessToken: token,
      sub: identity.sub,
      org: identity.org,
      // Propagate the service-account marker so resource-authz graphs
      // first-party service callers (e.g. the Slack bot) as
      // `service_account:<sub>` rather than `user:<sub>`.
      isServiceAccount: identity.isServiceAccount === true,
      principalType: identity.isServiceAccount === true ? 'service_account' as const : 'oidc_user' as const,
      authMethod: 'bearer' as const,
      user: { email: identity.email, name: identity.name },
    };
    if (process.env.NODE_ENV !== 'test') {
      await persistKeycloakSubMapping(bearerSession, user);
    }
    return {
      user,
      session: bearerSession,
    };
  }

  // Path 2: Session cookie (existing NextAuth flow)
  const { user, session } = await getAuthenticatedUser(request, { allowAnonymous: !getConfig('ssoEnabled') });
  return { user, session: { ...session, authMethod: 'session' as const } };
}

export async function withRbacAuth<T>(
  request: NextRequest,
  resource: RbacResource,
  scope: RbacScope,
  handler: (
    req: NextRequest,
    user: { email: string; name: string; role: string },
    session: SessionAuthSession
  ) => Promise<T>
): Promise<T> {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, resource, scope);
  return handler(request, user, session);
}

/**
 * @deprecated Spec 102 / FR-001 — use {@link requireRbacPermission} instead.
 *
 * `requireAdmin` is the legacy OIDC-group-based gate. Under the
 * 098-enterprise-rbac spec, every Web UI backend route is gated by Keycloak Authorization
 * Services (via `requireRbacPermission(session, '<resource>', '<scope>')`).
 *
 * Existing call sites are tracked in `tests/rbac/rbac-matrix.yaml` with
 * `migration_status: pending`. As each route migrates (Phase 3 — T040–T049
 * in `docs/docs/specs/102-comprehensive-rbac-tests-and-completion/tasks.md`)
 * the matrix entry flips to `migration_status: migrated` and the matrix-driver
 * test goes live.
 *
 * `scripts/check-no-new-requireAdmin.sh` runs in CI (T051) and fails the build
 * if a new call site is added in a route file that isn't already pending.
 *
 * Throws 403 if user is not an OpenFGA organization admin.
 */
export async function requireAdmin(
  session: { accessToken?: string; sub?: string; org?: string; user?: { email?: string } }
): Promise<void> {
  try {
    await requireRbacPermission(session, "admin_ui", "manage");
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(
        'This action requires admin access. Contact your admin to be added as an organization admin.',
        error.statusCode,
        'ADMIN_REQUIRED',
        error.reason ?? 'missing_relationship',
        'contact_admin'
      );
    }
    throw error;
  }
}

/**
 * @deprecated Spec 102 / FR-001 — use {@link requireRbacPermission} instead.
 *
 * Same migration story as {@link requireAdmin}. Read-only admin endpoints
 * should call `requireRbacPermission(session, '<resource>', 'view')` (or
 * `'audit.view'` for audit surfaces).
 *
 * Throws 403 if user lacks the required group.
 */
export function requireAdminView(session: { role?: string; canViewAdmin?: boolean }): void {
  if (session.role === 'admin') return;
  if (session.canViewAdmin !== true) {
    throw new ApiError(
      'This page requires admin-view access. Contact your admin for access.',
      403,
      'ADMIN_VIEW_REQUIRED',
      'missing_role',
      'contact_admin'
    );
  }
}


// ============================================================================
// Enterprise RBAC (098) — Keycloak Authorization Services
// ============================================================================

import { logAuthzDecision } from '@/lib/rbac/audit';
import { deniedApiResponse } from '@/lib/rbac/error-responses';
import { checkPermission } from '@/lib/rbac/keycloak-authz';
import { checkOpenFgaTuple } from '@/lib/rbac/openfga';
import { organizationObjectId } from '@/lib/rbac/organization';
import { isUnsafeRbacBypassEnabled, warnUnsafeRbacBypassEnabled } from '@/lib/rbac/bypass';
import type { RbacResource, RbacScope } from '@/lib/rbac/types';

function organizationRelationFor(resource: RbacResource, scope: RbacScope): string {
  if (resource === 'self_profile') {
    return scope === 'write' ? 'can_manage_self' : 'can_read_self';
  }
  if (resource === 'user_directory') {
    return 'can_search_directory';
  }
  if (resource === 'chat') {
    return 'can_chat';
  }
  if (resource === 'feedback') {
    return 'can_submit_feedback';
  }
  if (resource === 'user_settings') {
    return 'can_manage_self';
  }
  if (resource === 'user_files') {
    return 'can_use_files';
  }
  if (resource === 'ai_assist') {
    return 'can_use_ai_assist';
  }
  if (resource === 'credential_vault') {
    return 'can_use_credentials';
  }
  if (resource === 'admin_ui') {
    return scope === 'view' || scope === 'audit.view' ? 'can_audit' : 'can_manage';
  }
  if (resource === 'rag') {
    // RAG has three independent organization-level gates. Keep the coarse
    // route capability aligned with the operation; object-level source and
    // collection checks are applied separately by the route handlers.
    if (scope === 'query' || scope === 'invoke' || scope === 'kb.query') {
      return 'can_search';
    }
    if (scope === 'ingest' || scope === 'create' || scope === 'kb.ingest') {
      return 'can_ingest';
    }
    if (scope === 'view' || scope === 'read' || scope === 'use' || scope === 'tool.view') {
      return 'can_use';
    }
  }
  if (resource === 'skill') {
    // Skills are a self-service member feature. Browsing/running AND authoring
    // (create/configure) plus minting the caller's own catalog API keys are
    // available to any org member (`can_use` = member or admin). Mutation and
    // deletion of an EXISTING skill are additionally constrained per-resource by
    // ownership via `requireResourcePermission({ type: "skill", action: ... })`
    // in the route handlers, so this coarse org gate must NOT collapse to the
    // admin-only `can_manage` — otherwise generic members can't create or edit
    // their own skills at all (the create path has no resource to scope yet).
    return 'can_use';
  }
  if (scope === 'view' || scope === 'read' || scope === 'query' || scope === 'invoke') {
    return 'can_use';
  }
  if (scope === 'audit.view') {
    return 'can_audit';
  }
  return 'can_manage';
}

function resourceScopedTupleFor(
  resource: RbacResource,
  scope: RbacScope,
  principal: string,
): { user: string; relation: string; object: string } | null {
  if (resource === 'rag' && scope === 'admin') {
    return {
      user: principal,
      relation: 'can_manage',
      object: 'admin_surface:rag_datasources',
    };
  }
  return null;
}

function isOpenFgaUnconfiguredTestError(error: unknown): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    error instanceof Error &&
    error.message.includes('OPENFGA_HTTP is not set')
  );
}

async function allowViaLegacyTestPdp(
  accessToken: string | undefined,
  resource: RbacResource,
  scope: RbacScope
): Promise<boolean> {
  if (!accessToken) return false;
  const result = await checkPermission({ accessToken, resource, scope });
  return result.allowed === true;
}

async function legacyTestPdpDecision(
  accessToken: string | undefined,
  resource: RbacResource,
  scope: RbacScope
): Promise<boolean | null> {
  if (process.env.NODE_ENV !== 'test' || !accessToken) return null;
  const result = await checkPermission({ accessToken, resource, scope });
  return result.allowed === true;
}

/**
 * Require a specific RBAC permission via OpenFGA organization relationships.
 *
 * Keycloak is identity-only for CAIPE authorization. Product authorization
 * comes from OpenFGA, with BOOTSTRAP_ADMIN_EMAILS as a local break-glass
 * fallback while the first durable `admin organization:<org>` tuple is seeded.
 */
export async function requireRbacPermission(
  session: {
    accessToken?: string;
    sub?: string;
    org?: string;
    role?: string;
    user?: { email?: string };
    principalType?: SessionAuthSession['principalType'];
    isServiceAccount?: boolean;
  },
  resource: RbacResource,
  scope: RbacScope,
): Promise<void> {
  const accessToken = session.accessToken;
  const email = session.user?.email;
  const subject = session.sub;
  const principal = subject
    ? `${session.isServiceAccount === true ? 'service_account' : 'user'}:${subject}`
    : null;

  if (session.principalType === 'catalog_api_key' || session.principalType === 'skills_api_key') {
    throw new ApiError(
      'Scoped catalog credentials cannot be used for RBAC-protected resources.',
      403,
      'SCOPED_CREDENTIAL_NOT_ALLOWED',
      'pdp_denied',
      'contact_admin'
    );
  }

  if (isUnsafeRbacBypassEnabled()) {
    warnUnsafeRbacBypassEnabled(`${resource}#${scope}`);
    logAuthzDecision({
      tenantId: session.org ?? 'unknown',
      sub: subject ?? email ?? 'unsafe-rbac-bypass',
      resource,
      scope,
      outcome: 'allow',
      reasonCode: 'OK_ROLE_FALLBACK',
      pdp: 'local',
      email,
    });
    return;
  }

  if (!accessToken && !subject) {
    logAuthzDecision({
      tenantId: session.org ?? 'unknown',
      sub: session.sub ?? 'unknown',
      resource,
      scope,
      outcome: 'deny',
      reasonCode: 'DENY_NO_TOKEN',
      pdp: 'keycloak',
      email,
    });
    throw new ApiError(
      'Your session has expired. Please sign in again.',
      401,
      'NO_TOKEN',
      'session_expired',
      'sign_in'
    );
  }

  if (
    process.env.NODE_ENV === 'test' &&
    session.role === 'admin' &&
    (!accessToken || jwtHasRealmRole(accessToken, 'admin'))
  ) {
    logAuthzDecision({
      tenantId: session.org ?? 'unknown',
      sub: session.sub ?? 'unknown',
      resource,
      scope,
      outcome: 'allow',
      reasonCode: 'OK_ROLE_FALLBACK',
      pdp: 'local',
      email,
    });
    return;
  }

  if (!subject && process.env.NODE_ENV === 'test' && await allowViaLegacyTestPdp(accessToken, resource, scope)) {
    logAuthzDecision({
      tenantId: session.org ?? 'unknown',
      sub: session.sub ?? 'unknown',
      resource,
      scope,
      outcome: 'allow',
      reasonCode: 'OK',
      pdp: 'keycloak',
      email,
    });
    return;
  }

  const resourceScopedTuple = principal
    ? resourceScopedTupleFor(resource, scope, principal)
    : null;
  if (resourceScopedTuple) {
    try {
      const result = await checkOpenFgaTuple(resourceScopedTuple);
      if (result.allowed) {
        logAuthzDecision({
          tenantId: session.org ?? 'unknown',
          sub: session.sub ?? 'unknown',
          resource,
          scope,
          outcome: 'allow',
          reasonCode: 'OK',
          pdp: 'openfga',
          email,
        });
        return;
      }
    } catch {
      if (!isBootstrapAdminEmail(email)) {
        logAuthzDecision({
          tenantId: session.org ?? 'unknown',
          sub: session.sub ?? 'unknown',
          resource,
          scope,
          outcome: 'deny',
          reasonCode: 'DENY_PDP_UNAVAILABLE',
          pdp: 'openfga',
          email,
        });
        throw new ApiError(
          'Authorization service is temporarily unavailable. Please try again in a moment.',
          503,
          'PDP_UNAVAILABLE',
          'pdp_unavailable',
          'retry'
        );
      }
    }

    if (!isBootstrapAdminEmail(email)) {
      logAuthzDecision({
        tenantId: session.org ?? 'unknown',
        sub: session.sub ?? 'unknown',
        resource,
        scope,
        outcome: 'deny',
        reasonCode: 'DENY_NO_CAPABILITY',
        pdp: 'openfga',
        email,
      });
      const denial = deniedApiResponse(resource, scope);
      throw new ApiError(
        denial.message,
        403,
        denial.capability,
        'pdp_denied',
        'contact_admin'
      );
    }
  }

  const relation = organizationRelationFor(resource, scope);
  const object = organizationObjectId();
  const tuple = {
    user: principal ?? 'user:unknown',
    relation,
    object,
  };

  if (subject) {
    try {
      const result = await checkOpenFgaTuple(tuple);
      if (result.allowed) {
        logAuthzDecision({
          tenantId: session.org ?? 'unknown',
          sub: session.sub ?? 'unknown',
          resource,
          scope,
          outcome: 'allow',
          reasonCode: 'OK',
          pdp: 'openfga',
          email,
        });
        return;
      }
    } catch (error) {
      if (isOpenFgaUnconfiguredTestError(error)) {
        const legacyDecision = await legacyTestPdpDecision(accessToken, resource, scope);
        if (legacyDecision === true) {
          logAuthzDecision({
            tenantId: session.org ?? 'unknown',
            sub: session.sub ?? 'unknown',
            resource,
            scope,
            outcome: 'allow',
            reasonCode: 'OK',
            pdp: 'keycloak',
            email,
          });
          return;
        }
        if (legacyDecision === false) {
          logAuthzDecision({
            tenantId: session.org ?? 'unknown',
            sub: session.sub ?? 'unknown',
            resource,
            scope,
            outcome: 'deny',
            reasonCode: 'DENY_NO_CAPABILITY',
            pdp: 'keycloak',
            email,
          });
          const denial = deniedApiResponse(resource, scope);
          throw new ApiError(
            denial.message,
            403,
            denial.capability,
            'pdp_denied',
            'contact_admin'
          );
        }
      }
      if (!isBootstrapAdminEmail(email)) {
        logAuthzDecision({
          tenantId: session.org ?? 'unknown',
          sub: session.sub ?? 'unknown',
          resource,
          scope,
          outcome: 'deny',
          reasonCode: 'DENY_PDP_UNAVAILABLE',
          pdp: 'openfga',
          email,
        });
        throw new ApiError(
          'Authorization service is temporarily unavailable. Please try again in a moment.',
          503,
          'PDP_UNAVAILABLE',
          'pdp_unavailable',
          'retry'
        );
      }
    }
  }

  if (isBootstrapAdminEmail(email)) {
    logAuthzDecision({
      tenantId: session.org ?? 'unknown',
      sub: session.sub ?? 'unknown',
      resource,
      scope,
      outcome: 'allow',
      reasonCode: 'OK_ROLE_FALLBACK',
      pdp: 'local',
      email,
    });
    return;
  }

  logAuthzDecision({
    tenantId: session.org ?? 'unknown',
    sub: session.sub ?? 'unknown',
    resource,
    scope,
    outcome: 'deny',
    reasonCode: 'DENY_NO_CAPABILITY',
    pdp: 'openfga',
    email,
  });
  const denial = deniedApiResponse(resource, scope);
  throw new ApiError(
    denial.message,
    403,
    denial.capability,
    'pdp_denied',
    'contact_admin'
  );
}

// ============================================================================
// Error Handling
// ============================================================================
//
// `ApiError` lives in `@/lib/api-error` (a leaf module with no Next.js
// server-runtime imports) so it can be safely pulled into client
// components and jsdom tests. It is re-exported above for source
// compatibility with existing `import { ApiError } from "@/lib/api-middleware"`
// call sites.

/**
 * Handle API errors and return appropriate response
 */
export function handleApiError(error: unknown): NextResponse {
  const statusCode =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : error instanceof CredentialError
        ? error.status
        : 500;
  if (statusCode >= 500 || process.env.API_ERROR_LOG_4XX === 'true') {
    console.error('API Error:', error);
  }

  if (
    error instanceof ApiError ||
    (
      error !== null &&
      typeof error === 'object' &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
      typeof (error as { message?: unknown }).message === 'string'
    )
  ) {
    const apiError = error as ApiError;
    return NextResponse.json(
      {
        success: false,
        error: apiError.message,
        code: apiError.code,
        reason: apiError.reason,
        action: apiError.action,
      },
      { status: apiError.statusCode }
    );
  }

  if (error instanceof CredentialError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        reason: error.reasonCode,
        correlationId: error.correlationId,
      },
      { status: error.status }
    );
  }

  if (error instanceof Error) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: 'Internal server error',
    },
    { status: 500 }
  );
}

/**
 * Wrap API route handler with error handling.
 */
export function withErrorHandler<TContext, TResponse extends Response>(
  handler: (request: NextRequest, context: TContext) => Promise<TResponse>
): (request: NextRequest, context: TContext) => Promise<Response> {
  return async (request: NextRequest, context: TContext): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return handleApiError(error);
    }
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a credentials_ref value (an env var name used to look up a secret).
 *
 * credentials_ref is an indirection layer: admins store the *name* of a
 * server-side env var (e.g. "GITHUB_TOKEN_PRIVATE") instead of the secret
 * itself.  At runtime the server reads `process.env[credentials_ref]`.
 *
 * Without validation, an attacker-controlled credentials_ref could read
 * arbitrary env vars (OPENAI_API_KEY, MONGODB_URI, etc.) and exfiltrate
 * them via the outgoing HTTP request's Authorization header.
 *
 * Returns the sanitized string, or throws ApiError(400).
 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function validateCredentialsRef(
  value: unknown,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ApiError('credentials_ref must be a string', 400);
  }
  if (!ENV_VAR_NAME_RE.test(value)) {
    throw new ApiError(
      'credentials_ref must be a valid env var name (letters, digits, underscores)',
      400,
    );
  }
  return value;
}

/**
 * Validate required fields in request body
 */
export function validateRequired(data: object, fields: string[]): void {
  const missing = fields.filter((field) => {
    const value = Reflect.get(data, field);
    return value === undefined || value === null;
  });

  if (missing.length > 0) {
    throw new ApiError(
      `Missing required fields: ${missing.join(', ')}`,
      400,
      'VALIDATION_ERROR'
    );
  }
}

/**
 * Validate email format
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate UUID format
 */
export function validateUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate a conversation identifier accepted by the chat API.
 *
 * New conversations use UUIDs, but releases before server-owned ID generation
 * also persisted opaque, URL-safe identifiers. Keep those records operable so
 * users can read, rename, archive, or delete their existing history. The
 * identifier is still used only as an exact MongoDB string match; authorization
 * is enforced after the record is loaded.
 */
export function validateConversationId(id: string): boolean {
  if (validateUUID(id)) return true;

  // Legacy IDs are bounded URL-safe slugs. Excluding path separators, query
  // delimiters, whitespace, and MongoDB operator characters keeps route
  // handling unambiguous while accepting historical IDs such as
  // "legacy-demo-conversation".
  return /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/.test(id);
}

/**
 * Parse and validate pagination parameters
 */
export function getPaginationParams(request: NextRequest) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('page_size') || '20');

  if (page < 1) {
    throw new ApiError('Page must be >= 1', 400);
  }

  if (pageSize < 1 || pageSize > 100) {
    throw new ApiError('Page size must be between 1 and 100', 400);
  }

  return { page, pageSize, skip: (page - 1) * pageSize };
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Create success response
 */
export function successResponse<T>(data: T, status: number = 200): NextResponse {
  return NextResponse.json(
    {
      success: true,
      data,
    },
    { status }
  );
}

/**
 * Create paginated response
 */
export function paginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number
): NextResponse {
  return NextResponse.json({
    success: true,
    data: {
      items,
      total,
      page,
      page_size: pageSize,
      has_more: page * pageSize < total,
    },
  });
}

/**
 * Create error response
 */
export function errorResponse(
  message: string,
  statusCode: number = 400,
  code?: string,
  reason?: AuthFailureReason,
  action?: AuthFailureAction
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: message,
      code,
      reason,
      action,
    },
    { status: statusCode }
  );
}

// ============================================================================
// Authorization Helpers
// ============================================================================

/**
 * Check if user owns a resource
 */
export function requireOwnership(ownerId: string, userId: string) {
  if (ownerId !== userId) {
    throw new ApiError(
      'You do not have access to this resource.',
      403,
      'FORBIDDEN',
      'forbidden',
      'contact_admin'
    );
  }
}

/**
 * Resolve all team IDs that a user belongs to.
 * Uses canonical team_membership_sources and falls back to legacy teams.members[].
 */
export async function getUserTeamIds(userEmail: string): Promise<string[]> {
  const refs = new Set<string>();
  const normalizedEmail = userEmail.trim().toLowerCase();
  if (!normalizedEmail) return [];

  try {
    // assisted-by Codex Codex-sonnet-4-6
    // Chat team shares must follow the canonical membership store, not stale embedded team members.
    const sources = await getRbacCollection<TeamMembershipSource>('teamMembershipSources');
    const rows = await sources
      .find({ status: 'active', user_email: normalizedEmail })
      .project({ team_id: 1, team_slug: 1 })
      .toArray();

    for (const row of rows) {
      if (typeof row.team_id === 'string' && row.team_id.trim()) {
        refs.add(row.team_id.trim());
      }
      if (typeof row.team_slug === 'string' && row.team_slug.trim()) {
        refs.add(row.team_slug.trim());
      }
    }
  } catch {
    // Fall through to the legacy embedded-members lookup below.
  }

  try {
    const teams = await getCollection('teams');
    const emailClauses = Array.from(new Set([userEmail.trim(), normalizedEmail].filter(Boolean)));
    const userTeams = await teams
      .find({ $or: emailClauses.map((email) => ({ 'members.user_id': email })) })
      .project({ _id: 1, slug: 1 })
      .toArray();

    for (const team of userTeams) {
      if (team?._id !== undefined && team?._id !== null) {
        refs.add(team._id.toString());
      }
      if (typeof team?.slug === 'string' && team.slug.trim()) {
        refs.add(team.slug.trim());
      }
    }
  } catch {
    // Ignore legacy lookup failures; sharing should fail closed for non-matches.
  }

  return Array.from(refs);
}

export type ConversationAccessLevel = 'owner' | 'shared' | 'shared_readonly' | 'admin_audit';

interface ConversationAccessResult {
  conversation: ConversationAccessDocument;
  access_level: ConversationAccessLevel;
}

type ConversationAccessDocument = Conversation & Document;

function normalizedIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sessionSubject(session: { sub?: unknown } | undefined): string {
  return typeof session?.sub === 'string' ? session.sub.trim() : '';
}

function isConversationOwnerForAccess(
  conversation: { owner_id?: unknown; owner_subject?: unknown },
  userId: string,
  session?: { sub?: unknown },
): boolean {
  const subject = sessionSubject(session);
  if (subject && conversation.owner_subject === subject) return true;
  return Boolean(normalizedIdentity(userId) && normalizedIdentity(conversation.owner_id) === normalizedIdentity(userId));
}

/**
 * Check if user has access to a conversation (owner, shared with directly,
 * shared with one of their teams, via sharing_access records, or admin audit).
 *
 * When `session` is provided and the user is an admin, they receive read-only
 * audit access even if they are not the owner or a share recipient.
 */
export async function requireConversationAccess(
  conversationId: string,
  userId: string,
  getCollectionFn: (name: string) => Promise<Collection<ConversationAccessDocument>>,
  session?: { role?: string; sub?: string; canViewAdmin?: boolean }
): Promise<ConversationAccessResult> {
  const conversations = await getCollectionFn('conversations');
  const conversation = await conversations.findOne({ _id: conversationId });

  if (!conversation) {
    throw new ApiError('Conversation not found', 404, 'NOT_FOUND');
  }

  // Check if user is owner. Newer conversations may carry owner_subject; older
  // records rely on owner_id email and should be compared case-insensitively.
  // assisted-by Codex Codex-sonnet-4-6
  if (isConversationOwnerForAccess(conversation, userId, session)) {
    return { conversation, access_level: 'owner' };
  }

  // Check if conversation is shared with user directly
  const normalizedUserId = normalizedIdentity(userId);
  const directShareMatch = conversation.sharing?.shared_with?.some(
    (email: unknown) => normalizedIdentity(email) === normalizedUserId,
  );
  if (directShareMatch) {
    const sharingAccess = await getCollectionFn('sharing_access');
    const accessRecord = await sharingAccess.findOne({
      conversation_id: conversationId,
      granted_to: { $in: [userId, normalizedUserId] },
      revoked_at: null,
    });
    // Default to 'comment' (full access) for backward compatibility with
    // shares created before permissions were introduced
    const perm = accessRecord?.permission ?? 'comment';
    return {
      conversation,
      access_level: perm === 'comment' ? 'shared' : 'shared_readonly',
    };
  }

  // Check if conversation is shared with one of the user's teams
  const sharedTeams = conversation.sharing?.shared_with_teams;
  if (sharedTeams && sharedTeams.length > 0) {
    const userTeamIds = await getUserTeamIds(userId);
    if (userTeamIds.length > 0) {
      const matchedTeamId = sharedTeams.find((teamId: string) =>
        userTeamIds.includes(teamId)
      );
      if (matchedTeamId) {
        const teamPerms = conversation.sharing?.team_permissions;
        const perm = teamPerms?.[matchedTeamId] ?? 'comment';
        return {
          conversation,
          access_level: perm === 'comment' ? 'shared' : 'shared_readonly',
        };
      }
    }
  }

  // Check sharing_access collection (link-based or other grants)
  const sharingAccess = await getCollectionFn('sharing_access');
  const access = await sharingAccess.findOne({
    conversation_id: conversationId,
    granted_to: userId,
    revoked_at: null,
  });

  if (access) {
    const perm = access.permission ?? 'comment';
    return {
      conversation,
      access_level: perm === 'comment' ? 'shared' : 'shared_readonly',
    };
  }

  // Admins and sessions explicitly allowed to view admin data get read-only
  // audit access to any conversation.
  if (session?.role === 'admin' || session?.canViewAdmin === true) {
    return { conversation, access_level: 'admin_audit' };
  }

  throw new ApiError(
    'You do not have access to this conversation.',
    403,
    'FORBIDDEN',
    'forbidden',
    'contact_admin'
  );
}

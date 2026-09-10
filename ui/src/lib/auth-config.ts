import { decodeJwt } from "jose";
import type { NextAuthOptions } from "next-auth";

/**
 * Auth configuration for OIDC SSO
 *
 * Environment Variables Required:
 * - NEXTAUTH_URL: Base URL (e.g., http://localhost:3000 or https://your-domain.com)
 * - NEXTAUTH_SECRET: Random secret for JWT encryption
 * - OIDC_ISSUER: OIDC provider issuer URL
 * - OIDC_CLIENT_ID: OIDC client ID
 * - OIDC_CLIENT_SECRET: OIDC client secret
 * - SSO_ENABLED: "true" to enable SSO, otherwise disabled.
 *   (Also accepts NEXT_PUBLIC_SSO_ENABLED for backward compatibility.)
 *   If SSO does not appear enabled: check window.__APP_CONFIG__ in the browser.
 * - OIDC_GROUP_CLAIM: The OIDC claim name(s) for groups. Supports:
 *     - Single value: "memberOf"
 *     - Comma-separated: "groups,members,roles" (all checked, results combined)
 *     - Empty/unset: auto-detect from common claim names
 * - OIDC_REQUIRED_GROUP: Group name required for access (unset or empty disables the group gate)
 * - OIDC_REQUIRED_ADMIN_GROUP: Deprecated; upstream groups now sync to CAIPE teams
 * - BOOTSTRAP_ADMIN_EMAILS: Comma-separated emails granted admin on login (bootstrap only)
 * - OIDC_ENABLE_REFRESH_TOKEN: "true" to enable refresh token support (default: true if not set)
 * - OIDC_IDP_HINT: Keycloak IdP alias to auto-redirect (e.g., "duo-sso"). Omit to show login form.
 * - OIDC_GROUP_INCLUDELIST: Comma-separated regex patterns. Only groups matching at least one pattern
 *     are synced. Unset = all groups pass through.
 *     Example: "^platform-engineering$,^sre$,^caipe-.*"
 * - OIDC_GROUP_EXCLUDELIST: Comma-separated regex patterns. Groups matching any pattern are dropped.
 *     Excluded groups also trigger removal of any existing membership on next login.
 *     Example: "^test-.*,^temp-.*"
 * - IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED: Set to "false" to disable signed-in user's OIDC group claim reconciliation
 * - IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID: Provider id for claim-derived sync rules (default: "oidc-claims")
 * - IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS: Set to "true" to allow login-time reconciliation to CREATE
 *     new teams from unmatched OIDC group claims. Defaults to "false" — even with this enabled,
 *     team creation still requires `auto_create_team: true` on the matching identity-group-sync rule
 *     (defense in depth). Off by default because silent team creation from raw IdP claims expands
 *     the auth-data surface; admins should typically curate teams via the Admin UI instead.
 */

// Check if refresh token support should be enabled
// Defaults to true for backward compatibility, but can be disabled if OIDC provider doesn't support it
export const ENABLE_REFRESH_TOKEN = process.env.OIDC_ENABLE_REFRESH_TOKEN !== "false";

// Group claim name(s) - configurable via env var
// Supports single value or comma-separated list (e.g., "groups,members,roles")
// If not set, will auto-detect from common claim names
export const GROUP_CLAIM = process.env.OIDC_GROUP_CLAIM || "";

// assisted-by claude code claude-sonnet-4-6
// OIDC_GROUP_INCLUDELIST: comma-separated regex patterns. When set, only groups
// whose name matches at least one pattern are passed to the reconciler.
// Unset means all groups are included (existing behaviour).
// Example: "^platform-engineering$,^sre$,^caipe-.*"
//
// OIDC_GROUP_EXCLUDELIST: comma-separated regex patterns. Groups matching any
// pattern are dropped — including active removal of any existing membership
// derived from an excluded group on the user's next login.
// Example: "^test-.*,^temp-.*"
//
// Both lists can be used together: includelist runs first, then excludelist.
function _parsePatterns(envVar: string): RegExp[] | null {
  const raw = process.env[envVar]?.trim();
  if (!raw) return null;
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(p => {
    try {
      return new RegExp(p);
    } catch {
      console.warn(`${envVar}: invalid regex "${p}", skipping`);
      return null;
    }
  }).filter((r): r is RegExp => r !== null);
}
const _groupIncludelistPatterns = _parsePatterns("OIDC_GROUP_INCLUDELIST");
const _groupExcludelistPatterns = _parsePatterns("OIDC_GROUP_EXCLUDELIST");

/**
 * Resolve the identity-sync provider id for the current login so that
 * login-time membership rows are tagged with the SAME provider as the
 * background directory sync (e.g. both `okta`). This is what lets the two
 * paths merge: one team per group, and either path can add/remove the same
 * `managed` membership rows.
 *
 * Resolution order (most specific wins):
 *   1. `identity_provider` token claim — set when Keycloak is configured to
 *      forward the brokered IdP alias (true multi-IdP attribution).
 *   2. `OIDC_IDP_HINT` — the deployment's configured IdP alias (e.g. "okta",
 *      "duo-sso"), normalized to a bare provider id ("okta", "duo").
 *   3. `IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID` — explicit override.
 *   4. "oidc-claims" — generic fallback when no IdP is known.
 *
 * Normalization keeps the provider id aligned with
 * identity-group-sync-planner.sourceTypeForProvider (which keys off the
 * `okta`/`ad` prefixes), so "okta" → source_type "okta".
 */
function normalizeProviderId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("okta")) return "okta";
  if (value.startsWith("duo")) return "duo";
  if (value.startsWith("ad") || value.includes("active-directory")) return "ad";
  // Strip a trailing "-sso"/"-oidc"/"-saml" connection suffix; otherwise keep as-is.
  return value.replace(/[-_](sso|oidc|saml)$/i, "");
}

export function resolveLoginProviderId(profile?: Record<string, unknown>): string {
  const claim = profile?.identity_provider;
  if (typeof claim === "string" && claim.trim()) {
    return normalizeProviderId(claim);
  }
  if (process.env.OIDC_IDP_HINT?.trim()) {
    return normalizeProviderId(process.env.OIDC_IDP_HINT);
  }
  return process.env.IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID || "oidc-claims";
}

// Required group for authorization.
// Use ?? (nullish coalescing) so that setting OIDC_REQUIRED_GROUP="" disables
// the group check. Do not bake deployment-specific group names into source.
export const REQUIRED_GROUP = process.env.OIDC_REQUIRED_GROUP ?? "";

// Deprecated: product admin access is an OpenFGA organization relationship.
export const REQUIRED_ADMIN_GROUP = process.env.OIDC_REQUIRED_ADMIN_GROUP || "";

// Required group for dynamic agents (custom agents) access.
// This is an identity admission hint only; durable access is OpenFGA-backed.
export const REQUIRED_DYNAMIC_AGENTS_GROUP = process.env.OIDC_REQUIRED_DYNAMIC_AGENTS_GROUP || "";

// Required group for read-only admin dashboard access
// Users in this group can view admin data but cannot make changes
// Leave empty to allow all authenticated users to view admin dashboard
export const REQUIRED_ADMIN_VIEW_GROUP = process.env.OIDC_REQUIRED_ADMIN_VIEW_GROUP || "";

// Bootstrap admin emails — solves the chicken-and-egg problem where the first
// operator needs to create durable OpenFGA organization admin relationships.
// Comma-separated list of emails treated as break-glass admins on login.
function bootstrapAdminEmails(): Set<string> {
  return new Set(
    (process.env.BOOTSTRAP_ADMIN_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
  );
}

export function isBootstrapAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  const emails = bootstrapAdminEmails();
  if (emails.size === 0) return false;
  return emails.has(email.toLowerCase());
}

// Default group claim names to check (in order of priority)
// Note: Duo SSO uses "members" for full group list, "groups" for limited set
const DEFAULT_GROUP_CLAIMS = ["members", "memberOf", "groups", "group", "roles", "cognito:groups"];

/**
 * Helper to add groups from a claim value to a set
 */
function addGroupsFromValue(value: unknown, groups: Set<string>): void {
  if (Array.isArray(value)) {
    value.map(String).forEach(g => groups.add(g));
  } else if (typeof value === "string") {
    // Some providers return comma-separated or space-separated groups
    value.split(/[,\s]+/).filter(Boolean).forEach(g => groups.add(g));
  }
}

/**
 * Extract groups from OIDC claims with configurable claim name(s).
 * Mirrors the logic in server/src/server/rbac.py extract_groups_from_claims()
 *
 * Uses OIDC_GROUP_CLAIM if set (supports comma-separated for multiple claims),
 * otherwise checks ALL common claim names and combines groups from all
 * of them (using a set for deduplication).
 *
 * @param profile - OIDC profile/claims object
 * @returns Array of unique group names
 */
export function extractGroups(profile: Record<string, unknown>): string[] {
  const allGroups = new Set<string>();

  // If specific claim(s) configured, use only those
  // Supports comma-separated list (e.g., "groups,members,roles")
  if (GROUP_CLAIM) {
    const configuredClaims = GROUP_CLAIM.split(",").map(c => c.trim()).filter(Boolean);
    for (const claimName of configuredClaims) {
      const value = profile[claimName];
      if (value !== undefined) {
        addGroupsFromValue(value, allGroups);
      }
    }
    if (allGroups.size === 0) {
      console.warn(`OIDC group claim(s) "${GROUP_CLAIM}" not found in profile`);
    }
    return applyGroupFilters(Array.from(allGroups));
  }

  // Auto-detect: check ALL common group claim names and combine them
  // This is important for Duo SSO which uses both "groups" and "members"
  for (const claim of DEFAULT_GROUP_CLAIMS) {
    const value = profile[claim];
    if (value !== undefined) {
      addGroupsFromValue(value, allGroups);
    }
  }

  return applyGroupFilters(Array.from(allGroups));
}

/**
 * Apply OIDC_GROUP_INCLUDELIST and OIDC_GROUP_EXCLUDELIST filters.
 * Includelist runs first (keep only matching), then excludelist (drop matching).
 * Groups absent from the resulting list trigger removal of existing memberships
 * on the user's next login via the reconciler's normal removal path.
 */
function applyGroupFilters(groups: string[]): string[] {
  let result = groups;
  if (_groupIncludelistPatterns && _groupIncludelistPatterns.length > 0) {
    result = result.filter(g => _groupIncludelistPatterns!.some(re => re.test(g)));
  }
  if (_groupExcludelistPatterns && _groupExcludelistPatterns.length > 0) {
    result = result.filter(g => !_groupExcludelistPatterns!.some(re => re.test(g)));
  }
  return result;
}

async function reconcileLoginGroupsFromClaims(input: {
  subject?: string;
  email?: string;
  displayName?: string;
  groups: string[];
  providerId: string;
}): Promise<void> {
  if (process.env.IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED === "false") return;
  if (!input.subject || input.groups.length === 0) return;

  try {
    const { reconcileOidcClaimGroupsForUser } = await import("@/lib/rbac/oidc-claim-reconciler");
    await reconcileOidcClaimGroupsForUser({
      ...input,
      // Tag login memberships with the resolved IdP provider (e.g. "okta") so
      // they share a namespace with the background directory sync and reconcile
      // the same rows. See resolveLoginProviderId.
      providerId: input.providerId,
      // Strict opt-in: env must be exactly "true" to enable. Even then the
      // planner still requires the matched rule to have auto_create_team=true
      // (see identity-group-sync-planner.ts) — that's the policy gate.
      allowTeamCreation: process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS === "true",
    });
  } catch (error) {
    console.warn("[Auth] OIDC claim identity sync reconciliation failed:", error);
  }
}

function hasConfiguredGroup(groups: string[], requiredGroup: string): boolean {
  if (!requiredGroup) return false;
  const requiredLower = requiredGroup.toLowerCase();
  return groups.some((group) => {
    const groupLower = group.toLowerCase();
    return groupLower === requiredLower || groupLower.includes(`cn=${requiredLower}`);
  });
}

// Helper to check if user has required group
export function hasRequiredGroup(groups: string[]): boolean {
  if (!REQUIRED_GROUP) return true; // No group required

  return groups.some((group) => {
    // Handle both simple group names and full DN paths
    // e.g., "caipe-users" or "CN=caipe-users,OU=Groups,DC=example,DC=com"
    const groupLower = group.toLowerCase();
    const requiredLower = REQUIRED_GROUP.toLowerCase();
    return groupLower === requiredLower || groupLower.includes(`cn=${requiredLower}`);
  });
}

// OIDC admin groups bootstrap durable OpenFGA admin tuples; OpenFGA remains
// authoritative for protected API decisions after login.
export function isAdminUser(groups: string[]): boolean {
  return hasConfiguredGroup(groups, REQUIRED_ADMIN_GROUP);
}

// Dynamic Agents access is authorized by OpenFGA resource checks in the Web UI
// BFF. This legacy session flag remains only for backwards-compatible user
// context payloads and must not encode AD/OIDC group policy.
export function canAccessDynamicAgents(groups: string[]): boolean {
  void groups;
  void REQUIRED_DYNAMIC_AGENTS_GROUP;
  return true;
}

// Helper to check if user can view admin dashboard (read-only)
// If OIDC_REQUIRED_ADMIN_VIEW_GROUP is not set, all authenticated users can view
export function canViewAdminDashboard(groups: string[]): boolean {
  if (!REQUIRED_ADMIN_VIEW_GROUP) return true; // No view group configured = all authenticated users

  return groups.some((group) => {
    const groupLower = group.toLowerCase();
    const viewGroupLower = REQUIRED_ADMIN_VIEW_GROUP.toLowerCase();
    return groupLower === viewGroupLower || groupLower.includes(`cn=${viewGroupLower}`);
  });
}

/** Reset in-flight refresh map (for testing only). */
export function _resetInflightRefreshes(): void {
  _inflightRefreshes.clear();
}

// Safety net 1: In-flight deduplication.
// Maps the current refresh token → the pending exchange Promise so that
// concurrent callers (refetchInterval + TokenExpiryGuard) share one HTTP
// request instead of racing and triggering invalid_grant with rotating tokens.
type ExchangeResult = {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
} | null; // null = graceful race (see safety net 2)

type OidcExchangeResponse = Exclude<ExchangeResult, null> & {
  error?: string;
  error_description?: string;
};

const _inflightRefreshes = new Map<string, Promise<ExchangeResult>>();

// ─────────────────────────────────────────────────────────────────────────────
// Server-side token store
// ─────────────────────────────────────────────────────────────────────────────
// Large OAuth tokens (accessToken, refreshToken, idToken) are offloaded from
// the JWT cookie into a two-level store (L1 in-memory + L2 MongoDB) so the
// encrypted cookie stays under the 4096-byte browser limit.
//
// L1: per-pod Map with 60s TTL — zero-latency for the common case.
// L2: MongoDB collection `auth_token_cache` — shared across all replicas,
//     tokens AES-256-GCM encrypted at rest (key derived from NEXTAUTH_SECRET).
//
// See: https://github.com/caipe-io/ai-platform-engineering/issues/1986
import { getStoredTokens, storeTokens, resetTokenStore } from './auth-token-store';

// Claim groups are only needed for in-process authorization checks and are
// re-populated on login and every token refresh. They stay in L1 only.
const _claimGroupsCache = new Map<string, { groups: string[]; checkedAt: number }>();

export function cacheOidcClaimGroups(sub: string | undefined, groups: string[]): void {
  if (!sub) return;
  _claimGroupsCache.set(sub, { groups: [...groups], checkedAt: Math.floor(Date.now() / 1000) });
}

export function getCachedOidcClaimGroups(sub: string | undefined): string[] {
  if (!sub) return [];
  return _claimGroupsCache.get(sub)?.groups ?? [];
}

/** Reset server-side token store (for testing only). */
export function _resetServerTokenStore(): void {
  _claimGroupsCache.clear();
  resetTokenStore();
}

/**
 * Refresh the access token using the refresh token
 *
 * This function calls the OIDC token endpoint to exchange a refresh_token
 * for a new access_token and id_token.
 *
 * Safety nets:
 *   1. In-flight deduplication: concurrent calls with the same refresh token
 *      share a single HTTP exchange rather than racing.
 *   2. Graceful invalid_grant: if the provider rejects the token but the
 *      access token is still valid, we treat it as a race (another instance
 *      already refreshed) and return the existing token without an error.
 *
 * @param token - The JWT token containing the refresh token
 * @returns Updated token with new access_token and expiry
 */
async function refreshAccessToken(token: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}) {
  try {
    const issuer = process.env.OIDC_ISSUER;
    // Server-side calls (discovery + token refresh) prefer OIDC_DISCOVERY_URL so
    // they can use the Docker-internal hostname while OIDC_ISSUER stays
    // browser-facing. See provider config below for full rationale.
    const serverIssuer = process.env.OIDC_DISCOVERY_URL || issuer;
    const clientId = process.env.OIDC_CLIENT_ID;
    const clientSecret = process.env.OIDC_CLIENT_SECRET;

    if (!issuer || !clientId || !clientSecret) {
      console.error("[Auth] Missing OIDC configuration for token refresh");
      return {
        ...token,
        error: "RefreshTokenMissingConfig",
      };
    }

    if (!token.refreshToken) {
      console.error("[Auth] No refresh token available");
      return {
        ...token,
        error: "RefreshTokenMissing",
      };
    }

    const currentRefreshToken = token.refreshToken as string;

    // Safety net 1: join an in-flight exchange for the same refresh token
    const existing = _inflightRefreshes.get(currentRefreshToken);
    if (existing) {
      console.log("[Auth] Joining in-flight token exchange (concurrent refresh detected)");
      const result = await existing;
      if (result === null) {
        // Another caller already handled the race; current access token is still valid
        return { ...token, error: undefined };
      }
      return {
        ...token,
        accessToken: result.access_token,
        idToken: result.id_token,
        expiresAt: Math.floor(Date.now() / 1000) + (result.expires_in || 3600),
        refreshToken: result.refresh_token ?? currentRefreshToken,
        error: undefined,
      };
    }

    // Inner function that performs the actual HTTP exchange.
    // Returns the token data on success, null for graceful races, or throws on real errors.
    const doExchange = async (): Promise<ExchangeResult> => {
      // Discover the token endpoint from the OIDC issuer's well-known configuration.
      // Falls back to Keycloak-style path if discovery fails.
      let tokenEndpoint: string;
      try {
        const wellKnownUrl = `${serverIssuer}/.well-known/openid-configuration`;
        const discoveryResponse = await fetch(wellKnownUrl, { next: { revalidate: 3600 } });
        if (discoveryResponse.ok) {
          const discoveryDoc = await discoveryResponse.json();
          tokenEndpoint = discoveryDoc.token_endpoint;
          console.log("[Auth] Token endpoint from OIDC discovery:", tokenEndpoint);
        } else {
          console.warn("[Auth] OIDC discovery failed, falling back to Keycloak-style path");
          tokenEndpoint = `${serverIssuer}/protocol/openid-connect/token`;
        }
      } catch (discoveryError) {
        console.warn("[Auth] OIDC discovery error, falling back to Keycloak-style path:", discoveryError);
        tokenEndpoint = `${serverIssuer}/protocol/openid-connect/token`;
      }

      console.log("[Auth] Refreshing access token...");

      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          grant_type: "refresh_token",
          refresh_token: currentRefreshToken,
        }),
      });

      // Check content-type before parsing - OIDC providers may return HTML error pages
      const contentType = response.headers.get("content-type") || "";
      let data: OidcExchangeResponse;

      if (contentType.includes("application/json")) {
        data = await response.json() as OidcExchangeResponse;
      } else {
        const text = await response.text();
        console.error("[Auth] Token refresh returned non-JSON response:", text.substring(0, 200));
        throw new Error("RefreshTokenExpired");
      }

      if (!response.ok) {
        // Safety net 2: graceful invalid_grant handling.
        // When a peer (another Next.js instance or refetchInterval) already consumed
        // the rotating refresh token, we get invalid_grant back. If the access token
        // is still valid, treat this as a benign race rather than forcing a logout.
        if (data.error === "invalid_grant") {
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = token.expiresAt as number | undefined;
          if (expiresAt && expiresAt > now) {
            console.warn(
              "[Auth] invalid_grant with valid access token — concurrent refresh race detected, keeping current token"
            );
            return null; // Signal: no error, keep existing token
          }
        }
        console.error("[Auth] Token refresh failed:", data);
        throw new Error("RefreshTokenExpired");
      }

      console.log("[Auth] Token refreshed successfully");
      return data as ExchangeResult;
    };

    // Register the exchange Promise so concurrent callers can join it (safety net 1)
    const exchangePromise = doExchange();
    _inflightRefreshes.set(currentRefreshToken, exchangePromise);

    let result: ExchangeResult;
    try {
      result = await exchangePromise;
    } finally {
      _inflightRefreshes.delete(currentRefreshToken);
    }

    if (result === null) {
      // Graceful race: access token still valid, no logout needed
      return { ...token, error: undefined };
    }

    return {
      ...token,
      accessToken: result.access_token,
      idToken: result.id_token,
      expiresAt: Math.floor(Date.now() / 1000) + (result.expires_in || 3600),
      refreshToken: result.refresh_token ?? currentRefreshToken, // Use new refresh token if provided
      error: undefined, // Clear any previous errors
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage === "RefreshTokenExpired") {
      return { ...token, error: "RefreshTokenExpired" };
    }
    console.error("[Auth] Error refreshing access token:", error);
    return {
      ...token,
      error: "RefreshTokenError",
    };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    {
      id: "oidc",
      name: "SSO",
      type: "oauth",
      // OIDC_DISCOVERY_URL lets server-side discovery use a Docker-internal URL
      // (e.g. http://keycloak:7080/realms/caipe) while OIDC_ISSUER stays as the
      // browser-facing URL (e.g. http://localhost:7080/realms/caipe) so the
      // "iss" claim in JWTs validates against what the browser was redirected to.
      // Falls back to OIDC_ISSUER when not set (single-URL deployments).
      wellKnown: process.env.OIDC_DISCOVERY_URL
        ? `${process.env.OIDC_DISCOVERY_URL}/.well-known/openid-configuration`
        : process.env.OIDC_ISSUER
          ? `${process.env.OIDC_ISSUER}/.well-known/openid-configuration`
          : undefined,
      // Keycloak issues regular refresh tokens for confidential clients
      // without needing offline_access scope. Requesting offline_access
      // requires extra Keycloak config and causes login failures if not
      // enabled on the client/realm. Regular refresh tokens are sufficient.
      authorization: {
        params: {
          scope: "openid email profile groups",
          ...(process.env.OIDC_IDP_HINT ? { kc_idp_hint: process.env.OIDC_IDP_HINT } : {}),
        }
      },
      idToken: true,
      checks: ["pkce", "state"],
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      profile(profile) {
        // Build display name from available claims.
        // Keycloak sends standard OIDC: name, given_name, family_name
        // Duo SSO sends: fullname, firstname, lastname, username
        const composedName =
          `${profile.given_name || profile.firstname || ""} ${profile.family_name || profile.lastname || ""}`.trim();
        const name =
          profile.name || profile.fullname || composedName ||
          profile.preferred_username || profile.username || profile.email;

        console.log("[Auth profile] Claims:", {
          name: profile.name,
          given_name: profile.given_name,
          family_name: profile.family_name,
          fullname: profile.fullname,
          preferred_username: profile.preferred_username,
          resolved: name,
        });

        return {
          id: profile.sub,
          name,
          email: profile.email || profile.username,
          image: profile.picture,
        };
      },
    },
  ],
  callbacks: {
    async jwt({ token, account, profile, trigger, session: updateData }) {
      // Strip idToken from existing sessions — it adds ~1KB and pushes
      // the cookie over the 4096-byte limit, causing chunking loops.
      if (token.idToken) {
        delete token.idToken;
      }

      // Force-refresh when admin changes roles/permissions and calls
      // update({ forceRefresh: true }) from the client.
      if (
        trigger === "update" &&
        updateData &&
        typeof updateData === "object" &&
        (updateData as Record<string, unknown>).forceRefresh &&
        token.refreshToken
      ) {
        console.log("[Auth] Force-refreshing token");
        const refreshed = await refreshAccessToken(token) as typeof token;
        return refreshed;
      }

      // Initial sign in - persist the OAuth tokens (NOT id_token).
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;

        // Calculate refresh token expiry if refresh_expires_in is provided
        // Some OIDC providers (like Keycloak) include this field
        if (account.refresh_expires_in) {
          token.refreshTokenExpiresAt = Math.floor(Date.now() / 1000) + (account.refresh_expires_in as number);
        }

        const expiryDate = new Date((account.expires_at || 0) * 1000).toISOString();
        console.log("[Auth] Initial sign-in, token expires at:", expiryDate);

        // Log whether refresh token support is available
        if (ENABLE_REFRESH_TOKEN) {
          if (account.refresh_token) {
            console.log("[Auth] ✅ Refresh token available - seamless token renewal enabled");
            if (token.refreshTokenExpiresAt) {
              const refreshExpiryDate = new Date(token.refreshTokenExpiresAt * 1000).toISOString();
              console.log("[Auth] Refresh token expires at:", refreshExpiryDate);
            }
          } else {
            console.warn("[Auth] ⚠️  Refresh token not provided by OIDC provider - falling back to expiry warnings");
            console.warn("[Auth] Hint: Ensure OIDC provider supports 'offline_access' scope");
          }
        } else {
          console.log("[Auth] ℹ️  Refresh token support disabled (OIDC_ENABLE_REFRESH_TOKEN=false)");
        }
      }

      // Extract and check groups from profile (but DON'T store them - too large!)
      if (profile) {
        // Cast profile to Record for group extraction
        const profileData = profile as unknown as Record<string, unknown>;

        // Extract groups for authorization check only (not stored in token)
        const groups = extractGroups(profileData);
        const subject = (profileData.sub as string | undefined) ?? (token.sub as string | undefined);
        cacheOidcClaimGroups(subject, groups);

        // Only store the authorization result (NOT the groups array!)
        // Storing 40+ groups causes 8KB session cookies and browser crashes.
        token.isAuthorized = hasRequiredGroup(groups);
        token.canViewAdmin = canViewAdminDashboard(groups);
        token.canAccessDynamicAgents = canAccessDynamicAgents(groups);
        token.groupsCheckedAt = Math.floor(Date.now() / 1000);

        const email = profileData.email as string | undefined;
        const adminViaBootstrap = isBootstrapAdmin(email);
        const adminViaGroup = isAdminUser(groups);
        token.role = adminViaBootstrap || adminViaGroup ? 'admin' : 'user';

        if (adminViaBootstrap) {
          console.log(`[Auth JWT] ✅ Bootstrap admin granted for ${email} (via BOOTSTRAP_ADMIN_EMAILS)`);
        }
        if (adminViaGroup) {
          console.log(`[Auth JWT] ✅ Admin group detected for ${email}; OpenFGA admin bootstrap will reconcile`);
        }

        // Extract org claim for multi-tenant isolation (FR-020)
        if (typeof profileData.org === "string") {
          token.org = profileData.org;
        }

        // Debug logging (groups array is NOT stored in token)
        console.log('[Auth JWT] User groups count:', groups.length);
        console.log('[Auth JWT] User role:', token.role);
        console.log('[Auth JWT] Is authorized:', token.isAuthorized);
        if (token.org) {
          console.log('[Auth JWT] Org (tenant):', token.org);
        }

        const displayName =
          (profileData.name as string | undefined) ??
          (profileData.preferred_username as string | undefined);

        await import("@/lib/rbac/login-openfga-bootstrap")
          .then(({ reconcileLoginOpenFgaAccess }) =>
            reconcileLoginOpenFgaAccess({
              subject,
              email,
              isAuthorized: token.isAuthorized === true,
              isAdmin: token.role === "admin",
            })
          )
          .catch((error) => {
            console.warn("[Auth] Login OpenFGA bootstrap failed:", error);
          });

        await reconcileLoginGroupsFromClaims({
          subject,
          email,
          displayName,
          groups,
          providerId: resolveLoginProviderId(profileData),
        });
      }

      // NOTE: When trigger === "update" (from updateSession() or refetchInterval),
      // we intentionally DO NOT return early. The refresh logic below must run
      // so that proactive token refresh works. Previously, an early return here
      // caused updateSession() calls to return the stale token without refreshing.

      // Check if token needs refresh (refresh 5 minutes before expiry)
      // Only attempt if refresh token support is enabled
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = token.expiresAt as number | undefined;

      if (ENABLE_REFRESH_TOKEN && expiresAt) {
        const timeUntilExpiry = expiresAt - now;

        const shouldRefresh = timeUntilExpiry < 5 * 60; // Refresh if less than 5 min remaining

        if (shouldRefresh) {
          // Don't attempt refresh if there's already an error (prevents loops)
          if (token.error) {
            console.warn(`[Auth] Token refresh already failed (${token.error}), skipping refresh attempt`);
            return token;
          }

          // Don't attempt refresh if suppressed (graceful invalid_grant already handled)
          // This prevents infinite refresh loops when the refresh token is consumed but
          // the access token is still valid.
          const suppressedUntil = token.refreshSuppressedUntil as number | undefined;
          if (suppressedUntil && now < suppressedUntil) {
            return token;
          }

          console.debug(`[Auth] Token expires in ${timeUntilExpiry}s, attempting refresh...`);

          // Only attempt refresh if we have a refresh token
          if (token.refreshToken) {
            const refreshedToken = await refreshAccessToken(token) as typeof token;

            // If refresh returned the same access token (graceful invalid_grant race),
            // suppress further refresh attempts until the token expires to prevent
            // an infinite refresh loop.
            if (!refreshedToken.error && refreshedToken.accessToken === token.accessToken) {
              console.log(`[Auth] Refresh suppressed — access token still valid for ${timeUntilExpiry}s, will not retry`);
              return { ...refreshedToken, refreshSuppressedUntil: expiresAt };
            }

            // Re-evaluate group authorization every 4 hours using claims from
            // the fresh id_token. This ensures revoked group membership takes
            // effect within 4 hours rather than persisting for the full 24h session.
            const GROUP_RECHECK_INTERVAL = 4 * 60 * 60; // seconds
            const lastGroupCheck = (refreshedToken.groupsCheckedAt as number | undefined) ?? 0;
            const shouldRecheckGroups =
              !refreshedToken.error &&
              refreshedToken.idToken &&
              (now - lastGroupCheck) >= GROUP_RECHECK_INTERVAL;

            if (shouldRecheckGroups) {
              try {
                const claims = decodeJwt(refreshedToken.idToken as string);
                const groups = extractGroups(claims as Record<string, unknown>);
                cacheOidcClaimGroups(token.sub as string | undefined, groups);
                console.log(`[Auth] Re-evaluating groups from refreshed id_token (last checked ${Math.round((now - lastGroupCheck) / 3600)}h ago), count: ${groups.length}`);
                return {
                  ...refreshedToken,
                  isAuthorized: hasRequiredGroup(groups),
                  role: refreshedToken.role === 'admin' ? 'admin' : 'user',
                  canViewAdmin: canViewAdminDashboard(groups),
                  groupsCheckedAt: now,
                };
              } catch (err) {
                console.warn('[Auth] Failed to decode id_token for group re-check, keeping existing authorization:', err);
              }
            }

            return refreshedToken;
          } else {
            console.debug("[Auth] No refresh token available, falling back to expiry warnings");
            // Don't set error - just fall back to warning system
            // This allows graceful degradation if provider doesn't support refresh tokens
          }
        }
      }

      return token;
    },
    async session({ session, token }) {
      // Send properties to the client
      // IMPORTANT: Minimize what we store to keep cookie under 4096 bytes!
      // Don't store full tokens in session - they're huge (2KB+ each)
      // Only store what the client actually needs

      if (!token.error && token.sub && !token.accessToken) {
        token.error = "AccessTokenMissing";
      }

      // Only pass tokens if they're valid (not expired)
      if (!token.error) {
        session.accessToken = token.accessToken as string;
        session.hasRefreshToken = !!token.refreshToken;
      }

      session.error = token.error as string | undefined;
      session.isAuthorized = token.isAuthorized as boolean;
      session.expiresAt = token.expiresAt as number | undefined;

      // Pass refresh token metadata (NOT the token itself - security)
      session.hasRefreshToken = !!token.refreshToken;
      session.refreshTokenExpiresAt = token.refreshTokenExpiresAt as number | undefined;

      // Set role from token (OIDC group check only here)
      // MongoDB fallback check happens in API middleware (server-side only)
      session.role = (token.role as 'admin' | 'user') || 'user';
      // For pre-upgrade JWTs that lack canViewAdmin, default to true when no
      // admin view group is configured (all authenticated users can view).
      session.canViewAdmin = (token.canViewAdmin as boolean)
        ?? (REQUIRED_ADMIN_VIEW_GROUP === '' ? true : false);
      // Legacy context flag only. Dynamic Agents authorization is enforced by
      // OpenFGA-backed BFF/resource checks, not OIDC/AD group claims.
      session.canAccessDynamicAgents = true;

      // If token refresh failed or the server-side token cache was lost,
      // mark session as invalid and DON'T include tokens.
      if (
        token.error === "RefreshTokenExpired" ||
        token.error === "RefreshTokenError" ||
        token.error === "AccessTokenMissing"
      ) {
        console.error(`[Auth] Session invalid due to: ${token.error}`);
        session.error = token.error;
        // Clear tokens from session to reduce cookie size
        session.accessToken = undefined;
      }

      // User info is already populated by NextAuth from the profile() callback
      // We don't store profile in token anymore (saves session cookie size)
      // Just pass through the sub if available
      session.sub = token.sub as string | undefined;

      // Organization claim is tenant context only; authorization is OpenFGA-backed.
      session.org = token.org as string | undefined;

      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60, // 24 hours
  },
  // Custom encode/decode: offload large OAuth tokens (refreshToken, idToken)
  // to server-side memory so the encrypted cookie stays under 4096 bytes.
  // The JWT callback and session callback are unaffected — tokens are
  // transparently rehydrated on decode and stripped on encode.
  jwt: {
    async encode({ token, secret, maxAge }) {
      if (token?.sub) {
        await storeTokens(token.sub, {
          accessToken: token.accessToken as string | undefined,
          refreshToken: token.refreshToken as string | undefined,
          idToken: token.idToken as string | undefined,
        });
      }
      const slimToken = { ...(token ?? {}) } as Record<string, unknown>;
      delete slimToken.accessToken;
      delete slimToken.refreshToken;
      delete slimToken.idToken;
      // Dynamic import avoids top-level ESM/CJS conflict with jose in test environments
      const { encode } = await import("next-auth/jwt");
      return encode({ token: slimToken, secret, maxAge });
    },
    async decode({ token, secret }) {
      const { decode } = await import("next-auth/jwt");
      const decoded = await decode({ token, secret });
      if (decoded?.sub) {
        const stored = await getStoredTokens(decoded.sub);
        if (stored) {
          if (stored.accessToken) decoded.accessToken = stored.accessToken;
          if (stored.refreshToken) decoded.refreshToken = stored.refreshToken;
          if (stored.idToken) decoded.idToken = stored.idToken;
        }
      }
      return decoded;
    },
  },
  // Explicitly disable session store (we use JWT only)
  // This prevents NextAuth from trying to write SST files
  adapter: undefined,
  cookies: {
    sessionToken: {
      name: `next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        // Mark the session cookie `Secure` only when the site is actually
        // served over HTTPS. Keying this off NODE_ENV alone breaks local
        // installs: the prod UI image runs NODE_ENV=production but is browsed
        // over http://localhost, and browsers silently drop a `Secure` cookie
        // on plain http — causing an infinite SSO sign-in loop. Prod
        // deployments set NEXTAUTH_URL to their https URL, so this stays true.
        secure:
          process.env.NODE_ENV === 'production' &&
          (process.env.NEXTAUTH_URL ?? '').startsWith('https://'),
        // Reduce session cookie size by not storing everything in cookie
        maxAge: 24 * 60 * 60, // 24 hours
      },
    },
  },
  debug: process.env.NEXTAUTH_DEBUG === "true",
  // Disable NextAuth's internal logging persistence to prevent SST file errors
  logger: {
    error(code, metadata) {
      console.error('[NextAuth] Error:', code, metadata);
    },
    warn(code) {
      console.warn('[NextAuth] Warning:', code);
    },
    debug(code, metadata) {
      if (process.env.NODE_ENV === "development") {
        console.debug('[NextAuth] Debug:', code, metadata);
      }
    },
  },
};

// Extend next-auth types
declare module "next-auth" {
  interface Session {
    accessToken?: string;
    hasRefreshToken?: boolean;
    error?: string;
    isAuthorized?: boolean;
    sub?: string;
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    role?: 'admin' | 'user';
    canViewAdmin?: boolean; // Whether user can view admin dashboard (read-only)
    canAccessDynamicAgents?: boolean; // Legacy context flag; OpenFGA authorizes agents
    org?: string;           // Tenant identifier from org claim (FR-020)
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    error?: string;
    isAuthorized?: boolean;
    role?: 'admin' | 'user';
    canViewAdmin?: boolean;
    canAccessDynamicAgents?: boolean; // Legacy context flag; OpenFGA authorizes agents
    groupsCheckedAt?: number; // Unix timestamp of last group re-evaluation
    refreshSuppressedUntil?: number; // Unix timestamp — skip refresh attempts until this time (set after graceful invalid_grant)
    org?: string;           // Tenant identifier from org claim (FR-020)
  }
}

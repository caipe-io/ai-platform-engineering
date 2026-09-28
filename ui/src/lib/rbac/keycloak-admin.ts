// assisted-by Codex Codex-sonnet-4-6
import { randomBytes } from "crypto";

export interface KeycloakRole {
  id: string;
  name: string;
  description?: string;
  composite: boolean;
  clientRole: boolean;
  containerId: string;
}

export interface KeycloakIdpAlias {
  alias: string;
  displayName?: string;
  providerId: string;
  enabled?: boolean;
}

export interface KeycloakIdpMapper {
  id?: string;
  name?: string;
  identityProviderAlias?: string;
  identityProviderMapper?: string;
  config?: Record<string, string>;
}

export const BUILT_IN_ROLES = [
  "offline_access",
  "uma_authorization",
  "default-roles-caipe",
] as const;

const BUILT_IN_ROLE_SET = new Set<string>(BUILT_IN_ROLES);

type TokenCache = {
  token: string;
  expiresAtMs: number;
};

let tokenCache: TokenCache | null = null;
let tokenRefreshPromise: Promise<string> | null = null;

function getKeycloakUrl(): string {
  const url = process.env.KEYCLOAK_URL?.trim();
  if (!url) {
    throw new Error("KEYCLOAK_URL is not set");
  }
  return url.replace(/\/$/, "");
}

function getRealm(): string {
  const realm = process.env.KEYCLOAK_REALM?.trim();
  return realm || "caipe";
}

export { getRealm as getKeycloakRealm };

function getRealmTokenEndpoint(): string {
  return `${getKeycloakUrl()}/realms/${encodeURIComponent(getRealm())}/protocol/openid-connect/token`;
}

function getMasterTokenEndpoint(): string {
  return `${getKeycloakUrl()}/realms/master/protocol/openid-connect/token`;
}

function getAdminBaseUrl(): string {
  return `${getKeycloakUrl()}/admin/realms/${encodeURIComponent(getRealm())}`;
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return response.statusText || String(response.status);
  }
  try {
    const json = JSON.parse(text) as { error?: string; error_description?: string };
    if (json.error || json.error_description) {
      return [json.error, json.error_description].filter(Boolean).join(": ");
    }
  } catch {}
  return text.slice(0, 500);
}

async function requestTokenFromKeycloak(
  endpoint: string,
  body: URLSearchParams,
  label: string
): Promise<TokenCache> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(`Keycloak token (${label}) failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error(`Keycloak token (${label}) response missing access_token or expires_in`);
  }

  const bufferMs = 30_000;
  const expiresAtMs = Date.now() + Math.max(0, data.expires_in * 1000 - bufferMs);
  console.log(`[KeycloakAdmin] Obtained admin token via ${label}, cached until ~${new Date(expiresAtMs).toISOString()}`);
  return { token: data.access_token, expiresAtMs };
}

/**
 * Decide whether the `admin/admin` password-grant fallback against
 * `/realms/master` is allowed in this process. The fallback is a
 * convenience for local dev / docker-compose where the operator may not
 * have plumbed `KEYCLOAK_ADMIN_CLIENT_ID/SECRET` yet — but in a real
 * deployment it represents master-realm admin escalation from the BFF
 * if the Keycloak bootstrap admin password is still the default. We
 * therefore disable it unless the operator opts in OR the process is
 * obviously a dev/test build.
 *
 * Opt-in signals (any one wins):
 *   - `ALLOW_KEYCLOAK_ADMIN_PASSWORD_FALLBACK=true` (the explicit knob;
 *     set by docker-compose.dev and by the umbrella chart's values
 *     under a `dev-fallback` profile)
 *   - `NODE_ENV !== "production"` (matches every dev build of Node and
 *     keeps the local DX unchanged)
 *
 * Anything else throws — see the call site below — so a misconfigured
 * production install fails loudly with a configuration error instead of
 * silently calling /realms/master with `admin/admin`.
 */
function adminPasswordFallbackAllowed(): boolean {
  const explicit = process.env.ALLOW_KEYCLOAK_ADMIN_PASSWORD_FALLBACK?.trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  return nodeEnv !== "production";
}

async function fetchFreshAdminToken(): Promise<TokenCache> {
  const clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID?.trim();
  const clientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET?.trim();

  if (clientId && clientSecret) {
    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      });
      return await requestTokenFromKeycloak(
        getRealmTokenEndpoint(),
        body,
        "client_credentials"
      );
    } catch (err) {
      if (!adminPasswordFallbackAllowed()) {
        // Re-throw the underlying error verbatim so the operator sees
        // exactly which Keycloak response broke us (status + body).
        throw err;
      }
      console.warn(
        "[KeycloakAdmin] client_credentials failed, falling back to password grant:",
        err
      );
    }
  } else {
    if (!adminPasswordFallbackAllowed()) {
      throw new Error(
        "Keycloak admin credentials missing: set KEYCLOAK_ADMIN_CLIENT_ID + " +
          "KEYCLOAK_ADMIN_CLIENT_SECRET (via the keycloak.platformClient secret " +
          "in the Helm chart, or your secret store). The admin/admin password-grant " +
          "fallback is disabled in production — set " +
          "ALLOW_KEYCLOAK_ADMIN_PASSWORD_FALLBACK=true to opt in for local dev only."
      );
    }
    console.warn("[KeycloakAdmin] Missing admin client id/secret; using password grant (dev)");
  }

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username: "admin",
    password: "admin",
  });
  return await requestTokenFromKeycloak(
    getMasterTokenEndpoint(),
    body,
    "password (admin-cli)"
  );
}

export async function getAdminToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache !== null && tokenCache.expiresAtMs > now) {
    return tokenCache.token;
  }

  if (tokenRefreshPromise !== null) {
    return tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
    const next = await fetchFreshAdminToken();
    tokenCache = next;
    return next.token;
  })();

  try {
    return await tokenRefreshPromise;
  } finally {
    tokenRefreshPromise = null;
  }
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAdminToken();
  const url = `${getAdminBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

async function parseJsonArray<T>(response: Response): Promise<T[]> {
  if (response.status === 204) {
    return [];
  }
  const text = await response.text();
  if (!text) {
    return [];
  }
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Keycloak Admin API returned a non-array JSON body");
  }
  return data as T[];
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok || response.status === 204) {
    return;
  }
  const detail = await readErrorBody(response);
  throw new Error(`Keycloak Admin ${action} failed: ${response.status} ${detail}`);
}

export async function listRealmRoles(): Promise<KeycloakRole[]> {
  console.log("[KeycloakAdmin] listRealmRoles");
  const response = await adminFetch("/roles", { method: "GET" });
  await assertOk(response, "listRealmRoles");
  const raw = await parseJsonArray<Record<string, unknown>>(response);
  return raw.map((r) => {
    const id = String(r.id ?? "");
    const name = String(r.name ?? "");
    return {
      id,
      name,
      description: r.description !== undefined && r.description !== null ? String(r.description) : undefined,
      composite: Boolean(r.composite),
      clientRole: Boolean(r.clientRole),
      containerId: String(r.containerId ?? ""),
    };
  });
}

export async function createRealmRole(name: string, description?: string): Promise<void> {
  console.log(`[KeycloakAdmin] createRealmRole name=${name}`);
  const response = await adminFetch("/roles", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
  await assertOk(response, "createRealmRole");
}

export async function getRoleByName(name: string): Promise<KeycloakRole> {
  const encoded = encodeURIComponent(name);
  const response = await adminFetch(`/roles/${encoded}`, { method: "GET" });
  await assertOk(response, `getRoleByName(${name})`);
  const r = (await response.json()) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? name),
    description: r.description !== undefined && r.description !== null ? String(r.description) : undefined,
    composite: Boolean(r.composite),
    clientRole: Boolean(r.clientRole),
    containerId: String(r.containerId ?? ""),
  };
}

export async function deleteRealmRole(name: string): Promise<void> {
  if (BUILT_IN_ROLE_SET.has(name)) {
    throw new Error(`Cannot delete built-in realm role: ${name}`);
  }
  const role = await getRoleByName(name);
  if (!role.id) {
    throw new Error(`Keycloak role "${name}" has no id; cannot delete`);
  }
  console.log(`[KeycloakAdmin] deleteRealmRole name=${name} id=${role.id}`);
  const response = await adminFetch(`/roles-by-id/${encodeURIComponent(role.id)}`, {
    method: "DELETE",
  });
  await assertOk(response, "deleteRealmRole");
}

export async function listIdpAliases(): Promise<KeycloakIdpAlias[]> {
  console.log("[KeycloakAdmin] listIdpAliases");
  const response = await adminFetch("/identity-provider/instances", { method: "GET" });
  await assertOk(response, "listIdpAliases");
  const raw = await parseJsonArray<Record<string, unknown>>(response);
  return raw.map((p) => ({
    alias: String(p.alias ?? ""),
    displayName:
      p.displayName !== undefined && p.displayName !== null ? String(p.displayName) : undefined,
    providerId: String(p.providerId ?? ""),
    enabled: p.enabled !== false,
  }));
}

export async function listIdpMappers(alias: string): Promise<KeycloakIdpMapper[]> {
  console.log(`[KeycloakAdmin] listIdpMappers alias=${alias}`);
  const enc = encodeURIComponent(alias);
  const response = await adminFetch(`/identity-provider/instances/${enc}/mappers`, { method: "GET" });
  await assertOk(response, "listIdpMappers");
  const raw = await parseJsonArray<Record<string, unknown>>(response);
  return raw.map((m) => {
    const config = m.config;
    return {
      id: m.id !== undefined && m.id !== null ? String(m.id) : undefined,
      name: m.name !== undefined && m.name !== null ? String(m.name) : undefined,
      identityProviderAlias:
        m.identityProviderAlias !== undefined && m.identityProviderAlias !== null
          ? String(m.identityProviderAlias)
          : undefined,
      identityProviderMapper:
        m.identityProviderMapper !== undefined && m.identityProviderMapper !== null
          ? String(m.identityProviderMapper)
          : undefined,
      config:
        config !== undefined && config !== null && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, string>)
          : undefined,
    };
  });
}

export async function createGroupRoleMapper(
  alias: string,
  groupName: string,
  roleName: string
): Promise<KeycloakIdpMapper> {
  const mapperName = `${alias}-${groupName}-to-${roleName}`
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 240);
  const payload = {
    name: mapperName,
    identityProviderAlias: alias,
    identityProviderMapper: "oidc-advanced-role-idp-mapper",
    config: {
      syncMode: "INHERIT",
      "are.claim.values.regex": "false",
      claims: JSON.stringify([{ key: "groups", value: groupName }]),
      role: roleName,
    },
  };
  console.log(`[KeycloakAdmin] createGroupRoleMapper alias=${alias} group=${groupName} role=${roleName}`);
  const enc = encodeURIComponent(alias);
  const response = await adminFetch(`/identity-provider/instances/${enc}/mappers`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (response.status === 409) {
    // Mapper name is deterministic (alias-group-to-role), so a retry or a
    // repeat sync of the same group→role mapping hits this every time — the
    // desired state (the mapping exists) already holds. Resolve and return it.
    const existing = (await listIdpMappers(alias)).find((m) => m.name === mapperName);
    if (existing) return existing;
    throw new Error(`createGroupRoleMapper(${mapperName}): 409 but mapper not found on re-query`);
  }
  await assertOk(response, "createGroupRoleMapper");
  const text = await response.text();
  if (!text) {
    return {};
  }
  const m = JSON.parse(text) as Record<string, unknown>;
  const config = m.config;
  return {
    id: m.id !== undefined && m.id !== null ? String(m.id) : undefined,
    name: m.name !== undefined && m.name !== null ? String(m.name) : undefined,
    identityProviderAlias:
      m.identityProviderAlias !== undefined && m.identityProviderAlias !== null
        ? String(m.identityProviderAlias)
        : undefined,
    identityProviderMapper:
      m.identityProviderMapper !== undefined && m.identityProviderMapper !== null
        ? String(m.identityProviderMapper)
        : undefined,
    config:
      config !== undefined && config !== null && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, string>)
        : undefined,
  };
}

export async function listRealmUsersPage(
  first: number,
  max: number
): Promise<Array<Record<string, unknown>>> {
  const response = await adminFetch(
    `/users?first=${first}&max=${max}`,
    { method: "GET" }
  );
  await assertOk(response, "listRealmUsersPage");
  return parseJsonArray<Record<string, unknown>>(response);
}

export async function listRealmRoleMappingsForUser(
  userId: string
): Promise<KeycloakRole[]> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(
    `/users/${enc}/role-mappings/realm`,
    { method: "GET" }
  );
  await assertOk(response, "listRealmRoleMappingsForUser");
  const raw = await parseJsonArray<Record<string, unknown>>(response);
  return raw.map((r) => ({
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    description:
      r.description !== undefined && r.description !== null
        ? String(r.description)
        : undefined,
    composite: Boolean(r.composite),
    clientRole: Boolean(r.clientRole),
    containerId: String(r.containerId ?? ""),
  }));
}

export async function getRealmUserById(
  userId: string
): Promise<Record<string, unknown>> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}`, { method: "GET" });
  await assertOk(response, `getRealmUserById(${userId})`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Like {@link getRealmUserById} but returns `null` on a Keycloak 404 instead
 * of throwing. Used by the `/api/admin/users/resolve` BFF endpoint so a
 * "no such user" lookup is a normal `data: null` result rather than a 500 —
 * matching the "not found is a branch, not an error" contract its callers
 * (the Slack bot's user-directory lookups) rely on.
 */
export async function getRealmUserByIdOrNull(
  userId: string
): Promise<Record<string, unknown> | null> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}`, { method: "GET" });
  if (response.status === 404) return null;
  await assertOk(response, `getRealmUserByIdOrNull(${userId})`);
  return (await response.json()) as Record<string, unknown>;
}

export async function mergeUserAttributes(
  userId: string,
  attrs: Record<string, unknown>
): Promise<void> {
  const user = await getRealmUserById(userId);
  const existing =
    user.attributes && typeof user.attributes === "object" && !Array.isArray(user.attributes)
      ? (user.attributes as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}`, {
    method: "PUT",
    body: JSON.stringify({ ...user, attributes: merged }),
  });
  await assertOk(response, `mergeUserAttributes(${userId})`);
}

export interface KeycloakSession {
  id: string;
  username?: string;
  ipAddress?: string;
  start?: number;
  lastAccess?: number;
}

export interface KeycloakFederatedIdentity {
  identityProvider: string;
  userId: string;
  userName: string;
}

export interface SearchUsersParams {
  search?: string;
  enabled?: boolean;
  first?: number;
  max?: number;
}

export interface KeycloakUserEnsureResult {
  id: string;
  email: string;
  created: boolean;
}

export async function searchRealmUsers(
  params: SearchUsersParams
): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams();
  if (params.search) qs.set("search", params.search);
  if (params.enabled !== undefined) qs.set("enabled", String(params.enabled));
  qs.set("first", String(params.first ?? 0));
  qs.set("max", String(params.max ?? 20));
  const response = await adminFetch(`/users?${qs.toString()}`, { method: "GET" });
  await assertOk(response, "searchRealmUsers");
  return parseJsonArray<Record<string, unknown>>(response);
}

export async function findRealmUsersByExactEmail(email: string): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    email,
    exact: "true",
    first: "0",
    max: "5",
  });
  const response = await adminFetch(`/users?${qs.toString()}`, { method: "GET" });
  await assertOk(response, "findRealmUsersByExactEmail");
  return parseJsonArray<Record<string, unknown>>(response);
}

export async function countRealmUsers(
  params?: Pick<SearchUsersParams, "search" | "enabled">
): Promise<number> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set("search", params.search);
  if (params?.enabled !== undefined) qs.set("enabled", String(params.enabled));
  const response = await adminFetch(`/users/count?${qs.toString()}`, { method: "GET" });
  await assertOk(response, "countRealmUsers");
  const text = await response.text();
  return parseInt(text, 10) || 0;
}

export async function getUserSessions(
  userId: string
): Promise<KeycloakSession[]> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}/sessions`, { method: "GET" });
  await assertOk(response, "getUserSessions");
  const raw = await parseJsonArray<Record<string, unknown>>(response);
  return raw.map((s) => ({
    id: String(s.id ?? ""),
    username: s.username !== undefined ? String(s.username) : undefined,
    ipAddress: s.ipAddress !== undefined ? String(s.ipAddress) : undefined,
    start: typeof s.start === "number" ? s.start : undefined,
    lastAccess: typeof s.lastAccess === "number" ? s.lastAccess : undefined,
  }));
}

export async function getUserFederatedIdentities(
  userId: string
): Promise<KeycloakFederatedIdentity[]> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}/federated-identity`, { method: "GET" });
  await assertOk(response, "getUserFederatedIdentities");
  const raw = await parseJsonArray<Record<string, unknown>>(response);
  return raw.map((fi) => ({
    identityProvider: String(fi.identityProvider ?? ""),
    userId: String(fi.userId ?? ""),
    userName: String(fi.userName ?? ""),
  }));
}

/**
 * Register a federated-identity link for `userId` against IdP `alias`, using
 * the same shape Keycloak's OIDC broker writes on a real SSO login
 * (`federatedIdentities[].userId` = the broker's `sub`). Despite the docs, in
 * practice Keycloak's link endpoint does not replace an existing link for the
 * same alias — it 409s with "User is already linked with provider" instead.
 * That means the desired end state (the user is linked) already holds, so it
 * is treated as a no-op success rather than an error, matching the 409/404
 * "already in desired state" handling used elsewhere in this file (e.g.
 * {@link createFederatedShellUser}, {@link deleteRealmUser}). A 404 (user
 * doesn't exist) is not swallowed — the caller has a stale id and should
 * surface the error.
 */
export async function linkFederatedIdentity(
  userId: string,
  alias: string,
  identity: { userId: string; userName: string }
): Promise<void> {
  const encUser = encodeURIComponent(userId);
  const encAlias = encodeURIComponent(alias);
  const response = await adminFetch(`/users/${encUser}/federated-identity/${encAlias}`, {
    method: "POST",
    body: JSON.stringify({
      identityProvider: alias,
      userId: identity.userId,
      userName: identity.userName,
    }),
  });
  if (response.status === 409) return;
  await assertOk(response, `linkFederatedIdentity(${userId}, ${alias})`);
}

export async function assignRealmRolesToUser(
  userId: string,
  roles: KeycloakRole[]
): Promise<void> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}/role-mappings/realm`, {
    method: "POST",
    body: JSON.stringify(roles),
  });
  await assertOk(response, "assignRealmRolesToUser");
}

export async function removeRealmRolesFromUser(
  userId: string,
  roles: KeycloakRole[]
): Promise<void> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}/role-mappings/realm`, {
    method: "DELETE",
    body: JSON.stringify(roles),
  });
  await assertOk(response, "removeRealmRolesFromUser");
}

export async function updateUser(
  userId: string,
  data: Record<string, unknown>
): Promise<void> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  await assertOk(response, "updateUser");
}

export async function deleteRealmUser(userId: string): Promise<void> {
  const enc = encodeURIComponent(userId);
  const response = await adminFetch(`/users/${enc}`, { method: "DELETE" });
  if (response.status === 404) return;
  await assertOk(response, `deleteRealmUser(${userId})`);
}

export async function listUsersWithRole(
  roleName: string,
  first = 0,
  max = 100
): Promise<Array<Record<string, unknown>>> {
  const enc = encodeURIComponent(roleName);
  const response = await adminFetch(
    `/roles/${enc}/users?first=${first}&max=${max}`,
    { method: "GET" }
  );
  await assertOk(response, "listUsersWithRole");
  return parseJsonArray<Record<string, unknown>>(response);
}

export async function deleteIdpMapper(alias: string, mapperId: string): Promise<void> {
  console.log(`[KeycloakAdmin] deleteIdpMapper alias=${alias} mapperId=${mapperId}`);
  const encAlias = encodeURIComponent(alias);
  const encId = encodeURIComponent(mapperId);
  const response = await adminFetch(`/identity-provider/instances/${encAlias}/mappers/${encId}`, {
    method: "DELETE",
  });
  await assertOk(response, "deleteIdpMapper");
}

/** Alias for callers that expect the name `getKeycloakAdminToken` (098 RBAC resource sync). */
export { getAdminToken as getKeycloakAdminToken };

// ─────────────────────────────────────────────────────────────────────────────
// Spec 104 helpers — Keycloak admin conveniences used during ReBAC sync.
//
// `ensureRealmRole` is retained for coarse/bootstrap role administration only.
// Per-resource grants such as `agent_user:<id>` and `tool_user:<id>` belong in
// OpenFGA relationships and should not be created here for new flows.
//
// `findUserIdByEmail` is a thin convenience around `searchRealmUsers` for the
// common "I have an email, give me the Keycloak `sub`" case used when
// reconciling team membership → OpenFGA tuples.
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureRealmRole(
  name: string,
  description?: string
): Promise<KeycloakRole> {
  try {
    return await getRoleByName(name);
  } catch {
    await createRealmRole(name, description);
    return await getRoleByName(name);
  }
}

export async function findUserIdByEmail(email: string): Promise<string | null> {
  if (!email || !email.trim()) return null;
  const trimmed = email.trim().toLowerCase();
  const matches = await searchRealmUsers({ search: trimmed, max: 5 });
  for (const u of matches) {
    const userEmail = typeof u.email === "string" ? u.email.toLowerCase() : "";
    const userName = typeof u.username === "string" ? u.username.toLowerCase() : "";
    if (userEmail === trimmed || userName === trimmed) {
      const id = u.id;
      return typeof id === "string" && id ? id : null;
    }
  }
  // Fallback: if exactly one match and the prefix matches, return it. Keycloak's
  // `search` is a substring match; we don't want to accidentally pick the wrong
  // user, so we only accept the loose match when the result set is unambiguous.
  if (matches.length === 1) {
    const id = matches[0]?.id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

// Parse the new user's UUID from the `Location` header of a Keycloak user
// create (`.../users/<uuid>`).
function parseUserIdFromLocation(location: string | null): string | null {
  if (!location) return null;
  const id = location.split("/").pop()?.trim();
  return id || null;
}

// Keycloak's built-in `person-name-prohibited-characters` validator rejects
// firstName/lastName containing any of these characters with
// `error-person-name-invalid-character` (see
// PersonNameProhibitedCharactersValidator.PATTERN upstream). Directory-sourced
// names (e.g. Okta display names like "Jane Doe (Contractor)") can legitimately
// contain them, so strip rather than reject — losing a stray character is
// better than failing provisioning outright.
const PERSON_NAME_PROHIBITED_CHARS = /[<>&"\v$%!#?§;*~/\\|^=[\]{}()\x00-\x1f\x7f]/g;

function sanitizePersonNamePart(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(PERSON_NAME_PROHIBITED_CHARS, "").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

/**
 * Create a federated-only "shell" Keycloak user from an email so RBAC can be
 * granted before the person ever logs into CAIPE. Mirrors the Slack bot's
 * spec-103 shape: lowercased email as username+email, no password, no required
 * actions, `emailVerified: true`. On a first OIDC login the user "resumes" this
 * account (Keycloak matches by email). Idempotent: a 409 (already exists) falls
 * back to resolving the existing user by email.
 *
 * Most callers should prefer {@link provisionShellUser}, which stamps the
 * canonical `created_by` / `created_at` audit attributes; this lower-level
 * helper is the create primitive it (and the bootstrap paths) build on.
 */
export async function createFederatedShellUser(
  email: string,
  attributes: Record<string, string[]> = {},
  name?: { firstName?: string; lastName?: string }
): Promise<string> {
  const emailLower = email.trim().toLowerCase();
  const firstName = sanitizePersonNamePart(name?.firstName);
  const lastName = sanitizePersonNamePart(name?.lastName);
  const body: Record<string, unknown> = {
    username: emailLower,
    email: emailLower,
    emailVerified: true,
    enabled: true,
    requiredActions: [],
    attributes,
    ...(firstName && { firstName }),
    ...(lastName && { lastName }),
  };
  const response = await adminFetch(`/users`, { method: "POST", body: JSON.stringify(body) });

  if (response.status === 409) {
    // Race or pre-existing: re-resolve by email.
    const existing = await findUserIdByEmail(emailLower);
    if (existing) return existing;
    throw new Error(`createFederatedShellUser(${emailLower}): 409 but user not found on re-query`);
  }
  await assertOk(response, `createFederatedShellUser(${emailLower})`);

  const id = parseUserIdFromLocation(response.headers.get("location"));
  if (id) return id;
  // Some Keycloak configs omit a usable Location; fall back to lookup.
  const resolved = await findUserIdByEmail(emailLower);
  if (resolved) return resolved;
  throw new Error(`createFederatedShellUser(${emailLower}): could not determine new user id`);
}

async function maybeUpdateUserName(
  userId: string,
  name: { firstName?: string; lastName?: string }
): Promise<void> {
  const existing = await getRealmUserByIdOrNull(userId);
  if (!existing) return;
  const firstName = sanitizePersonNamePart(name.firstName);
  const lastName = sanitizePersonNamePart(name.lastName);
  // Only patch if the user is missing a name entirely (shell user never had one set)
  // OR if Okta has a different name
  const needsUpdate =
    (firstName && existing.firstName !== firstName) || (lastName && existing.lastName !== lastName);
  if (!needsUpdate) return;
  // Don't overwrite a manually-set name with nothing
  if (!firstName && !lastName) return;
  await updateUser(userId, {
    ...(firstName && { firstName }),
    ...(lastName && { lastName }),
  });
}

/**
 * Resolve an email to a Keycloak `sub`, creating a federated shell user when no
 * account exists yet. Returns the sub plus whether it was newly created.
 */
export async function resolveOrProvisionUserSub(
  email: string,
  attributes: Record<string, string[]> = {},
  name?: { firstName?: string; lastName?: string }
): Promise<{ sub: string; created: boolean }> {
  const existing = await findUserIdByEmail(email);
  if (existing) {
    // If user exists but is missing a name, patch it. Non-fatal: a transient
    // Keycloak error on the name update must not suppress the known sub or
    // prevent RBAC assignments from being applied this sync run.
    if (name?.firstName || name?.lastName) {
      try {
        await maybeUpdateUserName(existing, name);
      } catch (err) {
        console.warn(
          `[KeycloakAdmin] maybeUpdateUserName(${existing}) failed (non-fatal):`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return { sub: existing, created: false };
  }
  const sub = await createFederatedShellUser(email, attributes, name);
  return { sub, created: true };
}

export interface ProvisionShellUserInput {
  /** Email to resolve / provision. Lowercased before any Keycloak call. */
  email: string;
  /**
   * Who is asking. Recorded verbatim as the `created_by` user attribute on a
   * freshly-provisioned shell user so the origin of a JIT account is auditable
   * (e.g. `slack-bot:jit`, `idp-sync:okta`). Ignored when the user already
   * exists. Required so every provisioning surface is attributable.
   */
  source: string;
  /**
   * Extra user attributes to stamp on a newly-created shell user (e.g.
   * `{ slack_user_id: ["U123"] }`). Merged with the canonical `created_by` /
   * `created_at` attributes. Ignored when the user already exists.
   */
  attributes?: Record<string, string[]>;
  /** Display name from the IdP, split into firstName/lastName for Keycloak. */
  firstName?: string;
  lastName?: string;
}

export interface ProvisionShellUserResult {
  sub: string;
  created: boolean;
}

/**
 * Canonical JIT "create-or-resolve a federated shell user" entry point
 * (issue #1781). This is the single implementation every provisioning
 * surface converges on:
 *
 * * the BFF endpoint `POST /api/admin/users/provision-shell` (called by the
 *   Slack bot, and any future bot) is a thin wrapper over this function;
 * * the in-process Okta / IdP directory sync calls it directly.
 *
 * It owns the spec-103 attribute contract: a newly-provisioned user is
 * stamped with `created_by: [source]` and an RFC3339 `created_at`, plus any
 * caller-supplied `attributes`. Resolution of an existing user never mutates
 * attributes (idempotent). The federated-shell shape (no password, no required
 * actions, `emailVerified: true`, 409 → re-query) is inherited from
 * {@link createFederatedShellUser} via {@link resolveOrProvisionUserSub}.
 */
export async function provisionShellUser(
  input: ProvisionShellUserInput
): Promise<ProvisionShellUserResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new Error("provisionShellUser: email is required");
  }
  const source = input.source.trim();
  if (!source) {
    throw new Error("provisionShellUser: source is required");
  }
  const attributes: Record<string, string[]> = {
    ...(input.attributes ?? {}),
    created_by: [source],
    created_at: [new Date().toISOString().replace(/\.\d{3}Z$/, "Z")],
  };
  const name =
    input.firstName || input.lastName
      ? { firstName: input.firstName, lastName: input.lastName }
      : undefined;
  return resolveOrProvisionUserSub(email, attributes, name);
}

function exactEmailUserId(email: string, users: Array<Record<string, unknown>>): string | null {
  const matches = users.filter((u) => {
    const userEmail = typeof u.email === "string" ? u.email.toLowerCase() : "";
    const userName = typeof u.username === "string" ? u.username.toLowerCase() : "";
    return userEmail === email || userName === email;
  });
  if (matches.length > 1) {
    throw new Error(`Keycloak returned multiple users for bootstrap email ${email}`);
  }
  const id = matches[0]?.id;
  return typeof id === "string" && id ? id : null;
}

export async function ensureUserByEmail(email: string): Promise<KeycloakUserEnsureResult> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Bootstrap admin email is empty");
  }

  const existingId = exactEmailUserId(trimmed, await findRealmUsersByExactEmail(trimmed));
  if (existingId) {
    return { id: existingId, email: trimmed, created: false };
  }

  const response = await adminFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      username: trimmed,
      email: trimmed,
      enabled: true,
      emailVerified: true,
      requiredActions: [],
    }),
  });
  if (!response.ok && response.status !== 409) {
    await assertOk(response, `ensureUserByEmail(${trimmed})`);
  }

  const createdId = exactEmailUserId(trimmed, await findRealmUsersByExactEmail(trimmed));
  if (!createdId) {
    throw new Error(`Keycloak user for bootstrap email ${trimmed} was not found after create`);
  }
  return { id: createdId, email: trimmed, created: response.status !== 409 };
}

const SLACK_BOT_CLIENT_ID =
  process.env.KEYCLOAK_BOT_CLIENT_ID?.trim() || "caipe-slack-bot";

const WEBEX_BOT_CLIENT_ID =
  process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID?.trim() || "caipe-webex-bot";

export const BOT_OBO_AUDIENCE_CLIENT_ID =
  process.env.CAIPE_PLATFORM_AUDIENCE?.trim() || "caipe-platform";

function canonicalBotPolicyName(policyName: string): string {
  if (policyName === "caipe-webex-bot-token-exchange-policy") {
    return "caipe-webex-bot-token-exchange";
  }
  return policyName;
}

interface KeycloakClient {
  id: string;
  clientId: string;
}

interface KeycloakManagementPermissions {
  enabled?: boolean;
  scopePermissions?: Record<string, string | undefined>;
}

interface KeycloakAuthzPolicy {
  id: string;
  name: string;
}

interface KeycloakScopePermission {
  id?: string;
  name?: string;
  policies?: string[];
  [key: string]: unknown;
}

interface KeycloakScopePermissionDetails {
  id?: string;
  name?: string;
  decisionStrategy?: string;
  policies: Array<KeycloakAttachedPolicy>;
}

// We enrich the attached-policy view with `type` and the resolved
// `client_ids` (NOT raw UUIDs) so the invariant evaluator can verify
// that every policy is a strict client allow-list (type === "client" +
// non-empty client_ids naming known bot clients) rather than a
// permissive js/role/regex policy. Required for the AFFIRMATIVE
// decision-strategy threat model: under AFFIRMATIVE a single permissive
// policy is sufficient to grant access, so we audit shape, not just
// presence.
//
// IMPORTANT — why `client_ids`, not `clients`:
//
// Keycloak's `/permission/scope/<id>/associatedPolicies` endpoint
// returns policies with `config: {}` — the allow-list is NOT included
// on that path. To get it, we have to call the type-specific endpoint
// `/policy/client/<id>` which returns `clients: ["<uuid>", ...]`.
// We then resolve each UUID to its `clientId` string via the live
// `/clients` registry so the audit shows operator-meaningful names
// (`caipe-slack-bot`) rather than UUIDs the human cannot recognise.
// The previous version of this type stored UUIDs in `clients[]` and
// the evaluator was unable to detect policy attachment because the
// associatedPolicies path returned an empty config — see the
// regression test for the exact ground-truth payloads.
export interface KeycloakAttachedPolicy {
  id: string;
  name: string;
  type?: string;
  /**
   * Resolved client IDs the policy authorises (e.g. `["caipe-slack-bot"]`).
   * Empty array means the policy is `type=client` but Keycloak returned
   * no allow-list (genuinely permissive). `undefined` means we either
   * didn't try to hydrate (non-client policy type) or the hydration call
   * failed; treat undefined as "unknown", not "empty".
   */
  client_ids?: string[];
}

export interface KeycloakRbacDiagnosticValues {
  obo_permissions: Array<{
    bot_client_id: string;
    policy_name: string;
    policy_id: string;
    token_exchange_permission_id: string;
    token_exchange_policy_attached: boolean;
    users_impersonate_permission_id: string;
    users_impersonate_policy_attached: boolean;
  }>;
  bot_service_accounts: Array<{
    client_id: string;
    service_account_id: string;
    realm_management_roles: string[];
    impersonation_role_assigned: boolean;
  }>;
  token_exchange_permissions: Array<{
    client_id: string;
    token_exchange_permission_id: string;
    decision_strategy: string;
    policy_names: string[];
    /**
     * Full attached-policy view used by the invariant evaluator. Each
     * entry should be `type=client` with a non-empty `clients`
     * allow-list naming a known bot client. Anything else is a sign
     * that someone added a permissive policy via the Keycloak admin
     * console; under AFFIRMATIVE strategy that grants access without
     * the other policies needing to agree.
     */
    attached_policies: KeycloakAttachedPolicy[];
  }>;
  /**
   * Realm-level `users.impersonate` scope-permission. This is the
   * single permission that gates *all* OBO (token-exchange with
   * requested_subject) flows in this realm — every bot client must
   * have its allow-list policy attached here, and the strategy must
   * be AFFIRMATIVE so any one bot policy can vote PERMIT. Under the
   * default UNANIMOUS strategy, the second bot's per-client policy
   * starts voting DENY for the first bot and OBO fails with
   * `client not allowed to impersonate`.
   */
  users_impersonate_permission?: {
    permission_id: string;
    decision_strategy: string;
    attached_policies: KeycloakAttachedPolicy[];
  };
}

async function getClientByClientId(clientId: string): Promise<KeycloakClient | null> {
  const enc = encodeURIComponent(clientId);
  const response = await adminFetch(`/clients?clientId=${enc}`, { method: "GET" });
  await assertOk(response, `getClientByClientId(${clientId})`);
  const arr = await parseJsonArray<Record<string, unknown>>(response);
  if (arr.length === 0) return null;
  const c = arr[0]!;
  const id = typeof c.id === "string" ? c.id : "";
  const cid = typeof c.clientId === "string" ? c.clientId : "";
  if (!id || !cid) return null;
  return { id, clientId: cid };
}

async function enableClientManagementPermissions(
  clientUuid: string,
  clientId: string
): Promise<KeycloakManagementPermissions> {
  const enc = encodeURIComponent(clientUuid);
  const response = await adminFetch(`/clients/${enc}/management/permissions`, {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  await assertOk(response, `enableClientManagementPermissions(${clientId})`);
  return readClientManagementPermissions(clientUuid, clientId);
}

async function readClientManagementPermissions(
  clientUuid: string,
  clientId: string
): Promise<KeycloakManagementPermissions> {
  const enc = encodeURIComponent(clientUuid);
  const response = await adminFetch(`/clients/${enc}/management/permissions`, {
    method: "GET",
  });
  await assertOk(response, `readClientManagementPermissions(${clientId})`);
  return (await response.json()) as KeycloakManagementPermissions;
}

async function getUsersImpersonatePermissionId(): Promise<string | null> {
  const response = await adminFetch("/users-management-permissions", { method: "GET" });
  await assertOk(response, "getUsersImpersonatePermissionId");
  const payload = (await response.json()) as KeycloakManagementPermissions;
  return payload.scopePermissions?.impersonate ?? null;
}

async function enableUsersManagementPermissions(): Promise<KeycloakManagementPermissions> {
  const response = await adminFetch("/users-management-permissions", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  if (response.status === 403) {
    // Production BFF tokens intentionally do not need broad realm-admin
    // privilege when the Helm init hooks have already enabled this realm-level
    // feature. If the privileged PUT is forbidden, fall back to a read-only
    // check and continue only when the impersonate permission is present.
    const readOnlyResponse = await adminFetch("/users-management-permissions", { method: "GET" });
    await assertOk(readOnlyResponse, "readUsersManagementPermissionsAfterForbiddenEnable");
    const existing = (await readOnlyResponse.json()) as KeycloakManagementPermissions;
    if (existing.enabled && existing.scopePermissions?.impersonate) {
      return existing;
    }
  }
  await assertOk(response, "enableUsersManagementPermissions");
  const readResponse = await adminFetch("/users-management-permissions", { method: "GET" });
  await assertOk(readResponse, "readUsersManagementPermissions");
  return (await readResponse.json()) as KeycloakManagementPermissions;
}

async function getClientPolicyByName(
  realmManagementUuid: string,
  policyName: string
): Promise<KeycloakAuthzPolicy | null> {
  const response = await adminFetch(
    `/clients/${encodeURIComponent(realmManagementUuid)}/authz/resource-server/policy?name=${encodeURIComponent(policyName)}`,
    { method: "GET" }
  );
  await assertOk(response, `getClientPolicyByName(${policyName})`);
  const policies = await parseJsonArray<Record<string, unknown>>(response);
  const match = policies[0];
  if (!match) return null;
  const id = typeof match.id === "string" ? match.id : "";
  const name = typeof match.name === "string" ? match.name : policyName;
  return id ? { id, name } : null;
}

async function createClientPolicy(
  realmManagementUuid: string,
  policyName: string,
  description: string,
  clientUuid: string
): Promise<KeycloakAuthzPolicy> {
  const response = await adminFetch(
    `/clients/${encodeURIComponent(realmManagementUuid)}/authz/resource-server/policy/client`,
    {
      method: "POST",
      body: JSON.stringify({
        name: policyName,
        description,
        clients: [clientUuid],
      }),
    }
  );
  await assertOk(response, `createClientPolicy(${policyName})`);
  const payload = (await response.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) {
    throw new Error(`Keycloak client policy "${policyName}" was created without an id`);
  }
  return { id, name: policyName };
}

async function ensureClientPolicy(
  realmManagementUuid: string,
  policyName: string,
  description: string,
  clientUuid: string
): Promise<KeycloakAuthzPolicy> {
  const existing = await getClientPolicyByName(realmManagementUuid, policyName);
  if (existing) return existing;
  return createClientPolicy(realmManagementUuid, policyName, description, clientUuid);
}

async function attachPolicyToScopePermission(
  realmManagementUuid: string,
  permissionId: string,
  policyId: string
): Promise<void> {
  const encRealmManagement = encodeURIComponent(realmManagementUuid);
  const encPermission = encodeURIComponent(permissionId);
  const permissionPath = `/clients/${encRealmManagement}/authz/resource-server/permission/scope/${encPermission}`;
  const [response, associatedResponse] = await Promise.all([
    adminFetch(permissionPath, { method: "GET" }),
    adminFetch(`${permissionPath}/associatedPolicies`, { method: "GET" }),
  ]);
  await assertOk(response, `readScopePermission(${permissionId})`);
  await assertOk(associatedResponse, `readScopePermissionPolicies(${permissionId})`);
  const permission = (await response.json()) as KeycloakScopePermission;
  const associatedPolicies = await parseJsonArray<Record<string, unknown>>(associatedResponse);
  const policies = new Set(Array.isArray(permission.policies) ? permission.policies : []);
  for (const policy of associatedPolicies) {
    if (typeof policy.id === "string") {
      policies.add(policy.id);
    }
  }
  if (policies.has(policyId)) return;
  policies.add(policyId);

  const updateResponse = await adminFetch(permissionPath, {
    method: "PUT",
    body: JSON.stringify({ ...permission, policies: [...policies] }),
  });
  await assertOk(updateResponse, `attachPolicyToScopePermission(${permissionId})`);
}

async function setScopePermissionDecisionStrategy(
  realmManagementUuid: string,
  permissionId: string,
  decisionStrategy: "AFFIRMATIVE" | "UNANIMOUS"
): Promise<void> {
  const permissionPath = `/clients/${encodeURIComponent(realmManagementUuid)}/authz/resource-server/permission/scope/${encodeURIComponent(permissionId)}`;
  const response = await adminFetch(permissionPath, { method: "GET" });
  await assertOk(response, `readScopePermission(${permissionId})`);
  const permission = (await response.json()) as KeycloakScopePermission & { decisionStrategy?: string };
  if (permission.decisionStrategy === decisionStrategy) return;
  const updateResponse = await adminFetch(permissionPath, {
    method: "PUT",
    body: JSON.stringify({ ...permission, decisionStrategy }),
  });
  await assertOk(updateResponse, `setScopePermissionDecisionStrategy(${permissionId})`);
}

/**
 * Resolver from Keycloak client UUID → clientId string.
 *
 * We hand a single resolver instance down through one batched
 * `getKeycloakRbacDiagnosticValues` inspection so every per-policy
 * hydration shares the same UUID→clientId map (one `/clients` call
 * instead of N).
 */
type ClientUuidResolver = (uuid: string) => Promise<string | null>;

function createClientUuidResolver(): ClientUuidResolver {
  const cache = new Map<string, string | null>();
  let registryPromise: Promise<void> | null = null;
  // Lazy: only fetch the full client registry the first time we're
  // asked to resolve a UUID. If you only ever call this with UUIDs we
  // already know about (e.g. from a small fixture), we skip the call
  // entirely.
  const loadRegistry = async () => {
    if (registryPromise) return registryPromise;
    registryPromise = (async () => {
      // The default `max` on /clients is 100 in modern Keycloak; bump
      // it to 500 so a realm with many service-account clients still
      // returns the whole set in one go. (Pagination is a future
      // concern; we'd switch to a chunked iterator if a realm exceeds
      // 500 clients.)
      const response = await adminFetch(`/clients?max=500`, { method: "GET" });
      await assertOk(response, "listClientsForUuidResolver");
      const raw = await parseJsonArray<Record<string, unknown>>(response);
      for (const c of raw) {
        const id = typeof c.id === "string" ? c.id : "";
        const cid = typeof c.clientId === "string" ? c.clientId : "";
        if (id) cache.set(id, cid || null);
      }
    })();
    return registryPromise;
  };
  return async (uuid: string): Promise<string | null> => {
    if (cache.has(uuid)) return cache.get(uuid) ?? null;
    await loadRegistry();
    return cache.get(uuid) ?? null;
  };
}

/**
 * Hydrate a `type=client` Keycloak policy's allow-list by calling the
 * type-specific `/policy/client/<id>` endpoint. The `associatedPolicies`
 * endpoint that drives `readScopePermissionDetails` returns `config: {}`
 * on these policies, so we must round-trip per policy to get the real
 * `clients[]`. The trade-off is N extra HTTP calls per inspection where
 * N is the number of `type=client` policies attached across all probed
 * perms — in practice ≤6 across a healthy realm.
 *
 * Returns `null` if the policy is not `type=client` or if Keycloak
 * returns a 404 (e.g. orphaned policy). Returns `[]` when Keycloak
 * confirms the policy exists but has no clients in its allow-list —
 * that's a real "permissive policy" finding the invariant evaluator
 * surfaces.
 */
async function readClientPolicyClients(
  realmManagementUuid: string,
  policyId: string,
  resolveClientId: ClientUuidResolver
): Promise<string[] | null> {
  const path =
    `/clients/${encodeURIComponent(realmManagementUuid)}/authz/resource-server/policy/client/` +
    encodeURIComponent(policyId);
  const response = await adminFetch(path, { method: "GET" });
  if (response.status === 404) return null;
  await assertOk(response, `readClientPolicyClients(${policyId})`);
  const payload = (await response.json()) as Record<string, unknown>;
  // Keycloak returns `clients` either as a real array on /policy/client/<id>
  // or as a stringified array under `config.clients` on /policy/<id>;
  // we handle both shapes so the helper is robust if Keycloak versions
  // diverge on this endpoint.
  let uuids: string[] = [];
  if (Array.isArray(payload.clients)) {
    uuids = payload.clients.filter((v): v is string => typeof v === "string");
  } else if (payload.config && typeof payload.config === "object") {
    const raw = (payload.config as Record<string, unknown>).clients;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          uuids = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        uuids = [];
      }
    } else if (Array.isArray(raw)) {
      uuids = raw.filter((v): v is string => typeof v === "string");
    }
  }
  const resolved: string[] = [];
  for (const uuid of uuids) {
    const cid = await resolveClientId(uuid);
    // If we couldn't resolve a UUID (e.g. the client was deleted but
    // the policy still references it) we still want to surface
    // *something* in the audit — render the literal UUID so an admin
    // can find it in the Keycloak Admin Console. The invariant
    // evaluator treats unresolved UUIDs as not matching any known bot
    // (so they cannot satisfy "<bot> policy attached" checks).
    resolved.push(cid || uuid);
  }
  return resolved;
}

async function readScopePermissionDetails(
  realmManagementUuid: string,
  permissionId: string,
  resolveClientId?: ClientUuidResolver
): Promise<KeycloakScopePermissionDetails> {
  const permissionPath = `/clients/${encodeURIComponent(realmManagementUuid)}/authz/resource-server/permission/scope/${encodeURIComponent(permissionId)}`;
  const [response, associatedResponse] = await Promise.all([
    adminFetch(permissionPath, { method: "GET" }),
    adminFetch(`${permissionPath}/associatedPolicies`, { method: "GET" }),
  ]);
  await assertOk(response, `readScopePermissionDetails(${permissionId})`);
  await assertOk(associatedResponse, `readScopePermissionDetailsPolicies(${permissionId})`);
  const permission = (await response.json()) as KeycloakScopePermission & {
    decisionStrategy?: string;
  };
  const associatedPolicies = await parseJsonArray<Record<string, unknown>>(associatedResponse);

  // Project the associated-policy summary first. Then, in a second
  // pass, hydrate any `type=client` policies' `client_ids` via the
  // type-specific endpoint. Order is intentional so that the cheap
  // projection still works in tests / fixtures that mock only the
  // associated-policies call.
  const policies: KeycloakAttachedPolicy[] = associatedPolicies
    .map((policy): KeycloakAttachedPolicy | null => {
      const id = typeof policy.id === "string" ? policy.id : "";
      const name = typeof policy.name === "string" ? policy.name : id;
      if (!id) return null;
      const type = typeof policy.type === "string" ? policy.type : undefined;
      return { id, name, type };
    })
    .filter((policy): policy is KeycloakAttachedPolicy => policy !== null);

  if (resolveClientId) {
    await Promise.all(
      policies.map(async (policy) => {
        if (policy.type !== "client") return;
        const clientIds = await readClientPolicyClients(
          realmManagementUuid,
          policy.id,
          resolveClientId
        ).catch(() => null);
        if (clientIds !== null) policy.client_ids = clientIds;
      })
    );
  }

  return {
    id: typeof permission.id === "string" ? permission.id : permissionId,
    name: typeof permission.name === "string" ? permission.name : undefined,
    decisionStrategy:
      typeof permission.decisionStrategy === "string" ? permission.decisionStrategy : undefined,
    policies,
  };
}

/**
 * Validate a team slug. We keep the regex strict (lowercase alphanumerics
 * + hyphen) so the slug renders cleanly in OpenFGA object IDs
 * (`team:<slug>`), MongoDB foreign keys in `channel_team_mappings` /
 * `webex_space_team_mappings`, and admin URLs. Callers should reject
 * invalid slugs before persisting a team; this function is the canonical
 * regex.
 */
export function isValidTeamSlug(slug: string): boolean {
  if (!slug || slug.length > 63) return false;
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

async function ensureBotOboPermissions(botClientId: string, policyName: string): Promise<void> {
  const [botClient, oboAudienceClient, realmManagementClient] = await Promise.all([
    getClientByClientId(botClientId),
    getClientByClientId(BOT_OBO_AUDIENCE_CLIENT_ID),
    getClientByClientId("realm-management"),
  ]);

  if (!botClient) {
    throw new Error(`Keycloak bot client "${botClientId}" not found`);
  }
  if (!oboAudienceClient) {
    throw new Error(`Keycloak audience client "${BOT_OBO_AUDIENCE_CLIENT_ID}" not found`);
  }
  if (!realmManagementClient) {
    throw new Error('Keycloak client "realm-management" not found');
  }

  const [botPerms, oboAudiencePerms, usersPerms] = await Promise.all([
    enableClientManagementPermissions(botClient.id, botClient.clientId),
    enableClientManagementPermissions(oboAudienceClient.id, oboAudienceClient.clientId).catch(() =>
      readClientManagementPermissions(oboAudienceClient.id, oboAudienceClient.clientId)
    ),
    enableUsersManagementPermissions(),
  ]);

  const botTokenExchangePermissionId = botPerms.scopePermissions?.["token-exchange"];
  const oboAudienceTokenExchangePermissionId =
    oboAudiencePerms.scopePermissions?.["token-exchange"];
  const usersImpersonatePermissionId = usersPerms.scopePermissions?.impersonate;
  if (!botTokenExchangePermissionId) {
    throw new Error(`Keycloak client "${botClientId}" has no token-exchange permission`);
  }
  if (!oboAudienceTokenExchangePermissionId) {
    throw new Error(
      `Keycloak client "${BOT_OBO_AUDIENCE_CLIENT_ID}" has no token-exchange permission`
    );
  }
  if (!usersImpersonatePermissionId) {
    throw new Error("Keycloak users impersonate permission is not enabled");
  }

  const policy = await ensureClientPolicy(
    realmManagementClient.id,
    policyName,
    `Allows ${botClientId} to perform token exchange / OBO impersonation.`,
    botClient.id
  );

  await Promise.all([
    attachPolicyToScopePermission(
      realmManagementClient.id,
      botTokenExchangePermissionId,
      policy.id
    ),
    attachPolicyToScopePermission(
      realmManagementClient.id,
      usersImpersonatePermissionId,
      policy.id
    ),
    attachPolicyToScopePermission(
      realmManagementClient.id,
      oboAudienceTokenExchangePermissionId,
      policy.id
    ),
    // Keycloak creates scope-permissions with UNANIMOUS by default. A single
    // per-client policy under UNANIMOUS is functionally equivalent to
    // AFFIRMATIVE, but the invariant checker flags UNANIMOUS to prevent a
    // second policy being added later (e.g. during a future bot) from silently
    // breaking OBO via cross-DENY. Set it here so it is never left as UNANIMOUS.
    setScopePermissionDecisionStrategy(
      realmManagementClient.id,
      botTokenExchangePermissionId,
      "AFFIRMATIVE"
    ),
  ]);
}

export async function ensureSlackBotOboPermissions(): Promise<void> {
  return ensureBotOboPermissions(SLACK_BOT_CLIENT_ID, "caipe-slack-bot-token-exchange");
}

/**
 * Idempotently repairs the Keycloak token-exchange permissions required for
 * the Webex bot to mint user-scoped tokens whose target audience is the
 * CAIPE UI BFF resource server (`caipe-platform` by default).
 *
 * Keycloak authorizes token exchange on the target audience client. Enabling
 * management permissions on `caipe-webex-bot` is not enough; the Webex bot's
 * client policy must also be attached to the target audience client's
 * token-exchange scope permission.
 */
export async function ensureWebexBotOboPermissions(): Promise<void> {
  return ensureBotOboPermissions(WEBEX_BOT_CLIENT_ID, "caipe-webex-bot-token-exchange");
}

export async function ensureCaipePlatformTokenExchangeDecisionStrategy(
  decisionStrategy: "AFFIRMATIVE" | "UNANIMOUS" = "AFFIRMATIVE"
): Promise<void> {
  const [oboAudienceClient, realmManagementClient] = await Promise.all([
    getClientByClientId(BOT_OBO_AUDIENCE_CLIENT_ID),
    getClientByClientId("realm-management"),
  ]);
  if (!oboAudienceClient) {
    throw new Error(`Keycloak audience client "${BOT_OBO_AUDIENCE_CLIENT_ID}" not found`);
  }
  if (!realmManagementClient) {
    throw new Error('Keycloak client "realm-management" not found');
  }
  const perms = await enableClientManagementPermissions(
    oboAudienceClient.id,
    oboAudienceClient.clientId
  ).catch(() => readClientManagementPermissions(oboAudienceClient.id, oboAudienceClient.clientId));
  const tokenExchangePermissionId = perms.scopePermissions?.["token-exchange"];
  if (!tokenExchangePermissionId) {
    throw new Error(
      `Keycloak client "${BOT_OBO_AUDIENCE_CLIENT_ID}" has no token-exchange permission`
    );
  }
  await setScopePermissionDecisionStrategy(
    realmManagementClient.id,
    tokenExchangePermissionId,
    decisionStrategy
  );
}

export async function ensureBotServiceAccountImpersonationRoles(
  botClientIds: string[] = [SLACK_BOT_CLIENT_ID, WEBEX_BOT_CLIENT_ID]
): Promise<void> {
  const realmManagementClient = await getClientByClientId("realm-management");
  if (!realmManagementClient) {
    throw new Error('Keycloak client "realm-management" not found');
  }
  const roleResponse = await adminFetch(
    `/clients/${encodeURIComponent(realmManagementClient.id)}/roles/impersonation`,
    { method: "GET" }
  );
  await assertOk(roleResponse, "getRealmManagementImpersonationRole");
  const impersonationRole = (await roleResponse.json()) as KeycloakRole;

  for (const botClientId of botClientIds) {
    const botClient = await getClientByClientId(botClientId);
    if (!botClient) {
      throw new Error(`Keycloak bot client "${botClientId}" not found`);
    }
    const serviceAccountResponse = await adminFetch(
      `/clients/${encodeURIComponent(botClient.id)}/service-account-user`,
      { method: "GET" }
    );
    await assertOk(serviceAccountResponse, `getServiceAccountUser(${botClientId})`);
    const serviceAccount = (await serviceAccountResponse.json()) as { id?: string };
    if (!serviceAccount.id) {
      throw new Error(`Keycloak bot client "${botClientId}" service account has no id`);
    }
    const mappingsPath = `/users/${encodeURIComponent(serviceAccount.id)}/role-mappings/clients/${encodeURIComponent(realmManagementClient.id)}`;
    const currentResponse = await adminFetch(mappingsPath, { method: "GET" });
    await assertOk(currentResponse, `listServiceAccountRoleMappings(${botClientId})`);
    const current = await parseJsonArray<KeycloakRole>(currentResponse);
    if (current.some((role) => role.name === "impersonation")) continue;
    const assignResponse = await adminFetch(mappingsPath, {
      method: "POST",
      body: JSON.stringify([{ id: impersonationRole.id, name: impersonationRole.name }]),
    });
    await assertOk(assignResponse, `assignServiceAccountImpersonation(${botClientId})`);
  }
}

async function serviceAccountRoleValues(
  botClientId: string,
  realmManagementClient: KeycloakClient
): Promise<KeycloakRbacDiagnosticValues["bot_service_accounts"][number]> {
  const botClient = await getClientByClientId(botClientId);
  if (!botClient) {
    return {
      client_id: botClientId,
      service_account_id: "missing client",
      realm_management_roles: [],
      impersonation_role_assigned: false,
    };
  }
  const serviceAccountResponse = await adminFetch(
    `/clients/${encodeURIComponent(botClient.id)}/service-account-user`,
    { method: "GET" }
  );
  await assertOk(serviceAccountResponse, `inspectServiceAccountUser(${botClientId})`);
  const serviceAccount = (await serviceAccountResponse.json()) as { id?: string };
  if (!serviceAccount.id) {
    return {
      client_id: botClientId,
      service_account_id: "missing service account id",
      realm_management_roles: [],
      impersonation_role_assigned: false,
    };
  }
  const mappingsPath = `/users/${encodeURIComponent(serviceAccount.id)}/role-mappings/clients/${encodeURIComponent(realmManagementClient.id)}`;
  const currentResponse = await adminFetch(mappingsPath, { method: "GET" });
  await assertOk(currentResponse, `inspectServiceAccountRoleMappings(${botClientId})`);
  const current = await parseJsonArray<KeycloakRole>(currentResponse);
  const roles = current.map((role) => role.name).filter(Boolean).sort();
  return {
    client_id: botClientId,
    service_account_id: serviceAccount.id,
    realm_management_roles: roles,
    impersonation_role_assigned: roles.includes("impersonation"),
  };
}

/**
 * Read the Keycloak-side values managed by the RBAC reconciler. This is used
 * by the admin diagnostics UI and intentionally avoids mutating Keycloak.
 */
export async function getKeycloakRbacDiagnosticValues(): Promise<KeycloakRbacDiagnosticValues> {
  const [slackBotClient, webexBotClient, oboAudienceClient, realmManagementClient] =
    await Promise.all([
      getClientByClientId(SLACK_BOT_CLIENT_ID),
      getClientByClientId(WEBEX_BOT_CLIENT_ID),
      getClientByClientId(BOT_OBO_AUDIENCE_CLIENT_ID),
      getClientByClientId("realm-management"),
    ]);
  // One resolver instance per inspection — every `readScopePermissionDetails`
  // call below shares the same UUID→clientId map, so we only touch the
  // /clients registry once per probe even when N policies need hydrating.
  const resolveClientId = createClientUuidResolver();
  // Per-bot client `token-exchange` scope-permissions live on each
  // bot's *own* client (not on the audience). We inspect both so the
  // invariant evaluator can flag UNANIMOUS-with-multiple-policies on
  // either one — that's the exact failure mode that caused the
  // "client not allowed to exchange" outage we surfaced via this UI.
  const slackBotTokenExchangePerm =
    slackBotClient
      ? (await readClientManagementPermissions(slackBotClient.id, slackBotClient.clientId).catch(
          () => null
        ))?.scopePermissions?.["token-exchange"]
      : undefined;
  const webexBotTokenExchangePerm =
    webexBotClient
      ? (await readClientManagementPermissions(webexBotClient.id, webexBotClient.clientId).catch(
          () => null
        ))?.scopePermissions?.["token-exchange"]
      : undefined;
  const slackBotTokenExchangeDetails =
    realmManagementClient && slackBotTokenExchangePerm
      ? await readScopePermissionDetails(
          realmManagementClient.id,
          slackBotTokenExchangePerm,
          resolveClientId
        ).catch(() => null)
      : null;
  const webexBotTokenExchangeDetails =
    realmManagementClient && webexBotTokenExchangePerm
      ? await readScopePermissionDetails(
          realmManagementClient.id,
          webexBotTokenExchangePerm,
          resolveClientId
        ).catch(() => null)
      : null;
  const tokenExchangePermissionId =
    oboAudienceClient
      ? (await readClientManagementPermissions(
          oboAudienceClient.id,
          oboAudienceClient.clientId
        ).catch(() => null))?.scopePermissions?.["token-exchange"]
      : undefined;
  const usersImpersonatePermissionId = await getUsersImpersonatePermissionId().catch(() => null);
  const tokenExchangeDetails =
    realmManagementClient && tokenExchangePermissionId
      ? await readScopePermissionDetails(
          realmManagementClient.id,
          tokenExchangePermissionId,
          resolveClientId
        )
      : null;
  const usersImpersonateDetails =
    realmManagementClient && usersImpersonatePermissionId
      ? await readScopePermissionDetails(
          realmManagementClient.id,
          usersImpersonatePermissionId,
          resolveClientId
        )
      : null;

  const oboPermissionRows = await Promise.all(
    [
      { clientId: SLACK_BOT_CLIENT_ID, policyName: "caipe-slack-bot-token-exchange" },
      { clientId: WEBEX_BOT_CLIENT_ID, policyName: "caipe-webex-bot-token-exchange" },
    ].map(async ({ clientId, policyName }) => {
      const policy = realmManagementClient
        ? await getClientPolicyByName(realmManagementClient.id, policyName)
        : null;
      return {
        bot_client_id: clientId,
        policy_name: policyName,
        policy_id: policy?.id ?? "missing",
        token_exchange_permission_id: tokenExchangePermissionId ?? "missing",
        token_exchange_policy_attached: Boolean(
          policy?.id && tokenExchangeDetails?.policies.some((item) => item.id === policy.id)
        ),
        users_impersonate_permission_id: usersImpersonatePermissionId ?? "missing",
        users_impersonate_policy_attached: Boolean(
          policy?.id && usersImpersonateDetails?.policies.some((item) => item.id === policy.id)
        ),
      };
    })
  );

  const serviceAccountRows = realmManagementClient
    ? await Promise.all(
        [SLACK_BOT_CLIENT_ID, WEBEX_BOT_CLIENT_ID].map((clientId) =>
          serviceAccountRoleValues(clientId, realmManagementClient)
        )
      )
    : [];

  const tokenExchangePermissionRows: KeycloakRbacDiagnosticValues["token_exchange_permissions"] = [];
  if (oboAudienceClient) {
    tokenExchangePermissionRows.push({
      client_id: oboAudienceClient.clientId,
      token_exchange_permission_id: tokenExchangePermissionId ?? "missing",
      decision_strategy: tokenExchangeDetails?.decisionStrategy ?? "missing",
      policy_names:
        tokenExchangeDetails?.policies.map((policy) => canonicalBotPolicyName(policy.name)) ?? [],
      attached_policies: tokenExchangeDetails?.policies ?? [],
    });
  }
  if (slackBotClient) {
    tokenExchangePermissionRows.push({
      client_id: slackBotClient.clientId,
      token_exchange_permission_id: slackBotTokenExchangePerm ?? "missing",
      decision_strategy: slackBotTokenExchangeDetails?.decisionStrategy ?? "missing",
      policy_names:
        slackBotTokenExchangeDetails?.policies.map((policy) =>
          canonicalBotPolicyName(policy.name)
        ) ?? [],
      attached_policies: slackBotTokenExchangeDetails?.policies ?? [],
    });
  }
  if (webexBotClient) {
    tokenExchangePermissionRows.push({
      client_id: webexBotClient.clientId,
      token_exchange_permission_id: webexBotTokenExchangePerm ?? "missing",
      decision_strategy: webexBotTokenExchangeDetails?.decisionStrategy ?? "missing",
      policy_names:
        webexBotTokenExchangeDetails?.policies.map((policy) =>
          canonicalBotPolicyName(policy.name)
        ) ?? [],
      attached_policies: webexBotTokenExchangeDetails?.policies ?? [],
    });
  }

  return {
    obo_permissions: oboPermissionRows,
    bot_service_accounts: serviceAccountRows,
    token_exchange_permissions: tokenExchangePermissionRows,
    users_impersonate_permission:
      usersImpersonatePermissionId && usersImpersonateDetails
        ? {
            permission_id: usersImpersonatePermissionId,
            decision_strategy: usersImpersonateDetails.decisionStrategy ?? "missing",
            attached_policies: usersImpersonateDetails.policies,
          }
        : usersImpersonatePermissionId
          ? {
              permission_id: usersImpersonatePermissionId,
              decision_strategy: "missing",
              attached_policies: [],
            }
          : undefined,
  };
}

// Phase 3 (spec 2026-05-24-derive-team-from-channel) deleted
// `deleteTeamClientScope(slug)`. Team deletion is now a pure Mongo
// + OpenFGA operation. The team-* Keycloak client scope mechanism
// was never released to any user-facing realm so no operator-side
// cleanup is required.

function readAttributeValue(attrs: unknown, attributeName: string): string | undefined {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return undefined;
  const values = (attrs as Record<string, unknown>)[attributeName];
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const first = values[0];
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}

/**
 * Returns the Keycloak user id that currently owns `attributeValue` for `attributeName`, if any.
 */
export async function findRealmUserIdByAttribute(
  attributeName: string,
  attributeValue: string
): Promise<string | null> {
  const trimmed = attributeValue.trim();
  if (!trimmed) return null;

  const q = `${attributeName}:${trimmed}`;
  const response = await adminFetch(
    `/users?q=${encodeURIComponent(q)}&max=5`,
    { method: "GET" }
  );
  await assertOk(response, `findRealmUserIdByAttribute(${attributeName})`);
  const users = await parseJsonArray<Record<string, unknown>>(response);

  for (const user of users) {
    const value = readAttributeValue(user.attributes, attributeName);
    if (value !== trimmed) continue;
    const id = user.id;
    if (id !== undefined && id !== null) {
      return String(id);
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Service-account clients (spec 2026-06-05-service-accounts, WS-B / T008).
//
// Each service account is a dynamically-created Keycloak confidential client
// with serviceAccountsEnabled — one client = one credential. The client's
// service-account-user `sub` (UUID) becomes the OpenFGA subject id
// (`service_account:<sub>`). These mirror the existing adminFetch/assertOk
// helpers above; they add no new abstraction. assisted-by Claude claude-opus-4-8
// ───────────────────────────────────────────────────────────────────────────

/** The credential + identity read back after creating a service-account client. */
export interface ServiceAccountClient {
  /** Keycloak internal client UUID — used for secret/delete admin calls. */
  clientUuid: string;
  /** Keycloak clientId string, e.g. "caipe-sa-incident-bot-a1b2c3". */
  clientId: string;
  /** The generated client secret. Shown to the operator exactly once. */
  clientSecret: string;
  /** The service-account-user `sub` (UUID) — the OpenFGA subject id. */
  saSub: string;
}

/**
 * Turn a human-friendly name into a clientId-safe slug fragment: lowercase
 * alphanumerics + hyphen, collapsed, trimmed, capped. Empty input (or a name
 * with no usable characters) falls back to "sa" so the clientId is always
 * well-formed.
 */
function slugifyServiceAccountName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "sa";
}

/**
 * Parse the Keycloak client UUID out of the `Location` header returned by a
 * `POST /clients` (201) — e.g. `…/admin/realms/caipe/clients/<uuid>`.
 */
function clientUuidFromLocation(location: string | null): string | null {
  if (!location) return null;
  const trimmed = location.replace(/\/$/, "");
  const uuid = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return uuid || null;
}

/**
 * Create a confidential service-account client and read back its UUID, secret,
 * and service-account-user `sub`.
 *
 * Shape mirrors the static `caipe-slack-bot` client (publicClient:false,
 * serviceAccountsEnabled:true, standardFlowEnabled:false,
 * directAccessGrantsEnabled:false). clientId = `caipe-sa-<slug>-<short-rand>`,
 * where the random suffix guarantees uniqueness even when two teams reuse a
 * display name (FR-002a allows that).
 */
export async function createServiceAccountClient(name: string): Promise<ServiceAccountClient> {
  const slug = slugifyServiceAccountName(name);
  const suffix = randomBytes(3).toString("hex"); // 6 hex chars
  const clientId = `caipe-sa-${slug}-${suffix}`;

  const createResponse = await adminFetch("/clients", {
    method: "POST",
    body: JSON.stringify({
      clientId,
      name,
      enabled: true,
      publicClient: false,
      bearerOnly: false,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      authorizationServicesEnabled: false,
      protocol: "openid-connect",
    }),
  });
  await assertOk(createResponse, `createServiceAccountClient(${clientId})`);

  let clientUuid = clientUuidFromLocation(createResponse.headers.get("Location"));
  if (!clientUuid) {
    const client = await getClientByClientId(clientId);
    if (!client) {
      throw new Error(
        `Keycloak service-account client "${clientId}" was not found after create`,
      );
    }
    clientUuid = client.id;
  }
  const encUuid = encodeURIComponent(clientUuid);

  // Keycloak generates a secret on create; read it back explicitly.
  const secretResponse = await adminFetch(`/clients/${encUuid}/client-secret`, {
    method: "GET",
  });
  await assertOk(secretResponse, `getServiceAccountClientSecret(${clientId})`);
  const secretBody = (await secretResponse.json()) as { value?: string };
  if (!secretBody.value) {
    throw new Error(`Keycloak service-account client "${clientId}" has no secret`);
  }

  const saUserResponse = await adminFetch(`/clients/${encUuid}/service-account-user`, {
    method: "GET",
  });
  await assertOk(saUserResponse, `getServiceAccountUser(${clientId})`);
  const saUser = (await saUserResponse.json()) as { id?: string };
  if (!saUser.id) {
    throw new Error(
      `Keycloak service-account client "${clientId}" service account has no id`,
    );
  }

  return {
    clientUuid,
    clientId,
    clientSecret: secretBody.value,
    saSub: saUser.id,
  };
}

/**
 * Rotate a service account's credential by regenerating its client secret.
 * Returns the new secret (shown once). The old secret stops working
 * immediately (FR-017).
 */
export async function regenerateClientSecret(clientUuid: string): Promise<string> {
  const encUuid = encodeURIComponent(clientUuid);
  const response = await adminFetch(`/clients/${encUuid}/client-secret`, {
    method: "POST",
  });
  await assertOk(response, `regenerateClientSecret(${clientUuid})`);
  const body = (await response.json()) as { value?: string };
  if (!body.value) {
    throw new Error(`Keycloak did not return a new secret for client ${clientUuid}`);
  }
  return body.value;
}

/**
 * Delete a service-account client (revoke). After deletion the credential no
 * longer authenticates (FR-018). A 404 is treated as already-gone (idempotent).
 */
export async function deleteServiceAccountClient(clientUuid: string): Promise<void> {
  const encUuid = encodeURIComponent(clientUuid);
  const response = await adminFetch(`/clients/${encUuid}`, { method: "DELETE" });
  if (response.status === 404) {
    return;
  }
  await assertOk(response, `deleteServiceAccountClient(${clientUuid})`);
}

/**
 * The realm's client-credentials token endpoint — the URL an external service
 * account POSTs to (with its client_id + client_secret) to obtain a JWT. Shown
 * once alongside the credential on create/rotate (FR-005).
 *
 * MUST be HOST/EXTERNALLY reachable (#55). `KEYCLOAK_URL` is the Docker-INTERNAL
 * hostname (e.g. `http://keycloak:7080`) used for server-side admin calls — it
 * does NOT resolve from a user's host shell or an external SA caller, so echoing
 * it here breaks the token-mint step. Instead derive from the browser/external-
 * facing issuer:
 *   - `KEYCLOAK_PUBLIC_URL` (explicit external Keycloak base), else
 *   - `OIDC_ISSUER` (already the browser-facing realm URL, e.g.
 *     `http://localhost:7080/realms/caipe`) → append the token path, else
 *   - fall back to the internal `KEYCLOAK_URL` path (single-URL deployments).
 * This mirrors the internal-vs-browser-facing split auth-config already uses
 * (KEYCLOAK_URL/OIDC_DISCOVERY_URL for server-side vs OIDC_ISSUER for browser).
 */
export function getServiceAccountTokenUrl(): string {
  const realm = getRealm();
  const tokenPath = `/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;

  const publicBase = process.env.KEYCLOAK_PUBLIC_URL?.trim();
  if (publicBase) {
    return `${publicBase.replace(/\/$/, "")}${tokenPath}`;
  }

  const issuer = process.env.OIDC_ISSUER?.trim();
  if (issuer) {
    // OIDC_ISSUER is itself the realm URL (…/realms/<realm>). Preserve ITS realm
    // rather than stripping + re-appending KEYCLOAK_REALM — if the two ever
    // diverged, re-appending getRealm() would point the token URL at the wrong
    // realm (reviewer-a nit). When the issuer already ends in /realms/<realm>,
    // just append the protocol path to it directly; otherwise treat it as a
    // bare base and append the full /realms/<realm> token path.
    const trimmed = issuer.replace(/\/$/, "");
    if (/\/realms\/[^/]+$/.test(trimmed)) {
      return `${trimmed}/protocol/openid-connect/token`;
    }
    return `${trimmed}${tokenPath}`;
  }

  // Single-URL deployments: KEYCLOAK_URL is already host-reachable.
  return getRealmTokenEndpoint();
}

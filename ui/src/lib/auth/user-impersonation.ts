import { decodeJwt } from "jose";

import {
  ensureUiUserImpersonationPermissions,
  getRealmUserByIdOrNull,
  getUserFederatedIdentities,
  listIdpAliases,
} from "@/lib/rbac/keycloak-admin";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const IMPERSONATION_SCOPES = "openid roles groups org email profile";

let permissionBootstrap: Promise<void> | null = null;

export interface ImpersonationTarget {
  sub: string;
  name: string;
  email: string;
  username: string;
}

export interface ImpersonatedUserToken {
  accessToken: string;
  expiresAt: number;
  claims: Record<string, unknown>;
  target: ImpersonationTarget;
}

function keycloakUrl(): string {
  const value = process.env.KEYCLOAK_URL?.trim();
  if (!value) throw new Error("KEYCLOAK_URL is not set");
  return value.replace(/\/$/, "");
}

function realm(): string {
  return process.env.KEYCLOAK_REALM?.trim() || "caipe";
}

function clientId(): string {
  return process.env.KEYCLOAK_ADMIN_CLIENT_ID?.trim() || "caipe-platform";
}

function audience(): string {
  return process.env.CAIPE_PLATFORM_AUDIENCE?.trim() || "caipe-platform";
}

function tokenEndpoint(): string {
  return `${keycloakUrl()}/realms/${encodeURIComponent(realm())}/protocol/openid-connect/token`;
}

function userInfoEndpoint(): string {
  return `${keycloakUrl()}/realms/${encodeURIComponent(realm())}/protocol/openid-connect/userinfo`;
}

function isServiceAccount(user: Record<string, unknown>): boolean {
  const username = String(user.username ?? "").toLowerCase();
  return Boolean(user.serviceAccountClientId) || username.startsWith("service-account-");
}

function targetFromUser(user: Record<string, unknown>): ImpersonationTarget {
  const sub = String(user.id ?? "").trim();
  const email = String(user.email ?? "").trim();
  const username = String(user.username ?? "").trim();
  const name = [user.firstName, user.lastName]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ") || String(user.firstName ?? "").trim() || email || username;

  if (!sub || !email || !username || user.enabled !== true || isServiceAccount(user)) {
    throw new Error("The selected account is not an enabled human user");
  }
  return { sub, name, email, username };
}

function groupsFromUser(user: Record<string, unknown>): unknown {
  const attributes = user.attributes;
  if (!attributes || typeof attributes !== "object") return undefined;
  return (attributes as Record<string, unknown>).idp_groups;
}

async function ensurePermissions(): Promise<void> {
  if (!permissionBootstrap) {
    permissionBootstrap = ensureUiUserImpersonationPermissions().catch((error) => {
      permissionBootstrap = null;
      throw error;
    });
  }
  return permissionBootstrap;
}

/** Mint a real user bearer after validating the target against Keycloak. */
export async function mintImpersonatedUserToken(
  targetSub: string,
): Promise<ImpersonatedUserToken> {
  const clientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error("KEYCLOAK_ADMIN_CLIENT_SECRET is not set");
  }

  const user = await getRealmUserByIdOrNull(targetSub);
  if (!user) throw new Error("The selected user no longer exists");
  const target = targetFromUser(user);
  const [identityProviders, federatedIdentities] = await Promise.all([
    listIdpAliases(),
    getUserFederatedIdentities(target.sub),
  ]);
  if (identityProviders.some((provider) => provider.enabled !== false) && federatedIdentities.length === 0) {
    throw new Error("Only users linked to an identity provider can be impersonated");
  }

  await ensurePermissions();
  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: clientId(),
      client_secret: clientSecret,
      requested_subject: target.sub,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: audience(),
      scope: IMPERSONATION_SCOPES,
    }).toString(),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Keycloak user token exchange failed: ${response.status} ${detail.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new Error("Keycloak user token exchange returned no access_token");
  }
  const accessClaims = decodeJwt(payload.access_token) as Record<string, unknown>;
  if (accessClaims.sub !== target.sub) {
    throw new Error("Keycloak user token exchange returned the wrong subject");
  }

  const userInfoResponse = await fetch(userInfoEndpoint(), {
    headers: { Authorization: `Bearer ${payload.access_token}` },
  });
  if (!userInfoResponse.ok) {
    throw new Error(`Keycloak userinfo lookup failed: ${userInfoResponse.status}`);
  }
  const userInfoClaims = (await userInfoResponse.json()) as Record<string, unknown>;
  if (userInfoClaims.sub !== target.sub) {
    throw new Error("Keycloak userinfo returned the wrong subject");
  }
  const claims = {
    ...accessClaims,
    ...userInfoClaims,
    groups: userInfoClaims.groups ?? groupsFromUser(user),
  };
  const expiresAt = typeof accessClaims.exp === "number"
    ? accessClaims.exp
    : Math.floor(Date.now() / 1000) + (payload.expires_in ?? 300);

  return { accessToken: payload.access_token, expiresAt, claims, target };
}

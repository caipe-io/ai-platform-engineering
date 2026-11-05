import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";

import type { JWTIdentity } from "@/lib/jwt-validation";
import { linkSecondaryOidcIdentity } from "@/lib/auth/secondary-identity-link";

const SECONDARY_OIDC_JWKS_URI = "CAIPE_SECONDARY_OIDC_JWKS_URI";
const SECONDARY_OIDC_ISSUER = "CAIPE_SECONDARY_OIDC_ISSUER";
const SECONDARY_OIDC_AUDIENCES = "CAIPE_SECONDARY_OIDC_AUDIENCES";
const SECONDARY_OIDC_PROVIDER_ID = "CAIPE_SECONDARY_OIDC_PROVIDER_ID";
const SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL =
  "CAIPE_SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL";
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface SecondaryOidcConfig {
  audiences: string[];
  issuer: string;
  jwksUri: string;
  providerId: string;
  requireVerifiedEmail: boolean;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function booleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function getSecondaryOidcConfig(): SecondaryOidcConfig | null {
  const jwksUri = process.env[SECONDARY_OIDC_JWKS_URI]?.trim() || "";
  const issuer = process.env[SECONDARY_OIDC_ISSUER]?.trim() || "";
  const audiences = csv(process.env[SECONDARY_OIDC_AUDIENCES]);
  const providerId = process.env[SECONDARY_OIDC_PROVIDER_ID]?.trim() || "";
  const requireVerifiedEmailValue = process.env[SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL];
  const configured = Boolean(
    jwksUri || issuer || audiences.length || providerId || requireVerifiedEmailValue,
  );

  if (!configured) return null;
  if (!jwksUri || !issuer || audiences.length === 0 || !providerId) {
    throw new Error(
      `${SECONDARY_OIDC_JWKS_URI}, ${SECONDARY_OIDC_ISSUER}, ${SECONDARY_OIDC_AUDIENCES}, and ${SECONDARY_OIDC_PROVIDER_ID} must all be configured`,
    );
  }

  const parsed = new URL(jwksUri);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${SECONDARY_OIDC_JWKS_URI} must use HTTPS`);
  }
  const parsedIssuer = new URL(issuer);
  if (parsedIssuer.protocol !== "https:" || parsedIssuer.username || parsedIssuer.password || parsedIssuer.search || parsedIssuer.hash) {
    throw new Error(`${SECONDARY_OIDC_ISSUER} must use HTTPS`);
  }
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(
      `${SECONDARY_OIDC_PROVIDER_ID} must be a 1-64 character provider identifier`,
    );
  }

  return {
    audiences,
    issuer,
    jwksUri,
    providerId,
    // Keep strict email verification by default. Set this to false only for
    // a provider whose validated email claim is authoritative even when the
    // provider omits or sets email_verified=false for that trusted provider.
    requireVerifiedEmail: booleanEnv(
      SECONDARY_OIDC_REQUIRE_VERIFIED_EMAIL,
      requireVerifiedEmailValue,
      true,
    ),
  };
}

export function isSecondaryOidcConfigured(): boolean {
  return getSecondaryOidcConfig() !== null;
}

function getJWKS(config: SecondaryOidcConfig): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(config.jwksUri);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  jwksCache.set(config.jwksUri, jwks);
  return jwks;
}

function identityFromPayload(payload: JWTPayload): JWTIdentity {
  const email =
    (typeof payload.email === "string" && payload.email) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    (typeof payload.sub === "string" && payload.sub) ||
    "unknown";
  const name =
    (typeof payload.name === "string" && payload.name) ||
    (typeof payload.fullname === "string" && payload.fullname) ||
    email;
  return { email, name, groups: [], sub: typeof payload.sub === "string" ? payload.sub : undefined };
}

/** Validate a secondary OIDC JWT locally against cached remote JWKS keys. */
export async function validateSecondaryOidcJWT(token: string, resource: string): Promise<JWTIdentity> {
  const config = getSecondaryOidcConfig();
  if (!config) {
    throw new Error("CAIPE secondary OIDC JWT validation is not configured");
  }

  const { payload } = await jwtVerify(token, getJWKS(config), {
    issuer: config.issuer,
    audience: resourceAudiences(resource, config.audiences),
    algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "EdDSA"],
    requiredClaims: ["iss", "aud", "exp", "sub"],
  });
  if (typeof payload.iss !== "string" || typeof payload.sub !== "string") {
    throw new Error("The secondary OIDC token must contain issuer and subject claims");
  }
  const identity = identityFromPayload(payload);
  return linkSecondaryOidcIdentity({
    providerId: config.providerId,
    issuer: payload.iss,
    externalSub: payload.sub,
    // Some secondary providers encode the user's email address in
    // the OIDC subject instead of emitting a separate email claim.
    email: identity.email,
    emailVerified:
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : undefined,
    requireVerifiedEmail: config.requireVerifiedEmail,
    identity,
  });
}


/** Every secondary audience must be explicitly bound to the receiving resource. */
function resourceAudiences(resource: string, configured: string[]): string[] {
  const url = new URL(resource);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Secondary auth resources must be HTTPS URLs without credentials, query or fragment");
  }
  const raw = process.env.CAIPE_SECONDARY_AUTH_RESOURCES;
  const bindings: unknown = raw ? JSON.parse(raw) : {};
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error("CAIPE_SECONDARY_AUTH_RESOURCES must be a resource-to-audience JSON object");
  }
  const allowed = Object.hasOwn(bindings, resource)
    ? (bindings as Record<string, unknown>)[resource] : undefined;
  if (!Array.isArray(allowed) || !allowed.length ||
      allowed.some(value => typeof value !== "string" || !configured.includes(value))) {
    throw new Error("Secondary authentication is not allowed for this resource");
  }
  return allowed;
}

export function resetSecondaryOidcJWTCache(): void {
  jwksCache.clear();
}

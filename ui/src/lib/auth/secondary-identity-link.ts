import { createHash } from "crypto";

import type { JWTIdentity } from "@/lib/jwt-validation";
import { resolveUserIdentitiesByEmail, resolveUserIdentitiesBySubject, type ResolvedUserIdentity } from "@/lib/rbac/user-identity-directory";
import { assertAdminOnlyUserAttributes, findRealmUserIdsByAttribute, getRealmUserByIdOrNull, mergeUserAttributes } from "@/lib/rbac/keycloak-admin";
import { claimSecondaryIdentity, SecondaryIdentityClaimConflict } from "./secondary-identity-store";

const IDENTITY_KEY_ATTRIBUTE = "caipe_secondary_oidc_identity_key";
const PROVIDER_ID_ATTRIBUTE = "caipe_secondary_oidc_provider_id";
const ISSUER_ATTRIBUTE = "caipe_secondary_oidc_issuer";
const SUBJECT_ATTRIBUTE = "caipe_secondary_oidc_sub";
const EMAIL_ATTRIBUTE = "caipe_secondary_oidc_email";
const LINKED_AT_ATTRIBUTE = "caipe_secondary_oidc_linked_at";
const LINK_ATTRIBUTES = [
  IDENTITY_KEY_ATTRIBUTE,
  PROVIDER_ID_ATTRIBUTE,
  ISSUER_ATTRIBUTE,
  SUBJECT_ATTRIBUTE,
  EMAIL_ATTRIBUTE,
  LINKED_AT_ATTRIBUTE,
] as const;
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

export class SecondaryOidcIdentityLinkError extends Error {
  readonly name = "SecondaryOidcIdentityLinkError";

  constructor(
    readonly code: string,
    message: string,
    readonly unlinkedIdentity?: JWTIdentity,
  ) {
    super(message);
  }
}

export function unlinkedSecondaryOidcIdentity(
  error: unknown,
): JWTIdentity | null {
  return error instanceof SecondaryOidcIdentityLinkError &&
    error.code === "SECONDARY_OIDC_IDENTITY_USER_NOT_FOUND" &&
    error.unlinkedIdentity
    ? error.unlinkedIdentity
    : null;
}

export interface SecondaryOidcLinkInput {
  providerId: string;
  issuer: string;
  externalSub: string;
  email?: string;
  emailVerified?: boolean;
  requireVerifiedEmail?: boolean;
  identity: JWTIdentity;
}

async function claimIdentity(key: string, subject: string): Promise<void> {
  try {
    await claimSecondaryIdentity(key, subject);
  } catch (error) {
    if (!(error instanceof SecondaryIdentityClaimConflict)) throw error;
    throw new SecondaryOidcIdentityLinkError("SECONDARY_OIDC_IDENTITY_LINK_CONFLICT", error.message);
  }
}

function normalizedEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase() || "";
  return email && email.length <= 320 && email.includes("@") ? email : null;
}

function validIdentityKey(value: string): boolean {
  return OPENFGA_ID_PATTERN.test(value);
}

function validExternalSubject(value: string): boolean {
  return (
    Boolean(value) &&
    value === value.trim() &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function secondaryIdentityKey(issuer: string, externalSub: string): string {
  return createHash("sha256")
    .update(issuer, "utf8")
    .update("\0", "utf8")
    .update(externalSub, "utf8")
    .digest("hex");
}

function readAttribute(user: Record<string, unknown>, name: string): string | null {
  const attributes = user.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const values = (attributes as Record<string, unknown>)[name];
  if (!Array.isArray(values)) return null;
  const value = values[0];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalIdentity(
  identity: JWTIdentity,
  user: ResolvedUserIdentity,
): JWTIdentity {
  return {
    groups: [],
    sub: user.subject,
    email: user.email || identity.email,
    name: user.name || user.email || identity.name,
  };
}

async function requireLinkedUser(keycloakSub: string): Promise<ResolvedUserIdentity> {
  const users = await resolveUserIdentitiesBySubject([keycloakSub]);
  const user = users.get(keycloakSub);
  if (!user) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_LINK_STALE",
      "The linked CAIPE user no longer exists",
    );
  }
  return user;
}

async function rollbackClaimIfOwned(
  keycloakSub: string,
  identityKey: string,
): Promise<void> {
  const user = await getRealmUserByIdOrNull(keycloakSub);
  if (!user || readAttribute(user, IDENTITY_KEY_ATTRIBUTE) !== identityKey) return;

  const removals = Object.fromEntries(LINK_ATTRIBUTES.map((name) => [name, undefined]));
  await mergeUserAttributes(keycloakSub, removals);
}

/**
 * Resolve an immutable secondary-provider identity link stored on the Keycloak
 * user. The first successful request may establish the link from a trusted
 * corporate email; subsequent requests use only the hashed (issuer, external
 * sub) key, so email changes cannot silently reassign an identity.
 */
export async function linkSecondaryOidcIdentity(
  input: SecondaryOidcLinkInput,
): Promise<JWTIdentity> {
  const issuer = input.issuer.trim();
  // OIDC subjects are values, not user-entered labels. Never normalize one
  // before deriving the immutable link key: doing so can collapse two
  // provider identities into the same Keycloak link. Reject surrounding
  // whitespace instead and hash/store the exact claim value.
  const externalSub = input.externalSub;
  if (!issuer || !validExternalSubject(externalSub)) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_INVALID_SUBJECT",
      "The secondary OIDC token has no valid issuer subject",
    );
  }

  await assertAdminOnlyUserAttributes(LINK_ATTRIBUTES);
  const identityKey = secondaryIdentityKey(issuer, externalSub);
  const existingOwners = await findRealmUserIdsByAttribute(
    IDENTITY_KEY_ATTRIBUTE,
    identityKey,
  );
  if (existingOwners.length > 1) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT",
      "The secondary OIDC identity is linked to multiple Keycloak users",
    );
  }
  const existingOwner = existingOwners[0];
  if (existingOwner) {
    const keycloakUser = await getRealmUserByIdOrNull(existingOwner);
    if (!keycloakUser || keycloakUser.enabled === false) {
      throw new SecondaryOidcIdentityLinkError(
        "SECONDARY_OIDC_IDENTITY_LINK_STALE",
        "The linked Keycloak user no longer exists or is disabled",
      );
    }
    const user = await requireLinkedUser(existingOwner);
    await claimIdentity(identityKey, user.subject);
    return canonicalIdentity(input.identity, user);
  }

  if (input.requireVerifiedEmail !== false && input.emailVerified !== true) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_EMAIL_UNVERIFIED",
      "The secondary OIDC email must be explicitly verified",
    );
  }
  const email = normalizedEmail(input.email);
  if (!email) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_EMAIL_REQUIRED",
      "The secondary OIDC identity is not linked and has no corporate email",
    );
  }

  const users = await resolveUserIdentitiesByEmail([email], { requireUnique: true });
  const user = users.get(email);
  if (!user || !validIdentityKey(user.subject)) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_USER_NOT_FOUND",
      "No existing user matches the secondary auth email",
      input.identity,
    );
  }

  const keycloakUser = await getRealmUserByIdOrNull(user.subject);
  if (!keycloakUser) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_USER_NOT_FOUND",
      "The matching CAIPE profile has no active Keycloak user",
      input.identity,
    );
  }
  if (keycloakUser.enabled === false) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_LINK_STALE",
      "The matching Keycloak user is disabled",
    );
  }
  if (normalizedEmail(typeof keycloakUser.email === "string" ? keycloakUser.email : undefined) !== email) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_EMAIL_MISMATCH",
      "The directory email does not match the current Keycloak user",
    );
  }
  const targetExistingKey = readAttribute(keycloakUser, IDENTITY_KEY_ATTRIBUTE);
  if (targetExistingKey && targetExistingKey !== identityKey) {
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT",
      "The matching Keycloak user is already linked to another secondary identity",
    );
  }

  await claimIdentity(identityKey, user.subject);
  await mergeUserAttributes(user.subject, {
    [IDENTITY_KEY_ATTRIBUTE]: [identityKey],
    [PROVIDER_ID_ATTRIBUTE]: [input.providerId],
    [ISSUER_ATTRIBUTE]: [issuer],
    [SUBJECT_ATTRIBUTE]: [externalSub],
    [EMAIL_ATTRIBUTE]: [email],
    [LINKED_AT_ATTRIBUTE]: [new Date().toISOString()],
  });

  // Keycloak custom attributes do not have a global uniqueness constraint.
  // Re-read ownership and remove only our own write if another account won a
  // concurrent first-link race.
  const ownersAfterWrite = await findRealmUserIdsByAttribute(
    IDENTITY_KEY_ATTRIBUTE,
    identityKey,
  );
  if (ownersAfterWrite.length !== 1 || ownersAfterWrite[0] !== user.subject) {
    await rollbackClaimIfOwned(user.subject, identityKey);
    throw new SecondaryOidcIdentityLinkError(
      "SECONDARY_OIDC_IDENTITY_LINK_CONFLICT",
      "The secondary OIDC identity conflicts with an existing Keycloak link",
    );
  }

  return canonicalIdentity(input.identity, user);
}

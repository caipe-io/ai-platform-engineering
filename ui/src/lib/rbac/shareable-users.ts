import type { Filter } from "mongodb";

export interface ShareableUserDocument {
  email?: string;
  name?: string;
  avatar_url?: string;
  keycloak_sub?: string;
  metadata?: {
    keycloak_sub?: string;
  };
}

export function stableKeycloakSubject(user: ShareableUserDocument): string | undefined {
  const candidates = [
    user.keycloak_sub,
    user.metadata?.keycloak_sub,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim();
}

/**
 * Conversation shares are enforced with OpenFGA subjects. A Mongo user
 * without a Keycloak subject cannot receive a usable grant and must not be
 * offered as a share recipient.
 */
export function shareableUserIdentityFilter(): Filter<ShareableUserDocument> {
  return {
    $or: [
      { keycloak_sub: { $type: "string", $regex: "\\S" } },
      { "metadata.keycloak_sub": { $type: "string", $regex: "\\S" } },
    ],
  };
}

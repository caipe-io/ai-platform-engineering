/** Read-only identity diagnostics; never contains tokens or arbitrary attributes. */
export interface UserIdentityInfo {
  realm: string;
  fetchedAt: string;
  sessions: Array<{ id: string; start?: number; lastAccess?: number }>;
  federatedIdentities: Array<{ identityProvider: string; userId: string; userName: string }>;
  realmRoles: string[];
  lastAccess: number | null;
  unavailable: Array<"sessions" | "federatedIdentities" | "realmRoles">;
}

export interface UserMembershipSourceInfo {
  team: string;
  relationship: string;
  source: string;
  provider?: string;
  externalGroup?: string;
  subject?: string;
  lastSeenAt?: string;
  lastAppliedAt?: string;
}

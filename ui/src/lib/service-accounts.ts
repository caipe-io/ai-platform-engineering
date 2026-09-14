/**
 * MongoDB-backed display metadata for Service Accounts (FR-001..FR-026).
 *
 * Mirrors the shape of `ui/src/lib/catalog-api-keys.ts` (BFF-owned Mongo
 * wrapper) but holds NO credential material — Keycloak owns the secret and
 * OpenFGA owns access. This collection is a convenience/index layer only;
 * access decisions never read it.
 *
 * Architecture: docs/docs/security/rbac/architecture.md
 */

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import type { ServiceAccount, ServiceAccountScope } from "@/types/mongodb";

const COLLECTION = "service_accounts";

function requireMongoCollection(): void {
  if (!isMongoDBConfigured) {
    throw new Error("MongoDB unavailable for service_accounts");
  }
}

/** Fields needed to create a new SA doc (the wrapper stamps created_at/status). */
export interface CreateServiceAccountInput {
  sa_sub: string;
  client_id: string;
  client_uuid: string;
  name: string;
  description?: string;
  owning_team_id: string;
  created_by: string;
  scopes_snapshot?: ServiceAccountScope[];
  /**
   * [unlinked-sa] Set true ONLY for the platform unlinked SA (C2 contract).
   * Defaults undefined for all normal SAs — existing callers are unaffected.
   * Allows atomic insert of the flag rather than a separate updateOne.
   */
  is_platform_unlinked?: boolean;
}

/**
 * App-layer name-uniqueness check (FR-002a): a name must be unique among
 * **active** SAs within the owning team, compared **case-insensitively**.
 *
 * Enforced here (not via a partial unique index) so the "name freed on revoke"
 * semantics (FR-018a) stay simple and explicit — revoked docs are excluded.
 * The original-cased name is stored for display; only the comparison lowercases.
 *
 * @returns true when the name is already taken by an active SA in the team.
 */
export async function isNameTakenInTeam(
  owningTeamId: string,
  name: string,
): Promise<boolean> {
  if (!isMongoDBConfigured) {
    return false;
  }
  const target = name.trim().toLowerCase();
  if (!target) {
    return false;
  }
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  const docs = await collection
    .find({ owning_team_id: owningTeamId, status: "active" })
    .project({ name: 1 })
    .toArray();
  return docs.some(
    (doc) => typeof doc.name === "string" && doc.name.trim().toLowerCase() === target,
  );
}

/**
 * Insert a new active SA doc. Stamps `created_at` and `status: "active"`.
 * Callers MUST run {@link isNameTakenInTeam} first (FR-002a) and perform the
 * team-membership + scope-holding checks before reaching here.
 */
export async function createServiceAccountDoc(
  input: CreateServiceAccountInput,
): Promise<ServiceAccount> {
  requireMongoCollection();
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  const doc: ServiceAccount = {
    sa_sub: input.sa_sub,
    client_id: input.client_id,
    client_uuid: input.client_uuid,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    owning_team_id: input.owning_team_id,
    created_by: input.created_by,
    created_at: new Date(),
    status: "active",
    revoked_at: null,
    scopes_snapshot: input.scopes_snapshot ?? [],
    // [unlinked-sa] Spread is_platform_unlinked when provided; undefined for normal SAs.
    ...(input.is_platform_unlinked ? { is_platform_unlinked: true } : {}),
  };
  const result = await collection.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Escape user-supplied text for safe use inside a `new RegExp(...)`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ListByOwningTeamsOptions {
  includeRevoked?: boolean;
  /** Case-insensitive substring match against name/description. */
  search?: string;
  skip?: number;
  limit?: number;
}

/**
 * Build the Mongo filter shared by {@link listByOwningTeams} and
 * {@link countByOwningTeams} so the page + the total always agree.
 *
 * `owningTeamIds === null` means unbounded (org-admin, no team filter);
 * an empty array means "caller belongs to no team" and must match nothing.
 */
function buildOwningTeamsFilter(
  owningTeamIds: string[] | null,
  options: Pick<ListByOwningTeamsOptions, "includeRevoked" | "search">,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (owningTeamIds !== null) {
    filter.owning_team_id = { $in: owningTeamIds };
  }
  if (!options.includeRevoked) {
    filter.status = "active";
  }
  const search = options.search?.trim();
  if (search) {
    const rx = new RegExp(escapeRegExp(search), "i");
    filter.$or = [{ name: rx }, { description: rx }];
  }
  return filter;
}

/**
 * List SAs owned by any of the given teams (FR-014/021 — the caller's teams).
 * Pass `owningTeamIds: null` for the unbounded org-admin view (no team
 * filter); an empty array intentionally matches nothing (caller has no
 * teams). Active only by default; pass `includeRevoked` for audit views.
 * `skip`/`limit` opt into pagination — omit both for the full result set.
 * Sorted newest first. Returns [] when Mongo is not configured.
 */
export async function listByOwningTeams(
  owningTeamIds: string[] | null,
  options: ListByOwningTeamsOptions = {},
): Promise<ServiceAccount[]> {
  if (!isMongoDBConfigured || (owningTeamIds !== null && owningTeamIds.length === 0)) {
    return [];
  }
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  const filter = buildOwningTeamsFilter(owningTeamIds, options);
  let cursor = collection.find(filter).sort({ created_at: -1 });
  if (typeof options.skip === "number") cursor = cursor.skip(options.skip);
  if (typeof options.limit === "number") cursor = cursor.limit(options.limit);
  return cursor.toArray();
}

/** Total count matching the same filter as {@link listByOwningTeams}, for pagination. */
export async function countByOwningTeams(
  owningTeamIds: string[] | null,
  options: Pick<ListByOwningTeamsOptions, "includeRevoked" | "search"> = {},
): Promise<number> {
  if (!isMongoDBConfigured || (owningTeamIds !== null && owningTeamIds.length === 0)) {
    return 0;
  }
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  return collection.countDocuments(buildOwningTeamsFilter(owningTeamIds, options));
}

/**
 * Look up a single SA by its OpenFGA subject id (Keycloak service-account-user
 * `sub`). Returns null when not found or Mongo is unconfigured.
 */
export async function getBySub(saSub: string): Promise<ServiceAccount | null> {
  if (!isMongoDBConfigured) {
    return null;
  }
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  return collection.findOne({ sa_sub: saSub });
}

/**
 * Update an SA's lifecycle status. When revoking, stamps `revoked_at`
 * (terminal — FR-018a); reactivation is not a supported transition but the
 * field is cleared if a caller ever sets status back to "active".
 *
 * @returns true when a document was modified.
 */
export async function updateStatus(
  saSub: string,
  status: ServiceAccount["status"],
): Promise<boolean> {
  requireMongoCollection();
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  const set: Partial<ServiceAccount> =
    status === "revoked"
      ? { status, revoked_at: new Date() }
      : { status, revoked_at: null };
  const result = await collection.updateOne({ sa_sub: saSub }, { $set: set });
  return result.modifiedCount > 0;
}

/**
 * Replace the display-only `scopes_snapshot` after an OpenFGA tuple change
 * (create / add-scope / remove-scope). The snapshot is NOT authoritative —
 * OpenFGA tuples are the source of truth; this only keeps the list/detail view
 * cheap to render.
 *
 * @returns true when a document was modified.
 */
export async function updateScopesSnapshot(
  saSub: string,
  scopes: ServiceAccountScope[],
): Promise<boolean> {
  requireMongoCollection();
  const collection = await getCollection<ServiceAccount>(COLLECTION);
  const result = await collection.updateOne(
    { sa_sub: saSub },
    { $set: { scopes_snapshot: scopes } },
  );
  return result.modifiedCount > 0;
}

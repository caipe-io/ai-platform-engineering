import {
type OpenFgaTupleKey,
type TeamResourceTupleDiff,
} from "./openfga";
import { openFgaResourceId } from "./openfga-resource-ids";
import { organizationObjectId } from "./organization";

export type { TeamResourceTupleDiff } from "./openfga";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function isValidOpenFgaId(value: unknown): value is string {
  return typeof value === "string" && OPENFGA_ID_PATTERN.test(value);
}

function uniqueTuples(tuples: OpenFgaTupleKey[]): OpenFgaTupleKey[] {
  const seen = new Set<string>();
  const out: OpenFgaTupleKey[] = [];
  for (const tuple of tuples) {
    const key = `${tuple.user}\n${tuple.relation}\n${tuple.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

export type OwnerSubjectKind = "user" | "service_account";

function ownerPrincipal(
  subjectId: string | null | undefined,
  kind: OwnerSubjectKind = "user",
): string | null {
  if (!subjectId || !isValidOpenFgaId(subjectId)) return null;
  return `${kind}:${subjectId}`;
}

interface OwnedResourceInput {
  ownerSubject?: string | null;
  ownerSubjectKind?: OwnerSubjectKind;
  /** Previous personal owner to revoke during an explicit ownership transfer. */
  previousOwnerSubject?: string | null;
  previousOwnerSubjectKind?: OwnerSubjectKind;
  ownerTeamSlug?: string | null;
  /**
   * Keycloak `sub` of the creator. Written once as an audit-only
   * `user:<sub> creator <type>:<id>` tuple and never deleted (spec
   * 2026-06-03, US2). Optional so legacy callers and types that don't
   * track provenance are unaffected.
   */
  creatorSubject?: string | null;
}

export interface McpServerRelationshipInput extends OwnedResourceInput {
  serverId: string;
}

export interface ConfigDrivenMcpServerRelationshipInput {
  serverId: string;
  organizationId?: string | null;
}

export interface LlmModelRelationshipInput extends OwnedResourceInput {
  modelId: string;
}

export interface ConfigDrivenLlmModelRelationshipInput {
  modelId: string;
  organizationId?: string | null;
}

/**
 * Input for `buildDataSourceRelationshipTupleDiff`.
 *
 * A `data_source` is conceptually 1:1 with a `knowledge_base` today: the
 * RAG server uses the same `<datasource_id>` for both. The separate
 * OpenFGA type was added in [deploy/openfga/model.fga] so future
 * ingest-only roles can be granted without leaking read access on the
 * KB content.
 */
export interface DataSourceRelationshipInput extends OwnedResourceInput {
  dataSourceId: string;
  nextSharedTeamSlugs?: readonly string[] | null;
  previousSharedTeamSlugs?: readonly string[] | null;
  previousOwnerTeamSlug?: string | null;
  /**
   * The knowledge_base id this data source inherits read/ingest/manage
   * from (spec 2026-06-03, US4). A data_source is 1:1 with its KB, so this
   * is normally the same value as `dataSourceId`. When set, the reconciler
   * writes the `data_source:<id> parent_kb knowledge_base:<id>` edge once.
   */
  parentKnowledgeBaseId?: string | null;
}

/**
 * Input for `buildMcpToolRelationshipTupleDiff`.
 *
 * `mcp_tool` is the new OpenFGA type for RAG custom MCP tools
 * (`PUT /v1/mcp/custom-tools/<tool_id>`). Distinct from the existing
 * `tool:<id>` type used by AgentGateway → MCP wiring, because the two
 * have different owners and lifecycles.
 */
export interface McpToolRelationshipInput extends OwnedResourceInput {
  toolId: string;
  nextSharedTeamSlugs?: readonly string[] | null;
  previousSharedTeamSlugs?: readonly string[] | null;
  previousOwnerTeamSlug?: string | null;
  /** Org-wide sharing: grant every `organization#member` reader/user/caller. */
  sharedWithOrg?: boolean;
  /** Prior org-wide state, so a `true` → `false` flip emits revoke deletes. */
  previousSharedWithOrg?: boolean;
}

/**
 * Input for `buildIngestionSourceRelationshipTupleDiff`.
 *
 * `ingestion_source` is a standalone shareable resource (spec
 * 2026-07-21-rag-source-config-db) — it does not inherit from a
 * `knowledge_base`/`data_source`, since a source describes where content is
 * pulled *from*, not the resulting indexed data.
 */
export interface IngestionSourceRelationshipInput extends OwnedResourceInput {
  sourceId: string;
  nextSharedTeamSlugs?: readonly string[] | null;
  previousSharedTeamSlugs?: readonly string[] | null;
  previousOwnerTeamSlug?: string | null;
  /** `visibility: "global"` — grants every authenticated user `reader` via `user:*`. */
  globalUserAccess?: boolean;
  /** Prior global-visibility state, so a `true` → `false` flip emits a revoke delete. */
  previousGlobalUserAccess?: boolean;
}

export interface KnowledgeBaseRelationshipInput extends OwnedResourceInput {
  knowledgeBaseId: string;
  /**
   * Desired set of team slugs that should have read-only Search access on
   * this KB in addition to the owner. Invalid slugs are
   * silently dropped; duplicates are deduped. When omitted, only the owner
   * team is granted.
   */
  nextSharedTeamSlugs?: readonly string[] | null;
  /**
   * Previous set of shared team slugs persisted with this KB before this
   * reconcile call. Any slug in here that is NOT in `nextSharedTeamSlugs`
   * (and is also not the new owner team) is emitted as a delete so
   * unchecking a team in the UI genuinely revokes access instead of leaving
   * a dangling tuple.
   */
  previousSharedTeamSlugs?: readonly string[] | null;
  /** Desired direct-user Search grants (Keycloak subjects). */
  nextSharedUserSubjects?: readonly string[] | null;
  /** Previously persisted direct-user grants, used to emit revocations. */
  previousSharedUserSubjects?: readonly string[] | null;
  /**
   * Set only while cleaning a legacy projection in which search-only team
   * admins also received `manager`. New Search Access policies leave this
   * false, keeping repeated diffs idempotent.
   */
  previousSharedTeamAdminsManage?: boolean;
  /**
   * Previous owner-team slug, if it differed from the new owner. Allows
   * deleting the old owner-team grant when the KB is transferred to a
   * different owning team (a future feature; today the route never sets
   * this). Treated symmetrically with shared-team removals.
   */
  previousOwnerTeamSlug?: string | null;
}

function normalizeTeamSlugs(raw: readonly string[] | null | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (!trimmed || !isValidOpenFgaId(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// Shared shareable-resource core (spec 2026-06-03-unified-shareable-resource-rbac)
//
// `buildTeamGrantTuples` is the single home for the owner-team + share-with-
// teams effective-set diff that every shareable type used to re-implement:
// write `team:<t>#member <r>` (for each member relation `r`) + `team:<t>#admin
// manager` for each team in `{owner} ∪ shared`, and delete the matching tuples
// for each team in `previousEffective \ nextEffective`. The owner team is
// treated as "wanted" so duplicating it in the shared list is a no-op, and a
// team promoted from shared → owner is never deleted.
//
// `buildShareableResourceTupleDiff` layers the audit-only `creator` tuple, the
// optional personal `owner` subject, and (for data_source) the `parent_kb`
// inheritance edge on top of the team-grant diff. The per-type builders
// (`buildKnowledgeBaseRelationshipTupleDiff`, `buildDataSourceRelationshipTupleDiff`,
// `buildMcpToolRelationshipTupleDiff`) and the agent reconciler are thin
// adapters over these primitives (FR-003 / SC-006).
// ════════════════════════════════════════════════════════════════════════

export interface TeamGrantTuplesInput {
  /** Fully-qualified OpenFGA object, e.g. `data_source:ds-1`. */
  object: string;
  /**
   * The relations a team MEMBER receives on this object (admins always get
   * `manager` in addition). Defaults to `["reader"]`. The agent type passes
   * `["user"]`; `mcp_tool` passes `["reader", "user", "caller"]`.
   */
  memberRelations?: readonly string[];
  ownerTeamSlug?: string | null;
  previousOwnerTeamSlug?: string | null;
  nextSharedTeamSlugs?: readonly string[] | null;
  previousSharedTeamSlugs?: readonly string[] | null;
  /** Whether admins of shared (non-owner) teams receive `manager`. */
  sharedTeamAdminsManage?: boolean;
  /** Whether the previous shared-team projection included `manager`. */
  previousSharedTeamAdminsManage?: boolean;
}

/**
 * Compute the owner-team + shared-teams write/delete tuple diff for a single
 * object. Pure and order-deterministic: writes are emitted owner-first then in
 * `nextSharedTeamSlugs` order, each team contributing its member relations in
 * order followed by `#admin manager`. Deletes mirror that shape for retired
 * teams. Does NOT emit owner-subject, creator, or parent_kb tuples — those are
 * layered by `buildShareableResourceTupleDiff`.
 */
export function buildTeamGrantTuples(
  input: TeamGrantTuplesInput,
): TeamResourceTupleDiff {
  const { object } = input;
  const memberRelations =
    input.memberRelations && input.memberRelations.length > 0
      ? input.memberRelations
      : ["reader"];

  const writes: OpenFgaTupleKey[] = [];
  const deletes: OpenFgaTupleKey[] = [];

  const nextOwnerSlug =
    input.ownerTeamSlug && isValidOpenFgaId(input.ownerTeamSlug)
      ? input.ownerTeamSlug
      : null;
  const previousOwnerSlug =
    input.previousOwnerTeamSlug && isValidOpenFgaId(input.previousOwnerTeamSlug)
      ? input.previousOwnerTeamSlug
      : null;

  const nextSharedSlugs = normalizeTeamSlugs(input.nextSharedTeamSlugs);
  const previousSharedSlugs = normalizeTeamSlugs(input.previousSharedTeamSlugs);
  const sharedTeamAdminsManage = input.sharedTeamAdminsManage !== false;

  // Effective desired team slugs = owner ∪ shared. Union semantics mean an
  // owner team that also appears in the shared list neither double-writes nor
  // gets deleted on subsequent reconciles.
  const nextEffective = new Set<string>();
  if (nextOwnerSlug) nextEffective.add(nextOwnerSlug);
  for (const slug of nextSharedSlugs) nextEffective.add(slug);

  const nextManagers = new Set<string>();
  if (nextOwnerSlug) nextManagers.add(nextOwnerSlug);
  if (sharedTeamAdminsManage) {
    for (const slug of nextSharedSlugs) nextManagers.add(slug);
  }
  for (const slug of nextEffective) {
    for (const relation of memberRelations) {
      writes.push({ user: `team:${slug}#member`, relation, object });
    }
    if (nextManagers.has(slug)) {
      writes.push({ user: `team:${slug}#admin`, relation: "manager", object });
    }
  }

  const previousEffective = new Set<string>();
  if (previousOwnerSlug) previousEffective.add(previousOwnerSlug);
  for (const slug of previousSharedSlugs) previousEffective.add(slug);

  const previousManagers = new Set<string>();
  if (previousOwnerSlug) previousManagers.add(previousOwnerSlug);
  const previousSharedTeamAdminsManage =
    input.previousSharedTeamAdminsManage ?? sharedTeamAdminsManage;
  if (previousSharedTeamAdminsManage) {
    for (const slug of previousSharedSlugs) previousManagers.add(slug);
  }
  for (const slug of previousEffective) {
    if (!nextEffective.has(slug)) {
      for (const relation of memberRelations) {
        deletes.push({ user: `team:${slug}#member`, relation, object });
      }
    }
    if (previousManagers.has(slug) && !nextManagers.has(slug)) {
      deletes.push({ user: `team:${slug}#admin`, relation: "manager", object });
    }
  }

  return { writes: uniqueTuples(writes), deletes: uniqueTuples(deletes) };
}

/**
 * Canonical input for any person/team-owned, shareable resource. See
 * `docs/docs/security/rbac/architecture.md`
 * (R1).
 */
export interface ShareableResourceInput {
  objectType: string;
  objectId: string;
  /** Keycloak `sub` of the creator → `user:<sub> creator <type>:<id>` (audit-only, never deleted). */
  creatorSubject?: string | null;
  /** Optional personal/service-account owner subject → `<kind>:<sub> owner <type>:<id>`. */
  ownerSubject?: string | null;
  ownerSubjectKind?: OwnerSubjectKind;
  /** Previous personal/service-account owner to revoke during a transfer. */
  previousOwnerSubject?: string | null;
  previousOwnerSubjectKind?: OwnerSubjectKind;
  ownerTeamSlug?: string | null;
  /** Transfer: revokes the old owner team's grants when it differs from `ownerTeamSlug`. */
  previousOwnerTeamSlug?: string | null;
  nextSharedTeamSlugs?: readonly string[] | null;
  previousSharedTeamSlugs?: readonly string[] | null;
  /** Direct user grants. These receive the same member relations as teams. */
  nextSharedUserSubjects?: readonly string[] | null;
  /** Prior direct user grants, so removing a person emits tuple deletes. */
  previousSharedUserSubjects?: readonly string[] | null;
  /** Whether admins of shared (non-owner) teams receive `manager`. */
  sharedTeamAdminsManage?: boolean;
  /** Whether admins in the previous shared set received `manager`. */
  previousSharedTeamAdminsManage?: boolean;
  /** Member relations beyond the default `reader` — e.g. `["ingestor"]`, `["user"]`. */
  extraMemberRelations?: readonly string[];
  /** Override the member-relation set entirely (agent uses `["user"]`, not `reader`+extras). */
  memberRelations?: readonly string[];
  /** data_source only → writes `data_source:<id> parent_kb knowledge_base:<parentKnowledgeBaseId>`. */
  parentKnowledgeBaseId?: string | null;
  /**
   * Organization-wide sharing (mcp_tool, US6 follow-up). When `true`, every
   * `organization#member` is granted the same member relations on the object
   * (e.g. reader/user/caller). When it flips from `true` → `false` set
   * `previousSharedWithOrg: true` so the reconciler emits the revoke deletes.
   * Leave both undefined for types that don't support org-wide sharing — the
   * emission is then a no-op and the diff is unchanged.
   */
  sharedWithOrg?: boolean;
  previousSharedWithOrg?: boolean;
}

/**
 * Build the full tuple diff for a shareable resource: creator (once, audit-
 * only) → owner-subject (optional) → team grants → parent_kb edge (data_source).
 * The emission order is fixed so the per-type exact-order tests stay green.
 */
export function buildShareableResourceTupleDiff(
  input: ShareableResourceInput,
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.objectId)) {
    throw new Error(`Invalid OpenFGA ${input.objectType} id: ${input.objectId}`);
  }
  const object = `${input.objectType}:${input.objectId}`;
  const writes: OpenFgaTupleKey[] = [];

  // 1. creator — provenance only, written once, never deleted (FR-011).
  if (input.creatorSubject && isValidOpenFgaId(input.creatorSubject)) {
    writes.push({ user: `user:${input.creatorSubject}`, relation: "creator", object });
  }

  // 2. optional personal owner subject.
  const ownerUser = ownerPrincipal(input.ownerSubject, input.ownerSubjectKind);
  if (ownerUser) {
    writes.push({ user: ownerUser, relation: "owner", object });
  }
  const previousOwnerUser = ownerPrincipal(
    input.previousOwnerSubject,
    input.previousOwnerSubjectKind,
  );
  const deletes: OpenFgaTupleKey[] = [];
  if (previousOwnerUser && previousOwnerUser !== ownerUser) {
    deletes.push({ user: previousOwnerUser, relation: "owner", object });
  }

  // 3. owner-team + shared-team grants (the shared primitive).
  const memberRelations =
    input.memberRelations && input.memberRelations.length > 0
      ? input.memberRelations
      : ["reader", ...(input.extraMemberRelations ?? [])];
  const teamGrants = buildTeamGrantTuples({
    object,
    memberRelations,
    ownerTeamSlug: input.ownerTeamSlug,
    previousOwnerTeamSlug: input.previousOwnerTeamSlug,
    nextSharedTeamSlugs: input.nextSharedTeamSlugs,
    previousSharedTeamSlugs: input.previousSharedTeamSlugs,
    sharedTeamAdminsManage: input.sharedTeamAdminsManage,
    previousSharedTeamAdminsManage: input.previousSharedTeamAdminsManage,
  });
  writes.push(...teamGrants.writes);
  deletes.push(...teamGrants.deletes);

  // 4. optional direct-user grants. Personal ownership is already sufficient
  // for the owner, so do not duplicate reader/ingestor tuples for that user.
  // Keeping this in the shared primitive gives RAG one reconciliation path for
  // team and individual Search Access while leaving other resource types
  // byte-for-byte unchanged when these inputs are omitted.
  const ownerUserSubject =
    input.ownerSubjectKind === undefined || input.ownerSubjectKind === "user"
      ? input.ownerSubject?.trim() || null
      : null;
  const nextUserSubjects = normalizeTeamSlugs(input.nextSharedUserSubjects).filter(
    (subject) => subject !== ownerUserSubject,
  );
  const previousUserSubjects = normalizeTeamSlugs(input.previousSharedUserSubjects);
  const nextUserSet = new Set(nextUserSubjects);
  for (const subject of nextUserSubjects) {
    for (const relation of memberRelations) {
      writes.push({ user: `user:${subject}`, relation, object });
    }
  }
  for (const subject of previousUserSubjects) {
    if (nextUserSet.has(subject)) continue;
    for (const relation of memberRelations) {
      deletes.push({ user: `user:${subject}`, relation, object });
    }
  }

  // 5. organization-wide grant (opt-in; only emitted when the flag is
  // involved so other types stay byte-for-byte unchanged). Org members get the
  // same member relations as a shared team (reader/user/caller for mcp_tool).
  if (input.sharedWithOrg === true || input.previousSharedWithOrg === true) {
    const orgMember = `${organizationObjectId()}#member`;
    if (input.sharedWithOrg) {
      for (const relation of memberRelations) {
        writes.push({ user: orgMember, relation, object });
      }
    } else if (input.previousSharedWithOrg) {
      for (const relation of memberRelations) {
        deletes.push({ user: orgMember, relation, object });
      }
    }
  }

  // 6. data_source inheritance edge (the model's first tuple-to-userset).
  if (
    input.parentKnowledgeBaseId &&
    isValidOpenFgaId(input.parentKnowledgeBaseId)
  ) {
    writes.push({
      user: `knowledge_base:${input.parentKnowledgeBaseId}`,
      relation: "parent_kb",
      object,
    });
  }

  // creator and parent_kb are never in a delete set — only team + org grants are.
  return { writes: uniqueTuples(writes), deletes: uniqueTuples(deletes) };
}

export function buildMcpServerRelationshipTupleDiff(
  input: McpServerRelationshipInput
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.serverId)) {
    throw new Error(`Invalid OpenFGA MCP server id: ${input.serverId}`);
  }
  const writes: OpenFgaTupleKey[] = [];
  const object = `mcp_server:${input.serverId}`;
  const ownerUser = ownerPrincipal(input.ownerSubject, input.ownerSubjectKind);
  if (ownerUser) {
    writes.push({ user: ownerUser, relation: "owner", object });
  }
  if (input.ownerTeamSlug && isValidOpenFgaId(input.ownerTeamSlug)) {
    writes.push(
      { user: `team:${input.ownerTeamSlug}#member`, relation: "reader", object },
      { user: `team:${input.ownerTeamSlug}#member`, relation: "user", object },
      { user: `team:${input.ownerTeamSlug}#member`, relation: "invoker", object },
      { user: `team:${input.ownerTeamSlug}#admin`, relation: "manager", object },
    );
  }
  // assisted-by Codex Codex-sonnet-4-6
  // User-created servers should be visible/manageable to organization admins immediately.
  writes.push({ user: `${organizationObjectId()}#admin`, relation: "manager", object });
  return { writes: uniqueTuples(writes), deletes: [] };
}

export function buildConfigDrivenMcpServerRelationshipTupleDiff(
  input: ConfigDrivenMcpServerRelationshipInput
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.serverId)) {
    throw new Error(`Invalid OpenFGA MCP server id: ${input.serverId}`);
  }
  const organizationId = input.organizationId || "caipe";
  if (!isValidOpenFgaId(organizationId)) {
    throw new Error(`Invalid OpenFGA organization id: ${organizationId}`);
  }

  const object = `mcp_server:${input.serverId}`;
  const orgMember = `organization:${organizationId}#member`;
  // Org members may list/discover default MCP servers but must not invoke/test
  // them directly; runtime agent tool calls use agent-scoped tool tuples instead.
  // Org admins retain invoke via manager → can_manage → can_invoke.
  return {
    writes: uniqueTuples([
      { user: orgMember, relation: "reader", object },
      { user: orgMember, relation: "user", object },
      { user: `organization:${organizationId}#admin`, relation: "manager", object },
    ]),
    deletes: uniqueTuples([{ user: orgMember, relation: "invoker", object }]),
  };
}

export function buildLlmModelRelationshipTupleDiff(
  input: LlmModelRelationshipInput
): TeamResourceTupleDiff {
  const modelObjectId = openFgaResourceId("llm_model", input.modelId);
  if (!isValidOpenFgaId(modelObjectId)) {
    throw new Error(`Invalid OpenFGA LLM model id: ${input.modelId}`);
  }
  const writes: OpenFgaTupleKey[] = [];
  const object = `llm_model:${modelObjectId}`;
  const ownerUser = ownerPrincipal(input.ownerSubject, input.ownerSubjectKind);
  if (ownerUser) {
    writes.push({ user: ownerUser, relation: "owner", object });
  }
  if (input.ownerTeamSlug && isValidOpenFgaId(input.ownerTeamSlug)) {
    writes.push(
      { user: `team:${input.ownerTeamSlug}#member`, relation: "reader", object },
      { user: `team:${input.ownerTeamSlug}#admin`, relation: "manager", object },
    );
  }
  return { writes: uniqueTuples(writes), deletes: [] };
}

export function buildConfigDrivenLlmModelRelationshipTupleDiff(
  input: ConfigDrivenLlmModelRelationshipInput
): TeamResourceTupleDiff {
  const modelObjectId = openFgaResourceId("llm_model", input.modelId);
  if (!isValidOpenFgaId(modelObjectId)) {
    throw new Error(`Invalid OpenFGA LLM model id: ${input.modelId}`);
  }
  const organizationId = input.organizationId || "caipe";
  if (!isValidOpenFgaId(organizationId)) {
    throw new Error(`Invalid OpenFGA organization id: ${organizationId}`);
  }

  const object = `llm_model:${modelObjectId}`;
  return {
    writes: uniqueTuples([
      { user: `organization:${organizationId}#member`, relation: "reader", object },
      { user: `organization:${organizationId}#admin`, relation: "manager", object },
    ]),
    deletes: [],
  };
}

export function buildKnowledgeBaseRelationshipTupleDiff(
  input: KnowledgeBaseRelationshipInput
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.knowledgeBaseId)) {
    throw new Error(`Invalid OpenFGA knowledge base id: ${input.knowledgeBaseId}`);
  }
  // Search audiences are query-only. `ingestor` remains in the model for
  // trusted ingestion identities and legacy transports, but sharing a data
  // source never grants it. Owner lifecycle authority comes from the
  // independent ingestion_source graph.
  const diff = buildShareableResourceTupleDiff({
    objectType: "knowledge_base",
    objectId: input.knowledgeBaseId,
    creatorSubject: input.creatorSubject,
    ownerSubject: input.ownerSubject,
    previousOwnerSubject: input.previousOwnerSubject,
    previousOwnerSubjectKind: input.previousOwnerSubjectKind,
    ownerSubjectKind: input.ownerSubjectKind,
    ownerTeamSlug: input.ownerTeamSlug,
    previousOwnerTeamSlug: input.previousOwnerTeamSlug,
    nextSharedTeamSlugs: input.nextSharedTeamSlugs,
    previousSharedTeamSlugs: input.previousSharedTeamSlugs,
    nextSharedUserSubjects: input.nextSharedUserSubjects,
    previousSharedUserSubjects: input.previousSharedUserSubjects,
    sharedTeamAdminsManage: false,
    previousSharedTeamAdminsManage: input.previousSharedTeamAdminsManage,
  });

  // During development this branch briefly projected Search as
  // reader+ingestor. Reconciliation is also our local-data cleanup path: any
  // audience represented by the persisted desired/previous policy loses that
  // stale direct ingestor tuple. OpenFGA filters no-op deletes, so this remains
  // safe and idempotent for fresh installations and is not a migration.
  const staleTeamSlugs = normalizeTeamSlugs([
    ...(input.nextSharedTeamSlugs ?? []),
    ...(input.previousSharedTeamSlugs ?? []),
    ...(input.ownerTeamSlug ? [input.ownerTeamSlug] : []),
    ...(input.previousOwnerTeamSlug ? [input.previousOwnerTeamSlug] : []),
  ]);
  const staleUserSubjects = normalizeTeamSlugs([
    ...(input.nextSharedUserSubjects ?? []),
    ...(input.previousSharedUserSubjects ?? []),
  ]);
  const object = `knowledge_base:${input.knowledgeBaseId}`;
  return {
    writes: diff.writes,
    deletes: uniqueTuples([
      ...diff.deletes,
      ...staleTeamSlugs.map((slug) => ({
        user: `team:${slug}#member`,
        relation: "ingestor",
        object,
      })),
      ...staleUserSubjects.map((subject) => ({
        user: `user:${subject}`,
        relation: "ingestor",
        object,
      })),
    ]),
  };
}

/**
 * Build a data_source tuple diff with the same owner + shared-teams
 * semantics as `buildKnowledgeBaseRelationshipTupleDiff`. See
 * [deploy/openfga/model.fga] for
 * the `data_source` type definition.
 */
export function buildDataSourceRelationshipTupleDiff(
  input: DataSourceRelationshipInput
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.dataSourceId)) {
    throw new Error(`Invalid OpenFGA data source id: ${input.dataSourceId}`);
  }
  return buildShareableResourceTupleDiff({
    objectType: "data_source",
    objectId: input.dataSourceId,
    creatorSubject: input.creatorSubject,
    ownerSubject: input.ownerSubject,
    previousOwnerSubject: input.previousOwnerSubject,
    previousOwnerSubjectKind: input.previousOwnerSubjectKind,
    ownerSubjectKind: input.ownerSubjectKind,
    ownerTeamSlug: input.ownerTeamSlug,
    nextSharedTeamSlugs: input.nextSharedTeamSlugs,
    previousSharedTeamSlugs: input.previousSharedTeamSlugs,
    previousOwnerTeamSlug: input.previousOwnerTeamSlug,
    parentKnowledgeBaseId: input.parentKnowledgeBaseId,
  });
}

/**
 * Build an mcp_tool tuple diff.
 * `user` + `caller` on the tool, and team admins get `manager` (so they
 * can update or delete it via `PUT/DELETE /v1/mcp/custom-tools/<tool_id>`).
 * Mirrors the relation set on the `mcp_tool` type in
 * [deploy/openfga/model.fga].
 *
 * IMPORTANT: invocation is gated on `can_call = caller or can_manage or
 * owner` (both at the BFF `mcp_tool#can_call` gate and conceptually in the
 * model). The `user` relation only grants `can_use`, NOT `can_call`, so a
 * member granted just `reader` + `user` could *see/use* the tool but not
 * *invoke* it. Shared/owner team members must therefore also get `caller`,
 * otherwise sharing a tool with a team leaves its members unable to call it.
 */
export function buildMcpToolRelationshipTupleDiff(
  input: McpToolRelationshipInput
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.toolId)) {
    throw new Error(`Invalid OpenFGA mcp tool id: ${input.toolId}`);
  }
  return buildShareableResourceTupleDiff({
    objectType: "mcp_tool",
    objectId: input.toolId,
    creatorSubject: input.creatorSubject,
    ownerSubject: input.ownerSubject,
    previousOwnerSubject: input.previousOwnerSubject,
    previousOwnerSubjectKind: input.previousOwnerSubjectKind,
    ownerSubjectKind: input.ownerSubjectKind,
    ownerTeamSlug: input.ownerTeamSlug,
    nextSharedTeamSlugs: input.nextSharedTeamSlugs,
    previousSharedTeamSlugs: input.previousSharedTeamSlugs,
    previousOwnerTeamSlug: input.previousOwnerTeamSlug,
    sharedWithOrg: input.sharedWithOrg,
    previousSharedWithOrg: input.previousSharedWithOrg,
    // `reader` (default) → can_read, `user` → can_use, `caller` → can_call.
    // All three are required so shared team members can both see AND invoke
    // the tool (the invoke path checks `can_call`). Org-wide grants reuse the
    // same relation set.
    extraMemberRelations: ["user", "caller"],
  });
}

/**
 * Build an ingestion_source tuple diff. Mirrors the owner + shared-teams
 * semantics of `buildDataSourceRelationshipTupleDiff`/`buildMcpToolRelationshipTupleDiff`,
 * plus a `visibility: "global"` → `user:* reader` grant (same encoding as
 * `globalUserAccess` on agents, see `buildAgentRelationshipTupleDiff`).
 */
export function buildIngestionSourceRelationshipTupleDiff(
  input: IngestionSourceRelationshipInput
): TeamResourceTupleDiff {
  if (!isValidOpenFgaId(input.sourceId)) {
    throw new Error(`Invalid OpenFGA ingestion source id: ${input.sourceId}`);
  }
  const diff = buildShareableResourceTupleDiff({
    objectType: "ingestion_source",
    objectId: input.sourceId,
    creatorSubject: input.creatorSubject,
    ownerSubject: input.ownerSubject,
    previousOwnerSubject: input.previousOwnerSubject,
    previousOwnerSubjectKind: input.previousOwnerSubjectKind,
    ownerSubjectKind: input.ownerSubjectKind,
    ownerTeamSlug: input.ownerTeamSlug,
    nextSharedTeamSlugs: input.nextSharedTeamSlugs,
    previousSharedTeamSlugs: input.previousSharedTeamSlugs,
    previousOwnerTeamSlug: input.previousOwnerTeamSlug,
  });

  const object = `ingestion_source:${input.sourceId}`;
  const writes = [...diff.writes];
  const deletes = [...diff.deletes];
  if (input.globalUserAccess) {
    writes.push({ user: "user:*", relation: "reader", object });
  } else if (input.previousGlobalUserAccess) {
    deletes.push({ user: "user:*", relation: "reader", object });
  }
  return { writes: uniqueTuples(writes), deletes: uniqueTuples(deletes) };
}

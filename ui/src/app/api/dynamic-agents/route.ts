/**
 * API routes for Dynamic Agents management.
 *
 * All operations use local MongoDB directly.
 * The gateway owns all config writes — DA is a pure runtime reader.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  getPaginationParams,
  paginatedResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  RAG_COLLECTION_ID_PATTERN,
  RAG_COLLECTIONS_COLLECTION,
} from "@/lib/rag-collections.server";
import {
  allowedToolsFromAgent,
  deleteAllAgentToolTuples,
  reconcileAgentRelationships,
} from "@/lib/rbac/openfga-agent-tools";
import { cascadeDeleteAutonomousTasksForAgent } from "@/lib/dynamic-agents/autonomousTaskCascade";
import { filterAgentsByOwnershipScopeForSession } from "@/lib/rbac/agent-ownership-scope";
import { caipeOrgKey } from "@/lib/rbac/organization";
import {
  getPlatformDefaultAgentId,
  isPlatformDefaultAgent,
} from "@/lib/rbac/platform-default";
import {
  filterResourcesByPermission,
  requireAgentPermission,
  requireResourcePermission,
  agentRowPermissionsOrDefault,
  resolveAgentListPermissions,
  type ResourceAuthzSession,
} from "@/lib/rbac/resource-authz";
import { resolveShareableOwnershipWrite } from "@/lib/rbac/shareable-resource";
import { listTeamKbGrants } from "@/lib/rbac/team-resource-listing";
import {
  resolveUnlinkedServiceAccountSub,
  resolveUnlinkedServiceAccountGrantState,
} from "@/lib/rbac/unlinked-service-account";
import type {
  DynamicAgentConfig,
  DynamicAgentConfigWithPermissions,
  LegacyVisibilityType,
  SubAgentRef,
  VisibilityType,
} from "@/types/dynamic-agent";
import {
  PLATFORM_RAG_COLLECTION_ID,
  type RagCollection,
} from "@/types/rag-collection";
import { Collection, ObjectId } from "mongodb";
import { NextRequest } from "next/server";

const PLATFORM_DEFAULT_VISIBILITY_ERROR =
  "This agent is currently the platform default for new chats. Open Settings → Platform settings → Defaults and change the platform default before changing this agent's visibility.";
const PLATFORM_DEFAULT_DELETE_ERROR =
  "This agent is currently the platform default for new chats. Open Settings → Platform settings → Defaults and change the platform default before deleting this agent.";

const COLLECTION_NAME = "dynamic_agents";
const OPENFGA_RESOURCE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

interface TeamOwnershipDoc {
  _id?: unknown;
  slug?: string;
  name?: string;
  members?: Array<{ user_id?: string; email?: string; role?: string }>;
}

/**
 * Resolve a list of `shared_with_teams` entries (which historically have
 * been Mongo `_id` strings from the editor but may now also be canonical
 * slugs after this change is rolled out) into the canonical team slug
 * set used everywhere else in the RBAC layer.
 *
 * - Unknown / invalid entries are dropped (we don't want a typo in the
 *   request body to silently grant a non-existent `team:<bogus>#member`
 *   tuple that no admin can ever delete from the UI).
 * - Duplicates are removed.
 * - Order is preserved from the input.
 *
 * Returns `{ slugs, droppedInputs }` so callers can log/warn on drops
 * without surfacing a hard error (the agent save should not fail just
 * because one stale team reference was sent).
 */
async function resolveSharedTeamSlugs(
  rawInput: unknown,
): Promise<{ slugs: string[]; droppedInputs: string[] }> {
  if (!Array.isArray(rawInput) || rawInput.length === 0) {
    return { slugs: [], droppedInputs: [] };
  }
  const teams = await getCollection<TeamOwnershipDoc>("teams");
  const candidates: string[] = [];
  for (const value of rawInput) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) candidates.push(trimmed);
  }
  if (candidates.length === 0) return { slugs: [], droppedInputs: [] };

  const objectIdCandidates = candidates.filter((c) => ObjectId.isValid(c));
  const filters: Record<string, unknown>[] = [
    { slug: { $in: candidates } },
    { _id: { $in: candidates } },
  ];
  if (objectIdCandidates.length > 0) {
    filters.push({
      _id: { $in: objectIdCandidates.map((c) => new ObjectId(c)) },
    });
  }
  const docs = (await teams
    .find({ $or: filters })
    .project({ _id: 1, slug: 1 })
    .toArray()) as TeamOwnershipDoc[];

  const slugByCandidate = new Map<string, string>();
  for (const doc of docs) {
    const slug = normalizeString(doc.slug);
    if (!slug) continue;
    const idHex =
      doc._id instanceof ObjectId
        ? doc._id.toHexString()
        : normalizeString(doc._id);
    if (idHex) slugByCandidate.set(idHex, slug);
    slugByCandidate.set(slug, slug);
  }

  const seen = new Set<string>();
  const slugs: string[] = [];
  const droppedInputs: string[] = [];
  for (const candidate of candidates) {
    const slug = slugByCandidate.get(candidate);
    if (!slug) {
      droppedInputs.push(candidate);
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return { slugs, droppedInputs };
}

async function canManageOrganization(
  session: Parameters<typeof requireResourcePermission>[0],
): Promise<boolean> {
  try {
    await requireResourcePermission(session, {
      type: "organization",
      id: caipeOrgKey(),
      action: "manage",
    });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Reserved agent slugs that cannot be used as agent IDs.
 * These are LangGraph/deepagents internal names that would
 * conflict with namespace routing.
 *
 * Ported from DA mongo.py — DA no longer does slug checks
 * after CRUD migration.
 */
const RESERVED_AGENT_SLUGS = new Set([
  // LangGraph internal node names
  "__start__",
  "__end__",
  "__interrupt__",
  "__checkpoint__",
  "__error__",
  "start",
  "end",
  // LangGraph react agent node names
  "agent",
  "tools",
  "call-model",
  // DeepAgents built-in
  "general-purpose",
  "task",
]);

/**
 * Convert agent name to URL-safe slug.
 *
 * Examples:
 *   'My Test Agent' → 'my-test-agent'
 *   'RAG Helper!!!' → 'rag-helper'
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Mutable fields allowed in agent create/update requests. */
const AGENT_MUTABLE_FIELDS = [
  "name",
  "description",
  "system_prompt",
  "allowed_tools",
  "builtin_tools",
  "model",
  "visibility",
  "shared_with_teams",
  "subagents",
  "skills",
  "datasource_ids",
  "rag_collection_ids",
  "ui",
  "features",
  "interrupt_on",
  "enabled",
  "last_review",
] as const;

/**
 * Normalize a MongoDB agent document to the current schema.
 * Migrates legacy model_id/model_provider to model object.
 */
function normalizeAgentDoc(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  // Migrate legacy model_id/model_provider → model
  if (doc.model_id && !doc.model) {
    doc.model = { id: doc.model_id, provider: doc.model_provider || "unknown" };
    delete doc.model_id;
    delete doc.model_provider;
  }
  // A configured knowledge hand is always represented by two arrays. Older
  // rows could store the unselected half as null, which the editor must not
  // send back as an invalid value.
  if (
    Array.isArray(doc.datasource_ids) ||
    Array.isArray(doc.rag_collection_ids)
  ) {
    if (!Array.isArray(doc.datasource_ids)) doc.datasource_ids = [];
    if (!Array.isArray(doc.rag_collection_ids)) doc.rag_collection_ids = [];
  }
  return doc;
}

/**
 * Pick only allowed mutable fields from body, filtering out
 * undefined values. Prevents injection of server-controlled
 * fields like is_system, config_driven, owner_id.
 */
function pickMutableFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of AGENT_MUTABLE_FIELDS) {
    if (body[field] !== undefined) {
      result[field] = body[field];
    }
  }
  return result;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasRagToolAccess(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = (value as Record<string, unknown>)["knowledge-base"];
  return selection !== undefined && selection !== false;
}

async function platformRagDefaultIfAvailable(
  session: ResourceAuthzSession,
): Promise<string[] | undefined> {
  const collections = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const platform = await collections.findOne(
    { _id: PLATFORM_RAG_COLLECTION_ID } as never,
    { projection: { _id: 1 } },
  );
  if (!platform) return undefined;
  const readable = await filterResourcesByPermission(
    session,
    [{ id: PLATFORM_RAG_COLLECTION_ID }],
    { type: "rag_collection", action: "read", id: (row) => row.id },
    { bypassForOrgAdmin: true },
  );
  // Once Platform RAG exists, a new agent must never fall back to the legacy
  // unrestricted behavior. Callers without Platform readership start with an
  // explicit empty hand and can add collections/sources they are allowed to use.
  return readable.length > 0 ? [PLATFORM_RAG_COLLECTION_ID] : [];
}

function normalizeDatasourceIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(
      "datasource_ids must be an array of datasource ids",
      400,
      "INVALID_DATASOURCE_IDS",
    );
  }
  if (value.length > 200) {
    throw new ApiError(
      "An agent cannot select more than 200 datasources",
      400,
      "TOO_MANY_DATASOURCES",
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = normalizeString(item);
    if (!id || !OPENFGA_RESOURCE_ID_PATTERN.test(id)) {
      throw new ApiError(
        "datasource_ids must contain only valid datasource ids",
        400,
        "INVALID_DATASOURCE_IDS",
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  // Preserve an explicit [] as "this agent has no RAG sources". Undefined
  // is reserved for legacy agents with no agent-level datasource restriction.
  return ids;
}

function normalizeRagCollectionIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(
      "rag_collection_ids must be an array of knowledge base ids",
      400,
      "INVALID_RAG_COLLECTION_IDS",
    );
  }
  if (value.length > 50) {
    throw new ApiError(
      "An agent cannot select more than 50 knowledge bases",
      400,
      "TOO_MANY_RAG_COLLECTIONS",
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = normalizeString(item);
    if (!id || !RAG_COLLECTION_ID_PATTERN.test(id)) {
      throw new ApiError(
        "rag_collection_ids must contain only valid knowledge base ids",
        400,
        "INVALID_RAG_COLLECTION_IDS",
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

async function validateDatasourceSelection(
  datasourceIds: string[] | undefined,
  ownerTeamSlug: string | null,
  session: ResourceAuthzSession,
): Promise<void> {
  if (!datasourceIds?.length) return;
  const teamGranted = ownerTeamSlug
    ? new Set((await listTeamKbGrants(ownerTeamSlug)).kbIds)
    : new Set<string>();
  const needsCallerGrant = datasourceIds.filter((id) => !teamGranted.has(id));
  const callerGrantedRows = await filterResourcesByPermission(
    session,
    needsCallerGrant.map((id) => ({ id })),
    { type: "data_source", action: "read", id: (row) => row.id },
    { bypassForOrgAdmin: true },
  );
  const callerGranted = new Set(callerGrantedRows.map((row) => row.id));
  const denied = needsCallerGrant.filter((id) => !callerGranted.has(id));
  if (denied.length > 0) {
    throw new ApiError(
      `Neither you nor the Owner team has Search access to: ${denied.join(", ")}`,
      403,
      "DATASOURCE_NOT_ACCESSIBLE",
    );
  }
}

async function validateRagCollectionSelection(
  collectionIds: string[] | undefined,
  session: ResourceAuthzSession,
): Promise<void> {
  if (!collectionIds?.length) return;
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const existing = await collection
    .find({ _id: { $in: collectionIds } } as never)
    .project({ _id: 1 })
    .toArray();
  const existingIds = new Set(existing.map((row) => row._id));
  const missing = collectionIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      `These knowledge bases do not exist: ${missing.join(", ")}`,
      400,
      "RAG_COLLECTION_NOT_FOUND",
    );
  }
  const readable = await filterResourcesByPermission(
    session,
    collectionIds.map((id) => ({ id })),
    { type: "rag_collection", action: "read", id: (row) => row.id },
    { bypassForOrgAdmin: true },
  );
  const readableIds = new Set(readable.map((row) => row.id));
  const denied = collectionIds.filter((id) => !readableIds.has(id));
  if (denied.length > 0) {
    throw new ApiError(
      `You do not have access to these knowledge bases: ${denied.join(", ")}`,
      403,
      "RAG_COLLECTION_NOT_ACCESSIBLE",
    );
  }
}

function requireStableSubject(session: { sub?: unknown }): string {
  const subject = normalizeString(session.sub);
  if (!subject) {
    throw new ApiError(
      "A stable user subject is required for dynamic agent ownership.",
      401,
      "NO_SUBJECT",
    );
  }
  return subject;
}

function teamIdString(team: TeamOwnershipDoc): string | undefined {
  if (team._id instanceof ObjectId) return team._id.toHexString();
  return normalizeString(team._id);
}

async function loadOwnerTeam(ownerTeam: {
  slug?: string | null;
  id?: string | null;
}): Promise<TeamOwnershipDoc | null> {
  const teams = await getCollection<TeamOwnershipDoc>("teams");
  const filters: Record<string, unknown>[] = [];
  if (ownerTeam.slug) filters.push({ slug: ownerTeam.slug });
  if (ownerTeam.id) {
    filters.push({ _id: ownerTeam.id });
    if (ObjectId.isValid(ownerTeam.id))
      filters.push({ _id: new ObjectId(ownerTeam.id) });
  }
  if (filters.length === 0) return null;
  return teams.findOne(filters.length === 1 ? filters[0] : { $or: filters });
}

async function canUseOwnerTeam(
  session: Parameters<typeof requireResourcePermission>[0],
  ownerTeam: TeamOwnershipDoc,
): Promise<boolean> {
  const ownerTeamSlug = normalizeString(ownerTeam.slug);
  if (!ownerTeamSlug) return false;
  return canUseTeamSlug(session, ownerTeamSlug);
}

async function canUseTeamSlug(
  session: Parameters<typeof requireResourcePermission>[0],
  teamSlug: string,
): Promise<boolean> {
  try {
    await requireResourcePermission(session, {
      type: "team",
      id: teamSlug,
      action: "use",
    });
    return true;
  } catch {
    // assisted-by Codex Codex-sonnet-4-6
    // Team admins/owners may be represented only by the manage relation in
    // older projections; they still count as members for owner-team selection.
    try {
      await requireResourcePermission(session, {
        type: "team",
        id: teamSlug,
        action: "manage",
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function requireAgentWritePermission(
  session: Parameters<typeof requireAgentPermission>[0],
  agentId: string,
): Promise<void> {
  await requireAgentPermission(session, agentId, "write");
}

/**
 * Validate that subagents have compatible visibility with parent.
 *
 * Rules:
 * - Private agent → can use private, team, or global subagents
 * - Team agent → can use team or global subagents
 * - Global agent → can only use global subagents
 */
async function validateSubagentVisibility(
  parentVisibility: VisibilityType,
  subagents: SubAgentRef[],
  collection: Collection<DynamicAgentConfig>,
): Promise<{ valid: boolean; error?: string }> {
  if (!subagents || subagents.length === 0) return { valid: true };

  for (const ref of subagents) {
    const sub = await collection.findOne({ _id: ref.agent_id });
    if (!sub) {
      return {
        valid: false,
        error: `Subagent "${ref.agent_id}" not found`,
      };
    }

    // Sub agents read from the DB may still carry the legacy "private" visibility
    // until the migration script rewrites them. Treat any non team/global value as
    // private for the purpose of these checks.
    const subVis = sub.visibility as LegacyVisibilityType;

    // Global parent → only global subagents
    if (parentVisibility === "global" && subVis !== "global") {
      return {
        valid: false,
        error: `Global agents can only use global subagents. "${sub.name}" is ${subVis}.`,
      };
    }
    // Team parent → team or global subagents only
    if (
      parentVisibility === "team" &&
      subVis !== "team" &&
      subVis !== "global"
    ) {
      return {
        valid: false,
        error: `Team agents can only use team or global subagents. "${sub.name}" is ${subVis}.`,
      };
    }
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════
// GET — list agents
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/dynamic-agents
 * List dynamic agents visible to the current user.
 *
 * Query params:
 * - enabled_only=true: Only return enabled agents (useful for subagent selection)
 * - search=<string>: Filter agents by name or description (case-insensitive)
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

  const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);
  const { page, pageSize, skip } = getPaginationParams(request);
  const { searchParams } = new URL(request.url);
  const enabledOnly = searchParams.get("enabled_only") === "true";
  const search = searchParams.get("search")?.trim() || "";

  const query: Record<string, unknown> = enabledOnly
    ? { $or: [{ enabled: true }, { enabled: { $exists: false } }] }
    : {};

  if (search) {
    const regex = { $regex: search, $options: "i" };
    const orClauses: Record<string, unknown>[] = [
      { name: regex },
      { description: regex },
    ];
    if (ObjectId.isValid(search)) orClauses.push({ _id: new ObjectId(search) });
    const searchClause = { $or: orClauses };
    if (query.$or) {
      query.$and = [{ $or: query.$or }, searchClause];
      delete query.$or;
    } else {
      Object.assign(query, searchClause);
    }
  }

  const allItems = await collection
    .find(query)
    .sort({ created_at: -1 })
    .toArray();

  // Normalize legacy documents
  const normalizedItems = allItems.map((item) =>
    normalizeAgentDoc(item as unknown as Record<string, unknown>),
  ) as unknown as DynamicAgentConfig[];
  const platformDefaultAgentId = await getPlatformDefaultAgentId();
  const scopedItems = await filterAgentsByOwnershipScopeForSession(
    session,
    normalizedItems,
    platformDefaultAgentId,
  );
  const listTarget = {
    type: "agent" as const,
    action: enabledOnly ? ("use" as const) : ("discover" as const),
    id: (agent: DynamicAgentConfig) => String(agent._id),
  };
  const visibleItems = await filterResourcesByPermission(
    session,
    scopedItems,
    listTarget,
  );
  const pageItems = visibleItems.slice(skip, skip + pageSize);
  const { rows } = await resolveAgentListPermissions(
    session,
    pageItems.map((agent) => String(agent._id)),
  );

  const items: DynamicAgentConfigWithPermissions[] = pageItems.map((agent) => ({
    ...(agent as DynamicAgentConfig),
    permissions: agentRowPermissionsOrDefault(rows, String(agent._id)),
  }));

  return paginatedResponse(items, visibleItems.length, page, pageSize);
});

// ═══════════════════════════════════════════════════════════════
// POST — create agent
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/dynamic-agents
 * Create a new dynamic agent configuration.
 * Requires admin role.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);

  const body = await request.json();

  if (!body.name || typeof body.name !== "string") {
    throw new ApiError("Agent name is required", 400);
  }
  if (!body.system_prompt || typeof body.system_prompt !== "string") {
    throw new ApiError("System prompt is required", 400);
  }
  // Normalize legacy model_id/model_provider to model object
  if (body.model_id && !body.model) {
    body.model = {
      id: body.model_id,
      provider: body.model_provider || "unknown",
    };
    delete body.model_id;
    delete body.model_provider;
  }
  if (!body.model?.id || typeof body.model.id !== "string") {
    throw new ApiError("Model ID is required (model.id)", 400);
  }
  if (!body.model?.provider || typeof body.model.provider !== "string") {
    throw new ApiError("Model provider is required (model.provider)", 400);
  }
  const requestedOwnerTeamSlug = normalizeString(body.owner_team_slug);
  const requestedOwnerTeamId = normalizeString(body.owner_team_id);
  // Coerce any legacy 'private' on the wire to 'team' (private visibility was
  // retired 2026-05-22; see refactor commit 096a8b159). New agents without an
  // explicit visibility default to 'team' so they always have an owner team.
  const rawVisibility = body.visibility as LegacyVisibilityType | undefined;
  const visibility: VisibilityType =
    rawVisibility === "global" ? "global" : "team";
  let ownerTeam: TeamOwnershipDoc | null = null;
  let ownerTeamSlug: string | null = null;
  if (visibility === "global") {
    const canManageAllAgents = await canManageOrganization(session);
    if (!canManageAllAgents) {
      throw new ApiError(
        "Only platform admins can create global agents",
        403,
        "GLOBAL_AGENT_FORBIDDEN",
      );
    }
  }
  if (requestedOwnerTeamSlug || requestedOwnerTeamId || visibility === "team") {
    if (!requestedOwnerTeamSlug && !requestedOwnerTeamId) {
      throw new ApiError(
        "Owner team is required for team agents",
        400,
        "OWNER_TEAM_REQUIRED",
      );
    }
    ownerTeam = await loadOwnerTeam({
      slug: requestedOwnerTeamSlug,
      id: requestedOwnerTeamId,
    });
    if (!ownerTeam) {
      throw new ApiError("Owner team not found", 404, "OWNER_TEAM_NOT_FOUND");
    }
    ownerTeamSlug = normalizeString(ownerTeam.slug);
    if (!ownerTeamSlug) {
      throw new ApiError(
        "Owner team is missing a slug",
        409,
        "OWNER_TEAM_INVALID",
      );
    }
    const canUseTeam = await canUseOwnerTeam(session, ownerTeam);
    if (!canUseTeam) {
      throw new ApiError(
        "You must belong to the owner team to create this agent",
        403,
        "OWNER_TEAM_FORBIDDEN",
      );
    }
  }

  // Generate slug from name with agent- prefix
  const agentId = `agent-${slugify(body.name)}`;
  if (!agentId) {
    throw new ApiError(
      "Agent name must contain at least one alphanumeric character",
      400,
    );
  }

  // Reserved slug check
  if (RESERVED_AGENT_SLUGS.has(agentId) || agentId.startsWith("__")) {
    throw new ApiError(`Agent name "${body.name}" is reserved`, 409);
  }

  const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);

  // Uniqueness check
  const existing = await collection.findOne({ _id: agentId });
  if (existing) {
    throw new ApiError(`Agent with ID "${agentId}" already exists`, 409);
  }

  // Subagent visibility validation
  const subagents: SubAgentRef[] = body.subagents ?? [];
  if (subagents.length > 0) {
    const result = await validateSubagentVisibility(
      visibility,
      subagents,
      collection,
    );
    if (!result.valid) {
      throw new ApiError(result.error!, 400);
    }
  }

  // Resolve `shared_with_teams` (which historically held Mongo `_id`
  // values from the editor) into canonical slugs so (a) the OpenFGA
  // tuples we write below match the global subject naming convention
  // (`team:<slug>#member`) and (b) the stored Mongo field is
  // self-consistent for any future read path. Owner-team slug is
  // dropped from the shared list because the reconciler already writes
  // the owner-team tuples — keeping it duplicated in
  // `shared_with_teams` would surface confusingly in the UI and is
  // semantically a no-op for OpenFGA (deduped at write time).
  const { slugs: rawSharedTeamSlugs, droppedInputs: droppedSharedInputs } =
    await resolveSharedTeamSlugs(body.shared_with_teams);
  const sharedTeamSlugs = ownerTeamSlug
    ? rawSharedTeamSlugs.filter((slug) => slug !== ownerTeamSlug)
    : rawSharedTeamSlugs;
  if (droppedSharedInputs.length > 0) {
    console.warn(
      "[dynamic-agents] POST dropped unresolved shared_with_teams entries (no such team)",
      { agent: body.name, dropped: droppedSharedInputs },
    );
  }

  const hasDatasourceSelection = Object.prototype.hasOwnProperty.call(
    body,
    "datasource_ids",
  );
  const hasCollectionSelection = Object.prototype.hasOwnProperty.call(
    body,
    "rag_collection_ids",
  );
  let datasourceIds = normalizeDatasourceIds(body.datasource_ids);
  let ragCollectionIds = normalizeRagCollectionIds(body.rag_collection_ids);
  // Platform RAG is the default hand for newly-created RAG-enabled agents,
  // but only after migration has created it. Explicit [] on either field is
  // a deliberate opt-out and must never be replaced with the default.
  if (
    hasRagToolAccess(body.allowed_tools) &&
    !hasDatasourceSelection &&
    !hasCollectionSelection
  ) {
    const platformDefault = await platformRagDefaultIfAvailable(session);
    if (platformDefault !== undefined) {
      datasourceIds = [];
      ragCollectionIds = platformDefault;
    }
  }
  if (datasourceIds !== undefined || ragCollectionIds !== undefined) {
    datasourceIds ??= [];
    ragCollectionIds ??= [];
  }
  await validateDatasourceSelection(datasourceIds, ownerTeamSlug, session);
  await validateRagCollectionSelection(ragCollectionIds, session);

  // Build document with explicit field allowlist (Security VII)
  const ownerSubject = requireStableSubject(session);
  const now = new Date();
  const doc: DynamicAgentConfig = {
    _id: agentId,
    name: body.name as string,
    description: (body.description as string) ?? "",
    system_prompt: body.system_prompt as string,
    allowed_tools:
      (body.allowed_tools as Record<string, string[] | boolean>) ?? {},
    builtin_tools: body.builtin_tools ?? undefined,
    model: body.model as DynamicAgentConfig["model"],
    visibility,
    shared_with_teams: sharedTeamSlugs,
    owner_team_slug: ownerTeamSlug ?? undefined,
    owner_team_id: ownerTeam ? teamIdString(ownerTeam) : undefined,
    subagents,
    skills: (body.skills as string[]) ?? [],
    datasource_ids: datasourceIds,
    rag_collection_ids: ragCollectionIds,
    ui: body.ui as DynamicAgentConfig["ui"],
    features: body.features as DynamicAgentConfig["features"],
    interrupt_on: body.interrupt_on as DynamicAgentConfig["interrupt_on"],
    enabled: (body.enabled as boolean) ?? true,
    // Carry the AI Review verdict from the create payload so a blocking
    // review run during agent creation surfaces a grade in the list view.
    ...(body.last_review !== undefined
      ? { last_review: body.last_review as DynamicAgentConfig["last_review"] }
      : {}),
    // Server-controlled fields — never from request body
    owner_id: user.email,
    owner_subject: ownerSubject,
    is_system: false,
    config_driven: false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  // Only resolve the unlinked SA sub when it is needed. Global agents are
  // available to callers without a linked user identity (Slack/Webex bots),
  // while team agents continue to rely on explicit scopes.
  const unlinkedServiceAccountSub =
    visibility === "global" ? await resolveUnlinkedServiceAccountSub() : null;

  await reconcileAgentRelationships({
    agentId,
    previousAllowedTools: {},
    nextAllowedTools: doc.allowed_tools,
    ownerSubject: doc.owner_subject,
    organizationId: caipeOrgKey(),
    ownerTeamSlug,
    nextSharedTeamSlugs: sharedTeamSlugs,
    previousSharedTeamSlugs: [],
    // Encode `visibility === 'global'` as the wildcard `user:* user
    // agent:<id>` grant so a freshly-created global agent is usable by
    // every member without waiting for the list-time repair in
    // available/route.ts. Fresh create has no previous state to revoke.
    globalUserAccess: visibility === "global",
    unlinkedServiceAccountSub,
  });

  try {
    await collection.insertOne(doc);
  } catch (error) {
    await deleteAllAgentToolTuples(agentId).catch((cleanupError) => {
      console.warn(
        "[dynamic-agents] failed to clean up OpenFGA tuples after create failure:",
        cleanupError,
      );
    });
    throw error;
  }

  return successResponse(doc, 201);
});

// ═══════════════════════════════════════════════════════════════
// PUT — update agent
// ═══════════════════════════════════════════════════════════════

/**
 * PUT /api/dynamic-agents?id=<agent_id>
 * Update a dynamic agent configuration.
 * Requires admin role. Config-driven agents cannot be modified.
 */
export const PUT = withErrorHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    throw new ApiError("Agent ID is required", 400);
  }

  const { session } = await getAuthFromBearerOrSession(request);

  const body = await request.json();
  const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);

  // Verify agent exists
  const agent = await collection.findOne({ _id: id });
  if (!agent) {
    throw new ApiError("Agent not found", 404);
  }
  await requireAgentWritePermission(session, id);

  // Config-driven guard
  if (agent.config_driven) {
    throw new ApiError(
      "Config-driven agents cannot be modified. Update config.yaml instead.",
      403,
    );
  }

  // Build update with explicit field allowlist
  const updateData = pickMutableFields(body);
  const datasourceSelectionChanged = Object.prototype.hasOwnProperty.call(
    body,
    "datasource_ids",
  );
  const requestedDatasourceIds = datasourceSelectionChanged
    ? normalizeDatasourceIds(body.datasource_ids)
    : undefined;
  if (datasourceSelectionChanged) {
    updateData.datasource_ids = requestedDatasourceIds ?? [];
  }
  const collectionSelectionChanged = Object.prototype.hasOwnProperty.call(
    body,
    "rag_collection_ids",
  );
  const requestedCollectionIds = collectionSelectionChanged
    ? normalizeRagCollectionIds(body.rag_collection_ids)
    : undefined;
  if (collectionSelectionChanged) {
    updateData.rag_collection_ids = requestedCollectionIds ?? [];
  }
  // An ownership transfer changes owner_team_slug, which is intentionally NOT
  // in the mutable-field allowlist (owner is immutable on a normal edit).
  // Detect it here so a transfer-only request isn't dropped by the
  // "no fields to update" short-circuit below.
  const isTransferRequest =
    normalizeString(body.owner_team_slug) !== null &&
    normalizeString(body.owner_team_slug) !==
      normalizeString(agent.owner_team_slug);
  if (Object.keys(updateData).length === 0 && !isTransferRequest) {
    // No fields to update — return current state
    return successResponse(agent);
  }

  // Subagent visibility validation (using merged final values)
  const finalVisibility = (updateData.visibility ??
    agent.visibility) as VisibilityType;
  const finalSubagents = (updateData.subagents ??
    agent.subagents ??
    []) as SubAgentRef[];

  // Platform-default invariant: an agent can't be demoted from `global`
  // → `team` while it's the configured platform default — that would
  // silently strip the wildcard `user:*` grant new users rely on.
  // Force the admin to change the platform default in Admin → Settings
  // first. We only block the demote case; promoting team → global is
  // always fine.
  const currentVisibility = agent.visibility as
    | VisibilityType
    | "private"
    | undefined;
  const isDemoteToTeam =
    finalVisibility === "team" && currentVisibility === "global";
  if (isDemoteToTeam && (await isPlatformDefaultAgent(id))) {
    throw new ApiError(
      PLATFORM_DEFAULT_VISIBILITY_ERROR,
      409,
      "AGENT_IS_PLATFORM_DEFAULT",
    );
  }

  if (finalSubagents.length > 0) {
    const result = await validateSubagentVisibility(
      finalVisibility,
      finalSubagents,
      collection,
    );
    if (!result.valid) {
      throw new ApiError(result.error!, 400);
    }
  }

  // Resolve `shared_with_teams` on update so the OpenFGA reconciler
  // sees a slug-only set in both `previousSharedTeamSlugs` (from the
  // existing doc) and `nextSharedTeamSlugs` (from the request). If the
  // caller did not include `shared_with_teams` in the patch, keep the
  // existing value unchanged (do NOT clear it — that would silently
  // revoke team grants on every metadata-only update).
  const previousSharedRaw = Array.isArray(agent.shared_with_teams)
    ? (agent.shared_with_teams as string[])
    : [];
  const { slugs: previousSharedTeamSlugs } =
    await resolveSharedTeamSlugs(previousSharedRaw);

  let sharedTeamSlugs = previousSharedTeamSlugs;
  if (Object.prototype.hasOwnProperty.call(updateData, "shared_with_teams")) {
    const { slugs: nextRaw, droppedInputs: droppedSharedInputs } =
      await resolveSharedTeamSlugs(updateData.shared_with_teams);
    const ownerSlugForFilter = normalizeString(agent.owner_team_slug);
    sharedTeamSlugs = ownerSlugForFilter
      ? nextRaw.filter((slug) => slug !== ownerSlugForFilter)
      : nextRaw;
    if (droppedSharedInputs.length > 0) {
      console.warn(
        "[dynamic-agents] PUT dropped unresolved shared_with_teams entries (no such team)",
        { agent: id, dropped: droppedSharedInputs },
      );
    }
    // Persist the canonical slug form so subsequent reads from the
    // editor render the same identifiers we wrote to OpenFGA.
    updateData.shared_with_teams = sharedTeamSlugs;
  }

  updateData.updated_at = new Date().toISOString();

  // Ownership transfer (spec 2026-06-03, US3): owner_team_slug is immutable
  // on a normal edit, but the editor can transfer it to another team. The
  // transfer DECISION (guard: owner-team admin or org admin; not-a-member
  // confirmation; previous-owner revoke) is the single shared path used by
  // the RAG datasource + MCP tool routes too — see
  // `resolveShareableOwnershipWrite`. The agent persists to Mongo and writes
  // its own org-admin/tool-caller tuples via `reconcileAgentRelationships`,
  // so we use the resolver for the decision only and apply persistence here.
  const previousOwnerTeamSlug = normalizeString(agent.owner_team_slug);
  const resolvedOwnership = await resolveShareableOwnershipWrite(
    {
      objectType: "agent",
      objectId: id,
      session: { sub: session.sub, role: session.role, user: session.user },
      requestedOwnerTeamSlug: normalizeString(body.owner_team_slug),
      requestedSharedTeamSlugs: sharedTeamSlugs,
      confirmedNotMember: body.confirm_not_member === true,
      loadPrevious: async () => ({
        ownerTeamSlug: previousOwnerTeamSlug,
        sharedTeamSlugs: previousSharedTeamSlugs,
        creatorSubject: normalizeString(agent.owner_subject),
      }),
      persist: async () => {},
      canUseOwnerTeam: async (slug) => {
        const team = await loadOwnerTeam({ slug });
        return team ? canUseOwnerTeam(session, team) : false;
      },
    },
    {
      ownerTeamSlug: previousOwnerTeamSlug,
      sharedTeamSlugs: previousSharedTeamSlugs,
      creatorSubject: normalizeString(agent.owner_subject),
    },
  );
  const nextOwnerTeamSlug = resolvedOwnership.ownerTeamSlug;
  const transferPreviousOwner = resolvedOwnership.transferred
    ? (resolvedOwnership.previousOwnerTeamSlug ?? undefined)
    : undefined;
  if (resolvedOwnership.transferred) {
    const destinationTeam = await loadOwnerTeam({ slug: nextOwnerTeamSlug! });
    if (!destinationTeam) {
      throw new ApiError(
        "Destination team not found",
        404,
        "OWNER_TEAM_NOT_FOUND",
      );
    }
    updateData.owner_team_slug = nextOwnerTeamSlug ?? undefined;
    updateData.owner_team_id = teamIdString(destinationTeam) ?? undefined;
  }

  let finalDatasourceIds = datasourceSelectionChanged
    ? requestedDatasourceIds
    : agent.datasource_ids == null
      ? undefined
      : normalizeDatasourceIds(agent.datasource_ids);
  let finalCollectionIds = collectionSelectionChanged
    ? requestedCollectionIds
    : agent.rag_collection_ids == null
      ? undefined
      : normalizeRagCollectionIds(agent.rag_collection_ids);
  const finalAllowedTools = (updateData.allowed_tools ??
    agent.allowed_tools ??
    {}) as Record<string, string[] | boolean>;
  let appliedPlatformDefault = false;
  if (
    !datasourceSelectionChanged &&
    !collectionSelectionChanged &&
    finalDatasourceIds === undefined &&
    finalCollectionIds === undefined &&
    hasRagToolAccess(finalAllowedTools)
  ) {
    const platformDefault = await platformRagDefaultIfAvailable(session);
    if (platformDefault !== undefined) {
      finalDatasourceIds = [];
      finalCollectionIds = platformDefault;
      updateData.datasource_ids = [];
      updateData.rag_collection_ids = platformDefault;
      appliedPlatformDefault = true;
    }
  }
  if (datasourceSelectionChanged || collectionSelectionChanged) {
    finalDatasourceIds ??= [];
    finalCollectionIds ??= [];
    updateData.datasource_ids = finalDatasourceIds;
    updateData.rag_collection_ids = finalCollectionIds;
  }
  if (
    datasourceSelectionChanged ||
    resolvedOwnership.transferred ||
    appliedPlatformDefault
  ) {
    await validateDatasourceSelection(
      finalDatasourceIds,
      nextOwnerTeamSlug,
      session,
    );
  }
  if (
    collectionSelectionChanged ||
    resolvedOwnership.transferred ||
    appliedPlatformDefault
  ) {
    await validateRagCollectionSelection(finalCollectionIds, session);
  }

  // Resolve the unlinked SA grant state whenever the Everyone grant is being
  // added or removed. On a global → team transition, preserve a separately
  // assigned explicit service-account scope.
  const { sub: unlinkedServiceAccountSub, explicitAgentIds } =
    finalVisibility === "global" || currentVisibility === "global"
      ? await resolveUnlinkedServiceAccountGrantState()
      : { sub: null, explicitAgentIds: new Set<string>() };

  await reconcileAgentRelationships({
    agentId: id,
    previousAllowedTools: allowedToolsFromAgent(agent),
    nextAllowedTools: finalAllowedTools,
    ownerSubject: agent.owner_subject ?? agent.owner_id,
    organizationId: caipeOrgKey(),
    ownerTeamSlug: nextOwnerTeamSlug,
    previousOwnerTeamSlug: transferPreviousOwner,
    nextSharedTeamSlugs: sharedTeamSlugs,
    previousSharedTeamSlugs,
    // Keep the wildcard `user:* user agent:<id>` grant in sync with
    // visibility on every edit. Without this a `global → team` demote
    // would update Mongo but leave the everyone-can-use grant behind,
    // so non-owner-team members keep `can_use` (the SRE-agent leak).
    // `currentVisibility` may be the legacy 'private' value on old docs;
    // only an exact 'global' match counts as a previous wildcard grant.
    globalUserAccess: finalVisibility === "global",
    previousGlobalUserAccess: currentVisibility === "global",
    unlinkedServiceAccountSub,
    unlinkedGrantIsExplicit: explicitAgentIds.has(id),
  });

  const updated = await collection.findOneAndUpdate(
    { _id: id },
    { $set: updateData },
    { returnDocument: "after" },
  );

  if (!updated) {
    throw new ApiError("Failed to update agent", 500);
  }

  return successResponse(
    normalizeAgentDoc(updated as unknown as Record<string, unknown>),
  );
});

// ═══════════════════════════════════════════════════════════════
// DELETE — delete agent
// ═══════════════════════════════════════════════════════════════

/**
 * DELETE /api/dynamic-agents?id=<agent_id>
 * Delete a dynamic agent configuration.
 * Requires admin role. System and config-driven agents cannot be deleted.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    throw new ApiError("Agent ID is required", 400);
  }

  const { session } = await getAuthFromBearerOrSession(request);
  await requireAgentPermission(session, id, "delete");

  const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);

  // Verify agent exists
  const agent = await collection.findOne({ _id: id });
  if (!agent) {
    throw new ApiError("Agent not found", 404);
  }

  // System agent guard
  if (agent.is_system) {
    throw new ApiError("System agents cannot be deleted", 400);
  }

  // Config-driven guard
  if (agent.config_driven) {
    throw new ApiError(
      "Config-driven agents cannot be deleted. Remove from config.yaml instead.",
      403,
    );
  }

  // Platform-default invariant: deleting the currently configured
  // default would yank the public `user:*` grant new users rely on
  // and leave Admin → Settings pointing at a tombstone. Force the
  // admin to clear/change the platform default first.
  if (await isPlatformDefaultAgent(id)) {
    throw new ApiError(
      PLATFORM_DEFAULT_DELETE_ERROR,
      409,
      "AGENT_IS_PLATFORM_DEFAULT",
    );
  }

  // Autonomous tasks are owned by a separate service (autonomous-agents)
  // keyed on this agent's id. Cascade-delete them BEFORE removing the
  // agent doc / OpenFGA tuples, and abort on failure: agent ids are
  // deterministic slugs of the name, so an orphaned task left behind here
  // would silently reappear (and start firing again) under any future
  // agent recreated with the same name. Fail-closed keeps the whole
  // operation safely retryable — nothing below has run yet.
  try {
    await cascadeDeleteAutonomousTasksForAgent(id);
  } catch (err) {
    console.warn("[dynamic-agents] autonomous-task cascade delete failed:", err);
    throw new ApiError(
      "Failed to remove autonomous tasks for this agent. Deletion aborted; retry once the autonomous-agents service is reachable.",
      502,
      "AUTONOMOUS_TASK_CASCADE_FAILED",
    );
  }

  await deleteAllAgentToolTuples(id);
  await collection.deleteOne({ _id: id });

  return successResponse({ deleted: id });
});

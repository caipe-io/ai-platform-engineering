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
import { dynamicAgentForBrowser,dynamicAgentsForBrowser } from "@/lib/dynamic-agent-response";
import { trustedInteractionFromRequest } from "@/lib/authz/trusted-interaction";
import {
  authzRevisionFilter,
  AuthzSyncSupersededError,
  hasActiveAuthzSync,
  nextAuthzRevision,
  runRevisionedAuthzSync,
} from "@/lib/authz/resource-sync";
import { isPrivateResourcesEnabled } from "@/lib/feature-flags/private-resources";
import {
allowedToolsFromAgent,
deleteAllAgentToolTuples,
reconcileAgentRelationships,
} from "@/lib/rbac/openfga-agent-tools";
import {
filterAgentsByOwnershipScopeForSession,
isPrivateAgentOwner,
} from "@/lib/rbac/agent-ownership-scope";
import { validatePersistedAgentMcpDependencies } from "@/lib/rbac/agent-mcp-dependency-scope";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { getPlatformDefaultAgentId,isPlatformDefaultAgent } from "@/lib/rbac/platform-default";
import {
filterResourcesByPermission,
requireAgentPermission,
requireResourcePermission,
agentRowPermissionsOrDefault,
resolveAgentListPermissions,
} from "@/lib/rbac/resource-authz";
import { resolveShareableOwnershipWrite } from "@/lib/rbac/shareable-resource";
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
import { Collection,ObjectId,type UpdateFilter } from "mongodb";
import { NextRequest } from "next/server";

const PLATFORM_DEFAULT_VISIBILITY_ERROR =
  "This agent is currently the platform default for new chats. Open Settings → Platform settings → Defaults and change the platform default before changing this agent's visibility.";
const PLATFORM_DEFAULT_DELETE_ERROR =
  "This agent is currently the platform default for new chats. Open Settings → Platform settings → Defaults and change the platform default before deleting this agent.";

const COLLECTION_NAME = "dynamic_agents";

type AgentSortField = "name" | "visibility" | "tools" | "grade" | "status";
type SortDirection = "asc" | "desc";

const AGENT_SORT_FIELDS = new Set<AgentSortField>([
  "name",
  "visibility",
  "tools",
  "grade",
  "status",
]);

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function sameAllowedTools(
  left: Record<string, string[] | boolean>,
  right: Record<string, string[] | boolean>,
): boolean {
  const normalize = (value: Record<string, string[] | boolean>) => Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, tools]) => [key, Array.isArray(tools) ? [...tools].sort() : tools]),
  );
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function previousAgentAuthzState(agent: DynamicAgentConfig): DynamicAgentConfig {
  const previous = agent.authz_previous_state;
  return previous && typeof previous === "object" && !Array.isArray(previous)
    ? { ...agent, ...previous, authz_previous_state: undefined }
    : agent;
}

function agentAuthzSnapshot(agent: DynamicAgentConfig): Record<string, unknown> {
  return {
    visibility: agent.visibility,
    allowed_tools: agent.allowed_tools ?? {},
    owner_subject: agent.owner_subject,
    owner_id: agent.owner_id,
    creator_subject: agent.creator_subject,
    owner_team_slug: agent.owner_team_slug,
    owner_team_id: agent.owner_team_id,
    shared_with_teams: agent.shared_with_teams ?? [],
  };
}

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
  session: Parameters<typeof requireResourcePermission>[0]
): Promise<boolean> {
  try {
    await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
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
function normalizeAgentDoc(doc: Record<string, unknown>): Record<string, unknown> {
  // Migrate legacy model_id/model_provider → model
  if (doc.model_id && !doc.model) {
    doc.model = { id: doc.model_id, provider: doc.model_provider || "unknown" };
    delete doc.model_id;
    delete doc.model_provider;
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

function agentToolCount(agent: DynamicAgentConfig): number {
  return Object.keys(agent.allowed_tools ?? {}).length;
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
  direction: SortDirection,
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return (left - right) * (direction === "asc" ? 1 : -1);
}

function sortAgents(
  agents: DynamicAgentConfig[],
  field: AgentSortField,
  direction: SortDirection,
  pinnedAgentId: string | null,
): DynamicAgentConfig[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...agents].sort((left, right) => {
    const leftPinned = pinnedAgentId !== null && String(left._id) === pinnedAgentId;
    const rightPinned = pinnedAgentId !== null && String(right._id) === pinnedAgentId;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

    let comparison = 0;
    switch (field) {
      case "name":
        comparison = left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        break;
      case "visibility":
        comparison = left.visibility.localeCompare(right.visibility);
        break;
      case "tools":
        comparison = agentToolCount(left) - agentToolCount(right);
        break;
      case "grade":
        comparison = compareOptionalNumbers(
          left.last_review?.score,
          right.last_review?.score,
          direction,
        );
        if (comparison !== 0) {
          return comparison;
        }
        break;
      case "status":
        comparison = Number(left.enabled) - Number(right.enabled);
        break;
    }

    if (comparison !== 0) return comparison * multiplier;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function requireStableSubject(session: { sub?: unknown }): string {
  const subject = normalizeString(session.sub);
  if (!subject) {
    throw new ApiError("A stable user subject is required for dynamic agent ownership.", 401, "NO_SUBJECT");
  }
  return subject;
}

function requirePrivateAgentOwner(
  agent: Pick<DynamicAgentConfig, "visibility" | "owner_id" | "owner_subject">,
  session: { sub?: unknown },
): void {
  if (agent.visibility !== "private") return;
  const userSub = normalizeString(session.sub);
  if (!userSub || !isPrivateAgentOwner(agent, userSub)) {
    // Private resources are non-discoverable to non-owners, including org admins.
    throw new ApiError("Agent not found", 404);
  }
}

function teamIdString(team: TeamOwnershipDoc): string | undefined {
  if (team._id instanceof ObjectId) return team._id.toHexString();
  return normalizeString(team._id);
}

async function loadOwnerTeam(ownerTeam: { slug?: string | null; id?: string | null }): Promise<TeamOwnershipDoc | null> {
  const teams = await getCollection<TeamOwnershipDoc>("teams");
  const filters: Record<string, unknown>[] = [];
  if (ownerTeam.slug) filters.push({ slug: ownerTeam.slug });
  if (ownerTeam.id) {
    filters.push({ _id: ownerTeam.id });
    if (ObjectId.isValid(ownerTeam.id)) filters.push({ _id: new ObjectId(ownerTeam.id) });
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
    await requireResourcePermission(session, { type: "team", id: teamSlug, action: "use" });
    return true;
  } catch {
    // assisted-by Codex Codex-sonnet-4-6
    // Team admins/owners may be represented only by the manage relation in
    // older projections; they still count as members for owner-team selection.
    try {
      await requireResourcePermission(session, { type: "team", id: teamSlug, action: "manage" });
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
  parentOwnerSubject?: string | null,
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

    if (
      parentVisibility === "private"
      && (subVis !== "private" || sub.owner_subject !== parentOwnerSubject)
    ) {
      return {
        valid: false,
        error: `Private agents can only use private subagents owned by the same user. "${sub.name}" is not compatible.`,
      };
    }

    // Global parent → only global subagents
    if (parentVisibility === "global" && subVis !== "global") {
      return {
        valid: false,
        error: `Global agents can only use global subagents. "${sub.name}" is ${subVis}.`,
      };
    }
    // Team parent → team or global subagents only
    if (parentVisibility === "team" && subVis !== "team" && subVis !== "global") {
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
 * - sort_by=name|visibility|tools|grade|status: Sort the full visible result set
 * - sort_order=asc|desc: Sort direction (defaults to asc when sort_by is present)
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

    const collection =
      await getCollection<DynamicAgentConfig>(COLLECTION_NAME);
    const { page, pageSize, skip } = getPaginationParams(request);
    const { searchParams } = new URL(request.url);
    const enabledOnly = searchParams.get("enabled_only") === "true";
    const search = searchParams.get("search")?.trim() || "";
    const requestedSortField = searchParams.get("sort_by") as AgentSortField | null;
    const hasValidSortField = Boolean(
      requestedSortField && AGENT_SORT_FIELDS.has(requestedSortField),
    );
    const sortField: AgentSortField = hasValidSortField
      ? requestedSortField as AgentSortField
      : "name";
    const sortDirection: SortDirection = hasValidSortField && searchParams.get("sort_order") === "desc"
      ? "desc"
      : "asc";

    const query: Record<string, unknown> = enabledOnly
      ? { $or: [{ enabled: true }, { enabled: { $exists: false } }] }
      : {};

    if (search) {
      const regex = { $regex: search, $options: "i" };
      const orClauses: Record<string, unknown>[] = [{ name: regex }, { description: regex }];
      if (ObjectId.isValid(search)) orClauses.push({ _id: new ObjectId(search) });
      const searchClause = { $or: orClauses };
      if (query.$or) {
        query.$and = [{ $or: query.$or }, searchClause];
        delete query.$or;
      } else {
        Object.assign(query, searchClause);
      }
    }

    const allItems = await collection.find(query).sort({ created_at: -1 }).toArray();

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
    const permissionOptions = {
      trustedContext: { interaction: trustedInteractionFromRequest(request) },
    };
    const visibleItems = await filterResourcesByPermission(
      session,
      scopedItems,
      listTarget,
      permissionOptions,
    );
    const sortedItems = sortAgents(
      visibleItems,
      sortField,
      sortDirection,
      platformDefaultAgentId,
    );
    const pageItems = sortedItems.slice(skip, skip + pageSize);
    const { rows } = await resolveAgentListPermissions(
      session,
      pageItems.map((agent) => String(agent._id)),
      permissionOptions,
    );
    const browserItems = await dynamicAgentsForBrowser(pageItems);
    const items: DynamicAgentConfigWithPermissions[] = browserItems.map((agent) => ({
      ...agent,
      permissions: agentRowPermissionsOrDefault(rows, String(agent._id)),
    }));

    return paginatedResponse(
      items,
      visibleItems.length,
      page,
      pageSize,
    );
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
      body.model = { id: body.model_id, provider: body.model_provider || "unknown" };
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
    // Preserve explicit private visibility. Clients that omit visibility
    // retain the existing team default.
    const rawVisibility = body.visibility as LegacyVisibilityType | undefined;
    const visibility: VisibilityType = rawVisibility === "private"
      ? "private"
      : rawVisibility === "global" ? "global" : "team";
    if (visibility === "private" && !isPrivateResourcesEnabled()) {
      throw new ApiError("Private agents are not enabled for this deployment", 409, "PRIVATE_RESOURCES_DISABLED");
    }
    if (visibility === "private" && session.isServiceAccount === true) {
      throw new ApiError("Service accounts cannot own private agents", 403, "PRIVATE_OWNER_MUST_BE_USER");
    }
    let ownerTeam: TeamOwnershipDoc | null = null;
    let ownerTeamSlug: string | null = null;
    if (visibility === "global") {
      const canManageAllAgents = await canManageOrganization(session);
      if (!canManageAllAgents) {
        throw new ApiError("Only platform admins can create global agents", 403, "GLOBAL_AGENT_FORBIDDEN");
      }
    }
    if (
      visibility !== "private"
      && (requestedOwnerTeamSlug || requestedOwnerTeamId || visibility === "team")
    ) {
      if (!requestedOwnerTeamSlug && !requestedOwnerTeamId) {
        throw new ApiError("Owner team is required for team agents", 400, "OWNER_TEAM_REQUIRED");
      }
      ownerTeam = await loadOwnerTeam({ slug: requestedOwnerTeamSlug, id: requestedOwnerTeamId });
      if (!ownerTeam) {
        throw new ApiError("Owner team not found", 404, "OWNER_TEAM_NOT_FOUND");
      }
      ownerTeamSlug = normalizeString(ownerTeam.slug);
      if (!ownerTeamSlug) {
        throw new ApiError("Owner team is missing a slug", 409, "OWNER_TEAM_INVALID");
      }
      const canUseTeam = await canUseOwnerTeam(session, ownerTeam);
      if (!canUseTeam) {
        throw new ApiError("You must belong to the owner team to create this agent", 403, "OWNER_TEAM_FORBIDDEN");
      }
    }

    // Generate slug from name with agent- prefix
    const agentId = `agent-${slugify(body.name)}`;
    if (!agentId) {
      throw new ApiError("Agent name must contain at least one alphanumeric character", 400);
    }

    // Reserved slug check
    if (RESERVED_AGENT_SLUGS.has(agentId) || agentId.startsWith("__")) {
      throw new ApiError(`Agent name "${body.name}" is reserved`, 409);
    }

    const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);

    // Uniqueness check
    const existing = await collection.findOne({ _id: agentId });
    if (existing) {
      throw new ApiError(
        `Agent with ID "${agentId}" already exists`,
        409,
      );
    }

    // Subagent visibility validation
    const ownerSubject = requireStableSubject(session);
    const subagents: SubAgentRef[] = body.subagents ?? [];
    if (subagents.length > 0) {
      const result = await validateSubagentVisibility(
        visibility,
        subagents,
        collection,
        ownerSubject,
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
    const sharedTeamSlugs = visibility === "private" ? [] : ownerTeamSlug
      ? rawSharedTeamSlugs.filter((slug) => slug !== ownerTeamSlug)
      : rawSharedTeamSlugs;
    if (droppedSharedInputs.length > 0) {
      console.warn(
        "[dynamic-agents] POST dropped unresolved shared_with_teams entries (no such team)",
        { agent: body.name, dropped: droppedSharedInputs },
      );
    }

    // Build document with explicit field allowlist (Security VII)
    const now = new Date();
    const doc: DynamicAgentConfig = {
      _id: agentId,
      name: body.name as string,
      description: (body.description as string) ?? "",
      system_prompt: body.system_prompt as string,
      allowed_tools: (body.allowed_tools as Record<string, string[] | boolean>) ?? {},
      builtin_tools: body.builtin_tools ?? undefined,
      model: body.model as DynamicAgentConfig["model"],
      visibility,
      shared_with_teams: sharedTeamSlugs,
      owner_team_slug: ownerTeamSlug ?? undefined,
      owner_team_id: ownerTeam ? teamIdString(ownerTeam) : undefined,
      subagents,
      skills: (body.skills as string[]) ?? [],
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
      creator_id: user.email,
      creator_subject: ownerSubject,
      is_system: false,
      config_driven: false,
      authz_revision: 1,
      authz_sync_state: "ready",
      authz_last_synced_revision: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    // Only resolve the unlinked SA sub when it's actually needed — avoids a
    // Mongo lookup on every non-global agent create.
    const unlinkedServiceAccountSub =
      visibility === "global" ? await resolveUnlinkedServiceAccountSub() : null;

    await validatePersistedAgentMcpDependencies({
      session,
      agent: {
        visibility,
        ownerSubject,
        ownerTeamSlug,
        sharedTeamSlugs,
      },
      allowedTools: doc.allowed_tools,
    });

    await reconcileAgentRelationships({
      agentId,
      previousAllowedTools: {},
      nextAllowedTools: doc.allowed_tools,
      ownerSubject: doc.owner_subject,
      creatorSubject: doc.creator_subject,
      personalOwnerAccess: visibility === "private",
      organizationId: caipeOrgKey(),
      ownerTeamSlug,
      nextSharedTeamSlugs: sharedTeamSlugs,
      previousSharedTeamSlugs: [],
      // Encode `visibility === 'global'` as the wildcard `user:* user
      // agent:<id>` grant so a freshly-created global agent is usable by
      // every member without waiting for the list-time repair in
      // available/route.ts. Fresh create has no previous state to revoke.
      globalUserAccess: visibility === "global",
      // Also grant the unlinked SA `can_use` so callers with no linked user
      // identity (Slack/Webex bots) are treated as "everyone" too.
      unlinkedServiceAccountSub,
      verifyHigherConsistency: true,
    });

    try {
      await collection.insertOne(doc);
    } catch (error) {
      await deleteAllAgentToolTuples(agentId).catch((cleanupError) => {
        console.warn("[dynamic-agents] failed to clean up OpenFGA tuples after create failure:", cleanupError);
      });
      throw error;
    }

    return successResponse(await dynamicAgentForBrowser(doc), 201);
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
    requirePrivateAgentOwner(agent, session);
    await requireAgentWritePermission(session, id);
    if (hasActiveAuthzSync(agent)) {
      throw new ApiError(
        "This agent's authorization is already being reconciled. Retry shortly.",
        409,
        "AUTHZ_SYNC_PENDING",
      );
    }
    const previousAuthzState = previousAgentAuthzState(agent);

    // Config-driven guard
    if (agent.config_driven) {
      throw new ApiError(
        "Config-driven agents cannot be modified. Update config.yaml instead.",
        403,
      );
    }

    // Build update with explicit field allowlist
    const updateData = pickMutableFields(body);
    // An ownership transfer changes owner_team_slug, which is intentionally NOT
    // in the mutable-field allowlist (owner is immutable on a normal edit).
    // Detect it here so a transfer-only request isn't dropped by the
    // "no fields to update" short-circuit below.
    const isTransferRequest =
      normalizeString(body.owner_team_slug) !== null &&
      normalizeString(body.owner_team_slug) !== normalizeString(agent.owner_team_slug);
    if (Object.keys(updateData).length === 0 && !isTransferRequest) {
      // No fields to update — return current state
      return successResponse(await dynamicAgentForBrowser(agent));
    }

    // Subagent visibility validation (using merged final values)
    const finalVisibility = (updateData.visibility ??
      agent.visibility) as VisibilityType;
    const finalSubagents = (updateData.subagents ??
      agent.subagents ??
      []) as SubAgentRef[];
    const stableOwnerSubject = normalizeString(agent.owner_subject) ?? requireStableSubject(session);
    const stableCreatorSubject = normalizeString(agent.creator_subject) ?? stableOwnerSubject;
    if (finalVisibility === "private" && session.isServiceAccount === true) {
      throw new ApiError("Service accounts cannot own private agents", 403, "PRIVATE_OWNER_MUST_BE_USER");
    }

    // Platform-default invariant: an agent can't be demoted from `global`
    // → `team` while it's the configured platform default — that would
    // silently strip the wildcard `user:*` grant new users rely on.
    // Force the admin to change the platform default in Settings → Platform settings → Defaults
    // first. We only block the demote case; promoting team → global is
    // always fine.
    const currentVisibility = agent.visibility as VisibilityType | "private" | undefined;
    if (
      finalVisibility === "private"
      && currentVisibility !== "private"
      && !isPrivateResourcesEnabled()
    ) {
      throw new ApiError("Private agents are not enabled for this deployment", 409, "PRIVATE_RESOURCES_DISABLED");
    }
    const changesProtectedDefaultVisibility = finalVisibility === "private"
      || (finalVisibility === "team" && currentVisibility === "global");
    if (changesProtectedDefaultVisibility && (await isPlatformDefaultAgent(id))) {
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
        stableOwnerSubject,
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
    const previousSharedRaw = Array.isArray(previousAuthzState.shared_with_teams)
      ? (previousAuthzState.shared_with_teams as string[])
      : [];
    const { slugs: previousSharedTeamSlugs } =
      await resolveSharedTeamSlugs(previousSharedRaw);

    let sharedTeamSlugs = finalVisibility === "private" ? [] : previousSharedTeamSlugs;
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
    const previousReconciledOwnerTeamSlug = normalizeString(
      previousAuthzState.owner_team_slug,
    );
    const resolvedOwnership = finalVisibility === "private" ? {
      ownerTeamSlug: null,
      sharedTeamSlugs: [],
      transferred: previousOwnerTeamSlug !== null,
      previousOwnerTeamSlug,
    } : await resolveShareableOwnershipWrite(
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
    if (resolvedOwnership.transferred) {
      if (nextOwnerTeamSlug) {
        const destinationTeam = await loadOwnerTeam({ slug: nextOwnerTeamSlug });
        if (!destinationTeam) {
          throw new ApiError("Destination team not found", 404, "OWNER_TEAM_NOT_FOUND");
        }
        updateData.owner_team_slug = nextOwnerTeamSlug;
        updateData.owner_team_id = teamIdString(destinationTeam) ?? undefined;
      } else {
        // Private ownership is represented by the absence of team-owner fields.
        // Keep these paths out of $set because the private update unsets them.
        delete updateData.owner_team_slug;
        delete updateData.owner_team_id;
      }
    }

    const finalAllowedTools = (updateData.allowed_tools ??
      agent.allowed_tools ??
      {}) as Record<string, string[] | boolean>;
    await validatePersistedAgentMcpDependencies({
      session,
      agent: {
        visibility: finalVisibility,
        ownerSubject: stableOwnerSubject,
        ownerTeamSlug: nextOwnerTeamSlug,
        sharedTeamSlugs,
      },
      allowedTools: finalAllowedTools,
    });
    // Resolve the unlinked SA grant state whenever the wildcard grant is being
    // written OR revoked — the delete path needs the exact sub too, so we
    // can't skip resolution just because the agent is being demoted.
    // `explicitAgentIds` lets a `global → team` demote preserve an explicit
    // admin grant: the admin changed the agent's visibility, not the panel
    // override, so the unlinked SA keeps `can_use` on an agent it was
    // explicitly granted.
    const { sub: unlinkedServiceAccountSub, explicitAgentIds } =
      finalVisibility === "global" || previousAuthzState.visibility === "global"
        ? await resolveUnlinkedServiceAccountGrantState()
        : { sub: null, explicitAgentIds: new Set<string>() };
    const previousVisibilityForReconcile = previousAuthzState.visibility;
    const reconcile = (verifyHigherConsistency: boolean) => reconcileAgentRelationships({
      agentId: id,
      previousAllowedTools: allowedToolsFromAgent(previousAuthzState),
      nextAllowedTools: finalAllowedTools,
      ownerSubject: agent.owner_subject ?? agent.owner_id,
      creatorSubject: stableCreatorSubject,
      personalOwnerAccess: finalVisibility === "private",
      previousPersonalOwnerAccess: previousVisibilityForReconcile === "private",
      organizationId: caipeOrgKey(),
      ownerTeamSlug: nextOwnerTeamSlug,
      previousOwnerTeamSlug: previousReconciledOwnerTeamSlug !== nextOwnerTeamSlug
        ? previousReconciledOwnerTeamSlug
        : undefined,
      nextSharedTeamSlugs: sharedTeamSlugs,
      previousSharedTeamSlugs,
      // Keep the wildcard `user:* user agent:<id>` grant in sync with
      // visibility on every edit. Without this a `global → team` demote
      // would update Mongo but leave the everyone-can-use grant behind,
      // so non-owner-team members keep `can_use` (the SRE-agent leak).
      // Only an exact 'global' match counts as a previous wildcard grant.
      globalUserAccess: finalVisibility === "global",
      previousGlobalUserAccess: previousVisibilityForReconcile === "global",
      // Keep the unlinked SA's grant in sync with the same promote/demote
      // transition so callers with no linked user identity gain/lose
      // access exactly when "everyone" does.
      unlinkedServiceAccountSub,
      unlinkedGrantIsExplicit: explicitAgentIds.has(id),
      verifyHigherConsistency,
    });

    const mongoSet = finalVisibility === "private"
      ? { ...updateData, shared_with_teams: [] }
      : updateData;
    const mongoUnset: Record<string, ""> | undefined = finalVisibility === "private"
      ? { owner_team_slug: "", owner_team_id: "" }
      : undefined;
    const mongoUpdate: UpdateFilter<DynamicAgentConfig> = mongoUnset
      ? { $set: mongoSet, $unset: mongoUnset }
      : { $set: mongoSet };
    const authzMutationRequired = agent.authz_sync_state === "pending"
      || agent.authz_sync_state === "error"
      || finalVisibility !== currentVisibility
      || previousOwnerTeamSlug !== nextOwnerTeamSlug
      || !sameStringSet(previousSharedTeamSlugs, sharedTeamSlugs)
      || !sameAllowedTools(allowedToolsFromAgent(agent), finalAllowedTools);

    let updated: DynamicAgentConfig | null;
    if (!authzMutationRequired) {
      await reconcile(false);
      updated = await collection.findOneAndUpdate(
        { _id: id },
        mongoUpdate,
        { returnDocument: "after" },
      );
    } else {
      const revision = nextAuthzRevision(agent);
      const pending = await collection.findOneAndUpdate(
        { _id: id, ...authzRevisionFilter(agent) },
        {
          $set: {
            ...mongoSet,
            authz_revision: revision,
            authz_sync_state: "pending",
            authz_sync_started_at: new Date().toISOString(),
            authz_previous_state: agent.authz_previous_state ?? agentAuthzSnapshot(agent),
          },
          ...(mongoUnset
            ? { $unset: { ...mongoUnset, authz_last_error_code: "" } }
            : { $unset: { authz_last_error_code: "" } }),
        },
        { returnDocument: "after" },
      );
      if (!pending) {
        throw new ApiError(
          "This agent changed while authorization was being prepared. Retry the save.",
          409,
          "AUTHZ_SYNC_SUPERSEDED",
        );
      }

      try {
        updated = await runRevisionedAuthzSync({
          reconcile: async () => { await reconcile(true); },
          markError: async (errorCode) => {
            await collection.findOneAndUpdate(
              { _id: id, authz_revision: revision, authz_sync_state: "pending" },
              {
                $set: { authz_sync_state: "error", authz_last_error_code: errorCode },
                $unset: { authz_sync_started_at: "" },
              },
            );
          },
          markReady: () => collection.findOneAndUpdate(
            { _id: id, authz_revision: revision, authz_sync_state: "pending" },
            {
              $set: {
                authz_sync_state: "ready",
                authz_last_synced_revision: revision,
              },
              $unset: {
                authz_last_error_code: "",
                authz_previous_state: "",
                authz_sync_started_at: "",
              },
            },
            { returnDocument: "after" },
          ),
        });
      } catch (error) {
        if (error instanceof AuthzSyncSupersededError) {
          throw new ApiError(error.message, 409, "AUTHZ_SYNC_SUPERSEDED");
        }
        throw error;
      }
    }

    if (!updated) {
      throw new ApiError("Failed to update agent", 500);
    }

    return successResponse(await dynamicAgentForBrowser(
      normalizeAgentDoc(updated as unknown as Record<string, unknown>) as unknown as DynamicAgentConfig,
    ));
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

    const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);

    // Verify agent exists
    const agent = await collection.findOne({ _id: id });
    if (!agent) {
      throw new ApiError("Agent not found", 404);
    }
    requirePrivateAgentOwner(agent, session);
    await requireAgentPermission(session, id, "delete");

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
    // and leave Settings → Platform settings → Defaults pointing at a tombstone. Force the
    // admin to clear/change the platform default first.
    if (await isPlatformDefaultAgent(id)) {
      throw new ApiError(
        PLATFORM_DEFAULT_DELETE_ERROR,
        409,
        "AGENT_IS_PLATFORM_DEFAULT",
      );
    }

    await deleteAllAgentToolTuples(id);
    await collection.deleteOne({ _id: id });

    return successResponse({ deleted: id });
});

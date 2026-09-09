import type { UniversalRebacRelationship } from "@/types/rbac-universal";

import { getCurrentTraceparent,withAuthzSpan } from "./authz-tracing";
import { isUnsafeRbacBypassEnabled,warnUnsafeRbacBypassEnabled } from "./bypass";
import {
buildOpenFgaTupleDiff,
openFgaCheckRelation,
openFgaObject,
openFgaSubject,
type UniversalRebacTupleDiffInput,
} from "./tuple-builders";
import { organizationObjectId } from "./organization";

export interface OpenFgaTupleKey {
  user: string;
  relation: string;
  object: string;
}

export interface ResourceStringDiff {
  added: string[];
  removed: string[];
}

export interface ResourceBooleanDiff {
  added: boolean;
  removed: boolean;
}

export interface TeamResourceTupleDiffInput {
  teamSlug: string;
  agents: ResourceStringDiff;
  agentAdmins: ResourceStringDiff;
  tools: ResourceStringDiff;
  knowledgeBases?: ResourceStringDiff;
  skills?: ResourceStringDiff;
  tasks?: ResourceStringDiff;
  toolWildcard: ResourceBooleanDiff;
  /** All enabled MCP server ids — expands tool-wildcard grants to tool:<id>/*. */
  allMcpServerIds?: string[];
}

export interface TeamResourceTupleDiff {
  writes: OpenFgaTupleKey[];
  deletes: OpenFgaTupleKey[];
}

export interface OpenFgaReconcileResult {
  enabled: boolean;
  writes: number;
  deletes: number;
}

export interface OpenFgaTuple {
  key: OpenFgaTupleKey;
  timestamp?: string;
}

export interface OpenFgaReadOptions {
  tuple?: Partial<OpenFgaTupleKey>;
  pageSize?: number;
  continuationToken?: string;
  consistency?: "MINIMIZE_LATENCY" | "HIGHER_CONSISTENCY";
}

export interface OpenFgaReadResult {
  tuples: OpenFgaTuple[];
  continuationToken?: string;
}

export interface OpenFgaCheckResult {
  allowed: boolean;
}

function assertWritableRelations(diff: TeamResourceTupleDiff): void {
  const materialized = [...diff.writes, ...diff.deletes].find((tuple) =>
    tuple.relation.startsWith("can_")
  );
  if (materialized) {
    throw new Error(
      `Materialized relation ${materialized.relation} is not writable; write the base OpenFGA relationship instead`
    );
  }
}

const DEFAULT_STORE_NAME = "caipe-openfga";
const MAX_READ_PAGE_SIZE = 100;

function openFgaHttpUrl(): string | null {
  const url = process.env.OPENFGA_HTTP?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

function openFgaStoreName(): string {
  return process.env.OPENFGA_STORE_NAME?.trim() || DEFAULT_STORE_NAME;
}

function openFgaHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const traceparent = getCurrentTraceparent();
  if (traceparent) {
    headers.traceparent = traceparent;
  }
  return headers;
}

export function isOpenFgaConfigured(): boolean {
  return Boolean(openFgaHttpUrl());
}

function parseOpenFgaReconcileEnabledFlag(): boolean {
  const raw = process.env.OPENFGA_RECONCILE_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return ["true", "1", "yes", "on"].includes(raw);
}

export function isOpenFgaReconciliationEnabled(): boolean {
  return parseOpenFgaReconcileEnabledFlag() && Boolean(openFgaHttpUrl());
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

function resourceTuples(
  teamSlug: string,
  relation: string,
  objectType: "agent" | "tool" | "knowledge_base" | "skill" | "task",
  ids: string[],
  subjectRelation: "member" | "admin" = "member"
): OpenFgaTupleKey[] {
  return ids.map((id) => ({
    user: `team:${teamSlug}#${subjectRelation}`,
    relation,
    object: `${objectType}:${id}`,
  }));
}

const MCP_TOOL_WILDCARD_SUFFIX = "_*";
const MCP_TOOL_SLASH_WILDCARD_SUFFIX = "/*";

/**
 * Marker object recording that a team opted into the "all MCP servers" tool
 * wildcard. AgentGateway only ever checks per-server objects (`tool:<server>/*`)
 * so this `tool:*` object is never consulted at runtime — it exists purely so
 * `tool_wildcard` intent lives in OpenFGA (the single source of truth) rather
 * than the dropped `team.resources` array. A `team:<slug>#member caller tool:*`
 * tuple is the authoritative "wildcard on" signal: the per-team resources route
 * writes/clears it, and the MCP-server reconciler reads its callers to know
 * which teams a freshly-added server must be auto-granted to.
 */
export const TEAM_TOOL_WILDCARD_SENTINEL_OBJECT = "tool:*";

/** The `team:<slug>#member caller tool:*` sentinel tuple for a team. */
export function teamToolWildcardSentinelTuple(teamSlug: string): OpenFgaTupleKey {
  return { user: `team:${teamSlug}#member`, relation: "caller", object: TEAM_TOOL_WILDCARD_SENTINEL_OBJECT };
}

function mcpServerIdFromToolPrefix(toolId: string): string | null {
  let serverId: string | null = null;
  if (toolId.endsWith(MCP_TOOL_WILDCARD_SUFFIX)) {
    serverId = toolId.slice(0, -MCP_TOOL_WILDCARD_SUFFIX.length);
  } else if (toolId.endsWith(MCP_TOOL_SLASH_WILDCARD_SUFFIX)) {
    serverId = toolId.slice(0, -MCP_TOOL_SLASH_WILDCARD_SUFFIX.length);
  }
  return serverId || null;
}

function mcpServerAccessTuples(
  teamSlug: string,
  toolIds: string[],
  includeOrgAdminManager: boolean
): OpenFgaTupleKey[] {
  const tuples: OpenFgaTupleKey[] = [];
  for (const toolId of toolIds) {
    const serverId = mcpServerIdFromToolPrefix(toolId);
    if (!serverId) continue;
    const object = `mcp_server:${serverId}`;
    tuples.push(
      { user: `team:${teamSlug}#member`, relation: "reader", object },
      { user: `team:${teamSlug}#member`, relation: "user", object },
      { user: `team:${teamSlug}#member`, relation: "invoker", object },
      { user: `team:${teamSlug}#admin`, relation: "manager", object },
    );
    if (includeOrgAdminManager) {
      tuples.push({ user: `${organizationObjectId()}#admin`, relation: "manager", object });
    }
  }
  return tuples;
}

/** Gateway extAuthz checks `tool:<server>/*` (slash), not underscore wildcards. */
function mcpServerGatewayToolCallerTuples(teamSlug: string, toolIds: string[]): OpenFgaTupleKey[] {
  const tuples: OpenFgaTupleKey[] = [];
  for (const toolId of toolIds) {
    const serverId = mcpServerIdFromToolPrefix(toolId);
    if (!serverId) continue;
    tuples.push({
      user: `team:${teamSlug}#member`,
      relation: "caller",
      object: `tool:${serverId}/*`,
    });
  }
  return tuples;
}

const OPENFGA_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function isValidTeamAgentId(agentId: string): boolean {
  return OPENFGA_AGENT_ID_PATTERN.test(agentId);
}

/**
 * AgentGateway extAuthz checks `agent:<id> can_call tool:<server>/*`, not team
 * membership. Mirror team MCP grants onto team-assigned agents at save time.
 */
function agentRuntimeToolCallerTuples(agentIds: string[], toolIds: string[]): OpenFgaTupleKey[] {
  const { mcpServerSelections, directToolIds } = splitTeamToolSelections(toolIds);
  const tuples: OpenFgaTupleKey[] = [];
  for (const agentId of agentIds) {
    if (!isValidTeamAgentId(agentId)) continue;
    const agentUser = `agent:${agentId}`;
    for (const selection of mcpServerSelections) {
      const serverId = mcpServerIdFromToolPrefix(selection);
      if (!serverId) continue;
      tuples.push({
        user: agentUser,
        relation: "caller",
        object: `tool:${serverId}/*`,
      });
    }
    for (const toolId of directToolIds) {
      tuples.push({
        user: agentUser,
        relation: "caller",
        object: `tool:${toolId}`,
      });
    }
  }
  return tuples;
}

function mcpServerSelectionsFromIds(serverIds: string[]): string[] {
  return serverIds.map((serverId) => `${serverId}${MCP_TOOL_WILDCARD_SUFFIX}`);
}

/** AgentGateway checks per-server wildcards (`tool:<server>/*`), never `tool:*`. */
function agentRuntimeAllServerWildcards(agentIds: string[], serverIds: string[]): OpenFgaTupleKey[] {
  return agentRuntimeToolCallerTuples(agentIds, mcpServerSelectionsFromIds(serverIds));
}

function combinedTeamToolIds(added: string[], removed: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const toolId of [...added, ...removed]) {
    if (seen.has(toolId)) continue;
    seen.add(toolId);
    out.push(toolId);
  }
  return out;
}

function splitTeamToolSelections(toolIds: string[]): {
  mcpServerSelections: string[];
  directToolIds: string[];
} {
  const mcpServerSelections: string[] = [];
  const directToolIds: string[] = [];
  for (const toolId of toolIds) {
    if (mcpServerIdFromToolPrefix(toolId)) {
      mcpServerSelections.push(toolId);
    } else {
      directToolIds.push(toolId);
    }
  }
  return { mcpServerSelections, directToolIds };
}

/** Revoke legacy `tool:<prefix>_*` and `mcp_tool:<prefix>_*` tuples from older writers. */
function mcpServerLegacyToolGrantDeletes(teamSlug: string, toolIds: string[]): OpenFgaTupleKey[] {
  const deletes: OpenFgaTupleKey[] = [];
  for (const toolId of toolIds) {
    const serverId = mcpServerIdFromToolPrefix(toolId);
    if (!serverId) continue;
    const legacyToolId = `${serverId}${MCP_TOOL_WILDCARD_SUFFIX}`;
    deletes.push({
      user: `team:${teamSlug}#member`,
      relation: "caller",
      object: `tool:${legacyToolId}`,
    });
    for (const relation of ["reader", "user", "caller"] as const) {
      deletes.push({
        user: `team:${teamSlug}#member`,
        relation,
        object: `mcp_tool:${legacyToolId}`,
      });
    }
    deletes.push({
      user: `team:${teamSlug}#admin`,
      relation: "manager",
      object: `mcp_tool:${legacyToolId}`,
    });
  }
  return deletes;
}

export function buildTeamResourceTupleDiff(input: TeamResourceTupleDiffInput): TeamResourceTupleDiff {
  // Resource grants are keyed on the `team:<slug>#member` / `#admin` userset, so
  // a member's access is resolved transitively at check time via their
  // `user:<id> member team:<slug>` membership tuple. Those membership tuples are
  // owned exclusively by the team-membership writers (members route + sync/audit
  // reconcilers), NOT this resource-save path — re-writing them here forced an
  // O(members) Keycloak email→id lookup on every save for no authorization gain.
  const addedTools = splitTeamToolSelections(input.tools.added);
  const removedTools = splitTeamToolSelections(input.tools.removed);
  const wildcardServerSelections = mcpServerSelectionsFromIds(input.allMcpServerIds ?? []);
  const combinedToolIds = combinedTeamToolIds(input.tools.added, input.tools.removed);

  const writes = uniqueTuples([
    ...resourceTuples(input.teamSlug, "user", "agent", input.agents.added),
    ...resourceTuples(input.teamSlug, "manager", "agent", input.agentAdmins.added, "admin"),
    ...resourceTuples(input.teamSlug, "caller", "tool", addedTools.directToolIds),
    // Team Resources accepts MCP server selections as current `<server_id>/*`
    // or legacy `<server_id>_*`; OpenFGA tuples target `mcp_server:<id>` (BFF)
    // and `tool:<id>/*` (gateway).
    ...mcpServerAccessTuples(input.teamSlug, addedTools.mcpServerSelections, true),
    ...mcpServerGatewayToolCallerTuples(input.teamSlug, addedTools.mcpServerSelections),
    ...agentRuntimeToolCallerTuples(input.agents.added, input.tools.added),
    ...(input.toolWildcard.added
      ? [
          ...mcpServerAccessTuples(input.teamSlug, wildcardServerSelections, true),
          ...mcpServerGatewayToolCallerTuples(input.teamSlug, wildcardServerSelections),
          ...agentRuntimeAllServerWildcards(input.agents.added, input.allMcpServerIds ?? []),
        ]
      : []),
    ...resourceTuples(input.teamSlug, "reader", "knowledge_base", input.knowledgeBases?.added ?? []),
    ...resourceTuples(input.teamSlug, "user", "skill", input.skills?.added ?? []),
    ...resourceTuples(input.teamSlug, "user", "task", input.tasks?.added ?? []),
  ]);

  const agentsAffectedByWildcard = Array.from(
    new Set([...input.agents.added, ...input.agents.removed]),
  );

  const deletes = uniqueTuples([
    ...resourceTuples(input.teamSlug, "user", "agent", input.agents.removed),
    ...resourceTuples(input.teamSlug, "manager", "agent", input.agentAdmins.removed, "admin"),
    ...resourceTuples(input.teamSlug, "caller", "tool", removedTools.directToolIds),
    ...mcpServerAccessTuples(input.teamSlug, removedTools.mcpServerSelections, false),
    ...mcpServerGatewayToolCallerTuples(input.teamSlug, removedTools.mcpServerSelections),
    ...mcpServerLegacyToolGrantDeletes(input.teamSlug, removedTools.mcpServerSelections),
    ...agentRuntimeToolCallerTuples(input.agents.removed, combinedToolIds),
    ...agentRuntimeToolCallerTuples(input.agents.added, removedTools.mcpServerSelections),
    ...agentRuntimeToolCallerTuples(input.agents.added, removedTools.directToolIds),
    ...(input.toolWildcard.added
      ? agentRuntimeAllServerWildcards(input.agents.removed, input.allMcpServerIds ?? [])
      : []),
    ...(input.toolWildcard.removed
      ? [
          ...mcpServerAccessTuples(input.teamSlug, wildcardServerSelections, false),
          ...mcpServerGatewayToolCallerTuples(input.teamSlug, wildcardServerSelections),
          ...agentRuntimeAllServerWildcards(agentsAffectedByWildcard, input.allMcpServerIds ?? []),
        ]
      : []),
    ...resourceTuples(input.teamSlug, "reader", "knowledge_base", input.knowledgeBases?.removed ?? []),
    ...resourceTuples(input.teamSlug, "user", "skill", input.skills?.removed ?? []),
    ...resourceTuples(input.teamSlug, "user", "task", input.tasks?.removed ?? []),
  ]);

  return { writes, deletes };
}

export function buildUniversalRebacTupleDiff(
  input: UniversalRebacTupleDiffInput
): TeamResourceTupleDiff {
  return buildOpenFgaTupleDiff(input);
}

// Module-level singleton: one HTTP round-trip per process lifetime.
// Reset to null on failure so the next call retries.
let _storeIdPromise: Promise<string> | null = null;

export function resetOpenFgaStoreIdCacheForTests(): void {
  if (process.env.NODE_ENV === "test") {
    _storeIdPromise = null;
  }
}

export async function getOpenFgaStoreId(): Promise<string> {
  const explicitStoreId = process.env.OPENFGA_STORE_ID?.trim();
  if (explicitStoreId) return explicitStoreId;

  if (!_storeIdPromise) {
    const baseUrl = openFgaHttpUrl();
    if (!baseUrl) throw new Error("OPENFGA_HTTP is not set");
    _storeIdPromise = fetch(`${baseUrl}/stores`, { method: "GET", headers: openFgaHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`OpenFGA store discovery failed: ${res.status}`);
        const body = (await res.json()) as { stores?: Array<{ id?: string; name?: string }> };
        const store = body.stores?.find((c) => c.name === openFgaStoreName());
        if (!store?.id) throw new Error(`OpenFGA store ${openFgaStoreName()} was not found`);
        return store.id;
      })
      .catch((err: unknown) => {
        _storeIdPromise = null;
        throw err;
      });
  }
  return _storeIdPromise;
}

function tupleKeysEqual(a: OpenFgaTupleKey, b: OpenFgaTupleKey): boolean {
  return a.user === b.user && a.relation === b.relation && a.object === b.object;
}

/**
 * Whether an exact tuple is stored in OpenFGA (via Read, not Check).
 *
 * Check rejects some valid stored keys (e.g. `user:*`, `organization#member`
 * on types where Check validation differs from Write). Idempotent
 * write/delete filtering must use existence, not authorization evaluation.
 */
async function tupleExistsInStore(
  baseUrl: string,
  storeId: string,
  tuple: OpenFgaTupleKey,
  consistency?: OpenFgaReadOptions["consistency"],
): Promise<boolean> {
  const filter = tupleKeyFilter(tuple);
  if (!filter?.user || !filter.relation || !filter.object) {
    return false;
  }
  const response = await fetch(`${baseUrl}/stores/${storeId}/read`, {
    method: "POST",
    headers: openFgaHeaders(),
    body: JSON.stringify({
      tuple_key: filter,
      page_size: 1,
      ...(consistency ? { consistency } : {}),
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`OpenFGA tuple read failed: ${response.status} ${errorBody.slice(0, 200)}`);
  }
  const payload = (await response.json()) as {
    tuples?: Array<{ key?: OpenFgaTupleKey }>;
  };
  return (payload.tuples ?? []).some((entry) => entry.key && tupleKeysEqual(entry.key, tuple));
}

async function tupleAllowed(baseUrl: string, storeId: string, tuple: OpenFgaTupleKey): Promise<boolean> {
  const response = await fetch(`${baseUrl}/stores/${storeId}/check`, {
    method: "POST",
    headers: openFgaHeaders(),
    body: JSON.stringify({ tuple_key: tuple }),
  });
  if (!response.ok) {
    throw new Error(`OpenFGA tuple check failed: ${response.status}`);
  }
  const body = (await response.json()) as { allowed?: boolean };
  return Boolean(body.allowed);
}

function tupleKeyFilter(tuple?: Partial<OpenFgaTupleKey>): Partial<OpenFgaTupleKey> | undefined {
  if (!tuple) return undefined;
  const out: Partial<OpenFgaTupleKey> = {};
  if (tuple.user?.trim()) out.user = tuple.user.trim();
  if (tuple.relation?.trim()) out.relation = tuple.relation.trim();
  if (tuple.object?.trim()) out.object = tuple.object.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * OpenFGA's HTTP `/batch-check` endpoint caps each call at 50 checks by
 * default (`max_checks_per_batch_check`). Callers that fan a check out
 * over an unbounded collection (e.g. one row per Mongo document) can
 * easily exceed this — the call then fails outright, and a caller with a
 * blanket try/catch around the whole batch silently treats every check
 * as denied instead of just the ones over the limit.
 *
 * Configurable via `OPENFGA_MAX_CHECKS_PER_BATCH` for environments that
 * tune the server-side limit; defaults to 50 to match the stock server.
 */
const DEFAULT_OPENFGA_BATCH_CHECK_LIMIT = 50;

function openFgaBatchCheckLimit(): number {
  const fromEnv = Number(process.env.OPENFGA_MAX_CHECKS_PER_BATCH);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 50) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_OPENFGA_BATCH_CHECK_LIMIT;
}

async function postOpenFgaBatchCheck(
  baseUrl: string,
  storeId: string,
  tuples: OpenFgaTupleKey[],
): Promise<boolean[]> {
  const checks = tuples.map((tuple, i) => ({
    tuple_key: tuple,
    correlation_id: String(i),
  }));

  const response = await fetch(`${baseUrl}/stores/${storeId}/batch-check`, {
    method: "POST",
    headers: openFgaHeaders(),
    body: JSON.stringify({ checks }),
  });
  if (!response.ok) {
    throw new Error(`OpenFGA batch-check failed: ${response.status}`);
  }
  const body = (await response.json()) as { result: Record<string, { allowed?: boolean }> };
  return tuples.map((_, i) => Boolean(body.result[String(i)]?.allowed));
}

/**
 * Send multiple Check requests via the OpenFGA /batch-check endpoint
 * (available since OpenFGA v1.8), chunking to stay under the server's
 * per-call check limit. Returns a boolean array in the same order as the
 * input tuples. Falls back gracefully: if OPENFGA_HTTP is unset or
 * batch-check is unavailable, callers should use checkOpenFgaTuple()
 * instead.
 */
export async function batchCheckOpenFgaTuples(tuples: OpenFgaTupleKey[]): Promise<boolean[]> {
  if (tuples.length === 0) return [];
  if (isUnsafeRbacBypassEnabled()) {
    warnUnsafeRbacBypassEnabled("openfga.batch-check");
    return tuples.map(() => true);
  }
  const baseUrl = openFgaHttpUrl();
  if (!baseUrl) throw new Error("OPENFGA_HTTP is not set");
  const storeId = await getOpenFgaStoreId();

  const limit = openFgaBatchCheckLimit();
  if (tuples.length <= limit) {
    return postOpenFgaBatchCheck(baseUrl, storeId, tuples);
  }

  const chunkResults = await Promise.all(
    Array.from({ length: Math.ceil(tuples.length / limit) }, (_, i) =>
      postOpenFgaBatchCheck(baseUrl, storeId, tuples.slice(i * limit, (i + 1) * limit)),
    ),
  );
  return chunkResults.flat();
}

export async function checkOpenFgaTuple(tuple: OpenFgaTupleKey): Promise<OpenFgaCheckResult> {
  return withAuthzSpan(
    "openfga.check",
    {
      "authz.action": tuple.relation,
      "authz.object": tuple.object,
      "authz.user_ref": tuple.user.replace(/user:[^#]+/, "user:<redacted>"),
    },
    async () => {
      if (isUnsafeRbacBypassEnabled()) {
        warnUnsafeRbacBypassEnabled("openfga.check");
        return { allowed: true };
      }
      const baseUrl = openFgaHttpUrl();
      if (!baseUrl) {
        throw new Error("OPENFGA_HTTP is not set");
      }
      const storeId = await getOpenFgaStoreId();
      return { allowed: await tupleAllowed(baseUrl, storeId, tuple) };
    },
    getCurrentTraceparent(),
  );
}

export async function checkUniversalRebacRelationship(
  relationship: UniversalRebacRelationship
): Promise<OpenFgaCheckResult> {
  return checkOpenFgaTuple({
    user: openFgaSubject(relationship.subject),
    relation: openFgaCheckRelation(relationship.action),
    object: openFgaObject(relationship.resource),
  });
}

export async function readOpenFgaTuples(options: OpenFgaReadOptions = {}): Promise<OpenFgaReadResult> {
  const baseUrl = openFgaHttpUrl();
  if (!baseUrl) {
    throw new Error("OPENFGA_HTTP is not set");
  }
  const storeId = await getOpenFgaStoreId();
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), MAX_READ_PAGE_SIZE);
  const body = {
    ...(tupleKeyFilter(options.tuple) ? { tuple_key: tupleKeyFilter(options.tuple) } : {}),
    page_size: pageSize,
    ...(options.continuationToken ? { continuation_token: options.continuationToken } : {}),
    ...(options.consistency ? { consistency: options.consistency } : {}),
  };

  const response = await fetch(`${baseUrl}/stores/${storeId}/read`, {
    method: "POST",
    headers: openFgaHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`OpenFGA tuple read failed: ${response.status} ${errorBody.slice(0, 200)}`);
  }
  const payload = (await response.json()) as {
    tuples?: Array<{ key?: OpenFgaTupleKey; timestamp?: string }>;
    continuation_token?: string;
  };
  return {
    tuples: (payload.tuples ?? [])
      .filter((tuple): tuple is { key: OpenFgaTupleKey; timestamp?: string } => Boolean(tuple.key))
      .map((tuple) => ({ key: tuple.key, timestamp: tuple.timestamp })),
    continuationToken: payload.continuation_token || undefined,
  };
}

export interface OpenFgaListObjectsInput {
  user: string;
  relation: string;
  type: string;
}

export interface OpenFgaListObjectsResult {
  objects: string[];
}

export async function listOpenFgaObjects(
  input: OpenFgaListObjectsInput,
): Promise<OpenFgaListObjectsResult> {
  return withAuthzSpan(
    "openfga.list_objects",
    {
      "authz.relation": input.relation,
      "authz.type": input.type,
      "authz.user_ref": input.user.replace(/user:[^#]+/, "user:<redacted>"),
    },
    async () => {
      const baseUrl = openFgaHttpUrl();
      if (!baseUrl) {
        throw new Error("OPENFGA_HTTP is not set");
      }
      const storeId = await getOpenFgaStoreId();
      const response = await fetch(`${baseUrl}/stores/${storeId}/list-objects`, {
        method: "POST",
        headers: openFgaHeaders(),
        body: JSON.stringify({
          user: input.user,
          relation: input.relation,
          type: input.type,
        }),
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `OpenFGA list-objects failed: ${response.status} ${errorBody.slice(0, 200)}`,
        );
      }
      const payload = (await response.json()) as { objects?: string[] };
      return { objects: payload.objects ?? [] };
    },
    getCurrentTraceparent(),
  );
}

/**
 * OpenFGA's HTTP `Write` API caps each call at 100 tuple operations
 * (writes + deletes combined). Larger diffs MUST be split or the call
 * is rejected with `exceeded_entity_limit`.
 *
 * In CAIPE this surfaces most often during identity-group-sync reconciliation
 * for users who carry many OIDC group claims (corporate ADs frequently
 * yield 500+ groups per user). The plan happily computes the full diff
 * but the un-chunked HTTP call fails, leaving Mongo populated with
 * teams/membership-sources that have no backing OpenFGA tuples.
 *
 * Configurable via `OPENFGA_MAX_WRITES_PER_BATCH` for environments that
 * tune the server-side limit (rare); defaults to 100 to match the stock
 * server.
 */
const DEFAULT_OPENFGA_BATCH_LIMIT = 100;

function openFgaBatchLimit(): number {
  const fromEnv = Number(process.env.OPENFGA_MAX_WRITES_PER_BATCH);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 100) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_OPENFGA_BATCH_LIMIT;
}

/**
 * Result of a single OpenFGA write chunk. Used by callers that need to
 * compensate (delete already-written tuples) when a later chunk fails.
 *
 * `applied` is the exact list of tuple-keys the server acknowledged on
 * success — the value passed in the request body, since OpenFGA's `Write`
 * API is all-or-nothing per call (4xx/5xx aborts the call entirely
 * server-side).
 */
interface OpenFgaChunkResult {
  applied: { writes: OpenFgaTupleKey[]; deletes: OpenFgaTupleKey[] };
}

/**
 * POST one chunk to OpenFGA's `Write` endpoint. Throws on non-2xx with a
 * shape that callers can detect by name (`OpenFgaWriteError`).
 */
async function postOpenFgaWriteChunk(
  baseUrl: string,
  storeId: string,
  chunk: TeamResourceTupleDiff,
): Promise<OpenFgaChunkResult> {
  if (chunk.writes.length === 0 && chunk.deletes.length === 0) {
    return { applied: { writes: [], deletes: [] } };
  }
  const body = {
    ...(chunk.writes.length > 0 ? { writes: { tuple_keys: chunk.writes } } : {}),
    ...(chunk.deletes.length > 0 ? { deletes: { tuple_keys: chunk.deletes } } : {}),
  };
  const response = await fetch(`${baseUrl}/stores/${storeId}/write`, {
    method: "POST",
    headers: openFgaHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new OpenFgaWriteError(
      `OpenFGA tuple write failed: ${response.status} ${errorBody.slice(0, 200)}`,
      response.status,
    );
  }
  return { applied: { writes: chunk.writes, deletes: chunk.deletes } };
}

/**
 * Error thrown by chunked OpenFGA writes; carries the HTTP status so
 * callers can distinguish 4xx (definitely not applied) from 5xx
 * (ambiguous, but `Write` is all-or-nothing per call so this still means
 * not applied for THIS call).
 */
export class OpenFgaWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenFgaWriteError";
    this.status = status;
  }
}

/**
 * Split a diff into ≤`limit`-sized chunks. Writes and deletes share the
 * same per-call budget (the OpenFGA limit counts them together). When
 * the total fits in one chunk this returns a single-element array
 * containing the original diff, so the common case is allocation-free.
 */
export function chunkOpenFgaDiff(
  diff: TeamResourceTupleDiff,
  limit: number = openFgaBatchLimit(),
): TeamResourceTupleDiff[] {
  if (diff.writes.length + diff.deletes.length <= limit) {
    return [diff];
  }
  const chunks: TeamResourceTupleDiff[] = [];
  // Greedy fill: drain writes first, then deletes. Order doesn't matter
  // semantically (each chunk is its own server-side transaction), but
  // grouping by kind makes the chunk shape easy to reason about in tests
  // and in logs.
  let writes = diff.writes;
  let deletes = diff.deletes;
  while (writes.length + deletes.length > 0) {
    const take = Math.min(limit, writes.length + deletes.length);
    const writeTake = Math.min(take, writes.length);
    const deleteTake = take - writeTake;
    chunks.push({
      writes: writes.slice(0, writeTake),
      deletes: deletes.slice(0, deleteTake),
    });
    writes = writes.slice(writeTake);
    deletes = deletes.slice(deleteTake);
  }
  return chunks;
}

export async function writeOpenFgaTuples(diff: TeamResourceTupleDiff): Promise<OpenFgaReconcileResult> {
  assertWritableRelations(diff);
  if (!isOpenFgaConfigured()) {
    return { enabled: false, writes: 0, deletes: 0 };
  }
  if (diff.writes.length === 0 && diff.deletes.length === 0) {
    return { enabled: true, writes: 0, deletes: 0 };
  }

  const baseUrl = openFgaHttpUrl();
  if (!baseUrl) {
    throw new Error("OPENFGA_HTTP is not set");
  }
  const storeId = await getOpenFgaStoreId();
  const filteredDiff = await filterTupleDiff(baseUrl, storeId, diff);
  if (filteredDiff.writes.length === 0 && filteredDiff.deletes.length === 0) {
    return { enabled: true, writes: 0, deletes: 0 };
  }

  return applyDiffWithCompensation(baseUrl, storeId, filteredDiff);
}

/**
 * Apply a diff in ≤limit-sized chunks. Each chunk is its own server-side
 * transaction; on failure we attempt to compensate already-applied chunks so
 * callers see "all-or-nothing" semantics across the full diff. If a chunk
 * fails AND compensation also fails, we surface the original error and log the
 * compensation failure — the caller is responsible for higher-level rollback
 * (e.g. the identity-group-sync reconciler reverts Mongo state on this throw).
 */
async function applyDiffWithCompensation(
  baseUrl: string,
  storeId: string,
  diff: TeamResourceTupleDiff,
): Promise<OpenFgaReconcileResult> {
  const chunks = chunkOpenFgaDiff(diff);
  const applied: OpenFgaChunkResult[] = [];
  let totalWrites = 0;
  let totalDeletes = 0;
  try {
    for (const chunk of chunks) {
      const result = await postOpenFgaWriteChunk(baseUrl, storeId, chunk);
      applied.push(result);
      totalWrites += result.applied.writes.length;
      totalDeletes += result.applied.deletes.length;
    }
  } catch (err) {
    if (applied.length > 0) {
      await compensateAppliedChunks(baseUrl, storeId, applied).catch(
        (compensationErr) => {
          console.error(
            "[openfga] failed to compensate already-applied tuple chunks; manual cleanup may be required",
            { compensationErr, originalError: err },
          );
        },
      );
    }
    throw err;
  }

  return { enabled: true, writes: totalWrites, deletes: totalDeletes };
}

/**
 * Delete an exact set of already-stored tuples, bypassing the read-back
 * `/check` filtering that `writeOpenFgaTuples` applies.
 *
 * `writeOpenFgaTuples` is for reconciling *desired* relationships, where a
 * `/check` per tuple correctly skips no-op writes/deletes. It MUST NOT be
 * used to delete userset tuples such as the `team:<slug>#member` channel
 * visibility grants: OpenFGA `/check` does not resolve a userset as the
 * `user`, so `filterTupleDiff` would treat those deletes as "already gone"
 * and silently drop them, orphaning the tuples.
 *
 * Callers that have already enumerated the exact stored keys (e.g. channel
 * offboarding, which reads every tuple where the channel is subject or
 * object) use this instead. Deleting a tuple that no longer exists is a
 * server-side error, so only pass keys observed via a recent read.
 *
 * Like `writeOpenFgaTuples`, the deletes are chunked to honor OpenFGA's
 * per-call entity limit and a failed chunk compensates the already-applied
 * chunks (re-writing them) so the call is all-or-nothing across the diff.
 */
export async function deleteExactOpenFgaTuples(
  deletes: OpenFgaTupleKey[]
): Promise<OpenFgaReconcileResult> {
  assertWritableRelations({ writes: [], deletes });
  if (!isOpenFgaConfigured()) {
    return { enabled: false, writes: 0, deletes: 0 };
  }
  const unique = uniqueTuples(deletes);
  if (unique.length === 0) {
    return { enabled: true, writes: 0, deletes: 0 };
  }
  const baseUrl = openFgaHttpUrl();
  if (!baseUrl) {
    throw new Error("OPENFGA_HTTP is not set");
  }
  const storeId = await getOpenFgaStoreId();
  return applyDiffWithCompensation(baseUrl, storeId, { writes: [], deletes: unique });
}

/**
 * Best-effort compensating rollback of chunks that were successfully
 * applied before a later chunk failed. For each acknowledged write we
 * issue a delete; for each acknowledged delete we re-issue the write.
 *
 * Compensation is itself chunked. If compensation throws, the error is
 * logged at the call site (we don't want compensation failures to mask
 * the original error). OpenFGA's idempotency on duplicate-delete /
 * duplicate-write is what makes this safe even if some compensation
 * tuples partially succeeded before our compensation failed.
 */
async function compensateAppliedChunks(
  baseUrl: string,
  storeId: string,
  applied: OpenFgaChunkResult[],
): Promise<void> {
  const compensateWrites: OpenFgaTupleKey[] = [];
  const compensateDeletes: OpenFgaTupleKey[] = [];
  for (const result of applied) {
    // Reverse a write by deleting the same tuple, and reverse a delete
    // by re-writing it.
    compensateWrites.push(...result.applied.deletes);
    compensateDeletes.push(...result.applied.writes);
  }
  const compensationDiff: TeamResourceTupleDiff = {
    writes: compensateWrites,
    deletes: compensateDeletes,
  };
  const chunks = chunkOpenFgaDiff(compensationDiff);
  for (const chunk of chunks) {
    await postOpenFgaWriteChunk(baseUrl, storeId, chunk);
  }
}

/**
 * Max in-flight `/read` existence checks issued by `filterTupleDiff` at once.
 *
 * Each candidate tuple costs one OpenFGA `/read`. A naive `Promise.all` over
 * the whole diff opens one socket per tuple simultaneously. That was tolerable
 * when diffs were small (a handful of resource grants), but identity-group-sync
 * now reconciles the FULL retained membership set each run — tens of thousands
 * of tuples in a large directory. Firing that many concurrent fetches at once
 * exhausts the Node HTTP agent / file descriptors and can wedge or crash the
 * sync mid-run (which is exactly the failure mode that strands Mongo rows
 * without backing tuples). Bounding concurrency keeps the read phase steady.
 *
 * Tunable via `OPENFGA_READ_CONCURRENCY`; defaults to 32 — high enough to keep
 * the pipeline busy, low enough to never swamp the connection pool.
 */
const DEFAULT_OPENFGA_READ_CONCURRENCY = 32;

export function openFgaReadConcurrency(): number {
  const fromEnv = Number(process.env.OPENFGA_READ_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_OPENFGA_READ_CONCURRENCY;
}

/**
 * Map `items` through `fn` with at most `limit` promises in flight at a time.
 * Results preserve input order. A rejection from any worker rejects the whole
 * call (same semantics as `Promise.all`), so callers' error handling is
 * unchanged from the previous unbounded implementation.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function filterTupleDiff(
  baseUrl: string,
  storeId: string,
  diff: TeamResourceTupleDiff
): Promise<TeamResourceTupleDiff> {
  const concurrency = openFgaReadConcurrency();
  const writes = (
    await mapWithConcurrency(diff.writes, concurrency, async (tuple) =>
      (await tupleExistsInStore(baseUrl, storeId, tuple)) ? null : tuple,
    )
  ).filter((tuple): tuple is OpenFgaTupleKey => tuple !== null);
  const deletes = (
    await mapWithConcurrency(diff.deletes, concurrency, async (tuple) =>
      (await tupleExistsInStore(baseUrl, storeId, tuple)) ? tuple : null,
    )
  ).filter((tuple): tuple is OpenFgaTupleKey => tuple !== null);
  return { writes, deletes };
}

export async function writeOpenFgaTupleDiff(diff: TeamResourceTupleDiff): Promise<OpenFgaReconcileResult> {
  if (!isOpenFgaReconciliationEnabled()) {
    return { enabled: false, writes: 0, deletes: 0 };
  }
  return writeOpenFgaTuples(diff);
}

export class OpenFgaVerificationError extends Error {
  constructor() {
    super("OpenFGA did not reflect the reconciled tuple state");
    this.name = "OpenFgaVerificationError";
  }
}

/** Verify direct tuple writes and revocations using OpenFGA's primary-read mode. */
export async function verifyOpenFgaTupleDiff(diff: TeamResourceTupleDiff): Promise<void> {
  if (!isOpenFgaReconciliationEnabled()) return;
  const tuples = [...diff.writes, ...diff.deletes];
  if (tuples.length === 0) return;
  const baseUrl = openFgaHttpUrl();
  if (!baseUrl) throw new Error("OPENFGA_HTTP is not set");
  const storeId = await getOpenFgaStoreId();
  const present = await mapWithConcurrency(
    tuples,
    openFgaReadConcurrency(),
    (tuple) => tupleExistsInStore(baseUrl, storeId, tuple, "HIGHER_CONSISTENCY"),
  );
  const writesVerified = diff.writes.every((_, index) => present[index] === true);
  const deletesVerified = diff.deletes.every(
    (_, index) => present[diff.writes.length + index] === false,
  );
  if (!writesVerified || !deletesVerified) throw new OpenFgaVerificationError();
}

export async function writeUniversalRebacTupleDiff(
  input: UniversalRebacTupleDiffInput
): Promise<OpenFgaReconcileResult> {
  return writeOpenFgaTupleDiff(buildUniversalRebacTupleDiff(input));
}

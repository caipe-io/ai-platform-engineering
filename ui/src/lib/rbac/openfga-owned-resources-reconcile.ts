// assisted-by Cursor:composer-2.5
// assisted-by Codex Codex-sonnet-4-6
//
// Server-facing OpenFGA reconciliation for owned/shareable resources.
// Tuple builders live in openfga-owned-resources.ts (pure, no Mongo/CAS).

import {
  reconcileTupleDiff,
  OpenFgaReconcileRequiredError,
  type TupleReconcileContext,
} from "@/lib/authz";
import {
  isOpenFgaReconciliationEnabled,
  listOpenFgaObjects,
  readOpenFgaTuples,
  TEAM_TOOL_WILDCARD_SENTINEL_OBJECT,
  type OpenFgaReconcileResult,
  type OpenFgaTupleKey,
  type TeamResourceTupleDiff,
} from "./openfga";
import {
  buildConfigDrivenLlmModelRelationshipTupleDiff,
  buildConfigDrivenMcpServerRelationshipTupleDiff,
  buildDataSourceRelationshipTupleDiff,
  buildIngestionSourceRelationshipTupleDiff,
  buildKnowledgeBaseRelationshipTupleDiff,
  buildLlmModelRelationshipTupleDiff,
  buildMcpServerRelationshipTupleDiff,
  buildMcpToolRelationshipTupleDiff,
  buildShareableResourceTupleDiff,
  type ConfigDrivenLlmModelRelationshipInput,
  type ConfigDrivenMcpServerRelationshipInput,
  type DataSourceRelationshipInput,
  type IngestionSourceRelationshipInput,
  type KnowledgeBaseRelationshipInput,
  type LlmModelRelationshipInput,
  type McpServerRelationshipInput,
  type McpToolRelationshipInput,
  type ShareableResourceInput,
} from "./openfga-owned-resources";
import { openFgaResourceId } from "./openfga-resource-ids";
import {
  isEveryoneKnowledgeAudience,
  reconcileExistingUnlinkedKnowledgeAccess,
  withUnlinkedEveryoneKnowledgeAccess,
} from "./unlinked-knowledge-access";

export { OpenFgaReconcileRequiredError } from "@/lib/authz";

const OPENFGA_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function isValidAgentId(agentId: string): boolean {
  return OPENFGA_AGENT_ID_PATTERN.test(agentId);
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

function assertReconciliationEnabled(diff: TeamResourceTupleDiff): void {
  if (
    !isOpenFgaReconciliationEnabled() &&
    (diff.writes.length > 0 || diff.deletes.length > 0)
  ) {
    throw new OpenFgaReconcileRequiredError();
  }
}

async function reconcileOwnedResource(
  diff: TeamResourceTupleDiff,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  assertReconciliationEnabled(diff);
  return reconcileTupleDiff(diff, ctx);
}

/**
 * `team:<slug>` member usersets that opted into the all-MCP-servers wildcard,
 * read from the `tool:*` sentinel (the single source of truth now that the
 * `team.resources.tool_wildcard` flag is gone). Returns slugs only.
 */
async function listToolWildcardTeamSlugs(): Promise<string[]> {
  const slugs = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({
      tuple: { object: TEAM_TOOL_WILDCARD_SENTINEL_OBJECT },
      continuationToken,
    });
    for (const { key } of page.tuples) {
      if (key.relation !== "caller") continue;
      // Sentinel callers are `team:<slug>#member` usersets; ignore anything else.
      const match = /^team:([^#]+)#member$/.exec(key.user);
      if (match?.[1]) slugs.add(match[1]);
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return [...slugs];
}

/** Agent ids the team is granted use of (`team:<slug>#member user agent:<id>`). */
async function listTeamAgentIds(teamSlug: string): Promise<string[]> {
  const { objects } = await listOpenFgaObjects({
    user: `team:${teamSlug}#member`,
    relation: "user",
    type: "agent",
  });
  const prefix = "agent:";
  return objects
    .filter((object) => object.startsWith(prefix))
    .map((object) => object.slice(prefix.length))
    .filter(Boolean);
}

async function buildToolWildcardTeamBackfill(serverId: string): Promise<OpenFgaTupleKey[]> {
  const wildcardTeamSlugs = await listToolWildcardTeamSlugs();
  if (wildcardTeamSlugs.length === 0) return [];

  const tuples: OpenFgaTupleKey[] = [];
  for (const teamSlug of wildcardTeamSlugs) {
    const mcpServerObject = `mcp_server:${serverId}`;
    const gatewayToolObject = `tool:${serverId}/*`;
    tuples.push(
      { user: `team:${teamSlug}#member`, relation: "reader", object: mcpServerObject },
      { user: `team:${teamSlug}#member`, relation: "user", object: mcpServerObject },
      { user: `team:${teamSlug}#member`, relation: "invoker", object: mcpServerObject },
      { user: `team:${teamSlug}#admin`, relation: "manager", object: mcpServerObject },
      { user: `team:${teamSlug}#member`, relation: "caller", object: gatewayToolObject },
    );

    // The agent runtime calls tools as `agent:<id>`, so each agent the team is
    // granted must also gain caller access to the new server's gateway tool.
    for (const agentId of await listTeamAgentIds(teamSlug)) {
      if (!isValidAgentId(agentId)) continue;
      tuples.push({ user: `agent:${agentId}`, relation: "caller", object: gatewayToolObject });
    }
  }
  return uniqueTuples(tuples);
}

async function withMcpServerToolWildcardBackfill(
  serverId: string,
  diff: TeamResourceTupleDiff,
): Promise<TeamResourceTupleDiff> {
  const wildcardTuples = await buildToolWildcardTeamBackfill(serverId);
  if (wildcardTuples.length === 0) return diff;
  return {
    writes: uniqueTuples([...diff.writes, ...wildcardTuples]),
    deletes: diff.deletes,
  };
}

export async function reconcileShareableResource(
  input: ShareableResourceInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileOwnedResource(buildShareableResourceTupleDiff(input));
}

export async function reconcileMcpServerRelationships(
  input: McpServerRelationshipInput,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  const ownerKind = input.ownerSubjectKind ?? "user";
  const diff = await withMcpServerToolWildcardBackfill(
    input.serverId,
    buildMcpServerRelationshipTupleDiff(input),
  );
  return reconcileTupleDiff(diff, {
    ...ctx,
    source: ctx?.source ?? "mcp_server_create",
    caller:
      ctx?.caller ??
      (input.ownerSubject
        ? { type: ownerKind, id: input.ownerSubject }
        : undefined),
  });
}

export async function reconcileConfigDrivenMcpServerRelationships(
  input: ConfigDrivenMcpServerRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  const diff = await withMcpServerToolWildcardBackfill(
    input.serverId,
    buildConfigDrivenMcpServerRelationshipTupleDiff(input),
  );
  return reconcileOwnedResource(diff);
}

export async function reconcileLlmModelRelationships(
  input: LlmModelRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileOwnedResource(buildLlmModelRelationshipTupleDiff(input));
}

export async function deleteAllLlmModelRelationshipTuples(
  modelId: string,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  if (!isOpenFgaReconciliationEnabled()) {
    throw new OpenFgaReconcileRequiredError();
  }

  const object = `llm_model:${openFgaResourceId("llm_model", modelId)}`;
  const deletes = await readAllTuplesForObject(object);
  const diff = { writes: [] as OpenFgaTupleKey[], deletes: uniqueTuples(deletes) };
  assertReconciliationEnabled(diff);
  return reconcileTupleDiff(diff, {
    ...ctx,
    source: ctx?.source ?? "llm_model_delete",
  });
}

export async function reconcileConfigDrivenLlmModelRelationships(
  input: ConfigDrivenLlmModelRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileOwnedResource(buildConfigDrivenLlmModelRelationshipTupleDiff(input));
}

export async function reconcileKnowledgeBaseRelationships(
  input: KnowledgeBaseRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  const previousEveryoneAccess = isEveryoneKnowledgeAudience(
    input.previousSharedTeamSlugs,
  );
  const nextEveryoneAccess = isEveryoneKnowledgeAudience(
    input.nextSharedTeamSlugs,
  );
  const diff = await withUnlinkedEveryoneKnowledgeAccess(
    {
      type: "datasource",
      id: input.knowledgeBaseId,
      previousEveryoneAccess,
      nextEveryoneAccess,
    },
    buildKnowledgeBaseRelationshipTupleDiff(input),
  );
  const result = await reconcileOwnedResource(diff);
  if (previousEveryoneAccess && !nextEveryoneAccess) {
    await reconcileExistingUnlinkedKnowledgeAccess();
  }
  return result;
}

export async function reconcileDataSourceRelationships(
  input: DataSourceRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileOwnedResource(buildDataSourceRelationshipTupleDiff(input));
}

export async function reconcileMcpToolRelationships(
  input: McpToolRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileOwnedResource(buildMcpToolRelationshipTupleDiff(input));
}

export async function reconcileIngestionSourceRelationships(
  input: IngestionSourceRelationshipInput,
): Promise<OpenFgaReconcileResult> {
  return reconcileOwnedResource(buildIngestionSourceRelationshipTupleDiff(input));
}

async function deleteAllRelationshipTuplesForObject(
  object: string,
  source: string,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  if (!isOpenFgaReconciliationEnabled()) {
    throw new OpenFgaReconcileRequiredError();
  }

  const deletes = await readAllTuplesForObject(object);
  const diff = { writes: [] as OpenFgaTupleKey[], deletes: uniqueTuples(deletes) };
  assertReconciliationEnabled(diff);
  return reconcileTupleDiff(diff, { ...ctx, source: ctx?.source ?? source });
}

/** Remove every management tuple for an ingestion-source config row. */
export async function deleteAllIngestionSourceRelationshipTuples(
  sourceId: string,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  return deleteAllRelationshipTuplesForObject(
    `ingestion_source:${sourceId}`,
    "ingestion_source_delete",
    ctx,
  );
}

/** Remove every query/share tuple for a knowledge base. */
export async function deleteAllKnowledgeBaseRelationshipTuples(
  knowledgeBaseId: string,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  return deleteAllRelationshipTuplesForObject(
    `knowledge_base:${knowledgeBaseId}`,
    "knowledge_base_delete",
    ctx,
  );
}

/** Remove every tuple for a datasource, including its parent_kb edge. */
export async function deleteAllDataSourceRelationshipTuples(
  dataSourceId: string,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  return deleteAllRelationshipTuplesForObject(
    `data_source:${dataSourceId}`,
    "data_source_delete",
    ctx,
  );
}

/**
 * Remove every tuple targeting `mcp_tool:<toolId>` so deleting a custom MCP
 * tool leaves no orphaned grants.
 */
export async function deleteAllMcpToolRelationshipTuples(
  toolId: string,
): Promise<OpenFgaReconcileResult> {
  return deleteAllRelationshipTuplesForObject(
    `mcp_tool:${toolId}`,
    "mcp_tool_delete",
  );
}

const MCP_TOOL_WILDCARD_SUFFIX = "_*";

function mcpServerRelatedObjects(serverId: string): string[] {
  return [
    `mcp_server:${serverId}`,
    `mcp_tool:${serverId}${MCP_TOOL_WILDCARD_SUFFIX}`,
    `tool:${serverId}${MCP_TOOL_WILDCARD_SUFFIX}`,
    `tool:${serverId}/*`,
  ];
}

async function readAllTuplesForObject(object: string): Promise<OpenFgaTupleKey[]> {
  const tuples: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({ tuple: { object }, continuationToken });
    tuples.push(...page.tuples.map((entry) => entry.key));
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return tuples;
}

/**
 * Remove every OpenFGA tuple created for an MCP server: server grants,
 * legacy tool-prefix grants, gateway wildcard tool grants, and mcp_tool rows.
 */
export async function deleteAllMcpServerRelationshipTuples(
  serverId: string,
  ctx?: TupleReconcileContext,
): Promise<OpenFgaReconcileResult> {
  if (!isOpenFgaReconciliationEnabled()) {
    throw new OpenFgaReconcileRequiredError();
  }

  const deletes: OpenFgaTupleKey[] = [];
  for (const object of mcpServerRelatedObjects(serverId)) {
    deletes.push(...(await readAllTuplesForObject(object)));
  }

  const diff = { writes: [] as OpenFgaTupleKey[], deletes: uniqueTuples(deletes) };
  assertReconciliationEnabled(diff);
  return reconcileTupleDiff(diff, {
    ...ctx,
    source: ctx?.source ?? "mcp_server_delete",
  });
}

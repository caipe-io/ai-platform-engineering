/**
 * Seed configuration loader for the Next.js gateway.
 *
 * Loads initial agents, MCP servers, and models from a YAML config file
 * at server startup (via instrumentation.ts). These config-driven entities:
 *
 * - Have explicit IDs specified in the config
 * - Override existing entities with the same ID (upsert behavior)
 * - Are marked as config_driven=true and cannot be edited/deleted via UI
 * - Are re-applied on every server restart (config is source of truth)
 * - Stale config-driven entities (removed from YAML) are cleaned up
 *
 * Ported from DA services/seed_config.py — DA no longer seeds configs.
 */

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { BUILTIN_MCP_CREDENTIAL_SOURCES } from "@/lib/rbac/agentgateway-mcp-discovery";
import {
  computeIngestionSourceId,
  type IngestionSourceIdentity,
} from "@/lib/ingestion-source-id";
import { parseConfluencePageUrl } from "@/lib/confluence-url";
import {
  writeOpenFgaTuples,
  isOpenFgaReconciliationEnabled,
} from "@/lib/rbac/openfga";
import { reconcileAgentRelationships } from "@/lib/rbac/openfga-agent-tools";
import {
  resolveUnlinkedServiceAccountSub,
  resolveUnlinkedServiceAccountGrantState,
} from "@/lib/rbac/unlinked-service-account";
import {
  deleteAllIngestionSourceRelationshipTuples,
  reconcileConfigDrivenLlmModelRelationships,
  reconcileConfigDrivenMcpServerRelationships,
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
  reconcileShareableResource,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import { caipeOrgKey } from "@/lib/rbac/organization";
import {
  normalizeSharedWithTeamSlugs,
  repairWorkflowConfigTeamSlugRefs,
} from "@/lib/rbac/workflow-config-rebac";
import type {
  DynamicAgentConfig,
  MCPServerConfig,
  SubAgentRef,
  TransportType,
  VisibilityType,
} from "@/types/dynamic-agent";
import { PLATFORM_RAG_COLLECTION_ID } from "@/types/rag-collection";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
  IngestionSourceVisibility,
} from "@/types/ingestion-source";
import type {
  StepEntry,
  WorkflowConfig,
  WorkflowConfigVisibility,
} from "@/types/workflow-config";
import fs from "fs";
import yaml from "js-yaml";

// Pattern to match ${VAR_NAME} or ${VAR_NAME:-default}
const ENV_VAR_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface SeedModel {
  model_id: string;
  name: string;
  provider: string;
  description?: string;
}

interface SeedConfig {
  models: SeedModel[];
  agents: Record<string, unknown>[];
  mcp_servers: Record<string, unknown>[];
  workflow_configs: Record<string, unknown>[];
  rag_sources: Record<string, unknown>[];
}

/** Shape of documents in the llm_models collection. */
interface LLMModelDoc {
  _id: string; // model_id
  model_id: string;
  name: string;
  provider: string;
  description: string;
  config_driven: boolean;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════
// Env var expansion
// ═══════════════════════════════════════════════════════════════

/**
 * Recursively expand ${VAR} and ${VAR:-default} in values.
 *
 * In Kubernetes, Helm resolves values before creating the ConfigMap,
 * so the mounted YAML contains literal values. But in docker-compose
 * dev mode, the raw config.yaml is mounted and uses ${VAR:-default}
 * syntax, so we need this expansion for dev compatibility.
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      ENV_VAR_PATTERN,
      (_match: string, varName: string, defaultVal: string | undefined) => {
        const envValue = process.env[varName];
        if (envValue !== undefined) return envValue;
        if (defaultVal !== undefined) return defaultVal;
        console.warn(
          `[seed-config] Environment variable ${varName} not set and no default provided`,
        );
        return "";
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = expandEnvVars(v);
    }
    return result;
  }
  return value;
}

// ═══════════════════════════════════════════════════════════════
// YAML loading
// ═══════════════════════════════════════════════════════════════

export function loadSeedConfig(configPath: string): SeedConfig {
  console.log(`[seed-config] Loading configuration from: ${configPath}`);

  if (!fs.existsSync(configPath)) {
    console.warn(
      `[seed-config] Config not found at ${configPath}, skipping seed`,
    );
    return {
      models: [],
      agents: [],
      mcp_servers: [],
      workflow_configs: [],
      rag_sources: [],
    };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = (yaml.load(raw) as Record<string, unknown>) || {};

  // Models don't need env var expansion (no secrets)
  const models = (parsed.models ?? []) as SeedModel[];
  // Agents and servers may reference env vars in dev mode
  const agents = expandEnvVars(parsed.agents ?? []) as Record<
    string,
    unknown
  >[];
  const mcp_servers = expandEnvVars(parsed.mcp_servers ?? []) as Record<
    string,
    unknown
  >[];
  const workflow_configs = expandEnvVars(
    parsed.workflow_configs ?? [],
  ) as Record<string, unknown>[];
  const rag_sources = expandEnvVars(parsed.rag_sources ?? []) as Record<
    string,
    unknown
  >[];

  return { models, agents, mcp_servers, workflow_configs, rag_sources };
}

// ═══════════════════════════════════════════════════════════════
// Seeding functions
// ═══════════════════════════════════════════════════════════════

type AgentAllowedTools = DynamicAgentConfig["allowed_tools"];

function hasKnowledgeBaseTools(
  allowedTools: AgentAllowedTools | undefined,
): boolean {
  const selection = allowedTools?.["knowledge-base"];
  return selection === true || Array.isArray(selection);
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

async function reconcileSeededAgentRelationships(input: {
  agentId: string;
  previousAllowedTools?: AgentAllowedTools | null;
  nextAllowedTools?: AgentAllowedTools | null;
  ownerTeamSlug?: string | null;
  previousOwnerTeamSlug?: string | null;
  nextSharedTeamSlugs?: string[];
  previousSharedTeamSlugs?: string[];
  globalUserAccess?: boolean;
  previousGlobalUserAccess?: boolean;
  unlinkedServiceAccountSub?: string | null;
  logContext: string;
}): Promise<void> {
  try {
    // assisted-by Codex Codex-sonnet-4-6
    await reconcileAgentRelationships({
      agentId: input.agentId,
      previousAllowedTools: input.previousAllowedTools ?? {},
      nextAllowedTools: input.nextAllowedTools ?? {},
      ownerSubject: null,
      organizationId: caipeOrgKey(),
      ownerTeamSlug: input.ownerTeamSlug ?? null,
      previousOwnerTeamSlug: input.previousOwnerTeamSlug ?? null,
      nextSharedTeamSlugs: input.nextSharedTeamSlugs ?? [],
      previousSharedTeamSlugs: input.previousSharedTeamSlugs ?? [],
      globalUserAccess: input.globalUserAccess === true,
      previousGlobalUserAccess: input.previousGlobalUserAccess === true,
      unlinkedServiceAccountSub: input.unlinkedServiceAccountSub ?? null,
      failClosed: false,
    });
  } catch (error) {
    console.warn(
      `[seed-config] Failed to reconcile OpenFGA relationships for agent ${input.agentId} (${input.logContext}):`,
      error,
    );
  }
}

export async function seedAgents(
  agents: Record<string, unknown>[],
): Promise<number> {
  if (agents.length === 0) return 0;

  const collection = await getCollection<DynamicAgentConfig>("dynamic_agents");
  // Resolve once per seed pass rather than per agent — the sub is the same
  // for every agent seeded in this call.
  const unlinkedServiceAccountSub = await resolveUnlinkedServiceAccountSub();
  let count = 0;
  let platformRagExistsPromise: Promise<boolean> | undefined;
  const platformRagExists = (): Promise<boolean> => {
    platformRagExistsPromise ??= getCollection<{ _id: string }>(
      "rag_collections",
    )
      .then((collections) =>
        collections
          .findOne({ _id: PLATFORM_RAG_COLLECTION_ID } as never, {
            projection: { _id: 1 },
          })
          .then(Boolean),
      )
      .catch(() => false);
    return platformRagExistsPromise;
  };

  for (const agentData of agents) {
    const agentId = agentData.id as string | undefined;
    if (!agentId) {
      console.warn(
        `[seed-config] Skipping agent without id: ${agentData.name ?? "unknown"}`,
      );
      continue;
    }

    const now = new Date().toISOString();

    // Preserve created_at if document already exists
    const existing = await collection.findOne({ _id: agentId });

    if (existing?.config_import_adopted === true) {
      console.log(
        `[seed-config] Skipping agent ${agentId}: adopted via import, YAML seed ignored`,
      );
      continue;
    }

    const createdAt = existing?.created_at ?? now;

    // Optional `owner_team` (slug) in the config makes the seeded agent owned by
    // a team, which is what lets it be used in Slack channels mapped to that
    // team — the bot's channel ReBAC check probes `team:<slug>#member can_use
    // agent:<id>`, and only the OpenFGA reconcile below writes that tuple.
    // `visibility: global` alone grants `user:*`, which does NOT satisfy a
    // team-subject check.
    const ownerTeamSlug =
      (agentData.owner_team as string | undefined)?.trim() || null;
    const sharedTeamSlugs = (
      (agentData.shared_with_teams as string[] | undefined) ?? []
    ).filter((slug) => slug && slug !== ownerTeamSlug);

    const allowedTools =
      (agentData.allowed_tools as Record<string, string[] | boolean>) ?? {};
    const hasConfiguredDatasourceIds = Array.isArray(agentData.datasource_ids);
    const hasConfiguredCollectionIds = Array.isArray(
      agentData.rag_collection_ids,
    );
    const hasExistingDatasourceIds = Array.isArray(existing?.datasource_ids);
    const hasExistingCollectionIds = Array.isArray(
      existing?.rag_collection_ids,
    );
    let configuredDatasourceIds = hasConfiguredDatasourceIds
      ? normalizeStringArray(agentData.datasource_ids)
      : existing?.datasource_ids;
    let configuredCollectionIds = hasConfiguredCollectionIds
      ? normalizeStringArray(agentData.rag_collection_ids)
      : existing?.rag_collection_ids;
    if (
      hasKnowledgeBaseTools(allowedTools) &&
      !hasConfiguredDatasourceIds &&
      !hasConfiguredCollectionIds &&
      !hasExistingDatasourceIds &&
      !hasExistingCollectionIds &&
      (await platformRagExists())
    ) {
      // Match UI-created agents: after the explicit migration creates Platform
      // RAG, every config-driven agent without a prior explicit selection is
      // pinned to it instead of reviving the legacy unrestricted-corpus
      // behavior. This also covers an existing non-RAG agent whose config is
      // later changed to enable RAG. Empty arrays in Mongo or YAML remain an
      // explicit opt-out.
      configuredDatasourceIds = [];
      configuredCollectionIds = [PLATFORM_RAG_COLLECTION_ID];
    }

    const doc = {
      _id: agentId,
      name: (agentData.name as string) ?? agentId,
      description: (agentData.description as string) ?? "",
      system_prompt: (agentData.system_prompt as string) ?? "",
      allowed_tools: allowedTools,
      // Support both legacy (model_id/model_provider) and new (model.id/model.provider) formats
      model: agentData.model
        ? (agentData.model as { id: string; provider: string })
        : {
            id: (agentData.model_id as string) ?? "",
            provider: (agentData.model_provider as string) ?? "",
          },
      visibility: ((agentData.visibility as string) ??
        "global") as VisibilityType,
      shared_with_teams:
        sharedTeamSlugs.length > 0 ? sharedTeamSlugs : undefined,
      owner_team_slug: ownerTeamSlug ?? undefined,
      subagents: (agentData.subagents as SubAgentRef[]) ?? [],
      skills: (agentData.skills as string[]) ?? [],
      datasource_ids: configuredDatasourceIds,
      rag_collection_ids: configuredCollectionIds,
      builtin_tools:
        (agentData.builtin_tools as DynamicAgentConfig["builtin_tools"]) ??
        undefined,
      ui: (agentData.ui as DynamicAgentConfig["ui"]) ?? undefined,
      features:
        (agentData.features as DynamicAgentConfig["features"]) ?? undefined,
      interrupt_on:
        (agentData.interrupt_on as DynamicAgentConfig["interrupt_on"]) ??
        undefined,
      enabled: (agentData.enabled as boolean) ?? true,
      owner_id: "system",
      is_system: false,
      config_driven: true,
      created_at: createdAt,
      updated_at: now,
    };

    await collection.replaceOne({ _id: agentId }, doc, { upsert: true });

    // Write the OpenFGA ownership/share tuples so config-driven agents have
    // the same PDP-visible policy as agents saved through the editor.
    await reconcileSeededAgentRelationships({
      agentId,
      previousAllowedTools: existing?.allowed_tools,
      nextAllowedTools: doc.allowed_tools,
      ownerTeamSlug,
      previousOwnerTeamSlug: existing?.owner_team_slug ?? null,
      nextSharedTeamSlugs: sharedTeamSlugs,
      previousSharedTeamSlugs: normalizeStringArray(
        existing?.shared_with_teams,
      ),
      globalUserAccess: doc.visibility === "global",
      previousGlobalUserAccess: existing?.visibility === "global",
      unlinkedServiceAccountSub,
      logContext: "config seed",
    });

    console.log(`[seed-config] Seeded agent: ${agentId}`);
    count++;
  }

  return count;
}

/**
 * Adopt a set of config-driven agents into the DB as the source of truth.
 *
 * Sets `config_import_adopted: true` (so `seedAgents()`/`cleanupStaleConfigDriven()`
 * skip these IDs on every future restart, even while they remain in the YAML
 * seed file) and `config_driven: false` (so the admin UI treats them as
 * editable/deletable, matching every other DB-native agent). Applies the
 * given owner/shared team assignment to each adopted agent and reconciles
 * the corresponding OpenFGA tuples.
 *
 * Only agents currently present with `config_driven: true` are eligible —
 * already-adopted or DB-native agents are skipped so a re-run (or an
 * overlapping id list) can't silently reassign teams on agents outside the
 * batch the admin picked.
 */
export async function adoptConfigImportedAgents(
  agentIds: string[],
  teamAssignment: { ownerTeamSlug: string | null; sharedTeamSlugs: string[] },
): Promise<{ adopted: string[]; skipped: string[] }> {
  const collection = await getCollection<DynamicAgentConfig>("dynamic_agents");
  const ownerTeamSlug = teamAssignment.ownerTeamSlug;
  const sharedTeamSlugs = teamAssignment.sharedTeamSlugs.filter(
    (slug) => slug !== ownerTeamSlug,
  );
  const adopted: string[] = [];
  const skipped: string[] = [];
  const unlinkedServiceAccountSub = await resolveUnlinkedServiceAccountSub();

  for (const agentId of agentIds) {
    const existing = await collection.findOne({ _id: agentId });
    if (
      !existing ||
      existing.config_driven !== true ||
      existing.config_import_adopted === true
    ) {
      skipped.push(agentId);
      continue;
    }

    const nextVisibility: VisibilityType = ownerTeamSlug
      ? "team"
      : existing.visibility;
    const now = new Date().toISOString();

    await collection.updateOne(
      { _id: agentId },
      {
        $set: {
          config_driven: false,
          config_import_adopted: true,
          visibility: nextVisibility,
          owner_team_slug: ownerTeamSlug ?? undefined,
          shared_with_teams:
            sharedTeamSlugs.length > 0 ? sharedTeamSlugs : undefined,
          updated_at: now,
        },
      },
    );

    await reconcileSeededAgentRelationships({
      agentId,
      previousAllowedTools: existing.allowed_tools,
      nextAllowedTools: existing.allowed_tools,
      ownerTeamSlug,
      previousOwnerTeamSlug: existing.owner_team_slug ?? null,
      nextSharedTeamSlugs: sharedTeamSlugs,
      previousSharedTeamSlugs: normalizeStringArray(existing.shared_with_teams),
      globalUserAccess: nextVisibility === "global",
      previousGlobalUserAccess: existing.visibility === "global",
      unlinkedServiceAccountSub,
      logContext: "config import adopt",
    });

    console.log(`[seed-config] Adopted config-imported agent: ${agentId}`);
    adopted.push(agentId);
  }

  return { adopted, skipped };
}

async function seedMCPServers(
  servers: Record<string, unknown>[],
): Promise<number> {
  if (servers.length === 0) return 0;

  const collection = await getCollection<MCPServerConfig>("mcp_servers");
  let count = 0;

  for (const serverData of servers) {
    const serverId = serverData.id as string | undefined;
    if (!serverId) {
      console.warn(
        `[seed-config] Skipping MCP server without id: ${serverData.name ?? "unknown"}`,
      );
      continue;
    }

    const now = new Date().toISOString();

    // Preserve created_at if document already exists
    const existing = await collection.findOne({ _id: serverId });
    const createdAt = existing?.created_at ?? now;
    const source: MCPServerConfig["source"] | undefined =
      serverData.source === "manual" ||
      serverData.source === "config" ||
      serverData.source === "agentgateway"
        ? serverData.source
        : undefined;
    const agentgatewayEndpoint =
      typeof serverData.agentgateway_endpoint === "string"
        ? serverData.agentgateway_endpoint
        : undefined;
    const agentgatewayTargetEndpoint =
      typeof serverData.agentgateway_target_endpoint === "string"
        ? serverData.agentgateway_target_endpoint
        : undefined;

    const doc: MCPServerConfig = {
      _id: serverId,
      name: (serverData.name as string) ?? serverId,
      description: (serverData.description as string) ?? "",
      transport: ((serverData.transport as string) ?? "stdio") as TransportType,
      endpoint: (serverData.endpoint as string) ?? undefined,
      command: (serverData.command as string) ?? undefined,
      args: (serverData.args as string[]) ?? undefined,
      env: (serverData.env as Record<string, string>) ?? undefined,
      credential_sources: Array.isArray(serverData.credential_sources)
        ? (serverData.credential_sources as MCPServerConfig["credential_sources"])
        : undefined,
      enabled: (serverData.enabled as boolean) ?? true,
      config_driven: true,
      source,
      agentgateway_discovered:
        typeof serverData.agentgateway_discovered === "boolean"
          ? serverData.agentgateway_discovered
          : undefined,
      agentgateway_endpoint: agentgatewayEndpoint,
      agentgateway_target_endpoint: agentgatewayTargetEndpoint,
      created_at: createdAt,
      updated_at: now,
    };

    await collection.replaceOne({ _id: serverId }, doc, { upsert: true });
    await reconcileConfigDrivenMcpServerRelationships({
      serverId,
      organizationId: caipeOrgKey(),
    });
    console.log(`[seed-config] Seeded MCP server: ${serverId}`);
    count++;
  }

  return count;
}

async function seedAgentGatewayAdminAccess(): Promise<void> {
  try {
    const orgKey = caipeOrgKey();
    await writeOpenFgaTuples({
      writes: [
        {
          user: `organization:${orgKey}#admin`,
          relation: "manager",
          object: "mcp_server:agentgateway",
        },
      ],
      deletes: [],
    });
  } catch (error) {
    console.warn(
      "[seed-config] Failed to seed AgentGateway admin access:",
      error,
    );
  }
}

async function seedModels(models: SeedModel[]): Promise<number> {
  if (models.length === 0) return 0;

  const collection = await getCollection<LLMModelDoc>("llm_models");
  let count = 0;

  for (const model of models) {
    if (!model.model_id) {
      console.warn(
        `[seed-config] Skipping model without model_id: ${model.name ?? "unknown"}`,
      );
      continue;
    }

    const now = new Date().toISOString();

    const doc: LLMModelDoc = {
      _id: model.model_id,
      model_id: model.model_id,
      name: model.name ?? model.model_id,
      provider: model.provider ?? "unknown",
      description: model.description ?? "",
      config_driven: true,
      updated_at: now,
    };

    await collection.replaceOne({ _id: model.model_id }, doc, {
      upsert: true,
    });
    await reconcileConfigDrivenLlmModelRelationships({
      modelId: model.model_id,
      organizationId: caipeOrgKey(),
    }).catch((error) => {
      console.warn(
        `[seed-config] Failed to reconcile config-driven LLM model OpenFGA tuples for ${model.model_id}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
    count++;
  }

  console.log(`[seed-config] Seeded ${count} models`);
  return count;
}

async function seedWorkflowConfigs(
  configs: Record<string, unknown>[],
): Promise<number> {
  if (configs.length === 0) return 0;

  const collection = await getCollection<WorkflowConfig>("workflow_configs");
  let count = 0;

  for (const cfgData of configs) {
    const cfgId = cfgData.id as string | undefined;
    if (!cfgId) {
      console.warn(
        `[seed-config] Skipping workflow config without id: ${cfgData.name ?? "unknown"}`,
      );
      continue;
    }

    const now = new Date().toISOString();

    // Preserve created_at if document already exists
    const existing = await collection.findOne({ _id: cfgId });
    const createdAt = existing?.created_at ?? now;

    const visibility = ((cfgData.visibility as string) ??
      "global") as WorkflowConfigVisibility;
    const steps = (cfgData.steps ?? []) as StepEntry[];
    let sharedWithTeams =
      visibility === "team"
        ? ((cfgData.shared_with_teams as string[]) ?? undefined)
        : undefined;
    if (sharedWithTeams?.length) {
      sharedWithTeams = await normalizeSharedWithTeamSlugs(sharedWithTeams);
    }

    // Ensure each step has type: "step" (YAML may omit it)
    for (const step of steps) {
      if (!step.type) {
        (step as unknown as Record<string, unknown>).type = "step";
      }
    }

    const doc = {
      _id: cfgId,
      name: (cfgData.name as string) ?? cfgId,
      description: (cfgData.description as string) ?? "",
      steps,
      owner_id: "system",
      visibility,
      shared_with_teams: sharedWithTeams,
      config_driven: true,
      created_at: createdAt,
      updated_at: now,
    };

    await collection.replaceOne({ _id: cfgId }, doc, { upsert: true });
    try {
      await reconcileShareableResource({
        objectType: "task",
        objectId: cfgId,
        sharedWithOrg: visibility === "global",
        previousSharedWithOrg:
          existing?.visibility === "global" && visibility !== "global",
        memberRelations: ["reader", "user"],
        nextSharedTeamSlugs:
          visibility === "team" ? (sharedWithTeams ?? []) : [],
        previousSharedTeamSlugs:
          existing?.visibility === "team"
            ? (existing.shared_with_teams ?? [])
            : [],
      });
    } catch (err) {
      console.warn(
        `[seed-config] OpenFGA reconcile for workflow config ${cfgId} failed:`,
        err,
      );
    }
    console.log(`[seed-config] Seeded workflow config: ${cfgId}`);
    count++;
  }

  return count;
}

const INGESTION_SOURCE_TYPES: readonly IngestionSourceType[] = [
  "slack_channel",
  "confluence_space",
  "jira_project",
  "web_url",
  "webex_space",
];

/**
 * Extract the `source_type`-specific identity/config fields from a raw YAML
 * entry, keyed identically to the discriminated `IngestionSourceConfig`
 * union (ui/src/types/ingestion-source.ts). Returns `null` when the entry's
 * `source_type` is missing/unrecognized or its required identity fields are
 * absent, so the caller can skip the entry the same way `seedAgents` skips
 * entries missing `id`.
 */
/**
 * Exported so the `migrate-from-config` admin preview route can compute the
 * same deterministic `source_id` for a raw YAML entry without duplicating
 * the per-type identity-field switch.
 */
export function extractRagSourceTypeFields(
  sourceData: Record<string, unknown>,
): {
  identity: IngestionSourceIdentity;
  fields: Record<string, unknown>;
} | null {
  const sourceType = sourceData.source_type as IngestionSourceType | undefined;
  if (!sourceType || !INGESTION_SOURCE_TYPES.includes(sourceType)) return null;

  switch (sourceType) {
    case "slack_channel": {
      const channelId = sourceData.channel_id as string | undefined;
      if (!channelId) return null;
      return {
        identity: { source_type: "slack_channel", channel_id: channelId },
        fields: {
          source_type: sourceType,
          channel_id: channelId,
          lookback_days: sourceData.lookback_days as number | undefined,
          include_bots: sourceData.include_bots as boolean | undefined,
        },
      };
    }
    case "confluence_space": {
      const confluenceUrl = sourceData.confluence_url as string | undefined;
      const spaceKey = sourceData.space_key as string | undefined;
      const startPageUrl = sourceData.start_page_url as string | undefined;
      const parsedPage = startPageUrl
        ? parseConfluencePageUrl(startPageUrl)
        : null;
      if (
        !confluenceUrl ||
        !spaceKey ||
        !startPageUrl ||
        !parsedPage ||
        parsedPage.spaceKey !== spaceKey
      ) return null;
      return {
        identity: {
          source_type: "confluence_space",
          confluence_url: confluenceUrl,
          space_key: spaceKey,
          page_id: parsedPage.pageId,
        },
        fields: {
          source_type: sourceType,
          confluence_url: confluenceUrl,
          space_key: spaceKey,
          start_page_url: startPageUrl,
        },
      };
    }
    case "jira_project": {
      const projectKey = sourceData.project_key as string | undefined;
      const sourceSlug = sourceData.source_slug as string | undefined;
      if (!projectKey || !sourceSlug) return null;
      return {
        identity: {
          source_type: "jira_project",
          project_key: projectKey,
          source_slug: sourceSlug,
        },
        fields: {
          source_type: sourceType,
          project_key: projectKey,
          source_slug: sourceSlug,
          jql: (sourceData.jql as string) ?? "",
          include_comments: sourceData.include_comments as boolean | undefined,
        },
      };
    }
    case "web_url": {
      const url = sourceData.url as string | undefined;
      if (!url) return null;
      return {
        identity: { source_type: "web_url", url },
        fields: { source_type: sourceType, url },
      };
    }
    case "webex_space": {
      const spaceId = sourceData.space_id as string | undefined;
      if (!spaceId) return null;
      return {
        identity: { source_type: "webex_space", space_id: spaceId },
        fields: { source_type: sourceType, space_id: spaceId },
      };
    }
  }
}

export async function seedRagSources(
  sources: Record<string, unknown>[],
): Promise<number> {
  if (sources.length === 0) return 0;

  const collection = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  let count = 0;

  for (const sourceData of sources) {
    const extracted = extractRagSourceTypeFields(sourceData);
    if (!extracted) {
      console.warn(
        `[seed-config] Skipping rag source with missing identity fields: ${sourceData.name ?? "unknown"}`,
      );
      continue;
    }
    const sourceId = computeIngestionSourceId(extracted.identity);

    const now = new Date().toISOString();
    const existing = await collection.findOne({ source_id: sourceId } as never);

    if (existing?.config_import_adopted === true) {
      console.log(
        `[seed-config] Skipping rag source ${sourceId}: adopted via import, YAML seed ignored`,
      );
      continue;
    }

    const createdAt = existing?.created_at ?? now;
    const ownerTeamSlug =
      (sourceData.owner_team as string | undefined)?.trim() || null;
    // RAG source management has exactly one optional owner team. Retain the
    // legacy field only long enough to revoke its old tuples below; never
    // project or persist management shares for a newly-seeded record.
    const previousManagementSharedTeamSlugs = normalizeStringArray(
      existing?.shared_with_teams,
    );
    // Config-driven sources default to global visibility (an operator declaring a
    // source in Helm with no owner_team is very likely intending it to be broadly
    // readable) — mirrors seedAgents' `visibility ?? "global"` default, unlike
    // API-created sources which default to "team".
    const visibility = ((sourceData.visibility as string) ??
      "global") as IngestionSourceVisibility;
    const hasCanonicalSearchPolicy = Object.prototype.hasOwnProperty.call(
      sourceData,
      "search_with_teams",
    );
    const hasExplicitSearchPolicy =
      hasCanonicalSearchPolicy ||
      Object.prototype.hasOwnProperty.call(sourceData, "search_owner_team") ||
      Object.prototype.hasOwnProperty.call(
        sourceData,
        "search_shared_with_teams",
      );
    const legacySearchOwnerTeamSlug =
      (sourceData.search_owner_team as string | undefined)?.trim() || null;
    const rawSearchTeamSlugs = hasCanonicalSearchPolicy
      ? normalizeStringArray(sourceData.search_with_teams)
      : [
          ...(legacySearchOwnerTeamSlug ? [legacySearchOwnerTeamSlug] : []),
          ...normalizeStringArray(sourceData.search_shared_with_teams),
        ];
    const searchTeamSlugs = Array.from(
      new Set(rawSearchTeamSlugs.map((slug) => slug.trim()).filter(Boolean)),
    );
    const previousSearchTeamSlugs = Array.isArray(existing?.search_with_teams)
      ? Array.from(
          new Set(
            existing.search_with_teams
              .map((slug) => slug.trim())
              .filter(Boolean),
          ),
        )
      : existing?.search_owner_team_slug
        ? [existing.search_owner_team_slug]
        : [];
    const persistedSearchTeamSlugs = hasExplicitSearchPolicy
      ? searchTeamSlugs
      : previousSearchTeamSlugs;

    const doc = {
      source_id: sourceId,
      ...extracted.fields,
      name: (sourceData.name as string) ?? sourceId,
      description: (sourceData.description as string) ?? "",
      default_chunk_size: (sourceData.default_chunk_size as number) ?? 10000,
      default_chunk_overlap:
        (sourceData.default_chunk_overlap as number) ?? 2000,
      reload_interval: (sourceData.reload_interval as number) ?? 86400,
      status: existing?.status ?? "pending",
      visibility,
      shared_with_teams: [],
      search_with_teams: persistedSearchTeamSlugs,
      owner_team_slug: ownerTeamSlug ?? undefined,
      owner_id: ownerTeamSlug ? undefined : "system",
      config_driven: true,
      config_import_adopted: false,
      created_at: createdAt,
      updated_at: now,
    } as unknown as IngestionSourceConfig;

    // Management and Search Access are separate. Config supports the new
    // `search_with_teams` list while accepting the two old search aliases for
    // a transition period. Legacy management shares are revoked on the next
    // seed, and a search team never receives a manager tuple.
    const previousOwnerTeamSlug = existing?.owner_team_slug ?? null;
    await reconcileIngestionSourceRelationships({
      sourceId,
      ownerTeamSlug,
      previousOwnerTeamSlug,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: previousManagementSharedTeamSlugs,
      globalUserAccess: visibility === "global",
      previousGlobalUserAccess: existing?.visibility === "global",
    });
    if (hasExplicitSearchPolicy) {
      await reconcileKnowledgeBaseRelationships({
        knowledgeBaseId: sourceId,
        ownerTeamSlug: null,
        // The prior alias modeled this team as a KB owner. Treat it as the
        // previous owner once so its stale manager tuple is removed while its
        // explicit Search grant remains in the desired reader set.
        previousOwnerTeamSlug:
          existing?.search_owner_team_slug ?? legacySearchOwnerTeamSlug,
        nextSharedTeamSlugs: searchTeamSlugs,
        previousSharedTeamSlugs: previousSearchTeamSlugs,
        previousSharedTeamAdminsManage: true,
      });
      await reconcileDataSourceRelationships({
        dataSourceId: sourceId,
        parentKnowledgeBaseId: sourceId,
      });
    }

    await collection.replaceOne({ source_id: sourceId } as never, doc, {
      upsert: true,
    });

    console.log(`[seed-config] Seeded rag source: ${sourceId}`);
    count++;
  }

  return count;
}

/** Why a source_id was skipped by {@link adoptConfigImportedRagSources}. */
export type RagSourceAdoptSkipReason =
  | "not_found"
  | "not_config_driven"
  | "already_adopted";

export interface RagSourceAdoptSkip {
  source_id: string;
  reason: RagSourceAdoptSkipReason;
}

/**
 * Adopt a set of config-driven rag ingestion sources into the DB as the
 * source of truth. Mirrors `adoptConfigImportedAgents`'s eligibility guard
 * (only sources currently `{config_driven: true, config_import_adopted:
 * {$ne: true}}` are eligible, so a re-run or an overlapping id list can't
 * silently reassign teams on sources outside the batch the admin picked),
 * but reports *why* each id was skipped — the migrate-from-config admin
 * preview needs to distinguish "already adopted" (fine, no-op) from "not
 * found" / "not config-driven" (caller error) rather than lumping them
 * together as `adoptConfigImportedAgents` does.
 */
export async function adoptConfigImportedRagSources(
  sourceIds: string[],
  ownership: {
    ownerTeamSlug: string | null;
    ownerSubject?: string | null;
  },
): Promise<{ adopted: string[]; skipped: RagSourceAdoptSkip[] }> {
  const collection = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  const ownerTeamSlug = ownership.ownerTeamSlug;
  const ownerSubject = ownerTeamSlug ? null : (ownership.ownerSubject ?? null);
  const adopted: string[] = [];
  const skipped: RagSourceAdoptSkip[] = [];

  for (const sourceId of sourceIds) {
    const existing = await collection.findOne({ source_id: sourceId } as never);
    if (!existing) {
      skipped.push({ source_id: sourceId, reason: "not_found" });
      continue;
    }
    // Adoption flips config_driven to false, so an already-adopted record
    // also fails the config_driven check below — check config_import_adopted
    // first so its skip reason takes precedence.
    if (existing.config_import_adopted === true) {
      skipped.push({ source_id: sourceId, reason: "already_adopted" });
      continue;
    }
    if (existing.config_driven !== true) {
      skipped.push({ source_id: sourceId, reason: "not_config_driven" });
      continue;
    }

    const nextVisibility: IngestionSourceVisibility = ownerTeamSlug || ownerSubject
      ? "team"
      : existing.visibility;
    const now = new Date().toISOString();

    // Adoption changes source-management policy only. Query ownership stays
    // intact and remains editable through Search access.
    const previousOwnerTeamSlug = existing.owner_team_slug ?? null;
    const previousOwnerSubject = existing.owner_subject ?? null;
    const previousSharedTeamSlugs = normalizeStringArray(
      existing.shared_with_teams,
    );
    await reconcileIngestionSourceRelationships({
      sourceId,
      ownerSubject,
      previousOwnerSubject,
      ownerTeamSlug,
      previousOwnerTeamSlug,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs,
      globalUserAccess: nextVisibility === "global",
      previousGlobalUserAccess: existing.visibility === "global",
    });
    await collection.updateOne(
      { source_id: sourceId } as never,
      {
        $set: {
          config_driven: false,
          config_import_adopted: true,
          visibility: nextVisibility,
          ...(ownerTeamSlug ? { owner_team_slug: ownerTeamSlug } : {}),
          ...(ownerSubject ? { owner_subject: ownerSubject } : {}),
          shared_with_teams: [],
          updated_at: now,
        },
        $unset: ownerTeamSlug
          ? { owner_subject: "" }
          : ownerSubject
            ? { owner_team_slug: "" }
            : {},
      } as never,
    );

    console.log(
      `[seed-config] Adopted config-imported rag source: ${sourceId}`,
    );
    adopted.push(sourceId);
  }

  return { adopted, skipped };
}

// ═══════════════════════════════════════════════════════════════
// Stale cleanup
// ═══════════════════════════════════════════════════════════════

/**
 * Remove config-driven entities that are no longer in the config.
 *
 * When an entity is removed from config.yaml, it should be deleted
 * from the database on the next server restart.
 */
export async function cleanupStaleConfigDriven(
  currentAgentIds: Set<string>,
  currentServerIds: Set<string>,
  currentModelIds: Set<string>,
  currentWorkflowIds: Set<string>,
  currentRagSourceIds: Set<string>,
): Promise<void> {
  // Cleanup stale agents
  const agentCollection =
    await getCollection<DynamicAgentConfig>("dynamic_agents");
  const staleAgents = await agentCollection
    .find({
      config_driven: true,
      config_import_adopted: { $ne: true },
    } as never)
    .toArray();
  let agentsDeleted = 0;
  for (const agent of staleAgents) {
    if (!currentAgentIds.has(agent._id)) {
      console.log(
        `[seed-config] Removing stale config-driven agent: ${agent._id}`,
      );
      await agentCollection.deleteOne({ _id: agent._id });
      agentsDeleted++;
    }
  }

  // Cleanup stale MCP servers.
  //
  // Only delete servers that were seeded from the YAML config. AgentGateway-
  // *discovered* servers also carry `config_driven: true` (so they're managed,
  // not user-editable), but they are NOT part of the seed YAML — they're
  // provisioned at runtime by MCP discovery/sync. Without the `source` guard,
  // every restart wiped them (the seed config declares no `mcp_servers`),
  // which silently removed e.g. the `knowledge-base` server and reintroduced
  // the empty-Bearer 401 until the operator re-synced.
  const serverCollection = await getCollection<MCPServerConfig>("mcp_servers");
  const staleServers = await serverCollection
    .find({ config_driven: true, source: { $ne: "agentgateway" } } as never)
    .toArray();
  let serversDeleted = 0;
  for (const server of staleServers) {
    if (!currentServerIds.has(server._id)) {
      console.log(
        `[seed-config] Removing stale config-driven MCP server: ${server._id}`,
      );
      await serverCollection.deleteOne({ _id: server._id });
      serversDeleted++;
    }
  }

  // Cleanup stale models
  const modelCollection = await getCollection<LLMModelDoc>("llm_models");
  const staleModels = await modelCollection
    .find({ config_driven: true })
    .toArray();
  let modelsDeleted = 0;
  for (const model of staleModels) {
    if (!currentModelIds.has(model._id)) {
      console.log(
        `[seed-config] Removing stale config-driven model: ${model._id}`,
      );
      await modelCollection.deleteOne({ _id: model._id });
      modelsDeleted++;
    }
  }

  // Cleanup stale workflow configs
  const workflowCollection =
    await getCollection<WorkflowConfig>("workflow_configs");
  const staleWorkflows = await workflowCollection
    .find({ config_driven: true })
    .toArray();
  let workflowsDeleted = 0;
  for (const wf of staleWorkflows) {
    if (!currentWorkflowIds.has(wf._id)) {
      console.log(
        `[seed-config] Removing stale config-driven workflow config: ${wf._id}`,
      );
      await workflowCollection.deleteOne({ _id: wf._id });
      workflowsDeleted++;
    }
  }

  // Cleanup stale rag ingestion sources. No `source: {$ne: "agentgateway"}`-style
  // extra guard needed — unlike MCP servers, nothing else discovers/writes
  // `rag_ingestion_sources` records at runtime with `config_driven: true`
  // outside this seed path.
  const ragSourceCollection = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  const staleRagSources = await ragSourceCollection
    .find({
      config_driven: true,
      config_import_adopted: { $ne: true },
    } as never)
    .toArray();
  let ragSourcesDeleted = 0;
  for (const source of staleRagSources) {
    if (!currentRagSourceIds.has(source.source_id)) {
      console.log(
        `[seed-config] Removing stale config-driven rag source: ${source.source_id}`,
      );
      // Removing source configuration must not revoke independent query
      // grants for data that may still be populated by a legacy env-driven
      // ingestor. It does need exact management-tuple cleanup.
      if (isOpenFgaReconciliationEnabled()) {
        await deleteAllIngestionSourceRelationshipTuples(source.source_id);
      }
      await ragSourceCollection.deleteOne({
        source_id: source.source_id,
      } as never);
      ragSourcesDeleted++;
    }
  }

  if (
    agentsDeleted ||
    serversDeleted ||
    modelsDeleted ||
    workflowsDeleted ||
    ragSourcesDeleted
  ) {
    console.log(
      `[seed-config] Cleaned up stale config-driven entities: ` +
        `${agentsDeleted} agents, ${serversDeleted} servers, ${modelsDeleted} models, ${workflowsDeleted} workflows, ${ragSourcesDeleted} rag sources`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

/**
 * Default "Hello World" dynamic agent provisioned on a fresh install when
 * no other agents exist. Exported for tests; callers should go through
 * `bootstrapDefaultDynamicAgentIfEmpty()` so they get the empty-collection
 * guard.
 *
 * Notes on the shape:
 * - `config_driven: false` so admins can edit or delete it through the
 *   normal Custom Agents UI. The bootstrap is a one-time seed, not a
 *   policy lock — operators who want a curated default should add their
 *   agent to the seed YAML and the bootstrap will then no-op (collection
 *   no longer empty).
 * - `model: { id: "", provider: "" }` defers model selection to the
 *   dynamic-agents backend default. Hard-coding a model here would
 *   couple bootstrap behavior to a specific deployment.
 * - Built-in tools enabled with conservative defaults (`fetch_url` allow-list
 *   `*`, `sleep.max_seconds: 60`, `request_user_input` for workflow HITL).
 *   Lock-down environments can tighten these via the UI after first login.
 */
export const HELLO_WORLD_AGENT_ID = "hello-world";

/** Bump when bootstrap fields change so reconcile updates existing installs. */
export const HELLO_WORLD_BOOTSTRAP_REVISION = 2;

export function buildHelloWorldAgentDoc(now: string): DynamicAgentConfig {
  return {
    _id: HELLO_WORLD_AGENT_ID,
    name: "Hello World",
    description:
      "Default starter agent for testing CAIPE and demo workflows. Supports structured user input (forms), fetch URL, time, user info, and short waits. Edit or delete via the Custom Agents UI.",
    system_prompt: `You are Hello World, a friendly default assistant for testing and validating CAIPE.

When you need information from the user, always use the \`request_user_input\` tool with a clear prompt and structured fields. Do not ask questions in plain chat and wait for a reply — the user is not in the agent chat during workflow runs.

When a workflow step asks you to save data for later steps, use \`write_file\` on the workflow filesystem (for example \`choices.txt\` or \`movie_title.txt\` at the root). After collecting input via \`request_user_input\`, write the answers into the required files before finishing the step.

Be concise and helpful.`,
    allowed_tools: {},
    model: { id: "", provider: "" },
    visibility: "global",
    subagents: [],
    skills: [],
    builtin_tools: {
      fetch_url: { enabled: true, allowed_domains: "*" },
      current_datetime: { enabled: true },
      user_info: { enabled: true },
      sleep: { enabled: true, max_seconds: 60 },
      request_user_input: { enabled: true },
    },
    interrupt_on: { builtin: { request_user_input: true } },
    hello_world_bootstrap_revision: HELLO_WORLD_BOOTSTRAP_REVISION,
    enabled: true,
    owner_id: "system",
    is_system: false,
    config_driven: false,
    created_at: now,
    updated_at: now,
  } as DynamicAgentConfig;
}

/**
 * Provision the "Hello World" default dynamic agent if and only if the
 * `dynamic_agents` collection is empty. Idempotent and safe to call on
 * every startup. Returns `true` when an agent was inserted, `false`
 * otherwise (already populated, MongoDB unavailable, or insert failed).
 */
export async function bootstrapDefaultDynamicAgentIfEmpty(): Promise<boolean> {
  if (!isMongoDBConfigured) return false;

  const collection = await getCollection<DynamicAgentConfig>("dynamic_agents");
  const existingCount = await collection.countDocuments({});
  if (existingCount > 0) return false;

  const doc = buildHelloWorldAgentDoc(new Date().toISOString());
  // Use insertOne to make the empty-collection invariant explicit. If a
  // racing seedAgents() inserted something between countDocuments() and
  // here, the unique _id index would already protect us, but a duplicate
  // key error would still be reported — that's the right signal.
  try {
    await collection.insertOne(doc);
    await reconcileSeededAgentRelationships({
      agentId: HELLO_WORLD_AGENT_ID,
      previousAllowedTools: {},
      nextAllowedTools: doc.allowed_tools,
      ownerTeamSlug: null,
      previousOwnerTeamSlug: null,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
      globalUserAccess: true,
      previousGlobalUserAccess: false,
      unlinkedServiceAccountSub: await resolveUnlinkedServiceAccountSub(),
      logContext: "bootstrap insert",
    });
  } catch (err) {
    // Duplicate-key races are benign — another caller (or the YAML seed)
    // beat us to it. Anything else is worth surfacing.
    const code = (err as { code?: number } | null)?.code;
    if (code === 11000) {
      console.log(
        "[seed-config] default dynamic agent already present (race), skipping",
      );
      return false;
    }
    throw err;
  }
  console.log(
    `[seed-config] Provisioned default dynamic agent: ${HELLO_WORLD_AGENT_ID}`,
  );
  return true;
}

/**
 * Refresh the bootstrap Hello World agent when it is still owned by `system`
 * and its bootstrap revision is behind {@link HELLO_WORLD_BOOTSTRAP_REVISION}.
 * Does not overwrite agents the operator re-owned or deleted.
 */
export async function reconcileHelloWorldBootstrapAgent(): Promise<boolean> {
  if (!isMongoDBConfigured) return false;

  const collection = await getCollection<DynamicAgentConfig>("dynamic_agents");
  const now = new Date().toISOString();
  const doc = buildHelloWorldAgentDoc(now);
  const unlinkedServiceAccountSub = await resolveUnlinkedServiceAccountSub();

  const result = await collection.updateOne(
    {
      _id: HELLO_WORLD_AGENT_ID,
      owner_id: "system",
      $or: [
        { hello_world_bootstrap_revision: { $exists: false } },
        {
          hello_world_bootstrap_revision: {
            $lt: HELLO_WORLD_BOOTSTRAP_REVISION,
          },
        },
      ],
    },
    {
      $set: {
        description: doc.description,
        system_prompt: doc.system_prompt,
        builtin_tools: doc.builtin_tools,
        interrupt_on: doc.interrupt_on,
        hello_world_bootstrap_revision: HELLO_WORLD_BOOTSTRAP_REVISION,
        updated_at: now,
      },
    },
  );

  if (result.modifiedCount > 0) {
    await reconcileSeededAgentRelationships({
      agentId: HELLO_WORLD_AGENT_ID,
      previousAllowedTools: {},
      nextAllowedTools: doc.allowed_tools,
      ownerTeamSlug: null,
      previousOwnerTeamSlug: null,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
      globalUserAccess: true,
      previousGlobalUserAccess: false,
      unlinkedServiceAccountSub,
      logContext: "bootstrap revision update",
    });
    console.log(
      `[seed-config] Reconciled bootstrap agent ${HELLO_WORLD_AGENT_ID} to revision ${HELLO_WORLD_BOOTSTRAP_REVISION}`,
    );
    return true;
  }
  const existing = await collection.findOne({
    _id: HELLO_WORLD_AGENT_ID,
    owner_id: "system",
  });
  if (existing) {
    await reconcileSeededAgentRelationships({
      agentId: HELLO_WORLD_AGENT_ID,
      previousAllowedTools: existing.allowed_tools,
      nextAllowedTools: existing.allowed_tools ?? doc.allowed_tools,
      ownerTeamSlug: existing.owner_team_slug ?? null,
      previousOwnerTeamSlug: existing.owner_team_slug ?? null,
      nextSharedTeamSlugs: normalizeStringArray(existing.shared_with_teams),
      previousSharedTeamSlugs: normalizeStringArray(existing.shared_with_teams),
      globalUserAccess: existing.visibility === "global",
      previousGlobalUserAccess: existing.visibility === "global",
      unlinkedServiceAccountSub,
      logContext: "bootstrap self-heal",
    });
  }
  return false;
}

/**
 * ID of the bootstrap identity-group-sync rule that gets seeded on a fresh
 * install when IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS=true and no rules exist.
 * Exposed so admins can recognize the seeded rule in the Admin UI / API and
 * tests can target it.
 */
export const AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID =
  "auto-create-teams-bootstrap";

const AUTO_CREATE_TEAMS_BOOTSTRAP_ACTOR = "system:auto-create-teams-bootstrap";

/**
 * Build the permissive default identity-group-sync rule. One rule that:
 * - Matches every group claim via `^(?<team>.+)$` so the captured `team`
 *   substitutes into the templates verbatim.
 * - Names and slugs the team after the group itself (`{{team}}`); the slug
 *   normalizer downstream handles casing and special chars.
 * - Maps every member to `member` (admins still come from
 *   BOOTSTRAP_ADMIN_EMAILS — silently promoting from claims would be
 *   surprising and unsafe).
 * - Has `auto_create_team: true` so the planner is allowed to create teams.
 * - Sits at `priority: 1000` (higher numeric priority = lower precedence
 *   per identity-group-rule-matcher.ts:73) so any admin-authored rule
 *   wins for groups it cares about.
 *
 * Exported for tests; production callers should use the
 * `bootstrapDefaultIdentityGroupSyncRuleIfEmpty()` wrapper which gates on
 * the env var and the empty-collection invariant.
 */
export function buildAutoCreateTeamsBootstrapRule(now: string) {
  return {
    id: AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID,
    // Wildcard so the single catch-all applies to every IdP (login OIDC
    // claims AND the background Okta directory sync). listIdentityGroupSyncRules
    // returns "*" rules alongside any provider-scoped rules.
    provider_id: "*",
    name: "Auto-create teams from IdP group claims (bootstrap)",
    priority: 1000,
    enabled: true,
    review_status: "enabled" as const,
    include_patterns: ["^(?<team>.+)$"],
    exclude_patterns: [],
    team_name_template: "{{team}}",
    team_slug_template: "{{team}}",
    role_map: {},
    auto_create_team: true,
    created_by: AUTO_CREATE_TEAMS_BOOTSTRAP_ACTOR,
    created_at: now,
    updated_by: AUTO_CREATE_TEAMS_BOOTSTRAP_ACTOR,
    updated_at: now,
  };
}

/**
 * Provision (or repair) the bootstrap identity-group-sync rule when
 * `IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS === "true"`.
 *
 * Strategy: upsert by the well-known bootstrap rule ID rather than gating
 * on an empty collection. This means:
 * - Fresh installs: rule is inserted.
 * - Existing installs where the rule was seeded with an old `provider_id`
 *   (e.g. "oidc-claims" instead of "*"): the stale row is updated so both
 *   the OIDC login sync and the Okta directory sync pick it up.
 * - Admin-curated rules with different IDs are never touched.
 *
 * Returns `true` if the rule was inserted or updated, `false` otherwise.
 * Idempotent.
 */
export async function bootstrapDefaultIdentityGroupSyncRuleIfEmpty(): Promise<boolean> {
  if (process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS !== "true") {
    return false;
  }
  if (!isMongoDBConfigured) return false;

  const collection = await getCollection<{
    id: string;
    provider_id?: string;
    name?: string;
  }>("identity_group_sync_rules");

  const now = new Date().toISOString();
  const rule = buildAutoCreateTeamsBootstrapRule(now);

  const existing = await collection.findOne({
    id: AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID,
  } as { id: string });

  if (!existing) {
    try {
      await collection.insertOne(rule as { id: string });
      console.log(
        `[seed-config] Provisioned identity-group-sync rule: ${AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID} (auto-create teams from any IdP group claim, role=member)`,
      );
      return true;
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 11000) {
        console.log(
          "[seed-config] auto-create-teams bootstrap rule already present (race), skipping",
        );
        return false;
      }
      throw err;
    }
  }

  // Rule exists — update fields that may be stale from an older seed (e.g.
  // provider_id was "oidc-claims" before the wildcard "*" was introduced).
  const needsUpdate =
    existing.provider_id !== rule.provider_id || existing.name !== rule.name;

  if (!needsUpdate) return false;

  await collection.updateOne(
    { id: AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID } as { id: string },
    {
      $set: {
        provider_id: rule.provider_id,
        name: rule.name,
        updated_at: now,
        updated_by: AUTO_CREATE_TEAMS_BOOTSTRAP_ACTOR,
      },
    } as object,
  );
  console.log(
    `[seed-config] Updated identity-group-sync bootstrap rule: provider_id=${rule.provider_id}`,
  );
  return true;
}

/**
 * Backfill `credential_sources` on built-in MCP servers that are missing them.
 *
 * AgentGateway discovery (the UI's MCP-server provisioning path) historically
 * wrote `mcp_servers` documents without `credential_sources`, so transform-based
 * routes received an empty Bearer and the upstream 401'd (most visibly
 * `knowledge-base`/RAG). Fresh discoveries now attach the built-ins, but
 * documents already persisted in an existing deployment need a one-time fix.
 *
 * This runs automatically on every server startup, so an operator's only
 * "migration" step is rolling out the new image (e.g. `helm upgrade`). It is
 * idempotent and non-destructive:
 *   - Only matches docs where `credential_sources` is absent. An explicit empty
 *     array means the operator cleared credentials and must not be backfilled.
 *   - Keyed by the same {@link BUILTIN_MCP_CREDENTIAL_SOURCES} map used by fresh
 *     discovery, so the backfill and insert paths cannot drift.
 *
 * @returns the number of documents actually updated (for logging).
 */
export async function backfillBuiltinMcpCredentialSources(): Promise<number> {
  if (!isMongoDBConfigured) return 0;
  const collection = await getCollection<MCPServerConfig>("mcp_servers");
  let updated = 0;
  for (const [id, sources] of Object.entries(BUILTIN_MCP_CREDENTIAL_SOURCES)) {
    const result = await collection.updateOne(
      {
        _id: id,
        credential_sources: { $exists: false },
      },
      {
        $set: {
          credential_sources: sources,
          updated_at: new Date().toISOString(),
        },
      },
    );
    if (result.modifiedCount > 0) {
      updated += result.modifiedCount;
      console.log(
        `[seed-config] Backfilled credential_sources for MCP server: ${id}`,
      );
    }
  }
  return updated;
}

/**
 * First-run / post-wipe safety net for AgentGateway-discovered MCP servers.
 *
 * Discovered servers (`source: "agentgateway"`) are runtime-provisioned from
 * AgentGateway's live route table — the YAML seed never declares them, and
 * `backfillBuiltinMcpCredentialSources` only UPDATES existing docs. So once the
 * `mcp_servers` collection loses its discovered rows (e.g. wiped by an older
 * build that lacked the cleanup guard), nothing repopulates them unless this
 * repair pass runs, leaving built-in MCP routes absent from the UI.
 *
 * This runs ONE discovery pass at startup, but only when there are zero
 * discovered servers, so it self-heals an empty/wiped collection without
 * touching a healthy one. Idempotent and best-effort: any non-empty discovered
 * set short-circuits, and a failed/unreachable AgentGateway is logged and
 * swallowed (an empty collection is no worse than before).
 *
 * Returns the number of servers added/migrated by the heal (0 when skipped).
 */
export async function selfHealDiscoveredMcpServersIfEmpty(): Promise<number> {
  if (!isMongoDBConfigured) return 0;

  const collection = await getCollection<MCPServerConfig>("mcp_servers");
  const discoveredCount = await collection.countDocuments({
    source: "agentgateway",
  });
  if (discoveredCount > 0) return 0;

  try {
    const { syncSelectedAgentGatewayMcpServers } = await import(
      "@/app/api/mcp-servers/agentgateway/_lib"
    );
    const result = await syncSelectedAgentGatewayMcpServers();
    const healed = result.summary.added + result.summary.migrated;
    if (healed > 0) {
      console.log(
        `[seed-config] Self-healed ${healed} AgentGateway MCP server(s) ` +
          "into an empty collection (post-wipe / first-run recovery)",
      );
    }
    return healed;
  } catch (err) {
    // AgentGateway unreachable or sync failed — leave the collection empty
    // (operator can still click Sync). Never block startup.
    console.error(
      "[seed-config] AgentGateway MCP self-heal threw (collection left empty):",
      err,
    );
    return 0;
  }
}

/**
 * Reconcile OpenFGA tuples for platform-managed MCP servers already in Mongo.
 * Applies policy changes (e.g. revoking org-wide invoker) on every UI restart
 * without requiring a manual AgentGateway sync.
 */
export async function reconcileExistingPlatformMcpServerOpenFgaTuples(): Promise<number> {
  if (!isMongoDBConfigured || !isOpenFgaReconciliationEnabled()) return 0;

  const collection = await getCollection<MCPServerConfig>("mcp_servers");
  const servers = await collection
    .find(
      { $or: [{ config_driven: true }, { source: "agentgateway" }] } as never,
      { projection: { _id: 1 } },
    )
    .toArray();

  const orgId = caipeOrgKey();
  for (const server of servers) {
    const serverId = String(server._id ?? "").trim();
    if (!serverId) continue;
    await reconcileConfigDrivenMcpServerRelationships({
      serverId,
      organizationId: orgId,
    });
  }

  if (servers.length > 0) {
    console.log(
      `[seed-config] Reconciled OpenFGA tuples for ${servers.length} platform MCP server(s)`,
    );
  }
  return servers.length;
}

/**
 * Reconcile OpenFGA tuples for all dynamic agents in Mongo so policy changes
 * (e.g. revoking team-member writer grants) apply on UI restart.
 */
export async function reconcileExistingAgentOpenFgaTuples(): Promise<number> {
  if (!isMongoDBConfigured || !isOpenFgaReconciliationEnabled()) return 0;

  const { getPlatformDefaultAgentId } = await import(
    "@/lib/rbac/platform-default"
  );
  const platformDefaultAgentId = await getPlatformDefaultAgentId();

  const collection = await getCollection<DynamicAgentConfig>("dynamic_agents");
  const agents = await collection
    .find(
      {},
      {
        projection: {
          _id: 1,
          allowed_tools: 1,
          owner_subject: 1,
          owner_id: 1,
          owner_team_slug: 1,
          shared_with_teams: 1,
          visibility: 1,
        },
      },
    )
    .toArray();

  const orgId = caipeOrgKey();
  // Resolved once for the whole sweep. `explicitAgentIds` records the agents an
  // admin explicitly granted the unlinked SA via the Unlinked Access panel;
  // those grants are owned by the admin, not by visibility, so the sweep must
  // re-assert (self-heal) them rather than delete them. For global agents the
  // sub also drives the everyone-can-use backfill.
  const { sub: unlinkedServiceAccountSub, explicitAgentIds } =
    await resolveUnlinkedServiceAccountGrantState();
  for (const agent of agents) {
    const agentId = String(agent._id ?? "").trim();
    if (!agentId) continue;
    const allowedTools = agent.allowed_tools ?? {};
    const sharedSlugs = agent.shared_with_teams ?? [];
    const isGlobal = agent.visibility === "global";
    const retainPlatformDefaultGrant =
      platformDefaultAgentId !== null && agentId === platformDefaultAgentId;
    await reconcileAgentRelationships({
      agentId,
      previousAllowedTools: allowedTools,
      nextAllowedTools: allowedTools,
      ownerSubject: agent.owner_subject ?? agent.owner_id,
      organizationId: orgId,
      ownerTeamSlug: agent.owner_team_slug,
      nextSharedTeamSlugs: sharedSlugs,
      previousSharedTeamSlugs: sharedSlugs,
      globalUserAccess: isGlobal,
      // Sweep stale org-wide chat grants on team agents (including agents
      // demoted from global before reconcile carried delete flags).
      previousGlobalUserAccess: !isGlobal && !retainPlatformDefaultGrant,
      unlinkedServiceAccountSub,
      // An explicit admin grant survives the sweep: preserve the unlinked SA's
      // `can_use` tuple for non-global agents the admin granted directly, and
      // re-assert it if a prior visibility-driven delete removed it.
      unlinkedGrantIsExplicit: explicitAgentIds.has(agentId),
      failClosed: false,
    });
  }

  if (agents.length > 0) {
    console.log(
      `[seed-config] Reconciled OpenFGA tuples for ${agents.length} dynamic agent(s)`,
    );
  }
  return agents.length;
}

/**
 * Load and apply seed configuration from YAML.
 *
 * Called at server startup via instrumentation.ts to ensure config-driven
 * agents, MCP servers, and models are loaded into MongoDB.
 *
 * Also cleans up config-driven entities that have been removed from config.
 */
export async function applySeedConfig(): Promise<void> {
  if (isMongoDBConfigured) {
    try {
      const { bootstrapPlatformRagCollection } = await import(
        "@/lib/rag-collections.server"
      );
      await bootstrapPlatformRagCollection();
    } catch (err) {
      console.error("[seed-config] Platform RAG bootstrap threw:", err);
    }
  }

  const configPath = process.env.APP_CONFIG_PATH;
  if (!configPath) {
    console.log("[seed-config] APP_CONFIG_PATH not set, skipping seed");
  } else if (!isMongoDBConfigured) {
    console.warn("[seed-config] MongoDB not configured, skipping seed");
  } else {
    try {
      const config = loadSeedConfig(configPath);

      console.log(
        `[seed-config] Found ${config.models.length} models, ` +
          `${config.mcp_servers.length} MCP servers, ` +
          `${config.agents.length} agents, ` +
          `${config.workflow_configs.length} workflow configs, ` +
          `${config.rag_sources.length} rag sources in config`,
      );

      // Extract current IDs for stale cleanup
      const currentAgentIds = new Set(
        config.agents.map((a) => a.id as string).filter(Boolean),
      );
      const currentServerIds = new Set(
        config.mcp_servers.map((s) => s.id as string).filter(Boolean),
      );
      const currentModelIds = new Set(
        config.models.map((m) => m.model_id).filter(Boolean),
      );
      const currentWorkflowIds = new Set(
        config.workflow_configs.map((w) => w.id as string).filter(Boolean),
      );
      const currentRagSourceIds = new Set(
        config.rag_sources
          .map((s) => extractRagSourceTypeFields(s)?.identity)
          .filter(
            (identity): identity is IngestionSourceIdentity =>
              identity !== undefined,
          )
          .map((identity) => computeIngestionSourceId(identity)),
      );

      // Seed entities
      const modelCount = await seedModels(config.models);
      const serverCount = await seedMCPServers(config.mcp_servers);
      await seedAgentGatewayAdminAccess();
      const agentCount = await seedAgents(config.agents);
      const workflowCount = await seedWorkflowConfigs(config.workflow_configs);
      const workflowTeamSlugRepairs = await repairWorkflowConfigTeamSlugRefs();
      if (workflowTeamSlugRepairs > 0) {
        console.log(
          `[seed-config] Repaired shared_with_teams slugs on ${workflowTeamSlugRepairs} team workflow(s)`,
        );
      }
      const ragSourceCount = await seedRagSources(config.rag_sources);

      // Cleanup stale config-driven entities
      await cleanupStaleConfigDriven(
        currentAgentIds,
        currentServerIds,
        currentModelIds,
        currentWorkflowIds,
        currentRagSourceIds,
      );

      // Backfill credential_sources on previously-discovered built-in MCP
      // servers (idempotent self-migration for existing deployments).
      const credBackfillCount = await backfillBuiltinMcpCredentialSources();

      console.log(
        `[seed-config] Applied: ${modelCount} models, ` +
          `${serverCount} MCP servers, ${agentCount} agents, ${workflowCount} workflow configs, ` +
          `${ragSourceCount} rag sources` +
          (credBackfillCount > 0
            ? `, ${credBackfillCount} MCP credential_sources backfilled`
            : ""),
      );
    } catch (err) {
      // Log but don't crash — seeding failure shouldn't prevent startup
      console.error("[seed-config] Failed to apply seed config:", err);
    }
  }

  // Post-wipe / first-run safety net for AgentGateway-discovered MCP servers.
  // Runs OUTSIDE the APP_CONFIG_PATH block so an empty collection self-heals
  // even when no seed YAML is present. Best-effort — failures are logged but
  // don't block startup, and a non-empty discovered set is a no-op.
  if (isMongoDBConfigured) {
    try {
      await selfHealDiscoveredMcpServersIfEmpty();
    } catch (err) {
      console.error(
        "[seed-config] AgentGateway MCP server self-heal threw:",
        err,
      );
    }
    try {
      await reconcileExistingPlatformMcpServerOpenFgaTuples();
    } catch (err) {
      console.error(
        "[seed-config] Platform MCP server OpenFGA reconcile threw:",
        err,
      );
    }
    try {
      await reconcileExistingAgentOpenFgaTuples();
    } catch (err) {
      console.error(
        "[seed-config] Dynamic agent OpenFGA reconcile threw:",
        err,
      );
    }
    try {
      const { reconcileExistingUnlinkedKnowledgeAccess } = await import(
        "@/lib/rbac/unlinked-knowledge-access"
      );
      const result = await reconcileExistingUnlinkedKnowledgeAccess();
      if (result.datasourceCount > 0 || result.collectionCount > 0) {
        console.log(
          `[seed-config] Reconciled unlinked access for ${result.datasourceCount} datasource(s) and ${result.collectionCount} collection(s)`,
        );
      }
    } catch (err) {
      console.error(
        "[seed-config] Unlinked knowledge access reconcile threw:",
        err,
      );
    }
  }

  // First-run safety net: if the dynamic_agents collection is still empty
  // after the YAML seed runs (or if the YAML seed was skipped because
  // APP_CONFIG_PATH was unset), provision a minimal "Hello World" default
  // agent so freshly installed environments have something usable in the
  // Custom Agents UI without operator action. Idempotent: only runs when
  // collection.countDocuments({}) === 0, so any subsequent admin action
  // (creating a real agent, deleting Hello World) prevents re-seeding.
  // Best-effort — failures are logged but don't block startup.
  if (isMongoDBConfigured) {
    try {
      await bootstrapDefaultDynamicAgentIfEmpty();
    } catch (err) {
      console.error(
        "[seed-config] default dynamic agent bootstrap threw:",
        err,
      );
    }
    try {
      await reconcileHelloWorldBootstrapAgent();
    } catch (err) {
      console.error(
        "[seed-config] Hello World bootstrap reconcile threw:",
        err,
      );
    }
  }

  // First-run safety net for login-time team auto-creation. When
  // IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS=true is set, the auth path forwards
  // allowTeamCreation=true to the planner — but the planner still requires a
  // matching identity_group_sync_rules row with auto_create_team=true. Without
  // any rules, the reconciler bails silently at oidc-claim-reconciler.ts:99,
  // making the env var look broken. Seed one permissive default rule so the
  // env var actually works out of the box for fresh installs. Idempotent:
  // only runs when the rules collection is empty, so admin-curated rules are
  // never overwritten. Best-effort — failures are logged but don't block startup.
  if (isMongoDBConfigured) {
    try {
      await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();
    } catch (err) {
      console.error(
        "[seed-config] default identity-group-sync rule bootstrap threw:",
        err,
      );
    }
  }

  try {
    const { bootstrapOAuthConnectorsFromEnv } = await import(
      "@/lib/credentials/oauth-bootstrap"
    );
    await bootstrapOAuthConnectorsFromEnv();
  } catch (err) {
    console.error("[seed-config] credential OAuth bootstrap threw:", err);
  }

  try {
    const { bootstrapSecretsFromEnv } = await import(
      "@/lib/credentials/secret-bootstrap"
    );
    await bootstrapSecretsFromEnv();
  } catch (err) {
    console.error("[seed-config] credential secret bootstrap threw:", err);
  }

  // Spec 104: provision per-team Keycloak client scopes for any teams
  // that pre-date the slug field. Lives inside applySeedConfig because
  // Turbopack's instrumentation chunk tree-shakes a separate dynamic
  // import (the seed-config chunk is reliably emitted, so we piggyback
  // on it). Best-effort — failures are logged but don't block startup.
  try {
    const { syncTeamScopesOnStartup } = await import(
      "@/lib/rbac/team-scope-sync"
    );
    await syncTeamScopesOnStartup();
  } catch (err) {
    console.error("[seed-config] team-scope sync threw:", err);
  }
}

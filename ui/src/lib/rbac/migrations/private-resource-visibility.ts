import { CREDENTIAL_COLLECTIONS } from "@/lib/credentials/collections";
import { reconcileSecretRefOwnerRelationships } from "@/lib/credentials/secret-openfga";
import { getCollection } from "@/lib/mongodb";
import {
  reconcileConfigDrivenMcpServerRelationships,
  reconcileMcpServerRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import type { MigrationApplyResult, MigrationPlanResult } from "./types";

export const PRIVATE_RESOURCE_VISIBILITY_MIGRATION_ID = "private_resource_visibility_v1";
export const PRIVATE_RESOURCE_VISIBILITY_CONFIRMATION = "MIGRATE private resources TO v2";

export interface LegacyMcpScopeDocument {
  _id: string;
  name?: string;
  config_driven?: boolean;
  agentgateway_discovered?: boolean;
  visibility?: string;
  owner_subject?: string;
  owner_subject_kind?: "user" | "service_account";
  creator_subject?: string;
  owner_team_slug?: string;
  shared_with_teams?: string[];
}

export interface LegacySecretScopeDocument {
  id: string;
  name?: string;
  visibility?: string;
  owner: { type: "organization" | "team" | "user" | "service_account"; id: string };
  sharedWithTeams?: string[];
}

export type MigratedVisibility = "private" | "team" | "global";

export function classifyLegacyMcpVisibility(
  doc: LegacyMcpScopeDocument,
): MigratedVisibility {
  if (doc.visibility === "private" || doc.visibility === "team" || doc.visibility === "global") {
    return doc.visibility;
  }
  // Before explicit visibility existed, every MCP server was available to the
  // whole organization. Preserve that audience for every legacy row instead
  // of interpreting stale owner/team metadata as a request to narrow access.
  return "global";
}

export function classifyLegacySecretVisibility(
  doc: LegacySecretScopeDocument,
): MigratedVisibility {
  if (doc.visibility === "private" || doc.visibility === "team") return doc.visibility;
  return doc.owner.type === "user" && (doc.sharedWithTeams?.length ?? 0) === 0
    ? "private"
    : "team";
}

export interface PrivateResourceVisibilityPlan extends MigrationPlanResult {
  mcp_updates: Array<{ id: string; visibility: MigratedVisibility }>;
  secret_updates: Array<{ id: string; visibility: MigratedVisibility }>;
}

export function derivePrivateResourceVisibilityPlan(input: {
  mcpServers: LegacyMcpScopeDocument[];
  secrets: LegacySecretScopeDocument[];
}): PrivateResourceVisibilityPlan {
  const warnings: string[] = [];
  const mcpUpdates: PrivateResourceVisibilityPlan["mcp_updates"] = [];
  const secretUpdates: PrivateResourceVisibilityPlan["secret_updates"] = [];

  for (const server of input.mcpServers) {
    if (
      server.visibility === "private"
      || server.visibility === "team"
      || server.visibility === "global"
    ) continue;
    const visibility = classifyLegacyMcpVisibility(server);
    mcpUpdates.push({ id: server._id, visibility });
  }

  for (const secret of input.secrets) {
    if (secret.visibility === "private" || secret.visibility === "team") continue;
    secretUpdates.push({ id: secret.id, visibility: classifyLegacySecretVisibility(secret) });
  }

  const samples = [
    ...mcpUpdates.slice(0, 10).map((update) => ({
      collection: "mcp_servers",
      id: update.id,
      before: { visibility: null },
      after: { visibility: update.visibility },
    })),
    ...secretUpdates.slice(0, Math.max(0, 10 - mcpUpdates.length)).map((update) => ({
      collection: CREDENTIAL_COLLECTIONS.secretRefs,
      id: update.id,
      before: { visibility: null },
      after: { visibility: update.visibility },
    })),
  ];

  return {
    migration_id: PRIVATE_RESOURCE_VISIBILITY_MIGRATION_ID,
    release: "0.6.0",
    schema_area: "private_resource_visibility",
    kind: "explicit",
    from_version: 1,
    to_version: 2,
    counts: {
      mcp_servers_scanned: input.mcpServers.length,
      mcp_servers_to_update: mcpUpdates.length,
      secrets_scanned: input.secrets.length,
      secrets_to_update: secretUpdates.length,
      unresolved_mcp_servers: warnings.length,
    },
    warnings,
    sample_diffs: samples,
    tuple_writes_planned: mcpUpdates.length + secretUpdates.length,
    confirmation: PRIVATE_RESOURCE_VISIBILITY_CONFIRMATION,
    mcp_updates: mcpUpdates,
    secret_updates: secretUpdates,
  };
}

async function loadInputs(): Promise<{
  mcpServers: LegacyMcpScopeDocument[];
  secrets: LegacySecretScopeDocument[];
}> {
  const mcpServers = await getCollection<LegacyMcpScopeDocument>("mcp_servers");
  const secrets = await getCollection<LegacySecretScopeDocument>(CREDENTIAL_COLLECTIONS.secretRefs);
  const [mcpDocs, secretDocs] = await Promise.all([
    mcpServers.find({}).toArray(),
    secrets.find({}).toArray(),
  ]);
  return { mcpServers: mcpDocs, secrets: secretDocs };
}

export async function planPrivateResourceVisibilityMigration(): Promise<PrivateResourceVisibilityPlan> {
  return derivePrivateResourceVisibilityPlan(await loadInputs());
}

export async function applyPrivateResourceVisibilityMigration(input: {
  actor: string;
  now: string;
}): Promise<MigrationApplyResult> {
  const loaded = await loadInputs();
  const plan = derivePrivateResourceVisibilityPlan(loaded);
  if (plan.warnings.length > 0) {
    throw new Error(`Private-resource migration has unresolved rows: ${plan.warnings.join(" ")}`);
  }

  const mcpById = new Map(loaded.mcpServers.map((doc) => [doc._id, doc]));
  const secretById = new Map(loaded.secrets.map((doc) => [doc.id, doc]));
  const mcpCollection = await getCollection<LegacyMcpScopeDocument>("mcp_servers");
  const secretCollection = await getCollection<LegacySecretScopeDocument>(CREDENTIAL_COLLECTIONS.secretRefs);
  let mcpApplied = 0;
  let secretsApplied = 0;

  for (const update of plan.mcp_updates) {
    const doc = mcpById.get(update.id);
    if (!doc) continue;
    const ownerSubject = doc.owner_subject?.trim() || null;
    const ownerTeamSlug = doc.owner_team_slug?.trim() || null;
    if (update.visibility === "global") {
      const previousSharedTeamSlugs = doc.shared_with_teams ?? [];
      if (ownerSubject || ownerTeamSlug || previousSharedTeamSlugs.length > 0) {
        await reconcileMcpServerRelationships({
          serverId: doc._id,
          ownerSubject,
          ownerSubjectKind: doc.owner_subject_kind,
          creatorSubject: doc.creator_subject?.trim() || ownerSubject,
          personalOwnerAccess: false,
          previousPersonalOwnerAccess: Boolean(ownerSubject),
          previousOwnerTeamSlug: ownerTeamSlug,
          nextSharedTeamSlugs: [],
          previousSharedTeamSlugs,
          globalOrganizationAccess: true,
        }, {
          caller: ownerSubject
            ? { type: doc.owner_subject_kind === "service_account" ? "service_account" : "user", id: ownerSubject }
            : undefined,
          source: "private_resource_visibility_migration",
        });
      } else {
        await reconcileConfigDrivenMcpServerRelationships({ serverId: doc._id });
      }
    } else if (!doc.config_driven) {
      await reconcileMcpServerRelationships({
        serverId: doc._id,
        // Keep the previous direct owner in the diff when broadening to team
        // so CAS can delete that stale functional grant atomically.
        ownerSubject,
        ownerSubjectKind: update.visibility === "private" ? "user" : doc.owner_subject_kind,
        ownerTeamSlug: update.visibility === "team" ? ownerTeamSlug : null,
        creatorSubject: doc.creator_subject?.trim() || ownerSubject,
        personalOwnerAccess: update.visibility === "private",
        previousPersonalOwnerAccess: Boolean(ownerSubject),
        nextSharedTeamSlugs: update.visibility === "team" ? doc.shared_with_teams ?? [] : [],
        previousSharedTeamSlugs: doc.shared_with_teams ?? [],
      }, {
        caller: ownerSubject
          ? { type: doc.owner_subject_kind === "service_account" ? "service_account" : "user", id: ownerSubject }
          : undefined,
        source: "private_resource_visibility_migration",
      });
    }
    await mcpCollection.updateOne(
      { _id: update.id },
      update.visibility === "private"
        ? {
            $set: { visibility: "private", owner_subject_kind: "user", shared_with_teams: [] },
            $unset: { owner_team_slug: "" },
          }
        : update.visibility === "team"
          ? {
            $set: { visibility: "team" },
            $unset: { owner_subject: "", owner_subject_kind: "" },
          }
          : {
            $set: { visibility: "global", shared_with_teams: [] },
            $unset: { owner_subject: "", owner_subject_kind: "", owner_team_slug: "" },
          },
    );
    mcpApplied += 1;
  }

  for (const update of plan.secret_updates) {
    const doc = secretById.get(update.id);
    if (!doc) continue;
    await reconcileSecretRefOwnerRelationships({
      secretId: doc.id,
      owner: doc.owner,
      ownerSubject: doc.owner.type === "user" ? doc.owner.id : null,
    });
    await secretCollection.updateOne({ id: update.id }, { $set: { visibility: update.visibility } });
    secretsApplied += 1;
  }

  return {
    ...plan,
    applied_counts: {
      mcp_servers_updated: mcpApplied,
      secrets_updated: secretsApplied,
    },
    applied_at: input.now,
    applied_by: input.actor,
  };
}

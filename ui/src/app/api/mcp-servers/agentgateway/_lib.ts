import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
agentGatewayAdminConfigUrl,
buildAgentGatewayMcpDiscovery,
toAgentGatewayMcpServerDocument,
type AgentGatewayMcpDiscovery,
} from "@/lib/rbac/agentgateway-mcp-discovery";
import { reconcileConfigDrivenMcpServerRelationships } from "@/lib/rbac/openfga-owned-resources-reconcile";
import { caipeOrgKey } from "@/lib/rbac/organization";
import type { MCPServerConfig } from "@/types/dynamic-agent";

const COLLECTION_NAME = "mcp_servers";

type AgentGatewayMigrationWarning = {
  id: string;
  endpoint: string;
  target_endpoint?: string;
  existing_endpoint?: string;
  message: string;
};

export async function fetchAgentGatewayMcpDiscovery(): Promise<AgentGatewayMcpDiscovery> {
  const response = await fetch(agentGatewayAdminConfigUrl(), { method: "GET" });
  if (!response.ok) {
    throw new ApiError(`AgentGateway config request failed with HTTP ${response.status}`, 502);
  }

  const config = await response.json();
  const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
  const existingServers = await collection.find({}).toArray();
  return buildAgentGatewayMcpDiscovery(config, existingServers);
}

export async function syncSelectedAgentGatewayMcpServers(ids?: string[]) {
  const discovery = await fetchAgentGatewayMcpDiscovery();
  const selectedIds = new Set(
    ids && ids.length > 0 ? ids : discovery.targets.map((target) => target.id),
  );
  const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
  const added: string[] = [];
  const migrated: string[] = [];
  const refreshed: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const conflicts = discovery.targets.filter((target) => target.status === "conflict");
  const migration_warnings: AgentGatewayMigrationWarning[] = conflicts.map((target) => ({
    id: target.id,
    endpoint: target.endpoint,
    target_endpoint: target.target_endpoint,
    existing_endpoint: target.existing_endpoint,
    message:
      `Legacy MCP server conflicts with AgentGateway target "${target.id}". ` +
      "Remove or rename the legacy MCP server to let AgentGateway manage it.",
  }));

  for (const target of discovery.targets) {
    if (!selectedIds.has(target.id)) continue;
    if (target.status === "existing") {
      // The route is live in AgentGateway's own config right now (that's what
      // "existing" means — see buildAgentGatewayMcpDiscovery), but seed's
      // full-document replaceOne wipes agentgateway_discovered back to
      // undefined on every restart. Persist the confirmation here so the UI
      // and dynamic-agents tool wiring can trust the field for every
      // gitops-configured server, not just newly-discovered ones.
      await collection.updateOne(
        { _id: target.id } as never,
        {
          $set: {
            agentgateway_discovered: true,
            agentgateway_endpoint: target.endpoint,
            agentgateway_target_endpoint: target.target_endpoint,
            updated_at: new Date().toISOString(),
          },
        } as never,
      );
      await reconcileConfigDrivenMcpServerRelationships({
        serverId: target.id,
        organizationId: caipeOrgKey(),
      });
      refreshed.push(target.id);
      continue;
    }
    if (target.status === "conflict") {
      skipped.push({ id: target.id, reason: target.status });
      continue;
    }
    await reconcileConfigDrivenMcpServerRelationships({
      serverId: target.id,
      organizationId: caipeOrgKey(),
    });
    const doc = toAgentGatewayMcpServerDocument(target);
    if (target.status === "legacy") {
      const existing = await collection.findOne({ _id: target.id } as never);
      const existingCredentialSources = existing?.credential_sources;
      if (Array.isArray(existingCredentialSources) && existingCredentialSources.length > 0) {
        doc.credential_sources = existingCredentialSources;
      }
      await collection.updateOne({ _id: target.id } as never, { $set: doc } as never);
      migrated.push(target.id);
    } else {
      await collection.insertOne(doc);
      added.push(target.id);
    }
  }

  for (const id of selectedIds) {
    if (!discovery.targets.some((target) => target.id === id)) {
      skipped.push({ id, reason: "not_discovered" });
    }
  }

  return {
    added,
    migrated,
    refreshed,
    skipped,
    summary: {
      added: added.length,
      existing: discovery.targets.filter((target) => target.status === "existing").length,
      migrated: migrated.length,
      refreshed: refreshed.length,
      conflicts: conflicts.length,
      skipped: skipped.length,
    },
    conflicts,
    migration_warnings,
    targets: discovery.targets,
  };
}

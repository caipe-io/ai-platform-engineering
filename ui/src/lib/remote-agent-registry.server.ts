import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { ApiError } from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import type { RemoteAgentCredentialSource, RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import type { Document } from "mongodb";
const COLLECTION_NAME = "remote_agents";

export interface RemoteAgentDocument extends Document {
  _id: string;
  name: string;
  description?: string;
  endpoint?: string;
  timeout_seconds: number;
  streaming?: boolean;
  credential_source?: RemoteAgentCredentialSource;
  protocol_version?: string;
  protocol_bindings?: string[];
  enabled?: boolean;
  [key: string]: unknown;
}


function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function seedDeploymentAgents(collection: Awaited<ReturnType<typeof getCollection<RemoteAgentDocument>>>): Promise<void> {
  const endpoints = (process.env.REMOTE_AGENT_URLS || "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const endpoint of endpoints) {
    let url: URL;
    try { url = new URL(endpoint); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    const id = `remote-${slugify(host)}`;
    if (id === "remote-") continue;
    const baseName = host.split(".")[0].replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    const now = new Date().toISOString();
    await collection.updateOne(
      { _id: id },
      { $setOnInsert: {
        _id: id,
        name: baseName || "Remote A2A Agent",
        description: "Deployment-seeded remote A2A agent.",
        endpoint: url.toString().replace(/\/$/, ""),
        timeout_seconds: 120,
        protocol_bindings: [],
        enabled: true,
        source: "deployment",
        created_at: now,
        updated_at: now,
      } },
      { upsert: true },
    );
  }
}


export async function readRemoteAgentRegistry(session: Parameters<typeof requireResourcePermission>[0]) {
  let canManage = false;
  try {
    await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
    canManage = true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 403) throw error;
    // Listing is available to authenticated agent authors; writes remain admin-only.
  }
  const collection = await getCollection<RemoteAgentDocument>(COLLECTION_NAME);
  if (canManage) await seedDeploymentAgents(collection);
  const projection = {
    _id: 1,
    name: 1,
    description: 1,
    timeout_seconds: 1,
    streaming: 1,
    framework: 1,
    protocol_version: 1,
    protocol_bindings: 1,
    ...(canManage ? { endpoint: 1, credential_source: 1 } : {}),
  };
  const items = await collection.find({ enabled: { $ne: false } })
    .project(projection)
    .sort({ name: 1 })
    .toArray();
  return { items: items as unknown as RemoteAgentRegistryEntry[], can_manage_registry: canManage };
}

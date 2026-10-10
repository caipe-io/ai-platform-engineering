import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { normalizeRemoteAgentCredentialSource } from "@/lib/remote-agent-auth";
import type { RemoteAgentCredentialSource } from "@/types/dynamic-agent";
import { Document } from "mongodb";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "remote_agents";
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;

interface RemoteAgentDocument extends Document {
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

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("Name is required", 400, "INVALID_REMOTE_AGENT");
  }
  return value.trim();
}

function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("Endpoint is required", 400, "INVALID_REMOTE_AGENT");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError("Endpoint must be a valid URL", 400, "INVALID_REMOTE_AGENT");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError("Endpoint must use HTTP or HTTPS", 400, "INVALID_REMOTE_AGENT");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeTimeout(value: unknown): number {
  const seconds = value === undefined ? 120 : Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
    throw new ApiError(`Timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`, 400, "INVALID_REMOTE_AGENT_TIMEOUT");
  }
  return seconds;
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

async function requireRegistryAdmin(session: Parameters<typeof requireResourcePermission>[0]): Promise<void> {
  await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  let canManage = false;
  try {
    await requireRegistryAdmin(session);
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
    protocol_version: 1,
    protocol_bindings: 1,
    ...(canManage ? { endpoint: 1, credential_source: 1 } : {}),
  };
  const items = await collection.find({ enabled: { $ne: false } })
    .project(projection)
    .sort({ name: 1 })
    .toArray();
  return successResponse({ items, can_manage_registry: canManage });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireRegistryAdmin(session);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const name = normalizeName(body.name);
  const endpoint = normalizeEndpoint(body.endpoint);
  const timeout_seconds = normalizeTimeout(body.timeout_seconds);
  const credential_source = normalizeRemoteAgentCredentialSource(body.credential_source);
  if (body.streaming !== undefined && typeof body.streaming !== "boolean") {
    throw new ApiError("Streaming must be a boolean", 400, "INVALID_REMOTE_AGENT_STREAMING");
  }
  const id = `remote-${slugify(name)}`;
  if (id === "remote-") throw new ApiError("Name must include letters or numbers", 400, "INVALID_REMOTE_AGENT");

  const collection = await getCollection<RemoteAgentDocument>(COLLECTION_NAME);
  if (await collection.findOne({ _id: id })) {
    throw new ApiError("A remote agent with this name already exists", 409, "REMOTE_AGENT_EXISTS");
  }
  const now = new Date().toISOString();
  const entry = {
    _id: id,
    name,
    description: typeof body.description === "string" ? body.description.trim() : "",
    endpoint,
    timeout_seconds,
    streaming: body.streaming === true,
    credential_source,
    protocol_version: typeof body.protocol_version === "string" ? body.protocol_version : undefined,
    protocol_bindings: Array.isArray(body.protocol_bindings) ? body.protocol_bindings.filter((item): item is string => typeof item === "string") : [],
    enabled: true,
    created_at: now,
    updated_at: now,
    updated_by: user.email,
  };
  await collection.insertOne(entry);
  return successResponse(entry, 201);
});

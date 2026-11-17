import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { isAgentFramework } from "@/lib/agent-framework";
import { normalizeRemoteAgentCredentialSource } from "@/lib/remote-agent-auth";
import { readRemoteAgentRegistry, type RemoteAgentDocument } from "@/lib/remote-agent-registry.server";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "remote_agents";
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;


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


async function requireRegistryAdmin(session: Parameters<typeof requireResourcePermission>[0]): Promise<void> {
  await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  return successResponse(await readRemoteAgentRegistry(session));
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
  if (body.framework !== undefined && !isAgentFramework(body.framework)) throw new ApiError("Unknown agent framework", 400, "INVALID_REMOTE_AGENT_FRAMEWORK");
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
    ...(body.framework !== undefined ? { framework: body.framework } : {}),
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

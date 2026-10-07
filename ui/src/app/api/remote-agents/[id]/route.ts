import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { Document } from "mongodb";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "remote_agents";

interface RemoteAgentDocument extends Document {
  _id: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export const PUT = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: user.email };
  if (body.timeout_seconds !== undefined) {
    const timeout = Number(body.timeout_seconds);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
      throw new ApiError("Timeout must be between 1 and 600 seconds", 400, "INVALID_REMOTE_AGENT_TIMEOUT");
    }
    update.timeout_seconds = timeout;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new ApiError("Name is required", 400, "INVALID_REMOTE_AGENT");
    }
    update.name = body.name.trim();
  }
  if (body.description !== undefined) update.description = typeof body.description === "string" ? body.description.trim() : "";
  if (body.endpoint !== undefined) {
    if (typeof body.endpoint !== "string") throw new ApiError("Endpoint must be a URL", 400, "INVALID_REMOTE_AGENT");
    let url: URL;
    try { url = new URL(body.endpoint); } catch { throw new ApiError("Endpoint must be a valid URL", 400, "INVALID_REMOTE_AGENT"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApiError("Endpoint must use HTTP or HTTPS", 400, "INVALID_REMOTE_AGENT");
    update.endpoint = url.toString().replace(/\/$/, "");
  }
  const collection = await getCollection<RemoteAgentDocument>(COLLECTION_NAME);
  const result = await collection.findOneAndUpdate({ _id: id, enabled: { $ne: false } }, { $set: update }, { returnDocument: "after" });
  if (!result) throw new ApiError("Remote agent not found", 404, "REMOTE_AGENT_NOT_FOUND");
  return successResponse(result);
});

export const DELETE = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  const { id } = await context.params;
  const agentConfigs = await getCollection<Document & { allowed_remote_agents?: string[] }>("dynamic_agents");
  const references = await agentConfigs.countDocuments({ allowed_remote_agents: id });
  if (references > 0) {
    throw new ApiError("Remove this remote agent from dynamic agents before disabling it", 409, "REMOTE_AGENT_IN_USE");
  }
  const collection = await getCollection<RemoteAgentDocument>(COLLECTION_NAME);
  const result = await collection.deleteOne({ _id: id, enabled: { $ne: false } });
  if (result.deletedCount === 0) throw new ApiError("Remote agent not found", 404, "REMOTE_AGENT_NOT_FOUND");
  return successResponse({ id, deleted: true, removed_by: user.email });
});

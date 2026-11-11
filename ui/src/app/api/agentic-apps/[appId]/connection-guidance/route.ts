import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { MongoServerError } from "mongodb";
import { ApiError, getAuthFromBearerOrSession, requireRbacPermission, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp, isAgenticAppsEnabled } from "@/lib/agentic-apps/config";
import { validateConnectionGuidance, type AssistantConnectionGuide } from "@/lib/agentic-apps/connection-guidance";
import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { isWebexIdentityLinkingEnabled } from "@/lib/integration-config";

type Context = { params: Promise<{ appId: string }> };
interface GuideDocument { _id: string; guides: AssistantConnectionGuide[]; revision?: string; updated_at?: Date; updated_by?: string }

export const GET = withErrorHandler(async (request: NextRequest, context: Context) => {
  const { session, user } = await getAuthFromBearerOrSession(request);
  const { appId } = await context.params;
  const app = getConfiguredAgenticApp(appId);
  if (!isAgenticAppsEnabled() || !app) throw new ApiError("App unavailable", 404);
  const editor = request.nextUrl.searchParams.get("editor") === "true";
  if (editor) {
    await requireRbacPermission(session, "admin_ui", "admin");
    await requireResourcePermission(session, { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
  } else if (!canLaunchAgenticApp(app, agenticAppUserContextFromSession(session, user.role))) throw new ApiError("App unavailable", 404);
  const collection = await getCollection<GuideDocument>("agentic_app_connection_guidance");
  const document = await collection.findOne({ _id: appId });
  const guides = (document?.guides ?? []).map(guide => {
    if (editor || !guide.action_url || isWebexIdentityLinkingEnabled()) return guide;
    const action = new URL(guide.action_url, request.nextUrl.origin);
    return action.origin === request.nextUrl.origin && action.pathname === "/api/auth/webex-link/start"
      ? { ...guide, action_url: "", action_label: "" } : guide;
  });
  return Response.json({ success: true, data: { guides, revision: document?.revision ?? null } }, { headers: { "Cache-Control": "private, no-store" } });
});

export const PUT = withErrorHandler(async (request: NextRequest, context: Context) => {
  const { session, user } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  await requireResourcePermission(session, { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
  const { appId } = await context.params;
  if (!isAgenticAppsEnabled() || !getConfiguredAgenticApp(appId)) throw new ApiError("App unavailable", 404);
  const raw = await request.text();
  if (raw.length > 64 * 1024) throw new ApiError("Connection guidance is too large", 413);
  let guides: AssistantConnectionGuide[];
  let revision: string | null;
  try {
    const input = JSON.parse(raw);
    if (input.revision !== null && (typeof input.revision !== "string" || !input.revision || input.revision.length > 64)) throw new Error("Reload connection guidance before saving.");
    revision = input.revision;
    guides = validateConnectionGuidance(input.guides);
  }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid guidance", 400); }
  const collection = await getCollection<GuideDocument>("agentic_app_connection_guidance");
  const nextRevision = randomUUID();
  try {
    const result = await collection.updateOne({ _id: appId, revision }, { $set: { guides, revision: nextRevision, updated_at: new Date(), updated_by: user.email } }, { upsert: revision === null });
    if (!result.matchedCount && !result.upsertedCount) throw new ApiError("Connection guidance changed. Reload it before saving again.", 409);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) throw new ApiError("Connection guidance changed. Reload it before saving again.", 409);
    throw error;
  }
  return successResponse({ guides, revision: nextRevision });
});

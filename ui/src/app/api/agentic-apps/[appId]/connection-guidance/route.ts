import { NextRequest } from "next/server";
import { ApiError, getAuthFromBearerOrSession, requireRbacPermission, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp, isAgenticAppsEnabled } from "@/lib/agentic-apps/config";
import { validateConnectionGuidance, type AssistantConnectionGuide } from "@/lib/agentic-apps/connection-guidance";
import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

type Context = { params: Promise<{ appId: string }> };
interface GuideDocument { _id: string; guides: AssistantConnectionGuide[]; updated_at?: Date; updated_by?: string }

export const GET = withErrorHandler(async (request: NextRequest, context: Context) => {
  const { session, user } = await getAuthFromBearerOrSession(request);
  const { appId } = await context.params;
  const app = getConfiguredAgenticApp(appId);
  if (!isAgenticAppsEnabled() || !app || !canLaunchAgenticApp(app, agenticAppUserContextFromSession(session, user.role))) throw new ApiError("App unavailable", 404);
  const collection = await getCollection<GuideDocument>("agentic_app_connection_guidance");
  const document = await collection.findOne({ _id: appId });
  return Response.json({ success: true, data: { guides: document?.guides ?? [] } }, { headers: { "Cache-Control": "private, no-store" } });
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
  try { guides = validateConnectionGuidance(JSON.parse(raw).guides); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid guidance", 400); }
  const collection = await getCollection<GuideDocument>("agentic_app_connection_guidance");
  await collection.updateOne({ _id: appId }, { $set: { guides, updated_at: new Date(), updated_by: user.email } }, { upsert: true });
  return successResponse({ guides });
});

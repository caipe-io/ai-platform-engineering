import { NextRequest } from "next/server";
import { getAuthFromBearerOrSession, requireRbacPermission, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { isSlackIntegrationEnabled } from "@/lib/integration-config";
import { callSlackBotDirectory } from "@/lib/slack-bot-admin";

function emptyStatus(error?: string) {
  const empty = { status: "empty", fetched_at: null, updated_at: null, started_at: null, last_error: error };
  return {
    configured: false,
    bot_admin: { reachable: false, error },
    users: { ...empty, users_indexed: 0, active_users_indexed: 0, pages_scanned: 0, members_seen: 0 },
    emoji: { ...empty, emoji_indexed: 0 },
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "view");
  if (!isSlackIntegrationEnabled()) return successResponse(emptyStatus("Slack integration is not enabled."));
  try {
    return successResponse(await callSlackBotDirectory("status"));
  } catch (error) {
    return successResponse({ ...emptyStatus(error instanceof Error ? error.message : String(error)), configured: true });
  }
});

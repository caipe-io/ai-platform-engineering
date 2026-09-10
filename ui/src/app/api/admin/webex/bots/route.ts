import { NextRequest } from "next/server";

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireResourcePermission(
    session,
    { type: "admin_surface", id: "webex", action: "read" },
    { bypassForOrgAdmin: true },
  );
  const catalog = await callWebexBotAdmin<{ bots: unknown[] }>("/admin/webex/bots");
  return successResponse(catalog);
});

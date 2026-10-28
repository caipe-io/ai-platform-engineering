import { getAuthFromBearerOrSession, requireRbacPermission, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { callSlackBotDirectory } from "@/lib/slack-bot-admin";
import { NextRequest } from "next/server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "view");
  return successResponse(await callSlackBotDirectory("users", request.nextUrl.searchParams));
});

import { NextRequest, NextResponse } from "next/server";

import { withErrorHandler } from "@/lib/api-middleware";
import { authenticateRequest } from "@/lib/da-proxy";
import { availableFeedbackRoutes } from "@/lib/feedback-routes.server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateRequest(request, { resource: "feedback", scope: "submit" });
  if (auth instanceof NextResponse) return auth;
  const session = auth.authenticatedUser?.session ?? {};
  return NextResponse.json({ success: true, data: availableFeedbackRoutes(session as Record<string, unknown>, auth.role) },
    { headers: { "Cache-Control": "no-store" } });
});

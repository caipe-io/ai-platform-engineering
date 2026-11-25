import { ApiError, getAuthFromBearerOrSession, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { isMongoDBConfigured } from "@/lib/mongodb";
import { readActiveTeamUsage } from "@/lib/active-team-usage";
import { requireAdminSurfaceManage } from "@/lib/rbac/require-openfga";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireAdminSurfaceManage(session, "stats");
  if (!isMongoDBConfigured) {
    throw new ApiError("MongoDB is not configured", 503, "MONGODB_NOT_CONFIGURED");
  }

  const rawDays = Number.parseInt(request.nextUrl.searchParams.get("days") ?? "30", 10);
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(30, rawDays)) : 30;
  return successResponse(await readActiveTeamUsage(days));
});

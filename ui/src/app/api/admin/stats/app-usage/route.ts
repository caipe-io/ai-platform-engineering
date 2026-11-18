import { ApiError, getAuthFromBearerOrSession, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { readAppUsage } from "@/lib/app-usage";
import { isMongoDBConfigured } from "@/lib/mongodb";
import { requireAdminSurfaceManage } from "@/lib/rbac/require-openfga";
import type { NextRequest } from "next/server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireAdminSurfaceManage(session, "stats");
  if (!isMongoDBConfigured) throw new ApiError("MongoDB not configured", 503);
  const response = successResponse(await readAppUsage());
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});

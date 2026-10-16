import { successResponse, withErrorHandler } from "@/lib/api-middleware";
import { loadRuntimeProfiles } from "@/lib/dynamic-agents/runtime-profiles";
import { NextRequest } from "next/server";

export const GET = withErrorHandler(async (request: NextRequest) =>
  successResponse({ profiles: await loadRuntimeProfiles(request) }),
);

import { NextRequest } from "next/server";

import {
ApiError,
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getAuditClient } from "@/lib/audit";
import { getCredentialFeatureConfig } from "@/lib/feature-flags/credentials";
import { requireBaselineAdminSurfaceRead } from "@/lib/rbac/require-openfga";

function assertFeatureEnabled(): void {
  if (!getCredentialFeatureConfig().enabled) {
    throw new ApiError("Credential features are disabled", 404, "CREDENTIALS_DISABLED");
  }
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  assertFeatureEnabled();
  const { session } = await getAuthFromBearerOrSession(request);
  await requireBaselineAdminSurfaceRead(session, "credentials");
  const { records: events } = await getAuditClient().queryPage({ type: "credential_action", limit: 100 });
  return successResponse(events);
});

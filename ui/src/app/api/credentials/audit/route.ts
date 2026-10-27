import { NextRequest } from "next/server";

import {
ApiError,
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getAuditClient } from "@/lib/audit";
import { getCredentialFeatureConfig } from "@/lib/feature-flags/credentials";

function assertFeatureEnabled(): void {
  if (!getCredentialFeatureConfig().enabled) {
    throw new ApiError("Credential features are disabled", 404, "CREDENTIALS_DISABLED");
  }
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  assertFeatureEnabled();
  const { session } = await getAuthFromBearerOrSession(request);
  const actorId = typeof session.sub === "string" ? session.sub : "";
  if (!actorId) {
    throw new ApiError("Authenticated subject is required", 401, "UNAUTHORIZED");
  }
  const { records } = await getAuditClient().queryPage({ type: "credential_action", limit: 500 });
  const events = records
    .filter((event) => {
      const actor = event.actor as { id?: unknown } | undefined;
      return actor?.id === actorId;
    })
    .slice(0, 50);
  return successResponse(events);
});

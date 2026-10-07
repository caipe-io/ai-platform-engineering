import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { isWebexIdentityLinkingEnabled } from "@/lib/integration-config";
import { mergeUserAttributes } from "@/lib/rbac/keycloak-admin";

export const DELETE = withErrorHandler(async (request: NextRequest) => {
  if (!isWebexIdentityLinkingEnabled()) {
    throw new ApiError("Webex identity linking is not configured", 404, "WEBEX_LINK_NOT_CONFIGURED");
  }

  const { session } = await getAuthFromBearerOrSession(request);
  const ownerId = typeof session.sub === "string" ? session.sub : "";
  if (!ownerId) {
    throw new ApiError("Authenticated subject is required", 401, "UNAUTHORIZED");
  }

  await mergeUserAttributes(ownerId, { webex_user_id: undefined, webex_user_email: undefined });
  return successResponse({ unlinked: true });
});

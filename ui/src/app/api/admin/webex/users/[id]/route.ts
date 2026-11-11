import { NextRequest } from "next/server";

import {
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { unlinkWebexIdentity } from "@/lib/rbac/webex-identity-link";

export const DELETE = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const params = await context.params;
    const keycloakUserId = decodeURIComponent(params.id);

    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");

    await unlinkWebexIdentity(keycloakUserId);
    return successResponse({ revoked: true, keycloak_user_id: keycloakUserId });
  }
);

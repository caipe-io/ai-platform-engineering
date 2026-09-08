import {
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { mergeUserAttributes } from "@/lib/rbac/keycloak-admin";
import { NextRequest } from "next/server";

export const DELETE = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const params = await context.params;
    const keycloakUserId = decodeURIComponent(params.id);

    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");

    await mergeUserAttributes(keycloakUserId, { webex_user_id: undefined, webex_user_email: undefined });
    return successResponse({ revoked: true, keycloak_user_id: keycloakUserId });
  }
);

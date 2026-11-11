import {
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { mergeUserAttributes } from "@/lib/rbac/keycloak-admin";
import { setWebexIdentityForUserRoutes } from "@/lib/rbac/webex-direct-user-route-store";
import { NextRequest } from "next/server";

export const DELETE = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const params = await context.params;
    const keycloakUserId = decodeURIComponent(params.id);

    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");

    await mergeUserAttributes(keycloakUserId, { webex_user_id: undefined, webex_user_email: undefined });
    await setWebexIdentityForUserRoutes(keycloakUserId, null);
    return successResponse({ revoked: true, keycloak_user_id: keycloakUserId });
  }
);

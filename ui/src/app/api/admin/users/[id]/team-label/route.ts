import { ApiError, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { authOptions } from "@/lib/auth-config";
import { mergeUserAttributes } from "@/lib/rbac/keycloak-admin";
import { requireResourcePermission, type ResourceAuthzSession } from "@/lib/rbac/resource-authz";
import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";

const USER_DIRECTORY_SURFACE_ID = "user_directory";

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const session = await getServerSession(authOptions) as ResourceAuthzSession | null;
  if (!session?.user?.email) {
    throw new ApiError("Sign in required", 401, "NOT_SIGNED_IN");
  }
  if (session.isServiceAccount) {
    throw new ApiError("A user session is required to edit team labels", 403, "HUMAN_ADMIN_REQUIRED");
  }

  await requireResourcePermission(
    session,
    { type: "admin_surface", id: USER_DIRECTORY_SURFACE_ID, action: "write" },
    { bypassForOrgAdmin: true },
  );

  const { id } = await context.params;
  const userId = id?.trim();
  if (!userId) throw new ApiError("User id is required", 400, "INVALID_USER_ID");

  const body = await request.json().catch(() => null) as { team_label?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.team_label !== "string") {
    throw new ApiError("team_label must be a string", 400, "INVALID_TEAM_LABEL");
  }
  const teamLabel = body.team_label.trim();
  if (teamLabel.length > 80 || /[\u0000-\u001f\u007f]/.test(teamLabel)) {
    throw new ApiError("Team label must be 80 characters or fewer and contain no control characters", 400, "INVALID_TEAM_LABEL");
  }

  await mergeUserAttributes(userId, { team_label: teamLabel || null });
  return successResponse({ ok: true, team_label: teamLabel });
});

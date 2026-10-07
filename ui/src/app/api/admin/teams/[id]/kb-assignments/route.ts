import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { listTeamKbGrants } from "@/lib/rbac/team-resource-listing";
import { findUserRoleInTeam } from "@/lib/rbac/team-membership-store";

const GLOBAL_PSEUDO_TEAM = "global";

interface TeamDoc {
  _id: ObjectId;
  slug?: string;
}

function validateTeamId(id: string): void {
  if (id === GLOBAL_PSEUDO_TEAM) return;
  if (!ObjectId.isValid(id)) throw new ApiError("Invalid team ID format", 400);
}

function requireMongoDB(): void {
  if (!isMongoDBConfigured) {
    throw new ApiError(
      "MongoDB not configured - team Search access requires MongoDB",
      503,
      "MONGODB_NOT_CONFIGURED",
    );
  }
}

async function resolveVisibleTeamSlug(
  id: string,
  user: { email: string; role?: string },
  session: Parameters<typeof requireRbacPermission>[0],
): Promise<string> {
  if (id === GLOBAL_PSEUDO_TEAM) {
    if (user.role !== "admin") {
      throw new ApiError("Only admins can view global Search access", 403);
    }
    return GLOBAL_PSEUDO_TEAM;
  }

  const teams = await getCollection<TeamDoc>("teams");
  const team = await teams.findOne({ _id: new ObjectId(id) } as never);
  if (!team) throw new ApiError("Team not found", 404);
  const canViewAdmin = await requireRbacPermission(session, "admin_ui", "admin").then(
    () => true,
    () => false,
  );
  if (!canViewAdmin) {
    const role = team.slug
      ? await findUserRoleInTeam(team.slug, {
          user_email: user.email.trim().toLowerCase(),
        })
      : null;
    if (!role) {
      throw new ApiError(
        "You do not have permission to view this team's Search access",
        403,
      );
    }
  }
  return team.slug || id;
}

export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    requireMongoDB();
    const { id } = await context.params;
    validateTeamId(id);
    const { user, session } = await getAuthFromBearerOrSession(request);
    const teamSlug = await resolveVisibleTeamSlug(id, user, session);
    const grants = await listTeamKbGrants(teamSlug);
    return successResponse({
      team_id: id,
      kb_ids: grants.kbIds,
      // Retained only for response compatibility. The UI intentionally renders
      // one product-level permission: Search.
      kb_permissions: grants.permissions,
      allowed_datasource_ids: grants.kbIds,
      updated_at: null,
      updated_by: null,
    });
  },
);

async function rejectLegacyAssignmentWrite(request: NextRequest): Promise<never> {
  await getAuthFromBearerOrSession(request);
  throw new ApiError(
    "Manage Search from the datasource settings so Owner rules and publication approval are applied.",
    409,
    "DATASOURCE_SETTINGS_REQUIRED",
  );
}

export const PUT = withErrorHandler(rejectLegacyAssignmentWrite);
export const DELETE = withErrorHandler(rejectLegacyAssignmentWrite);

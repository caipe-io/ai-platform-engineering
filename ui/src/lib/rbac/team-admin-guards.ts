import { ApiError,requireRbacPermission } from "@/lib/api-middleware";
import { isEveryoneTeamSlug } from "@/lib/rbac/reserved-teams";
import { findUserRoleInTeam } from "@/lib/rbac/team-membership-store";

/**
 * Minimal team shape required by this gate. Only `slug` is consulted —
 * the canonical reader (`findUserRoleInTeam`) takes it from there.
 *
 * Pre-2026-05-26 the gate read `team.members[]` directly. That dual-write
 * field is being removed; see
 * docs/docs/specs/2026-05-26-canonical-team-membership/.
 */
interface TeamLike {
  slug?: string;
}

/**
 * The Everyone team controls defaults that may affect every user. A scoped
 * team-admin grant is therefore insufficient for mutations; only a platform
 * admin may change it.
 */
export async function requireReservedTeamMutationPermission(
  session: { accessToken?: string; sub?: string; org?: string; user?: { email?: string } },
  team: TeamLike,
): Promise<void> {
  if (isEveryoneTeamSlug(team.slug)) {
    await requireRbacPermission(session, "admin_ui", "admin");
  }
}

/**
 * Returns true iff the actor has an active "admin" role in the team
 * according to the canonical `team_membership_sources` collection.
 *
 * Legacy semantics note: the embedded array previously distinguished
 * `"owner"` from `"admin"`. The canonical store collapses both to
 * `"admin"` (see plan §"Phase 2"). For the team-membership-management
 * gate these were always treated identically (`role === "owner" ||
 * role === "admin"`), so this is behavior-preserving.
 */
async function isScopedTeamAdmin(email: string | undefined, team: TeamLike): Promise<boolean> {
  if (!email || !team.slug) return false;
  const role = await findUserRoleInTeam(team.slug, { user_email: email });
  return role === "admin";
}

export async function requireTeamMembershipManagementPermission(
  session: { accessToken?: string; sub?: string; org?: string; user?: { email?: string } },
  actorEmail: string | undefined,
  team: TeamLike
): Promise<"platform_admin" | "team_admin"> {
  if (isEveryoneTeamSlug(team.slug)) {
    await requireRbacPermission(session, "admin_ui", "admin");
    return "platform_admin";
  }

  try {
    await requireRbacPermission(session, "admin_ui", "admin");
    return "platform_admin";
  } catch (error) {
    if (await isScopedTeamAdmin(actorEmail, team)) {
      return "team_admin";
    }
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError("You do not have permission to manage this team", 403);
  }
}

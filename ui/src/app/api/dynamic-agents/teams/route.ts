/**
 * API route for listing teams the current user belongs to.
 * Used by the agent editor to populate the team sharing dropdown.
 */

import {
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { resolveAgentOwnerTeamAccess } from "@/lib/rbac/agent-owner-team";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { TeamMembershipSource } from "@/types/identity-group-sync";
import { NextRequest } from "next/server";

interface Team {
  _id: unknown;
  name: string;
  slug?: string;
  description?: string;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function canManageOrganization(session: Parameters<typeof requireResourcePermission>[0]): Promise<boolean> {
  try {
    await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/dynamic-agents/teams
 * List teams the current user is a member of.
 *
 * Source of truth: `team_membership_sources` (post 2026-05-26
 * canonical-membership refactor). Pre-2026-05-26 this filtered the
 * teams collection by `members.user_id` and read `team.members[]`
 * inline; that field is no longer authoritative.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);

    const teamsCollection = await getCollection<Team>("teams");
    const isAdmin = await canManageOrganization(session);
    const normalizedEmail = normalizeEmail(user.email);

    if (isAdmin) {
      // Keep all teams visible for sharing and ownership transfers. Creating
      // a team-owned agent still requires the same team grant as POST.
      const teams = (await teamsCollection
        .find({})
        .project({ _id: 1, name: 1, slug: 1, description: 1 })
        .sort({ name: 1 })
        .toArray()) as Team[];
      const access = await resolveAgentOwnerTeamAccess(
        session,
        teams.flatMap((team) => team.slug ? [team.slug] : []),
      );
      return successResponse(
        teams.map((team) => ({
          _id: String(team._id),
          name: team.name,
          slug: team.slug,
          description: team.description,
          user_role: team.slug && access.manageable.has(team.slug)
            ? "admin"
            : team.slug && access.usable.has(team.slug) ? "member" : null,
          can_own_agents: Boolean(team.slug && (
            access.usable.has(team.slug) || access.manageable.has(team.slug)
          )),
        })),
      );
    }

    if (!normalizedEmail) {
      // Defensive: a session without an email cannot be in any team.
      return successResponse([]);
    }

    // Non-admin path: one query against team_membership_sources to learn
    // which teams the user belongs to and at what role, then a single
    // {$in} lookup against teams to fetch display metadata. Active rows
    // only; role is escalated to "admin" if any active row is admin.
    const sources = await getRbacCollection<TeamMembershipSource>("teamMembershipSources");
    const rows = await sources
      .find({ status: "active", user_email: normalizedEmail })
      .toArray();
    if (rows.length === 0) return successResponse([]);

    const roleBySlug = new Map<string, "member" | "admin">();
    for (const row of rows) {
      if (!row.team_slug) continue;
      const current = roleBySlug.get(row.team_slug);
      if (current === "admin") continue;
      roleBySlug.set(row.team_slug, row.relationship === "admin" ? "admin" : "member");
    }
    if (roleBySlug.size === 0) return successResponse([]);

    const teams = (await teamsCollection
      .find({ slug: { $in: Array.from(roleBySlug.keys()) } })
      .project({ _id: 1, name: 1, slug: 1, description: 1 })
      .sort({ name: 1 })
      .toArray()) as Team[];

    const access = await resolveAgentOwnerTeamAccess(
      session,
      teams.flatMap((team) => team.slug ? [team.slug] : []),
    );

    return successResponse(
      teams.map((team) => {
        const role = team.slug ? roleBySlug.get(team.slug) ?? null : null;
        return {
          _id: String(team._id),
          name: team.name,
          slug: team.slug,
          description: team.description,
          user_role: role,
          // Any active team member may create an agent owned by that team;
          // POST checks team `use` and writes the creator as `owner`.
          can_own_agents: Boolean(team.slug && (
            access.usable.has(team.slug) || access.manageable.has(team.slug)
          )),
        };
      }),
    );
});

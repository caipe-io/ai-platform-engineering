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
import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { TeamMembershipSource } from "@/types/identity-group-sync";
import { ObjectId,type Filter,type FindCursor } from "mongodb";
import { NextRequest } from "next/server";

interface Team {
  _id: ObjectId | string;
  name: string;
  slug?: string;
  description?: string;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function teamSearchFilter(query: string): Filter<Team> {
  const escaped = escapeRegex(query);
  return {
    $or: [
      { name: { $regex: escaped, $options: "i" } },
      { slug: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
    ],
  };
}

function teamRefsFilter(refs: string[]): Filter<Team> {
  const objectIds = refs
    .filter((ref) => ObjectId.isValid(ref))
    .map((ref) => new ObjectId(ref));
  return {
    $or: [
      { slug: { $in: refs } },
      { _id: { $in: [...refs, ...objectIds] } },
    ],
  };
}

function requestedLimit(request: NextRequest, hasQuery: boolean): number | undefined {
  const raw = request.nextUrl.searchParams.get("limit");
  if (!raw && !hasQuery) return undefined;
  const parsed = Number(raw || 20);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 50) : 20;
}

async function loadTeams(
  cursor: FindCursor<Team>,
  limit: number | undefined,
): Promise<Team[]> {
  const projected = cursor
    .project({ _id: 1, name: 1, slug: 1, description: 1 })
    .sort({ name: 1 });
  if (limit !== undefined) projected.limit(limit);
  return (await projected.toArray()) as Team[];
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
    const query = request.nextUrl.searchParams.get("q")?.trim() || "";
    const refs = Array.from(new Set(
      request.nextUrl.searchParams.getAll("ref").map((ref) => ref.trim()).filter(Boolean),
    )).slice(0, 50);
    const requestedFilters: Filter<Team>[] = [];
    if (query) requestedFilters.push(teamSearchFilter(query));
    if (refs.length > 0) requestedFilters.push(teamRefsFilter(refs));
    const requestedFilter: Filter<Team> = requestedFilters.length > 1
      ? { $and: requestedFilters }
      : requestedFilters[0] || {};
    const limit = requestedLimit(request, Boolean(query));

    if (isAdmin) {
      // Admins see every team; role is always "admin" so dropdowns let
      // them pick any team.
      const teams = await loadTeams(teamsCollection.find(requestedFilter), limit);
      return successResponse(
        teams.map((team) => ({
          _id: String(team._id),
          name: team.name,
          slug: team.slug,
          description: team.description,
          user_role: "admin",
          can_own_agents: true,
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

    const membershipFilter: Filter<Team> = { slug: { $in: Array.from(roleBySlug.keys()) } };
    const teams = await loadTeams(
      teamsCollection.find(
        requestedFilters.length > 0
          ? { $and: [membershipFilter, requestedFilter] }
          : membershipFilter,
      ),
      limit,
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
          can_own_agents: role === "admin" || role === "member",
        };
      }),
    );
});

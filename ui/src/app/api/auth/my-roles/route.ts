import { authOptions } from "@/lib/auth-config";
import { isWebexIdentityLinkingEnabled } from "@/lib/integration-config";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { getRealmUserById } from "@/lib/rbac/keycloak-admin";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import type { TeamMembershipSource } from "@/types/identity-group-sync";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * GET /api/auth/my-roles
 *
 * Returns the authenticated user's RBAC posture:
 * - realm_roles: Keycloak realm roles from JWT
 * - teams: Team memberships from MongoDB
 * - per_kb_roles / per_agent_roles: retained for response compatibility,
 *   but new resource grants live in OpenFGA and are not surfaced from JWT roles
 * - idp_source: Identity provider (from JWT azp/iss)
 * - slack_linked: Whether the user has a linked Slack account
 * - webex_linked: Whether the user has a linked Webex account
 * - webex_link_available: Whether self-service Webex linking is configured
 */
const RESOURCE_ROLE_PREFIXES = [
  "kb_reader:",
  "kb_ingestor:",
  "kb_admin:",
  "agent_user:",
  "agent_admin:",
  "tool_user:",
  "task_user:",
  "task_admin:",
  "skill_user:",
  "skill_admin:",
] as const;

function isResourceRole(role: string): boolean {
  return RESOURCE_ROLE_PREFIXES.some((prefix) => role.startsWith(prefix));
}

export async function GET() {
  const session = (await getServerSession(authOptions)) as {
    accessToken?: string;
    realmRoles?: string[];
    user?: { email?: string | null; name?: string | null };
    role?: string;
  } | null;

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = session.user.email;

  const payload = session.accessToken
    ? decodeJwtPayload(session.accessToken)
    : {};

  const ra = (payload.realm_access as { roles?: string[] } | undefined)?.roles;
  const realmRoles: string[] = Array.isArray(ra) ? [...ra] : [];
  if (Array.isArray(session.realmRoles)) {
    for (const r of session.realmRoles) {
      if (!realmRoles.includes(r)) realmRoles.push(r);
    }
  }

  const hiddenResourceRoleCount = realmRoles.filter(isResourceRole).length;
  const baseRoles = realmRoles.filter((r) => !isResourceRole(r));

  const idpSource = (payload.azp as string) || (payload.iss as string) || "unknown";

  // `slug` is the canonical OpenFGA team identity (team:<slug>) — membership
  // tuples, the SA owning-team check, and owner_team tuples are all keyed by it.
  // Clients that submit a team identifier (e.g. the Service Accounts owning-team
  // picker) MUST use `slug`, NOT `_id` (the Mongo ObjectId), or the OpenFGA
  // check misses the membership tuple (#48). `_id` is retained for display/back-compat.
  let teams: Array<{ _id: string; slug: string; name: string; role?: string }> = [];
  let slackLinked = false;
  let webexLinked = false;

  if (isMongoDBConfigured) {
    try {
      // Source of truth: team_membership_sources (post 2026-05-26
      // canonical-membership refactor). One indexed query yields the
      // user's slugs + role; a single {$in} lookup decorates them with
      // team display names.
      const sources = await getRbacCollection<TeamMembershipSource>("teamMembershipSources");
      const rows = await sources
        .find({ status: "active", user_email: email })
        .toArray();

      const roleBySlug = new Map<string, "member" | "admin">();
      for (const row of rows) {
        if (!row.team_slug) continue;
        const current = roleBySlug.get(row.team_slug);
        if (current === "admin") continue;
        roleBySlug.set(row.team_slug, row.relationship === "admin" ? "admin" : "member");
      }

      if (roleBySlug.size > 0) {
        const teamsCol = await getCollection("teams");
        const teamDocs = await teamsCol
          .find({ slug: { $in: Array.from(roleBySlug.keys()) } })
          .project({ _id: 1, name: 1, slug: 1 })
          .toArray();
        teams = teamDocs.map((t) => {
          const slug = typeof t.slug === "string" ? t.slug : "";
          return {
            _id: t._id.toString(),
            slug,
            name: t.name as string,
            role: roleBySlug.get(slug),
          };
        });
      }
    } catch {
      // MongoDB may not be available, or the source store may not exist
      // on a fresh install. Empty `teams` is the correct safe default.
    }

    try {
      const sub = (session as { sub?: string }).sub;
      if (sub) {
        const kcUser = await getRealmUserById(sub);
        const attrs = kcUser.attributes as Record<string, string[]> | undefined;
        slackLinked = !!(attrs?.slack_user_id?.[0]?.trim());
        webexLinked = !!(attrs?.webex_user_id?.[0]?.trim());
      }
    } catch {
      // Keycloak may not be available
    }
  }

  return NextResponse.json({
    email,
    name: session.user.name,
    role: session.role ?? "user",
    realm_roles: baseRoles,
    per_kb_roles: [],
    per_agent_roles: [],
    legacy_resource_roles_hidden_count: hiddenResourceRoleCount,
    teams,
    idp_source: idpSource,
    slack_linked: slackLinked,
    webex_linked: webexLinked,
    webex_link_available: isWebexIdentityLinkingEnabled(),
  });
}

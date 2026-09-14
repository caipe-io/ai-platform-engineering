import {
ApiError,
getAuthFromBearerOrSession,
requireRbacPermission,
withErrorHandler,
} from "@/lib/api-middleware";
import { isMongoDBConfigured } from "@/lib/mongodb";
import {
countRealmUsers,
findRealmUsersByExactEmail,
getRealmUserById,
listRealmRoleMappingsForUser,
listUsersWithRole,
searchRealmUsers,
} from "@/lib/rbac/keycloak-admin";
import {
curateRealmRolesForUser,
type RealmRoleClassification,
} from "@/lib/rbac/keycloak-transition";
import {
resolveAuthorizedAdminSimulationScope,
simulationSubjectCanAuditOrganization,
} from "@/lib/rbac/admin-simulation-server";
import { listOpenFgaObjects } from "@/lib/rbac/openfga";
import { requireBaselineAdminSurfaceRead } from "@/lib/rbac/require-openfga";
import {
listActiveTeamMemberEmailsBySlugsPaged,
listActiveTeamMembershipSourcesBySlug,
listTeamMembershipSources,
} from "@/lib/rbac/team-membership-source-store";
import { type NextRequest,NextResponse } from "next/server";

type AdminUsersListBase = {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  attributes: Record<string, string[]>;
  slack_link_status: "linked" | "unlinked";
  webex_link_status: "linked" | "unlinked";
};

type AdminUsersListWithRoles = AdminUsersListBase & {
  roles: string[];
  raw_roles: string[];
  role_classifications: RealmRoleClassification[];
  hidden_role_count: number;
};

type AdminUsersListItem = AdminUsersListBase | AdminUsersListWithRoles;

function parseBoolParam(v: string | null): boolean | undefined {
  if (v === null || v === "") return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ApiError('Invalid "enabled" value; use true or false', 400);
}

function normalizeAttributes(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else if (v != null) out[k] = [String(v)];
  }
  return out;
}

function readSlackUserIdFromUser(u: Record<string, unknown>): string | undefined {
  const attrs = u.attributes as Record<string, unknown> | undefined;
  if (!attrs) return undefined;
  const sid = attrs.slack_user_id;
  const v = Array.isArray(sid) ? sid[0] : sid;
  const normalized = v != null ? String(v).trim() : "";
  return normalized || undefined;
}

function readWebexUserIdFromUser(u: Record<string, unknown>): string | undefined {
  const attrs = u.attributes as Record<string, unknown> | undefined;
  if (!attrs) return undefined;
  const wid = attrs.webex_user_id;
  const v = Array.isArray(wid) ? wid[0] : wid;
  const normalized = v != null ? String(v).trim() : "";
  return normalized || undefined;
}

function getSlackLinkStatus(
  u: Record<string, unknown>
): AdminUsersListItem["slack_link_status"] {
  return readSlackUserIdFromUser(u) ? "linked" : "unlinked";
}

function getWebexLinkStatus(u: Record<string, unknown>): AdminUsersListItem["webex_link_status"] {
  return readWebexUserIdFromUser(u) ? "linked" : "unlinked";
}

async function loadRoleUserIdSet(roleName: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let first = 0;
  const max = 100;
  for (;;) {
    const batch = await listUsersWithRole(roleName, first, max);
    if (batch.length === 0) break;
    for (const row of batch) {
      const id = row.id;
      if (id != null) ids.add(String(id));
    }
    first += batch.length;
  }
  return ids;
}

// `team_membership_sources` is the canonical membership store. It carries
// BOTH a `team_id` (Mongo `_id` string) and a `team_slug`; the two are not
// interchangeable, so a caller must look up by whichever identifier it holds.
function membershipEmails(sources: { status?: string; user_email?: string }[]): Set<string> {
  const emails = new Set<string>();
  for (const s of sources) {
    if (s.status !== "active") continue;
    if (s.user_email) emails.add(s.user_email.trim().toLowerCase());
  }
  return emails;
}

// Admin `?team=` filter passes the team's Mongo `_id` string.
async function loadTeamMemberEmails(teamId: string): Promise<Set<string>> {
  return membershipEmails(await listTeamMembershipSources(teamId));
}

// Non-admin team scope resolves teams from OpenFGA `team:<slug>` objects, so
// it holds slugs rather than ids.
async function loadTeamMemberEmailsBySlug(slug: string): Promise<Set<string>> {
  return membershipEmails(await listActiveTeamMembershipSourcesBySlug(slug));
}

function mapBaseRow(u: Record<string, unknown>): AdminUsersListBase {
  return {
    id: String(u.id ?? ""),
    username: String(u.username ?? ""),
    email: String(u.email ?? ""),
    firstName:
      u.firstName !== undefined && u.firstName !== null ? String(u.firstName) : "",
    lastName: u.lastName !== undefined && u.lastName !== null ? String(u.lastName) : "",
    enabled: u.enabled !== false,
    attributes: normalizeAttributes(u.attributes),
    slack_link_status: getSlackLinkStatus(u),
    webex_link_status: getWebexLinkStatus(u),
  };
}

// Per-user role enrichment is opt-in via `?includeRoles=true`. Each call adds
// one Keycloak Admin REST round-trip (`/users/{id}/role-mappings/realm`), so
// with default pageSize=20 we previously fanned out to 20 extra calls per
// list request. The UI list table does not render role fields; callers that
// need them (detail panel) use `/api/admin/users/[id]/roles` instead.
async function enrichListRow(
  u: Record<string, unknown>,
  includeRoles: boolean
): Promise<AdminUsersListItem> {
  const base = mapBaseRow(u);
  if (!includeRoles) return base;
  const roleRows = await listRealmRoleMappingsForUser(base.id);
  const curatedRoles = curateRealmRolesForUser(roleRows.map((r) => r.name));
  return {
    ...base,
    ...curatedRoles,
  };
}

function userMatchesFilters(
  u: Record<string, unknown>,
  opts: {
    roleIdSet: Set<string> | null;
    teamEmailSet: Set<string> | null;
    slackStatus: AdminUsersListItem["slack_link_status"] | null;
    webexStatus: AdminUsersListItem["webex_link_status"] | null;
  }
): boolean {
  const id = String(u.id ?? "");
  if (opts.roleIdSet && !opts.roleIdSet.has(id)) return false;

  const email = String(u.email ?? "").trim().toLowerCase();
  if (opts.teamEmailSet && !opts.teamEmailSet.has(email)) return false;

  if (opts.slackStatus && getSlackLinkStatus(u) !== opts.slackStatus) return false;
  if (opts.webexStatus && getWebexLinkStatus(u) !== opts.webexStatus) return false;

  return true;
}

export const GET = withErrorHandler(async (request: NextRequest): Promise<NextResponse> => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireBaselineAdminSurfaceRead(session, "users");
  const url = new URL(request.url);
  const simulationScope = await resolveAuthorizedAdminSimulationScope(url.searchParams, session);

  const hasAdminView = simulationScope
    ? await simulationSubjectCanAuditOrganization(simulationScope)
    : await requireRbacPermission(session, "admin_ui", "view").then(
        () => true,
        () => false
      );

  // Per-user role enrichment is opt-in. The Users-tab table, the team
  // typeaheads, the simulation picker, and the ReBAC graph filters do not
  // render role fields; they should not pay for N extra Keycloak round-trips
  // per page. Callers that need role data either pass `?includeRoles=true`
  // or use the per-user `/api/admin/users/[id]/roles` endpoint.
  const includeRolesRaw = (url.searchParams.get("includeRoles") ?? "").trim().toLowerCase();
  const includeRoles = includeRolesRaw === "true" || includeRolesRaw === "1";

  // Parsed once up front so both the plain-member (team-scoped) branch below
  // and the admin/team-admin branch can page their Keycloak round-trips
  // instead of resolving every row in one request.
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20", 10);
  if (Number.isNaN(page) || page < 1) {
    throw new ApiError("page must be >= 1", 400);
  }
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError("pageSize must be between 1 and 100", 400);
  }
  const skip = (page - 1) * pageSize;

  // Resolve the caller's subject + the teams they administer (`team#admin`).
  // Org/super admins keep the unscoped full-list view. A TEAM admin (not org
  // admin) is now widened to the same full-list view so they can VIEW any
  // user, but each row is stamped `can_edit` only for users on a team they
  // administer. Plain members fall back to the self/team-scoped listing.
  const selfSubjectId = simulationScope
    ? simulationScope.subjectType === "user"
      ? simulationScope.subjectId
      : ""
    : typeof session.sub === "string"
      ? session.sub.trim()
      : "";
  const actor = simulationScope?.openfgaUser
    ?? (selfSubjectId ? `user:${selfSubjectId}` : "");
  let adminSlugs = new Set<string>();
  if (!hasAdminView) {
    if (simulationScope?.subjectType === "team" && simulationScope.teamRelation === "admin") {
      adminSlugs = new Set([simulationScope.subjectId]);
    } else if (actor) {
      try {
        const adminObjects = await listOpenFgaObjects({
          user: actor,
          relation: "admin",
          type: "team",
        });
        adminSlugs = new Set(
          adminObjects.objects.map((obj) => obj.split(":").slice(1).join(":")).filter(Boolean)
        );
      } catch {
        // fail-closed: treat as non-team-admin
      }
    }
  }
  const isTeamAdmin = adminSlugs.size > 0;
  const orgAdmin = hasAdminView;

  // Emails the caller may EDIT: org admins → everyone (null sentinel); team
  // admins → union of member emails across the teams they administer.
  let editableEmails: Set<string> | null = null;
  if (!orgAdmin && isTeamAdmin) {
    editableEmails = new Set<string>();
    await Promise.all(
      [...adminSlugs].map(async (slug) => {
        try {
          const emails = await loadTeamMemberEmailsBySlug(slug);
          for (const email of emails) editableEmails!.add(email);
        } catch {
          // skip this team on error
        }
      })
    );
  }
  const canEditEmail = (email: string): boolean =>
    editableEmails === null || editableEmails.has(email.trim().toLowerCase());
  const stampCanEdit = <T extends AdminUsersListItem>(rows: T[]): Array<T & { can_edit: boolean }> =>
    rows.map((row) => ({ ...row, can_edit: orgAdmin || canEditEmail(row.email) }));

  if (!orgAdmin && !isTeamAdmin) {
    if (!actor) {
      throw new ApiError("A stable user subject is required to load your user profile.", 401);
    }
    const selfOnlyResponse = async (): Promise<NextResponse> => {
      if (!selfSubjectId) {
        return NextResponse.json({
          users: [],
          total: 0,
          page: 1,
          pageSize: 0,
          scoped: "team",
        });
      }
      const self = await enrichListRow(
        await getRealmUserById(selfSubjectId),
        true
      );
      return NextResponse.json({
        users: [{ ...self, can_edit: self.id === selfSubjectId }],
        total: 1,
        page: 1,
        pageSize: 1,
        scoped: "self",
      });
    };

    let teamSlugs: string[] = [];
    if (simulationScope?.subjectType === "team") {
      teamSlugs = [simulationScope.subjectId];
    } else {
      try {
        const teamObjects = await listOpenFgaObjects({
          user: actor,
          relation: "member",
          type: "team",
        });
        teamSlugs = teamObjects.objects
          .map((obj) => {
            const parts = obj.split(":");
            return parts.length >= 2 ? parts.slice(1).join(":") : "";
          })
          .filter(Boolean);
      } catch {
        // fall through to self-only
      }
    }

    if (teamSlugs.length === 0) {
      return selfOnlyResponse();
    }

    // Dedup + sort + page happen in Mongo (`listActiveTeamMemberEmailsBySlugsPaged`)
    // rather than in Node. A team can be arbitrarily large (e.g. an
    // Okta-synced org-wide group with thousands of members) — fetching every
    // member row into Node on every Users-tab load, just to slice a page out
    // of it in JS, meant the request cost the full team size regardless of
    // `pageSize`. It also used to fan out one Keycloak call per member in one
    // unbounded `Promise.all`, which OOMKilled the istio-proxy sidecar in prod;
    // this still resolves at most `pageSize` emails via Keycloak per request.
    const { emails: pageEmails, total: teamMemberTotal } =
      await listActiveTeamMemberEmailsBySlugsPaged(teamSlugs, skip, pageSize);

    if (teamMemberTotal === 0) {
      return selfOnlyResponse();
    }

    const seenIds = new Set<string>();
    const teamUsers: AdminUsersListItem[] = [];
    await Promise.all(
      pageEmails.map(async (email) => {
        try {
          const matches = await findRealmUsersByExactEmail(email);
          for (const u of matches) {
            const id = String(u.id ?? "");
            if (!id || seenIds.has(id)) continue;
            seenIds.add(id);
            teamUsers.push(await enrichListRow(u, false));
          }
        } catch {
          // skip this email on error
        }
      })
    );

    // Plain members can only edit their own profile.
    return NextResponse.json({
      users: teamUsers.map((u) => ({ ...u, can_edit: u.id === selfSubjectId })),
      total: teamMemberTotal,
      page,
      pageSize,
      scoped: "team",
    });
  }

    const search = (url.searchParams.get("search") ?? "").trim() || undefined;
    const role = (url.searchParams.get("role") ?? "").trim() || undefined;
    const team = (url.searchParams.get("team") ?? "").trim() || undefined;
    const slackRaw = (url.searchParams.get("slackStatus") ?? "").trim().toLowerCase();
    const slackStatus =
      slackRaw === "linked" || slackRaw === "unlinked"
        ? (slackRaw as AdminUsersListItem["slack_link_status"])
        : slackRaw === ""
          ? null
          : (() => {
              throw new ApiError('slackStatus must be "linked" or "unlinked"', 400);
            })();

    const webexRaw = (url.searchParams.get("webexStatus") ?? "").trim().toLowerCase();
    const webexStatus =
      webexRaw === "linked" || webexRaw === "unlinked"
        ? (webexRaw as AdminUsersListItem["webex_link_status"])
        : webexRaw === ""
          ? null
          : (() => {
              throw new ApiError('webexStatus must be "linked" or "unlinked"', 400);
            })();

    const enabled = parseBoolParam(url.searchParams.get("enabled"));

    if (team && !isMongoDBConfigured) {
      return NextResponse.json(
        {
          error: "MongoDB not configured — team filter requires MongoDB",
          code: "MONGODB_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    const roleIdSet = role ? await loadRoleUserIdSet(role) : null;
    if (roleIdSet && roleIdSet.size === 0) {
      return NextResponse.json({
        users: [],
        total: 0,
        page,
        pageSize,
      });
    }

    const teamEmailSet =
      team && isMongoDBConfigured ? await loadTeamMemberEmails(team) : null;

    if (team && teamEmailSet && teamEmailSet.size === 0) {
      return NextResponse.json({
        users: [],
        total: 0,
        page,
        pageSize,
      });
    }

    const needsScan =
      Boolean(roleIdSet) ||
      Boolean(teamEmailSet) ||
      Boolean(slackStatus) ||
      Boolean(webexStatus);

    if (!needsScan) {
      const first = skip;
      const raw = await searchRealmUsers({
        search,
        enabled,
        first,
        max: pageSize,
      });
      const total = await countRealmUsers({ search, enabled });
      const users = await Promise.all(
        raw.map((row) => enrichListRow(row, includeRoles))
      );
      return NextResponse.json({
        users: stampCanEdit(users),
        total,
        page,
        pageSize,
      });
    }

    const filterOpts = {
      roleIdSet,
      teamEmailSet,
      slackStatus,
      webexStatus,
    };

    const pageRows: AdminUsersListItem[] = [];
    let matchCount = 0;
    let kcFirst = 0;
    const batchSize = 100;

    for (;;) {
      const batch = await searchRealmUsers({
        search,
        enabled,
        first: kcFirst,
        max: batchSize,
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        if (!userMatchesFilters(row, filterOpts)) continue;
        if (matchCount >= skip && pageRows.length < pageSize) {
          pageRows.push(await enrichListRow(row, includeRoles));
        }
        matchCount += 1;
      }
      kcFirst += batch.length;
    }

    return NextResponse.json({
      users: stampCanEdit(pageRows),
      total: matchCount,
      page,
      pageSize,
    });
});

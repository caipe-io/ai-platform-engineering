// GET /api/admin/teams - List all teams
// POST /api/admin/teams - Create a new team

import {
ApiError,
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import {
resolveAuthorizedAdminSimulationScope,
simulationSubjectCanManageAdminSurface,
} from '@/lib/rbac/admin-simulation-server';
import { isEveryoneTeamSlug } from '@/lib/rbac/reserved-teams';
import { isValidTeamSlug } from '@/lib/rbac/keycloak-admin';
import { listOpenFgaObjects } from '@/lib/rbac/openfga';
import { listTeamKbGrantsBatch, listTeamResourceIdsBatch, TEAM_TOOL_WILDCARD_SENTINEL_ID } from '@/lib/rbac/team-resource-listing';
import { requireAdminSurfaceManage,requireBaselineAdminSurfaceRead } from '@/lib/rbac/require-openfga';
import { upsertTeamMembershipSource } from '@/lib/rbac/team-membership-source-store';
import { loadTeamIdpSourceTypes,loadTeamMemberCounts } from '@/lib/rbac/team-membership-store';
import {
mongoRoleToOpenFgaRelations,
resolveKeycloakUserSubject,
writeTeamMembershipTuples,
} from '@/lib/rbac/team-membership-sync';
import type { TeamMembershipSource } from '@/types/identity-group-sync';
import type { Document } from 'mongodb';
import { NextRequest,NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface CreateTeamRequest {
  name: string;
  slug?: string;
  description?: string;
  members?: string[];
}

interface TeamListDocument extends Document {
  created_at?: Date;
  description?: string;
  name?: string;
  owner_id?: string;
  slug?: string;
  status?: string;
}

/**
 * Derive a Keycloak-safe slug from a team name. Mirrors the rules enforced
 * by `isValidTeamSlug`: lowercase alphanumerics, hyphens, no leading/trailing
 * hyphen, max 63 chars. We deliberately do NOT strip Unicode-to-ASCII (we'd
 * rather fail loudly so the admin notices) — names that produce an empty
 * slug after stripping are rejected with a 400.
 */
/** Escape user-supplied text for safe use inside a `new RegExp(...)`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

// GET /api/admin/teams
export const GET = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - teams require MongoDB',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  const { session } = await getAuthFromBearerOrSession(request);
  await requireBaselineAdminSurfaceRead(session, 'teams');
  const url = new URL(request.url);
  const simulationScope = await resolveAuthorizedAdminSimulationScope(url.searchParams, session);

  // Mirror the per-row access pattern from PR #1883 (Slack channels). Org/super
  // admins keep the unscoped view; everyone else only sees teams they're a
  // member of, with `can_manage` flipped on for teams where they're a team
  // admin. Failures resolving membership fail-closed so a transiently broken
  // PDP can't accidentally leak the full team list to a regular user.
  const hasAdminView = simulationScope
    ? await simulationSubjectCanManageAdminSurface(simulationScope, 'teams')
    : await requireRbacPermission(session, 'admin_ui', 'admin').then(
        () => true,
        () => false
      );

  let memberSlugs = new Set<string>();
  let adminSlugs = new Set<string>();
  if (!hasAdminView) {
    if (simulationScope?.subjectType === 'team') {
      memberSlugs = new Set([simulationScope.subjectId]);
      if (simulationScope.teamRelation === 'admin') {
        adminSlugs = new Set([simulationScope.subjectId]);
      }
    } else {
      const actor = simulationScope?.openfgaUser
        ?? (typeof session.sub === 'string' && session.sub.trim()
          ? `user:${session.sub.trim()}`
          : '');
      if (actor) {
        try {
          const [memberResult, adminResult] = await Promise.all([
            listOpenFgaObjects({ user: actor, relation: 'member', type: 'team' }),
            listOpenFgaObjects({ user: actor, relation: 'admin', type: 'team' }),
          ]);
          memberSlugs = new Set(
            memberResult.objects.map((obj) => obj.split(':').slice(1).join(':')).filter(Boolean)
          );
          adminSlugs = new Set(
            adminResult.objects.map((obj) => obj.split(':').slice(1).join(':')).filter(Boolean)
          );
        } catch {
          // fail-closed: no teams visible
        }
      }
    }
  }

  const teams = await getCollection<TeamListDocument>('teams');

  // Pagination + server-side search are OPT-IN via the `page` query param.
  // The Admin Teams grid sends `?page=&page_size=&search=` so it only ever
  // pulls one page of rows into the browser. Callers that omit `page` (the
  // shared Stats/Feedback team-filter dropdowns and the access-simulation
  // team picker) still get the full list, exactly as before.
  const paginated = url.searchParams.has('page');
  const page = paginated ? Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1) : 1;
  const pageSizeRaw = parseInt(url.searchParams.get('page_size') || '24', 10) || 24;
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
  const search = (url.searchParams.get('search') || '').trim();
  // Archived teams (identity-sync teams whose Okta group vanished, or teams an
  // admin retired) are hidden by default so the grid only shows live teams.
  // The admin UI opts back in via `?include_archived=true` behind a checkbox.
  const includeArchived = url.searchParams.get('include_archived') === 'true';

  // Build the Mongo query honoring per-row access control + search so the
  // skip/limit and the aggregations only ever touch matching rows.
  const andClauses: Record<string, unknown>[] = [];
  if (!includeArchived) {
    // Treat a missing `status` as active — legacy team docs predate the field.
    andClauses.push({ status: { $ne: 'archived' } });
  }
  if (!hasAdminView) {
    const allowedSlugs = Array.from(memberSlugs);
    if (allowedSlugs.length === 0) {
      // Fail-closed: a non-admin with no team memberships sees nothing.
      const empty = paginated
        ? successResponse({ teams: [], total: 0, page, page_size: pageSize, has_more: false })
        : successResponse({ teams: [], total: 0 });
      empty.headers.set('Cache-Control', 'no-store, max-age=0');
      return empty;
    }
    andClauses.push({ slug: { $in: allowedSlugs } });
  }
  if (search) {
    const rx = new RegExp(escapeRegExp(search), 'i');
    andClauses.push({ $or: [{ name: rx }, { slug: rx }, { description: rx }, { owner_id: rx }] });
  }
  const query: Record<string, unknown> = andClauses.length > 0 ? { $and: andClauses } : {};

  // The page (or full set) of team documents to decorate + return.
  let pageTeams: TeamListDocument[];
  let total: number;
  if (paginated) {
    total = await teams.countDocuments(query);
    pageTeams = await teams
      .find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();
  } else {
    pageTeams = await teams.find(query).sort({ created_at: -1 }).toArray();
    total = pageTeams.length;
  }

  // Commit 4/8 of the canonical-team-membership refactor (spec
  // 2026-05-26-canonical-team-membership): instead of returning
  // team.members[] (which the Admin UI used to read .length on for the
  // Members badge), decorate every row with `member_count` derived from
  // the canonical team_membership_sources store via a single aggregation
  // query. With pagination this only spans the current page's slugs, so
  // the aggregation stays cheap even with thousands of teams.
  const slugs = pageTeams
    .map((team) => (typeof team.slug === 'string' ? team.slug : ''))
    .filter((slug): slug is string => slug.length > 0);
  const memberCounts = slugs.length > 0 ? await loadTeamMemberCounts(slugs) : new Map<string, number>();
  // Distinct IdP source types per team (okta/oidc_claim/...), for the
  // "synced from <IdP>" badge on the Admin team cards.
  const idpSourceTypes = slugs.length > 0 ? await loadTeamIdpSourceTypes(slugs) : new Map<string, string[]>();

  // Decorate each team with `kb_count` read live from OpenFGA (the single
  // source of truth — there is no `team_kb_ownership` store anymore). Every KB
  // write path (the kb-assignments PUT and the RAG-server upload) lands the
  // same `knowledge_base` tuples, so one batched list-objects per page slug
  // returns owned + shared together. Keyed by slug. Fail-closed to zero on
  // OpenFGA error (the grid still renders; counts read 0 until FGA heals).
  const kbCounts = new Map<string, number>();
  if (slugs.length > 0) {
    try {
      const kbGrants = await listTeamKbGrantsBatch(slugs);
      for (const [slug, grants] of kbGrants) {
        kbCounts.set(slug, grants.kbIds.length);
      }
    } catch (err) {
      console.error('[Admin Teams] failed to load OpenFGA KB counts', err);
    }
  }

  // Decorate each team with owned+shared agent/skill/workflow counts read live
  // from OpenFGA (the single source of truth — the legacy `team.resources`
  // array is gone). The reconcilers write the same `team:<slug>#member <rel>`
  // tuple for owner AND shared teams, so one list-objects per (team, type)
  // returns owned + shared together. Bounded to the current page's slugs ×
  // 3 types via the batched + request-cached helper. Fail-closed to zero on
  // OpenFGA error (the grid still renders; counts just read 0 until FGA heals).
  let resourceCounts = new Map<string, { agents: string[]; skills: string[]; workflows: string[]; tools: string[] }>();
  if (slugs.length > 0) {
    try {
      resourceCounts = await listTeamResourceIdsBatch(slugs, ['agents', 'skills', 'workflows', 'tools']);
    } catch (err) {
      console.error('[Admin Teams] failed to load OpenFGA resource counts', err);
    }
  }

  const teamsWithCounts = pageTeams.map((team) => {
    const slug = typeof team.slug === 'string' ? team.slug : '';
    const fgaCounts = slug ? resourceCounts.get(slug) : undefined;
    // The `tool:*` sentinel means "all MCP servers"; surface it as a wildcard
    // flag and exclude it from the explicit per-server tool count.
    const toolIds = fgaCounts?.tools ?? [];
    const toolWildcard = toolIds.includes(TEAM_TOOL_WILDCARD_SENTINEL_ID);
    const toolCount = toolIds.filter((id) => id !== TEAM_TOOL_WILDCARD_SENTINEL_ID).length;
    return {
      ...team,
      member_count: slug ? memberCounts.get(slug) ?? 0 : 0,
      kb_count: slug ? kbCounts.get(slug) ?? 0 : 0,
      agent_count: fgaCounts?.agents.length ?? 0,
      skill_count: fgaCounts?.skills.length ?? 0,
      workflow_count: fgaCounts?.workflows.length ?? 0,
      tool_count: toolCount,
      tool_wildcard: toolWildcard,
      idp_source_types: slug ? idpSourceTypes.get(slug) ?? [] : [],
      can_manage:
        hasAdminView ||
        (slug ? !isEveryoneTeamSlug(slug) && adminSlugs.has(slug) : false),
    };
  });

  const response = paginated
    ? successResponse({
        teams: teamsWithCounts,
        total,
        page,
        page_size: pageSize,
        has_more: page * pageSize < total,
      })
    : successResponse({
        teams: teamsWithCounts,
        total,
      });
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  return response;
});

// POST /api/admin/teams
export const POST = withErrorHandler(async (request: NextRequest) => {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - teams require MongoDB',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireAdminSurfaceManage(session, 'teams');

  const body: CreateTeamRequest = await request.json();

    if (!body.name || body.name.trim() === '') {
      throw new ApiError('Team name is required', 400);
    }

    const slug = (body.slug?.trim() || deriveSlug(body.name)).toLowerCase();
    if (!slug || !isValidTeamSlug(slug)) {
      throw new ApiError(
        `Could not derive a valid slug from team name "${body.name}". ` +
          `Provide a "slug" explicitly (lowercase letters, digits, hyphens; max 63 chars).`,
        400
      );
    }

    const teams = await getCollection<TeamListDocument>('teams');
    
    // Check if team name already exists
    const existing = await teams.findOne({ name: body.name });
    if (existing) {
      throw new ApiError('Team name already exists', 400);
    }
    const slugConflict = await teams.findOne({ slug });
    if (slugConflict) {
      throw new ApiError(
        `Team slug "${slug}" already in use by team "${slugConflict.name}". ` +
          `Provide a different "slug" in the request.`,
        400
      );
    }

    // Compute the initial roster for OpenFGA + team_membership_sources
    // writes below. The creator is ALWAYS the owner — even if their own
    // email also appears in `body.members` (which the UI sometimes does
    // by mistake). Dedupe silently so we don't issue duplicate tuple
    // writes for the same identity.
    //
    // Commit 6/8 of the canonical-team-membership refactor (spec
    // 2026-05-26-canonical-team-membership): this roster is now a
    // local-only iteration helper. It is NOT persisted onto the team
    // document — `team_membership_sources` is the only store of truth.
    const now = new Date();
    const creatorEmail = user.email.trim().toLowerCase();
    const inviteeEmails = (body.members ?? [])
      .map(email => email.trim().toLowerCase())
      .filter(email => email.length > 0 && email !== creatorEmail);
    const members = [
      ...inviteeEmails.map(email => ({
        user_id: email,
        role: 'member' as const,
        added_at: now,
        added_by: user.email,
      })),
      {
        user_id: creatorEmail,
        role: 'owner' as const,
        added_at: now,
        added_by: user.email,
      },
    ];

    const team = {
      name: body.name,
      slug,
      description: body.description || '',
      source: 'manual',
      status: 'active',
      owner_id: user.email,
      created_by: user.email,
      updated_by: user.email,
      created_at: now,
      updated_at: now,
    };

    const result = await teams.insertOne(team);

    // Phase 3 (spec 2026-05-24-derive-team-from-channel) removed the per-team
    // Keycloak client scope. Team identity is now derived from the
    // channel→team mapping at message time, not from a baked-in `active_team`
    // JWT claim, so the BFF no longer needs to touch Keycloak when a team is
    // created. The remaining work is OpenFGA tuple sync below.

    // Sync OpenFGA + team_membership_sources for every member in the new
    // team. This is the step that the original implementation forgot to do
    // — without these tuples, `team:<slug>#can_use` is always false and
    // `OWNER_TEAM_FORBIDDEN` fires on the next agent-creation request,
    // even for the team's own creator.
    //
    // Failures here are logged but never thrown: the Mongo team + Keycloak
    // scope are already committed and the startup audit will repair any
    // tuple that didn't make it. The team-creation API is still useful
    // even if OpenFGA is briefly unreachable.
    const createdAt = now.toISOString();
    const sourceBase = {
      team_id: result.insertedId.toString(),
      team_slug: slug,
      source_type: 'manual' as const,
      managed: false,
      status: 'active' as const,
      created_by: user.email,
      created_at: createdAt,
      first_seen_at: createdAt,
      last_seen_at: createdAt,
      last_applied_at: createdAt,
    };

    await Promise.all(
      members.map(async (member) => {
        const email = member.user_id;
        const relationship =
          member.role === 'owner' ? 'admin' : (member.role as 'member' | 'admin');
        // Resolve the stable Keycloak subject for this email. May be
        // undefined when the user does not yet exist in Keycloak; we still
        // persist the source row so a later audit can repair the tuple.
        const userSubject = await resolveKeycloakUserSubject(email, slug);

        if (userSubject) {
          try {
            await writeTeamMembershipTuples(
              userSubject,
              slug,
              mongoRoleToOpenFgaRelations(member.role),
              'assign',
            );
          } catch (err) {
            console.error(
              `[Admin] Failed to write OpenFGA membership tuple for ${email} on team ${slug}:`,
              err,
            );
          }
        } else {
          console.warn(
            `[Admin] No Keycloak subject for ${email} on team ${slug}; ` +
              `skipping OpenFGA tuple write. Source row persisted for later repair.`,
          );
        }

        const source: TeamMembershipSource = {
          ...sourceBase,
          user_email: email,
          user_subject: userSubject,
          relationship,
        };
        await upsertTeamMembershipSource(source);
      }),
    );

    console.log(`[Admin] Team created: ${body.name} (slug=${slug}) by ${user.email}`);

  return successResponse({
    message: 'Team created successfully',
    team_id: result.insertedId,
    team,
  }, 201);
});

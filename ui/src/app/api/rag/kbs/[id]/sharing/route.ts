/**
 * Knowledge Base Search Access route for legacy/direct data sources.
 *
 * GET /api/rag/kbs/[id]/sharing — returns the canonical people/team Search
 * grants plus the singular person/team Owner. Policy comes
 * from OpenFGA; names and email addresses are directory projections only.
 *
 * PUT /api/rag/kbs/[id]/sharing — accepts structured `owner` and
 * `search_access` references (with legacy team-only fields retained) and calls
 * the shared reconcilers so removing a person or team genuinely revokes it.
 *
 * Gate: source configuration visibility/management comes from the independent
 * `ingestion_source` graph. A `knowledge_base#admin` fallback keeps older
 * direct datasources manageable until their first save projects that source
 * policy. Search-only users cannot read this configuration.
 */

import { ApiError, handleApiError } from "@/lib/api-middleware";
import { authOptions } from "@/lib/auth-config";
import { getCollection } from "@/lib/mongodb";
import {
  createPublicationRequest,
  invalidatePublicationRequests,
  publicationResourceRevision,
  recordAutoApprovedPublication,
  type RagPublicationState,
} from "@/lib/publication-approval.server";
import {
  datasourceCollectionAudience,
  visibleRagCollectionsByDatasource,
} from "@/lib/rag-collections.server";
import {
  prepareRagPublication,
  ragPublicationRevision,
} from "@/lib/rag-publication-approval.server";
import { readOpenFgaTuples } from "@/lib/rbac/openfga";
import {
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import {
  canTransferResourceOwnership,
  requireResourcePermission,
} from "@/lib/rbac/resource-authz";
import {
  resolveUserIdentitiesBySubject,
  unresolvedUserIdentity,
  type ResolvedUserIdentity,
} from "@/lib/rbac/user-identity-directory";
import type { Team } from "@/types/teams";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;
const MAX_SHARED_SUBJECTS = 50;

type SharingManagerResource = "knowledge_base" | "ingestion_source";

async function requireSharingAccess(
  session: { sub?: string; role?: string; user?: { email?: string | null } },
  id: string,
  sourceAction: "read" | "manage",
): Promise<SharingManagerResource> {
  try {
    await requireResourcePermission(
      session,
      { type: "ingestion_source", id, action: sourceAction },
      { bypassForOrgAdmin: true },
    );
    return "ingestion_source";
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 403) throw error;
  }

  // Compatibility fallback for direct datasources created before the
  // independent ingestion_source graph was introduced. Never fall back to KB
  // read: a Search Access grant must not reveal management configuration.
  await requireResourcePermission(
    session,
    { type: "knowledge_base", id, action: "admin" },
    { bypassForOrgAdmin: true },
  );
  return "knowledge_base";
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && OPENFGA_ID_PATTERN.test(value);
}

function parseTeamSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      "team_slugs must be an array of team slugs",
      400,
      "INVALID_TEAM_SLUGS",
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") {
      throw new ApiError(
        "team_slugs must contain only valid team slugs",
        400,
        "INVALID_TEAM_SLUGS",
      );
    }
    const trimmed = candidate.trim();
    if (!trimmed || !isValidId(trimmed)) {
      throw new ApiError(
        "team_slugs must contain only valid team slugs",
        400,
        "INVALID_TEAM_SLUGS",
      );
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  if (out.length > MAX_SHARED_SUBJECTS) {
    throw new ApiError(
      `A knowledge base cannot be shared with more than ${MAX_SHARED_SUBJECTS} teams`,
      400,
      "TOO_MANY_SHARED_TEAMS",
    );
  }
  return out;
}

function parseUserSubjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      "user_subjects must be an array of user subjects",
      400,
      "INVALID_USER_SUBJECTS",
    );
  }
  const subjects = Array.from(
    new Set(
      raw.map((candidate) => {
        if (!isValidId(candidate)) {
          throw new ApiError(
            "user_subjects must contain only valid user subjects",
            400,
            "INVALID_USER_SUBJECTS",
          );
        }
        return candidate.trim();
      }),
    ),
  );
  if (subjects.length > MAX_SHARED_SUBJECTS) {
    throw new ApiError(
      `A knowledge base cannot be shared with more than ${MAX_SHARED_SUBJECTS} people`,
      400,
      "TOO_MANY_SHARED_USERS",
    );
  }
  return subjects;
}

async function requireExistingTeams(teamSlugs: string[]): Promise<void> {
  if (teamSlugs.length === 0) return;
  const teams = await getCollection<Team>("teams");
  const rows = await teams
    .find({ slug: { $in: teamSlugs } } as never)
    .project({ slug: 1 })
    .toArray();
  const existing = new Set(rows.map((team) => team.slug));
  if (teamSlugs.some((slug) => !existing.has(slug))) {
    throw new ApiError("One or more teams do not exist", 404, "TEAM_NOT_FOUND");
  }
}

async function requireExistingUsers(
  userSubjects: string[],
  currentSessionSubject?: string,
): Promise<void> {
  if (userSubjects.length === 0) return;
  const identities = await resolveUserIdentitiesBySubject(userSubjects);
  if (
    userSubjects.some(
      (subject) =>
        subject !== currentSessionSubject && !identities.has(subject),
    )
  ) {
    throw new ApiError("One or more users do not exist", 404, "USER_NOT_FOUND");
  }
}

interface SharedAccessSnapshot {
  teamSlugs: string[];
  userSubjects: string[];
}

async function loadSharedAccess(kbId: string): Promise<SharedAccessSnapshot> {
  // Read every tuple targeting this knowledge_base and extract any
  // `team:<slug>#member reader knowledge_base:<id>` entry. Reading this
  // canonical marker is sufficient to recover the search-team set.
  const slugs = new Set<string>();
  const userSubjects = new Set<string>();
  let continuationToken: string | undefined;
  const object = `knowledge_base:${kbId}`;
  do {
    const page = await readOpenFgaTuples({
      tuple: { object },
      continuationToken,
    });
    for (const tuple of page.tuples) {
      const key = tuple.key;
      if (!key) continue;
      if (key.object !== object) continue;
      if (key.relation !== "reader") continue;
      const match = /^team:([^#]+)#member$/.exec(key.user);
      if (match && match[1] && isValidId(match[1])) {
        slugs.add(match[1]);
      }
      const userMatch = /^user:(.+)$/.exec(key.user);
      if (userMatch && userMatch[1] && isValidId(userMatch[1])) {
        userSubjects.add(userMatch[1]);
      }
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);

  return {
    teamSlugs: [...slugs].sort(),
    userSubjects: [...userSubjects].sort(),
  };
}

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

/**
 * Read the persisted owner team + creator from the datasource config (the
 * source of truth — see spec 2026-06-03, US5). A data_source is 1:1 with its
 * knowledge_base (same id), so we look up the datasource by `kbId` from the
 * RAG server's `/v1/datasources` list. Returns nulls when the config is
 * unavailable or carries no ownership (pre-migration datasources).
 */
interface DatasourceConfigSnapshot {
  ownerTeamSlug: string | null;
  ownerSubject: string | null;
  creatorSubject: string | null;
  searchUserSubjects: string[];
}

async function loadOwnerFromConfig(
  kbId: string,
  session: { accessToken?: string; org?: string },
  options: { required?: boolean } = {},
): Promise<DatasourceConfigSnapshot> {
  const empty: DatasourceConfigSnapshot = {
    ownerTeamSlug: null,
    ownerSubject: null,
    creatorSubject: null,
    searchUserSubjects: [],
  };
  if (!session.accessToken) {
    if (options.required) {
      throw new ApiError(
        "A Keycloak access token is required for KB sharing.",
        401,
        "NOT_SIGNED_IN",
      );
    }
    return empty;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (session.org) headers["X-Tenant-Id"] = session.org;

  let response: Response;
  try {
    response = await fetch(`${getRagServerUrl()}/v1/datasources`, {
      method: "GET",
      headers,
    });
  } catch {
    if (options.required) {
      throw new ApiError(
        "The datasource configuration service is unavailable.",
        503,
        "RAG_CONFIG_UNAVAILABLE",
      );
    }
    return empty;
  }
  if (!response.ok) {
    if (options.required) {
      throw new ApiError(
        `Failed to load datasource configuration (${response.status}).`,
        response.status === 401 || response.status === 403
          ? response.status
          : 502,
        "RAG_CONFIG_LOAD_FAILED",
      );
    }
    return empty;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (options.required) {
      throw new ApiError(
        "The datasource configuration response was invalid.",
        502,
        "RAG_CONFIG_INVALID",
      );
    }
    return empty;
  }
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { datasources?: unknown }).datasources)
  ) {
    if (options.required) {
      throw new ApiError(
        "The datasource configuration response was invalid.",
        502,
        "RAG_CONFIG_INVALID",
      );
    }
    return empty;
  }
  const list = (data as { datasources: Array<Record<string, unknown>> })
    .datasources;
  const match = list.find((ds) => {
    const id = ds.datasource_id ?? ds.id;
    return typeof id === "string" && id === kbId;
  });
  if (!match) {
    if (options.required) {
      throw new ApiError(
        "Datasource configuration not found",
        404,
        "DATASOURCE_CONFIG_NOT_FOUND",
      );
    }
    return empty;
  }
  const ownerTeamSlug =
    typeof match.owner_team_slug === "string" && match.owner_team_slug.trim()
      ? match.owner_team_slug.trim()
      : null;
  const creatorSubject =
    typeof match.creator_subject === "string" && match.creator_subject.trim()
      ? match.creator_subject.trim()
      : null;
  const ownerSubject =
    typeof match.owner_subject === "string" && match.owner_subject.trim()
      ? match.owner_subject.trim()
      : null;
  const searchUserSubjects = Array.isArray(match.search_with_users)
    ? match.search_with_users.filter(isValidId)
    : [];
  return { ownerTeamSlug, ownerSubject, creatorSubject, searchUserSubjects };
}

/**
 * Persist access metadata through the RAG server's narrow policy endpoint.
 * The endpoint authorizes a query-policy admin or independent source manager
 * and cannot overwrite connector assignment or source settings.
 */
async function persistAccessPolicyToConfig(
  kbId: string,
  update: {
    ownerTeamSlug?: string | null;
    ownerSubject?: string | null;
    searchTeamSlugs?: string[];
    searchUserSubjects?: string[];
  },
  session: { accessToken?: string; org?: string },
): Promise<void> {
  if (!session.accessToken) {
    throw new ApiError(
      "The datasource configuration is unavailable for ownership transfer.",
      503,
      "RAG_CONFIG_UNAVAILABLE",
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (session.org) headers["X-Tenant-Id"] = session.org;
  const response = await fetch(
    `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(kbId)}/owner-team`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ...(Object.prototype.hasOwnProperty.call(update, "ownerTeamSlug")
          ? { owner_team_slug: update.ownerTeamSlug }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, "ownerSubject")
          ? { owner_subject: update.ownerSubject }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, "searchTeamSlugs")
          ? { search_with_teams: update.searchTeamSlugs }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, "searchUserSubjects")
          ? { search_with_users: update.searchUserSubjects }
          : {}),
      }),
    },
  );
  if (!response.ok) {
    throw new ApiError(
      `Failed to persist datasource access metadata (${response.status}).`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
      "ACCESS_POLICY_PERSIST_FAILED",
    );
  }
}

interface SharingIdentity {
  kind: "user" | "team";
  id: string;
  name: string;
  email?: string | null;
}

function userSharingIdentity(identity: ResolvedUserIdentity): SharingIdentity {
  return {
    kind: "user",
    id: identity.subject,
    name: identity.name ?? identity.email ?? identity.display_name,
    email: identity.email,
  };
}

async function resolveSharingUsers(
  subjects: string[],
  session: {
    sub?: unknown;
    user?: { email?: string | null; name?: string | null };
  },
): Promise<Map<string, ResolvedUserIdentity>> {
  const resolved = await resolveUserIdentitiesBySubject(subjects).catch(
    () => new Map(),
  );
  const sessionSubject =
    typeof session.sub === "string" ? session.sub.trim() : "";
  if (
    sessionSubject &&
    subjects.includes(sessionSubject) &&
    !resolved.has(sessionSubject)
  ) {
    const email = session.user?.email?.trim() || null;
    const name = session.user?.name?.trim() || null;
    resolved.set(sessionSubject, {
      subject: sessionSubject,
      email,
      name,
      display_name: email ?? name ?? "Current user",
    });
  }
  return resolved;
}

function identityForSubject(
  subject: string,
  identities: Map<string, ResolvedUserIdentity>,
): SharingIdentity {
  return userSharingIdentity(
    identities.get(subject) ?? unresolvedUserIdentity(subject),
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isValidId(id)) {
      throw new ApiError(
        `Invalid knowledge base id: ${id}`,
        400,
        "INVALID_KB_ID",
      );
    }

    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      throw new ApiError("Unauthorized", 401);
    }
    if (!session.accessToken) {
      throw new ApiError(
        "A Keycloak access token is required for KB sharing.",
        401,
        "NOT_SIGNED_IN",
      );
    }

    await requireSharingAccess(
      { sub: session.sub, role: session.role, user: session.user },
      id,
      "read",
    );

    const [sharedAccess, owner] = await Promise.all([
      loadSharedAccess(id),
      loadOwnerFromConfig(id, {
        accessToken: session.accessToken,
        org: session.org,
      }),
    ]);
    const ownerSubject = owner.ownerTeamSlug
      ? null
      : (owner.ownerSubject ??
        owner.creatorSubject ??
        (typeof session.sub === "string" ? session.sub.trim() || null : null));
    const identitySubjects = Array.from(
      new Set(
        [
          ownerSubject,
          owner.creatorSubject,
          ...sharedAccess.userSubjects,
        ].filter((subject): subject is string => Boolean(subject)),
      ),
    );
    const identities = await resolveSharingUsers(identitySubjects, session);
    const collectionLabels = await visibleRagCollectionsByDatasource(session, [
      id,
    ]);
    const ownerIdentity: SharingIdentity | null = owner.ownerTeamSlug
      ? { kind: "team", id: owner.ownerTeamSlug, name: owner.ownerTeamSlug }
      : ownerSubject
        ? identityForSubject(ownerSubject, identities)
        : null;

    return NextResponse.json({
      knowledge_base_id: id,
      // Management ownership and Search Access are independent. An owner team
      // may also be an explicitly selected search team, so never hide or
      // dedupe it from the canonical knowledge_base reader tuples.
      shared_team_slugs: sharedAccess.teamSlugs,
      shared_user_subjects: sharedAccess.userSubjects,
      owner_team_slug: owner.ownerTeamSlug,
      owner_subject: ownerSubject,
      creator_subject: owner.creatorSubject,
      owner: ownerIdentity,
      creator: owner.creatorSubject
        ? identityForSubject(owner.creatorSubject, identities)
        : null,
      search_access: [
        ...sharedAccess.teamSlugs.map((slug) => ({
          kind: "team" as const,
          id: slug,
          name: slug,
        })),
        ...sharedAccess.userSubjects.map((subject) =>
          identityForSubject(subject, identities),
        ),
      ],
      rag_collections: collectionLabels.get(id) ?? [],
    });
  } catch (error) {
    if (error instanceof ApiError) return handleApiError(error);
    console.error("[rag/kbs/[id]/sharing] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load KB sharing", details: String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isValidId(id)) {
      throw new ApiError(
        `Invalid knowledge base id: ${id}`,
        400,
        "INVALID_KB_ID",
      );
    }

    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      throw new ApiError("Unauthorized", 401);
    }
    if (!session.accessToken) {
      throw new ApiError(
        "A Keycloak access token is required for KB sharing.",
        401,
        "NOT_SIGNED_IN",
      );
    }

    const sharingManagerResource = await requireSharingAccess(
      { sub: session.sub, role: session.role, user: session.user },
      id,
      "manage",
    );

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(
        "Request body must be an object with a `team_slugs` array",
        400,
        "INVALID_BODY",
      );
    }
    const typedBody = body as {
      team_slugs?: unknown;
      user_subjects?: unknown;
      search_access?: unknown;
      owner?: unknown;
      owner_team_slug?: unknown;
      confirm_not_member?: unknown;
    };
    let requestedSlugs: string[];
    let requestedUserSubjects: string[] | undefined;
    if (Object.prototype.hasOwnProperty.call(typedBody, "search_access")) {
      if (!Array.isArray(typedBody.search_access)) {
        throw new ApiError(
          "search_access must be an array",
          400,
          "INVALID_SEARCH_ACCESS",
        );
      }
      const teams: string[] = [];
      const users: string[] = [];
      for (const raw of typedBody.search_access) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new ApiError(
            "search_access entries must identify a person or team",
            400,
            "INVALID_SEARCH_ACCESS",
          );
        }
        const ref = raw as { kind?: unknown; id?: unknown };
        if (
          (ref.kind !== "team" && ref.kind !== "user") ||
          !isValidId(ref.id)
        ) {
          throw new ApiError(
            "search_access entries must identify a valid person or team",
            400,
            "INVALID_SEARCH_ACCESS",
          );
        }
        (ref.kind === "team" ? teams : users).push(ref.id.trim());
      }
      requestedSlugs = parseTeamSlugs(teams);
      requestedUserSubjects = parseUserSubjects(users);
    } else {
      requestedSlugs = parseTeamSlugs(typedBody.team_slugs);
      requestedUserSubjects = Object.prototype.hasOwnProperty.call(
        typedBody,
        "user_subjects",
      )
        ? parseUserSubjects(typedBody.user_subjects)
        : undefined;
    }

    let requestedOwnerTeam: string | null | undefined;
    let requestedOwnerSubject: string | null | undefined;
    const ownerWasRequested = Object.prototype.hasOwnProperty.call(
      typedBody,
      "owner",
    );
    if (ownerWasRequested) {
      if (
        !typedBody.owner ||
        typeof typedBody.owner !== "object" ||
        Array.isArray(typedBody.owner)
      ) {
        throw new ApiError(
          "owner must identify a person or team",
          400,
          "INVALID_OWNER",
        );
      }
      const owner = typedBody.owner as { kind?: unknown; id?: unknown };
      if (
        (owner.kind !== "team" && owner.kind !== "user") ||
        !isValidId(owner.id)
      ) {
        throw new ApiError(
          "owner must identify a valid person or team",
          400,
          "INVALID_OWNER",
        );
      }
      if (owner.kind === "team") requestedOwnerTeam = owner.id.trim();
      else requestedOwnerSubject = owner.id.trim();
    } else if (
      Object.prototype.hasOwnProperty.call(typedBody, "owner_team_slug")
    ) {
      // Backward compatibility for clients that predate person/team refs.
      if (
        typeof typedBody.owner_team_slug !== "string" ||
        !isValidId(typedBody.owner_team_slug)
      ) {
        throw new ApiError(
          "owner_team_slug must be a valid team slug",
          400,
          "INVALID_OWNER_TEAM",
        );
      }
      requestedOwnerTeam = typedBody.owner_team_slug.trim();
    }
    if (
      Object.prototype.hasOwnProperty.call(typedBody, "confirm_not_member") &&
      typeof typedBody.confirm_not_member !== "boolean"
    ) {
      throw new ApiError(
        "confirm_not_member must be a boolean",
        400,
        "INVALID_CONFIRMATION",
      );
    }
    const confirmedNotMember = typedBody.confirm_not_member === true;
    await requireExistingTeams([
      ...requestedSlugs,
      ...(requestedOwnerTeam ? [requestedOwnerTeam] : []),
    ]);
    await requireExistingUsers(
      [
        ...(requestedUserSubjects ?? []),
        ...(requestedOwnerSubject ? [requestedOwnerSubject] : []),
      ],
      typeof session.sub === "string" ? session.sub : undefined,
    );
    const [previousAccess, snapshot] = await Promise.all([
      loadSharedAccess(id),
      loadOwnerFromConfig(
        id,
        { accessToken: session.accessToken, org: session.org },
        { required: true },
      ),
    ]);

    // A few pre-migration direct datasources have neither ownership field nor
    // creator provenance. Their first access-policy save adopts them as a
    // personal source for the authorized caller instead of leaving a
    // permanently ownerless row.
    const sessionSubject =
      typeof session.sub === "string" ? session.sub.trim() || null : null;
    const previousPersonalOwner = snapshot.ownerTeamSlug
      ? null
      : (snapshot.ownerSubject ?? snapshot.creatorSubject);
    const effectivePreviousPersonalOwner = snapshot.ownerTeamSlug
      ? null
      : (previousPersonalOwner ?? sessionSubject);
    const nextOwnerTeam =
      ownerWasRequested || requestedOwnerTeam !== undefined
        ? (requestedOwnerTeam ?? null)
        : snapshot.ownerTeamSlug;
    const nextPersonalOwner = ownerWasRequested
      ? (requestedOwnerSubject ?? null)
      : requestedOwnerTeam !== undefined
        ? null
        : effectivePreviousPersonalOwner;
    if (!nextOwnerTeam && !nextPersonalOwner) {
      throw new ApiError(
        "Select a person or team to own this data source",
        400,
        "INVALID_OWNER",
      );
    }
    const ownerSelectionWasRequested =
      ownerWasRequested || requestedOwnerTeam !== undefined;
    const ownerChanged =
      ownerSelectionWasRequested &&
      (nextOwnerTeam !== snapshot.ownerTeamSlug ||
        nextPersonalOwner !== effectivePreviousPersonalOwner);
    // A legacy team-only client did not know about user_subjects. Preserve
    // direct grants unless the client explicitly supplies either the modern
    // search_access array or the legacy user_subjects field.
    const nextSearchUserSubjects = (
      requestedUserSubjects ?? previousAccess.userSubjects
    ).filter((subject) => subject !== nextPersonalOwner);
    const hadPersistedOwner = Boolean(
      snapshot.ownerTeamSlug || previousPersonalOwner,
    );
    if (ownerChanged && hadPersistedOwner) {
      const canTransfer = await canTransferResourceOwnership(
        { sub: session.sub, role: session.role, user: session.user },
        { type: sharingManagerResource, id },
      );
      if (!canTransfer) {
        throw new ApiError(
          "Only the current Owner or an organization admin can transfer this datasource.",
          403,
          "TRANSFER_FORBIDDEN",
        );
      }
    }
    if (ownerChanged && nextOwnerTeam && !confirmedNotMember) {
      const canUseDestination = await requireResourcePermission(
        { sub: session.sub, role: session.role, user: session.user },
        { type: "team", id: nextOwnerTeam, action: "use" },
      ).then(
        () => true,
        () => false,
      );
      if (!canUseDestination) {
        throw new ApiError(
          "You are not a member of the destination team. Confirm the transfer to proceed.",
          409,
          "TRANSFER_NOT_MEMBER_UNCONFIRMED",
        );
      }
    }
    if (
      ownerChanged &&
      nextPersonalOwner &&
      nextPersonalOwner !== session.sub &&
      !confirmedNotMember
    ) {
      throw new ApiError(
        "Transferring this data source to another person may remove your access. Confirm the transfer to proceed.",
        409,
        "TRANSFER_CONFIRMATION_REQUIRED",
      );
    }
    const creatorSubject = snapshot.creatorSubject ?? sessionSubject;
    const sourceCollection = await getCollection<IngestionSourceConfig>(
      "rag_ingestion_sources",
    );
    const localSource = await sourceCollection.findOne({
      source_id: id,
    } as never);
    const publicationSource = {
      ...(localSource ?? {
        source_id: id,
        source_type: "web_url",
        name: id,
        status: "active",
        default_chunk_size: 1000,
        default_chunk_overlap: 100,
        reload_interval: 3600,
        config_driven: false,
        config_import_adopted: false,
        visibility: "team",
        shared_with_teams: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      creator_subject: creatorSubject ?? undefined,
      owner_team_slug: snapshot.ownerTeamSlug ?? undefined,
      owner_subject: effectivePreviousPersonalOwner ?? undefined,
    } as IngestionSourceConfig;
    if (snapshot.ownerTeamSlug) {
      delete (publicationSource as unknown as Record<string, unknown>)
        .owner_subject;
    } else {
      delete (publicationSource as unknown as Record<string, unknown>)
        .owner_team_slug;
    }
    const collectionAudience = ownerChanged
      ? await datasourceCollectionAudience(id, {
          ownerTeamSlug: snapshot.ownerTeamSlug,
          ownerSubject: effectivePreviousPersonalOwner,
        })
      : {
          collectionIds: [],
          readerTeamSlugs: [],
          hasExternalPrincipal: false,
          organizationWide: false,
        };
    const publication = await prepareRagPublication({
      session,
      source: publicationSource,
      currentSearchTeamSlugs: previousAccess.teamSlugs,
      currentSearchUserSubjects: previousAccess.userSubjects,
      requestedSearchTeamSlugs: requestedSlugs,
      requestedSearchUserSubjects: nextSearchUserSubjects,
      ownerUpdate: ownerChanged
        ? {
            owner_team_slug: nextOwnerTeam,
            owner_subject: nextPersonalOwner,
          }
        : undefined,
      materialChange: ownerChanged,
      externalAudienceTeamSlugs: collectionAudience.readerTeamSlugs,
      externalBroadAudience: collectionAudience.hasExternalPrincipal,
      externalOrganizationWide: collectionAudience.organizationWide,
    });
    await invalidatePublicationRequests(
      publication.resource,
      publication.actor,
      "A newer datasource access change replaced this publication proposal.",
    );
    const effectiveSearch = publication.plan
      .effective_state as unknown as RagPublicationState;
    const effectiveSearchTeamSlugs = effectiveSearch.search_team_slugs;
    const effectiveSearchUserSubjects = effectiveSearch.search_user_subjects;
    const ownerChangeDeferred =
      publication.plan.requires_approval && ownerChanged;
    const appliedOwnerTeam = ownerChangeDeferred
      ? snapshot.ownerTeamSlug
      : nextOwnerTeam;
    const appliedPersonalOwner = ownerChangeDeferred
      ? effectivePreviousPersonalOwner
      : nextPersonalOwner;
    const appliedOwnerMetadataChanged =
      appliedOwnerTeam !== snapshot.ownerTeamSlug ||
      appliedPersonalOwner !== previousPersonalOwner;
    const appliedPersonalOwnerChanged =
      previousPersonalOwner !== appliedPersonalOwner;
    let accessMetadataPersisted = false;
    let policyWriteStarted = false;
    let result!: Awaited<
      ReturnType<typeof reconcileKnowledgeBaseRelationships>
    >;
    let sourceResult!: Awaited<
      ReturnType<typeof reconcileIngestionSourceRelationships>
    >;
    let dataSourceResult!: Awaited<
      ReturnType<typeof reconcileDataSourceRelationships>
    >;

    try {
      await persistAccessPolicyToConfig(
        id,
        {
          ...(appliedOwnerMetadataChanged
            ? {
                ownerTeamSlug: appliedOwnerTeam,
                ownerSubject: appliedPersonalOwner,
              }
            : {}),
          searchTeamSlugs: effectiveSearchTeamSlugs,
          searchUserSubjects: effectiveSearchUserSubjects,
        },
        {
          accessToken: session.accessToken,
          org: session.org,
        },
      );
      accessMetadataPersisted = true;

      policyWriteStarted = true;
      sourceResult = await reconcileIngestionSourceRelationships({
        sourceId: id,
        ownerSubject: appliedPersonalOwner,
        previousOwnerSubject: appliedPersonalOwnerChanged
          ? previousPersonalOwner
          : undefined,
        ownerTeamSlug: appliedOwnerTeam,
        previousOwnerTeamSlug: appliedOwnerMetadataChanged
          ? snapshot.ownerTeamSlug
          : undefined,
        nextSharedTeamSlugs: [],
        previousSharedTeamSlugs: [],
        creatorSubject,
      });
      result = await reconcileKnowledgeBaseRelationships({
        knowledgeBaseId: id,
        ownerSubject: appliedPersonalOwner,
        previousOwnerSubject: appliedPersonalOwnerChanged
          ? previousPersonalOwner
          : undefined,
        // Owner Team is management-only. Supplying the old owner as the
        // previous KB owner removes the coupled legacy query grant on save.
        ownerTeamSlug: null,
        previousOwnerTeamSlug: snapshot.ownerTeamSlug,
        nextSharedTeamSlugs: effectiveSearchTeamSlugs,
        previousSharedTeamSlugs: previousAccess.teamSlugs,
        nextSharedUserSubjects: effectiveSearchUserSubjects,
        previousSharedUserSubjects: previousAccess.userSubjects,
        // This legacy/direct panel previously granted managers to shared-team
        // admins. Remove those stale tuples on the next save.
        previousSharedTeamAdminsManage: true,
        creatorSubject,
      });
      dataSourceResult = await reconcileDataSourceRelationships({
        dataSourceId: id,
        parentKnowledgeBaseId: id,
      });
      if (localSource) {
        const localSet: Record<string, unknown> = {
          search_with_teams: effectiveSearchTeamSlugs,
          search_with_users: effectiveSearchUserSubjects,
          updated_at: new Date().toISOString(),
        };
        if (appliedOwnerTeam) localSet.owner_team_slug = appliedOwnerTeam;
        if (appliedPersonalOwner) localSet.owner_subject = appliedPersonalOwner;
        const mongoUpdate: Record<string, unknown> = {
          $set: localSet,
        };
        const unset: Record<string, string> = { search_owner_team_slug: "" };
        if (appliedOwnerTeam) unset.owner_subject = "";
        else unset.owner_team_slug = "";
        mongoUpdate.$unset = unset;
        const localUpdated = await sourceCollection.findOneAndUpdate(
          { source_id: id } as never,
          mongoUpdate as never,
          { returnDocument: "after" },
        );
        if (!localUpdated)
          throw new Error("Datasource config disappeared while saving access");
      }
    } catch (error) {
      // The datasource metadata is written first so the old owner remains
      // authorized if the policy write fails. Restore the exact old policy
      // before restoring metadata; after a successful transfer only that
      // restored policy lets a non-org-admin old owner call the narrow owner
      // endpoint again.
      if (policyWriteStarted) {
        try {
          await reconcileIngestionSourceRelationships({
            sourceId: id,
            ownerSubject: previousPersonalOwner,
            previousOwnerSubject: appliedPersonalOwnerChanged
              ? appliedPersonalOwner
              : undefined,
            ownerTeamSlug: snapshot.ownerTeamSlug,
            previousOwnerTeamSlug: appliedOwnerMetadataChanged
              ? appliedOwnerTeam
              : undefined,
            nextSharedTeamSlugs: [],
            previousSharedTeamSlugs: [],
            creatorSubject: snapshot.creatorSubject,
          });
          await reconcileKnowledgeBaseRelationships({
            knowledgeBaseId: id,
            ownerSubject: previousPersonalOwner,
            previousOwnerSubject: appliedPersonalOwnerChanged
              ? appliedPersonalOwner
              : undefined,
            // Restore the prior query set without re-coupling management. If
            // the old management owner had query access it is already present
            // in previousSlugs and is restored as a search-only team.
            ownerTeamSlug: null,
            previousOwnerTeamSlug: appliedOwnerTeam,
            nextSharedTeamSlugs: previousAccess.teamSlugs,
            previousSharedTeamSlugs: effectiveSearchTeamSlugs,
            nextSharedUserSubjects: previousAccess.userSubjects,
            previousSharedUserSubjects: effectiveSearchUserSubjects,
            previousSharedTeamAdminsManage: false,
            creatorSubject: snapshot.creatorSubject,
          });
          await reconcileDataSourceRelationships({
            dataSourceId: id,
            parentKnowledgeBaseId: id,
          });
        } catch (rollbackError) {
          console.error(
            `[rag/kbs/${id}/sharing] failed to restore Search policy`,
            rollbackError,
          );
        }
      }
      if (accessMetadataPersisted) {
        try {
          await persistAccessPolicyToConfig(
            id,
            {
              ...(appliedOwnerMetadataChanged
                ? { ownerTeamSlug: snapshot.ownerTeamSlug }
                : {}),
              ...(appliedOwnerMetadataChanged
                ? { ownerSubject: previousPersonalOwner }
                : {}),
              searchTeamSlugs: previousAccess.teamSlugs,
              searchUserSubjects: snapshot.searchUserSubjects,
            },
            {
              accessToken: session.accessToken,
              org: session.org,
            },
          );
        } catch (rollbackError) {
          console.error(
            `[rag/kbs/${id}/sharing] failed to restore datasource access metadata`,
            rollbackError,
          );
        }
      }
      throw error;
    }

    const currentLocalSource = localSource
      ? await sourceCollection.findOne({ source_id: id } as never)
      : null;
    const resourceRevision = currentLocalSource
      ? ragPublicationRevision(currentLocalSource, effectiveSearch)
      : publicationResourceRevision({
          source_id: id,
          owner_team_slug: appliedOwnerTeam,
          owner_subject: appliedPersonalOwner,
          creator_subject: creatorSubject,
          ...effectiveSearch,
        });
    let publicationRequest: Awaited<
      ReturnType<typeof createPublicationRequest>
    > | null = null;
    if (publication.plan.requires_approval) {
      publicationRequest = await createPublicationRequest({
        resource: publication.resource,
        resourceRevision,
        requestedState: publication.requestedState as unknown as Record<
          string,
          unknown
        >,
        effectiveState: effectiveSearch as unknown as Record<string, unknown>,
        riskFacts: publication.plan.risk_facts,
        requester: publication.actor,
        requesterTeamSlugs: publication.requesterTeamSlugs,
        approverTeamSlugs: publication.plan.approver_team_slugs,
        approverUserSubjects: publication.plan.approver_user_subjects,
      });
    } else {
      await recordAutoApprovedPublication({
        resource: publication.resource,
        resourceRevision,
        requestedState: publication.requestedState as unknown as Record<
          string,
          unknown
        >,
        effectiveState: effectiveSearch as unknown as Record<string, unknown>,
        riskFacts: publication.plan.risk_facts,
        requester: publication.actor,
        requesterTeamSlugs: publication.requesterTeamSlugs,
        approverTeamSlugs: publication.plan.approver_team_slugs,
        approverUserSubjects: publication.plan.approver_user_subjects,
      });
    }

    const identitySubjects = Array.from(
      new Set(
        [
          appliedPersonalOwner,
          creatorSubject,
          ...nextSearchUserSubjects,
        ].filter((subject): subject is string => Boolean(subject)),
      ),
    );
    const identities = await resolveSharingUsers(identitySubjects, session);
    const collectionLabels = await visibleRagCollectionsByDatasource(session, [
      id,
    ]);
    return NextResponse.json({
      knowledge_base_id: id,
      owner_team_slug: appliedOwnerTeam,
      owner_subject: appliedPersonalOwner,
      shared_team_slugs: effectiveSearchTeamSlugs,
      shared_user_subjects: effectiveSearchUserSubjects,
      creator_subject: creatorSubject,
      owner: appliedOwnerTeam
        ? { kind: "team", id: appliedOwnerTeam, name: appliedOwnerTeam }
        : appliedPersonalOwner
          ? identityForSubject(appliedPersonalOwner, identities)
          : null,
      creator: creatorSubject
        ? identityForSubject(creatorSubject, identities)
        : null,
      search_access: [
        ...effectiveSearchTeamSlugs.map((slug) => ({
          kind: "team" as const,
          id: slug,
          name: slug,
        })),
        ...effectiveSearchUserSubjects.map((subject) =>
          identityForSubject(subject, identities),
        ),
      ],
      rag_collections: collectionLabels.get(id) ?? [],
      source_reconcile: sourceResult,
      reconcile: result,
      data_source_reconcile: dataSourceResult,
      ...(publicationRequest
        ? {
            publication_request: {
              id: publicationRequest._id,
              status: publicationRequest.status,
              requested_state: publicationRequest.requested_state,
              effective_state: publicationRequest.effective_state,
              risk_facts: publicationRequest.risk_facts,
              requester: publicationRequest.requester,
              created_at: publicationRequest.created_at,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof ApiError) return handleApiError(error);
    console.error("[rag/kbs/[id]/sharing] PUT error:", error);
    return NextResponse.json(
      { error: "Failed to update KB sharing", details: String(error) },
      { status: 500 },
    );
  }
}

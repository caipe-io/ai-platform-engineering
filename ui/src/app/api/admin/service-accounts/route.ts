import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import { ApiError } from "@/lib/api-error";
import { reconcileTupleDiff } from "@/lib/authz";
import { checkOpenFgaTuple, listOpenFgaObjects } from "@/lib/rbac/openfga";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";
import {
  createServiceAccountClient,
  deleteServiceAccountClient,
  getServiceAccountTokenUrl,
} from "@/lib/rbac/keycloak-admin";
import { logOpenFgaRebacAuditEvent } from "@/lib/rbac/audit";
import { resolveAuthorizedAdminSimulationScope } from "@/lib/rbac/admin-simulation-server";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import { organizationObjectId } from "@/lib/rbac/organization";
import {
  countByOwningTeams,
  createServiceAccountDoc,
  isNameTakenInTeam,
  listByOwningTeams,
} from "@/lib/service-accounts";
import {
  parseScope,
  scopeCheckTuple,
  scopeWriteTuple,
  type ScopeRef,
} from "@/lib/service-account-scopes";
import type { ServiceAccount, ServiceAccountScope } from "@/types/mongodb";
import { isProtectedServiceAccount } from "@/types/mongodb";

// ── Request-validation constants (constitution VII: validate at the boundary) ──
const NAME_MIN = 1;
const NAME_MAX = 64;
/** Display names: letters, digits, space, and - _ . — must start/end alnum. */
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/;
const DESCRIPTION_MAX = 256;
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SCOPES = 100;

interface CreateBody {
  name: string;
  description?: string;
  owning_team_id: string;
  scopes: ScopeRef[];
}

/** Parse + validate the create body at the boundary. Returns the typed body or an error string. */
function parseCreateBody(raw: unknown): { body?: CreateBody; error?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (
    name.length < NAME_MIN ||
    name.length > NAME_MAX ||
    !NAME_PATTERN.test(name)
  ) {
    return {
      error: `name must be ${NAME_MIN}-${NAME_MAX} chars (letters, digits, space, . _ -)`,
    };
  }

  let description: string | undefined;
  if (obj.description !== undefined && obj.description !== null) {
    if (
      typeof obj.description !== "string" ||
      obj.description.length > DESCRIPTION_MAX
    ) {
      return {
        error: `description must be a string ≤ ${DESCRIPTION_MAX} chars`,
      };
    }
    description = obj.description.trim() || undefined;
  }

  const owningTeamId =
    typeof obj.owning_team_id === "string" ? obj.owning_team_id.trim() : "";
  if (!TEAM_ID_PATTERN.test(owningTeamId)) {
    return { error: "owning_team_id is malformed" };
  }

  if (!Array.isArray(obj.scopes)) {
    return { error: "scopes must be an array" };
  }
  if (obj.scopes.length > MAX_SCOPES) {
    return { error: `scopes may not exceed ${MAX_SCOPES} entries` };
  }
  const scopes: ScopeRef[] = [];
  for (const entry of obj.scopes) {
    const { scope, error } = parseScope(entry);
    if (!scope) return { error };
    scopes.push(scope);
  }

  return { body: { name, description, owning_team_id: owningTeamId, scopes } };
}

/**
 * GET /api/admin/service-accounts
 *
 * List service accounts the caller can manage — active SAs in teams the caller
 * belongs to (FR-014, FR-021). Owning-team membership is the visibility
 * boundary: callers only ever see SAs owned by their own teams. Organization
 * admins (`hasOrganizationAdmin`) instead see SAs across every team.
 *
 * `?include_revoked=true` optionally includes revoked SAs (audit view).
 *
 * Pagination + server-side search are OPT-IN via the `page` query param,
 * mirroring `admin/teams`: callers that omit `page` (e.g. `ServiceAccountSelect`)
 * still get the full unpaginated list, exactly as before.
 *
 * NEVER returns credential material (FR-005). `scope_counts` come from the
 * display snapshot (cheap); the per-SA detail route reads authoritative scopes
 * from OpenFGA.
 *
 * Response: { success, data: { items: [...], total, page?, page_size? } }
 */

interface ServiceAccountListItem {
  id: string;
  name: string;
  description?: string;
  owning_team_id: string;
  created_by: string;
  created_at: Date;
  status: ServiceAccount["status"];
  protected: boolean;
  scope_counts: {
    agents: number;
    tools: number;
    datasources: number;
    collections: number;
  };
}

/** Strip the OpenFGA `team:` prefix from a list-objects result. */
function teamIdFromObject(object: string): string {
  return object.startsWith("team:") ? object.slice("team:".length) : object;
}

function scopeCounts(snapshot: ServiceAccountScope[] | undefined): {
  agents: number;
  tools: number;
  datasources: number;
  collections: number;
} {
  let agents = 0;
  let tools = 0;
  let datasources = 0;
  let collections = 0;
  for (const scope of snapshot ?? []) {
    if (scope.type === "agent") agents += 1;
    else if (scope.type === "tool") tools += 1;
    else if (scope.type === "datasource") datasources += 1;
    else if (scope.type === "collection") collections += 1;
  }
  return { agents, tools, datasources, collections };
}

export async function GET(request: NextRequest) {
  const session = (await getServerSession(authOptions)) as {
    sub?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email || !session.sub) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  let simulationScope;
  try {
    simulationScope = await resolveAuthorizedAdminSimulationScope(
      request.nextUrl.searchParams,
      session,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.statusCode },
      );
    }
    throw error;
  }
  const effectiveSubject =
    simulationScope?.openfgaUser ?? `user:${session.sub}`;
  // Org admins (real, session-backed) see every team's SAs unless a preview
  // subject narrows the view. `hasOrganizationAdmin` works for both Bearer
  // and session-cookie callers — unlike the stale `session.role === "admin"`
  // check this replaces, which was always false for Bearer callers.
  const isAdmin = simulationScope
    ? await checkOpenFgaTuple({
        user: effectiveSubject,
        relation: "can_manage",
        object: organizationObjectId(),
      })
        .then((decision) => decision.allowed)
        .catch(() => false)
    : await hasOrganizationAdmin(session);

  const searchParams = new URL(request.url).searchParams;
  const includeRevoked = searchParams.get("include_revoked") === "true";
  // Optional: narrow to a single owning team (e.g. the team that owns a Slack
  // channel). Still bounded by the caller's memberships below (unless admin),
  // so this only ever filters within what the caller may already see.
  const teamFilter = searchParams.get("team")?.trim() || null;

  // Pagination + search are OPT-IN via `page`, mirroring `admin/teams`: a
  // caller that omits `page` still gets the full unpaginated list.
  const paginated = searchParams.has("page");
  const page = paginated
    ? Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1)
    : 1;
  const pageSizeRaw = parseInt(searchParams.get("page_size") || "24", 10) || 24;
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
  const search = (searchParams.get("search") || "").trim();

  try {
    // `null` means "unbounded" (org admin, no team/preview narrowing) — every
    // team's SAs are visible. Any other value bounds the query to those teams.
    let owningTeamIds: string[] | null;

    if (teamFilter && isAdmin) {
      // Admins can see SAs for any team — no membership intersection needed.
      owningTeamIds = [teamFilter];
    } else if (simulationScope?.subjectType === "team") {
      // A team userset preview represents membership in that selected team.
      // Keep the list bounded to it instead of asking OpenFGA to infer a
      // user's team memberships from a userset subject.
      owningTeamIds = [simulationScope.subjectId];
      if (teamFilter && teamFilter !== simulationScope.subjectId) {
        owningTeamIds = [];
      }
    } else if (isAdmin && !simulationScope) {
      // Org admin, no team filter, no preview subject: the full org-wide view.
      owningTeamIds = null;
    } else {
      // Visibility boundary: the caller's own team memberships (FR-021).
      const teamObjects = await listOpenFgaObjects({
        user: effectiveSubject,
        relation: "member",
        type: "team",
      });
      owningTeamIds = teamObjects.objects.map(teamIdFromObject);

      if (teamFilter) {
        // Intersect the requested team with the caller's memberships. If the
        // caller isn't in that team, the result is empty (no cross-team leak).
        owningTeamIds = owningTeamIds.filter((id) => id === teamFilter);
      }
    }

    if (owningTeamIds !== null && owningTeamIds.length === 0) {
      return NextResponse.json({
        success: true,
        data: paginated
          ? { items: [], total: 0, page, page_size: pageSize }
          : { items: [] },
      });
    }

    const listOptions = { includeRevoked, search: search || undefined };
    const docs = await listByOwningTeams(owningTeamIds, {
      ...listOptions,
      ...(paginated ? { skip: (page - 1) * pageSize, limit: pageSize } : {}),
    });
    const total = paginated
      ? await countByOwningTeams(owningTeamIds, listOptions)
      : docs.length;

    const items: ServiceAccountListItem[] = docs.map((doc) => ({
      id: doc.sa_sub,
      name: doc.name,
      ...(doc.description ? { description: doc.description } : {}),
      owning_team_id: doc.owning_team_id,
      created_by: doc.created_by,
      created_at: doc.created_at,
      status: doc.status,
      protected: isProtectedServiceAccount(doc),
      scope_counts: scopeCounts(doc.scopes_snapshot),
    }));

    return NextResponse.json({
      success: true,
      data: paginated ? { items, total, page, page_size: pageSize } : { items },
    });
  } catch (error) {
    console.error("[service-accounts:list] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to list service accounts" },
      { status: 503 },
    );
  }
}

/**
 * POST /api/admin/service-accounts
 *
 * Create a scoped service account (US1; FR-001..FR-008). 7-step flow:
 *  0. Validate body at the boundary (400 on malformed — constitution VII).
 *  1. Team membership: check(user:<caller>, member, team:<owning_team_id>) → 403.
 *  2. Name unique among active SAs in team, case-insensitive (FR-002a) → 409.
 *  3. Per-scope check(user:<caller>, …): reject the WHOLE request if any scope
 *     is not held (FR-006/008) → 403, reporting which scopes were rejected.
 *  4. Keycloak: create confidential client → client_uuid, client_secret, sa_sub.
 *  5. OpenFGA: write owner_team tuple + one base tuple per granted scope.
 *  6. Mongo: insert the service_accounts doc (status active, scopes_snapshot).
 *  7. Audit: service_account.create (FR-026).
 *
 * Returns the credential ONCE (FR-005) in the 201 response — never re-fetchable.
 * On a post-Keycloak failure, the created client + any written tuples are
 * compensated (deleted) so a failed create leaves no orphans.
 */
export async function POST(request: NextRequest) {
  const session = (await getServerSession(authOptions)) as {
    sub?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email || !session.sub) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  const callerSub = session.sub;
  const caller = `user:${callerSub}`;

  // Step 0 — boundary validation.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const { body, error: parseError } = parseCreateBody(raw);
  if (!body) {
    return NextResponse.json(
      { success: false, error: parseError },
      { status: 400 },
    );
  }

  try {
    // Step 1 — team membership (FR-002).
    const membership = await checkOpenFgaTuple({
      user: caller,
      relation: "member",
      object: `team:${body.owning_team_id}`,
    });
    if (!membership.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "You are not a member of the owning team",
        },
        { status: 403 },
      );
    }

    // Step 2 — name uniqueness among active SAs in the team (FR-002a).
    if (await isNameTakenInTeam(body.owning_team_id, body.name)) {
      return NextResponse.json(
        {
          success: false,
          error: `A service account named "${body.name}" already exists in this team`,
        },
        { status: 409 },
      );
    }

    // Step 3 — per-scope authorization: reject the whole request if ANY scope
    // is not held by the caller (FR-006/008). Deduplicate first.
    const seen = new Set<string>();
    const scopes: ScopeRef[] = [];
    for (const scope of body.scopes) {
      const key = `${scope.type}:${scope.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push(scope);
    }

    // The grantable picker exposes the full catalog to organization admins.
    // Match the add-scope endpoint: org-admin authority is sufficient even
    // when it is implemented as a BFF/RAG super-grant instead of one direct
    // tuple on every resource.
    const platformAdmin =
      scopes.length > 0 ? await hasOrganizationAdmin(session) : false;
    const scopeChecks = platformAdmin
      ? scopes.map((scope) => ({ scope, allowed: true }))
      : await Promise.all(
          scopes.map(async (scope) => ({
            scope,
            allowed: (await checkOpenFgaTuple(scopeCheckTuple(scope, caller)))
              .allowed,
          })),
        );
    const rejected = scopeChecks.filter((r) => !r.allowed).map((r) => r.scope);
    if (rejected.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: "You cannot grant scopes you do not hold",
          data: { rejected_scopes: rejected },
        },
        { status: 403 },
      );
    }

    // Step 4 — Keycloak: create the confidential client.
    const client = await createServiceAccountClient(body.name);
    const saSubject = `service_account:${client.saSub}`;

    // Step 5 — OpenFGA: ownership + coarse-gateway baseline + scope tuples
    // (base relations only).
    const ownerTuple: OpenFgaTupleKey = {
      user: `team:${body.owning_team_id}#member`,
      relation: "owner_team",
      object: saSubject,
    };
    // Coarse AgentGateway ext_authz gate (mcp_gateway:list): the bridge runs
    // this check for EVERY caller before any per-tool check. Human users get
    // this baseline tuple via repairCurrentUserBaseline on login; service
    // accounts never log into the BFF, so we must write it explicitly at
    // create (and remove it at revoke) — otherwise every SA tool call is
    // denied at the coarse gate even with correct scopes. See research.md R-9.
    const gatewayBaselineTuple: OpenFgaTupleKey = {
      user: saSubject,
      relation: "caller",
      object: "mcp_gateway:list",
    };
    // RAG has a feature-level organization gate in addition to datasource
    // ACLs. Keep that implementation detail out of the self-service picker:
    // selecting knowledge adds the harmless search baseline, while the selected
    // datasource or collection reader tuples remain the actual data boundary.
    const ragSearchBaselineTuple: OpenFgaTupleKey | null = scopes.some(
      (scope) => scope.type === "datasource" || scope.type === "collection",
    )
      ? {
          user: saSubject,
          relation: "searcher",
          object: organizationObjectId(),
        }
      : null;
    const scopeTuples = scopes.map((scope) =>
      scopeWriteTuple(scope, saSubject),
    );
    const writes = [
      ownerTuple,
      gatewayBaselineTuple,
      ...(ragSearchBaselineTuple ? [ragSearchBaselineTuple] : []),
      ...scopeTuples,
    ];

    try {
      await reconcileTupleDiff(
        { writes, deletes: [] },
        {
          caller: { type: "user", id: callerSub },
          source: "service_account_create",
        },
      );
    } catch (writeError) {
      // Compensate: remove the just-created Keycloak client so a failed write
      // leaves no orphaned credential.
      await deleteServiceAccountClient(client.clientUuid).catch(() => {});
      throw writeError;
    }

    // Step 6 — Mongo: insert the display doc.
    const grantedSnapshot: ServiceAccountScope[] = scopes.map((scope) => ({
      type: scope.type,
      ref: scope.ref,
      added_by: callerSub,
      added_at: new Date(),
    }));
    try {
      await createServiceAccountDoc({
        sa_sub: client.saSub,
        client_id: client.clientId,
        client_uuid: client.clientUuid,
        name: body.name,
        description: body.description,
        owning_team_id: body.owning_team_id,
        created_by: callerSub,
        scopes_snapshot: grantedSnapshot,
      });
    } catch (mongoError) {
      // Compensate fully: delete tuples + the Keycloak client.
      await reconcileTupleDiff(
        { writes: [], deletes: writes },
        {
          caller: { type: "user", id: callerSub },
          source: "service_account_create_rollback",
        },
      ).catch(() => {});
      await deleteServiceAccountClient(client.clientUuid).catch(() => {});
      throw mongoError;
    }

    // Step 7 — audit (FR-026): actor + target + scopes.
    logOpenFgaRebacAuditEvent({
      sub: callerSub,
      operation: "service_account.create",
      scope: "admin",
      resourceRef: `service_account:${client.saSub}`,
      email: session.user.email ?? undefined,
      correlationId: `service_account.create:${client.saSub}:${body.owning_team_id}:agents=${grantedSnapshot.filter((s) => s.type === "agent").length},tools=${grantedSnapshot.filter((s) => s.type === "tool").length},datasources=${grantedSnapshot.filter((s) => s.type === "datasource").length},collections=${grantedSnapshot.filter((s) => s.type === "collection").length}`,
    });

    // Credential returned ONCE (FR-005).
    return NextResponse.json(
      {
        success: true,
        data: {
          id: client.saSub,
          name: body.name,
          owning_team_id: body.owning_team_id,
          credential: {
            client_id: client.clientId,
            client_secret: client.clientSecret,
            token_url: getServiceAccountTokenUrl(),
          },
          granted_scopes: scopes,
          rejected_scopes: [],
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[service-accounts:create] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create service account" },
      { status: 503 },
    );
  }
}

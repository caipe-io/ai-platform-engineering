import {
  ApiError,
  getAuthFromBearerOrSession,
  handleApiError,
  requireRbacPermission,
} from "@/lib/api-middleware";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import {
  deleteAllDataSourceRelationshipTuples,
  deleteAllIngestionSourceRelationshipTuples,
  deleteAllKnowledgeBaseRelationshipTuples,
  deleteAllMcpToolRelationshipTuples,
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
  reconcileMcpToolRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import { organizationObjectId } from "@/lib/rbac/organization";
import {
  filterResourcesByPermission,
  requireResourcePermission,
  type ResourceAuthzSession,
  type ResourcePermissionAction,
} from "@/lib/rbac/resource-authz";
import { getCollection } from "@/lib/mongodb";
import {
  computeLocalFileDatasourceId,
  localUploadFilename,
} from "@/lib/local-file-datasource-id";
import {
  createPublicationRequest,
  invalidatePublicationRequests,
  publicationResourceRevision,
  recordAutoApprovedPublication,
  type RagPublicationState,
} from "@/lib/publication-approval.server";
import {
  enforceRagFileUploadLimits,
  enforceRagIngestorLimits,
  getRagIngestorLimits,
} from "@/lib/rag-ingestor-limits.server";
import {
  removeDatasourceFromAgentPins,
  removeDatasourceFromRagCollections,
  visibleRagCollectionsByDatasource,
} from "@/lib/rag-collections.server";
import { prepareRagPublication } from "@/lib/rag-publication-approval.server";
import { resolveShareableOwnershipWrite } from "@/lib/rbac/shareable-resource";
import { resolveUserIdentitiesBySubject } from "@/lib/rbac/user-identity-directory";
import type { RbacScope } from "@/lib/rbac/types";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
} from "@/types/ingestion-source";
import type { PublicationRequestDocument } from "@/types/publication-approval";
import { NextRequest, NextResponse } from "next/server";

/**
 * RAG API Proxy with JWT Bearer Token Authentication
 *
 * Proxies requests from /api/rag/* to the RAG server with JWT authentication.
 * The RAG server validates the JWT token and uses the subject for OpenFGA
 * checks. Static IdP/AD groups are not consumed by RAG authorization.
 *
 * Authentication:
 * - Authorization: Bearer {access_token} (OIDC JWT access token)
 *
 * The RAG server uses the access_token to authenticate the caller and
 * derive OpenFGA subjects for resource checks.
 *
 * This is the standards-compliant OAuth approach - only the access_token is
 * passed downstream, and user claims are fetched server-side from the
 * authoritative source (OIDC provider's userinfo endpoint).
 *
 * Example:
 *   /api/rag/healthz -> RAG_SERVER_URL/healthz (readiness probe, no Bearer token)
 *   /api/rag/v1/query -> RAG_SERVER_URL/v1/query (with Bearer token)
 *
 * The Web UI backend enforces coarse RAG access before proxying and
 * checks object-level OpenFGA relationships where the request identifies
 * a knowledge base, data source, or MCP tool.
 */

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

function scopeForRagProxyMethod(
  method: string,
  pathSegments: string[] = [],
): RbacScope {
  const path = pathSegments.join("/").toLowerCase();

  // Content retrieval is governed by the explicit search capability. The
  // RAG server additionally intersects each request with readable datasource
  // ids, so this gate never replaces object-level authorization.
  if (
    path === "v1/query" ||
    path === "v1/mcp/invoke" ||
    path.startsWith("v1/graph/explore/") ||
    path.startsWith("v1/chunk/") ||
    /^v1\/datasource\/[^/]+\/documents$/.test(path)
  ) {
    return "query";
  }

  if (method === "GET") {
    // Datasource/source-management discovery must not require Search Access:
    // a management-only owner still needs to see configuration and jobs.
    return "view";
  }

  if (method === "POST" && path.startsWith("v1/ingest/")) {
    if (path.endsWith("/reload-all")) return "admin";
    if (path.endsWith("/reload")) {
      // Existing-source reload is an Owner lifecycle action. The object-level
      // ingestion_source#can_manage check below and the RAG server enforce it.
      return "view";
    }
    return "ingest";
  }

  if (method === "POST") {
    if (path === "v1/datasource") return "ingest";
    if (path === "v1/jobs/batch") return "view";
    if (/^v1\/datasource\/[^/]+\/cleanup$/.test(path)) return "view";
    if (/^v1\/job\/[^/]+\/terminate$/.test(path)) {
      // The RAG server resolves the job's datasource and requires Owner access.
      return "view";
    }
    if (path === "v1/mcp/custom-tools") return "view";
  }

  if (
    (method === "PATCH" && /^v1\/datasource\/[^/]+$/.test(path)) ||
    (method === "DELETE" && path === "v1/datasource")
  ) {
    // Datasource lifecycle mutations are authorized below against the
    // independent ingestion_source Owner graph.
    return "view";
  }

  if (
    (method === "PUT" || method === "DELETE") &&
    /^v1\/mcp\/custom-tools\/[^/]+$/.test(path)
  ) {
    // The per-tool ownership gate below is authoritative for self-service
    // custom tools; this coarse check only requires org membership.
    return "view";
  }

  // Global cleanup, ingestor administration, built-in tool configuration,
  // and unknown mutations remain administrator-only by default.
  return "admin";
}

function actionForRagRequest(
  method: string,
  pathSegments: string[],
): ResourcePermissionAction {
  const path = pathSegments.join("/").toLowerCase();
  if (method === "GET")
    return path.includes("query") || path.includes("search")
      ? "read"
      : "discover";
  if (method === "POST") {
    if (
      path.endsWith("/reload") ||
      /^v1\/datasource\/[^/]+\/cleanup$/.test(path) ||
      /^v1\/job\/[^/]+\/terminate$/.test(path)
    ) {
      return "admin";
    }
    if (
      path.includes("ingest") ||
      path.includes("upload") ||
      path.includes("datasource")
    )
      return "ingest";
    return "read";
  }
  return "admin";
}

function resourceTypeForRagRequest(
  pathSegments: string[],
): "data_source" | "knowledge_base" {
  const path = pathSegments.join("/").toLowerCase();
  if (
    path === "v1/query" ||
    path === "v1/mcp/invoke" ||
    path.startsWith("v1/ingest/") ||
    path === "v1/datasource" ||
    path.startsWith("v1/datasource/") ||
    path === "v1/datasources" ||
    path.startsWith("v1/datasources/")
  ) {
    return "data_source";
  }
  return "knowledge_base";
}

function extractKnowledgeBaseId(
  request: NextRequest,
  pathSegments: string[],
  body?: unknown,
): string | null {
  for (const key of [
    "kb_id",
    "knowledge_base_id",
    "knowledgeBaseId",
    "datasource_id",
    "datasourceId",
  ]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) return value;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const bodyValue = (body as Record<string, unknown>)[key];
      if (typeof bodyValue === "string" && bodyValue.trim())
        return bodyValue.trim();
    }
  }

  if (
    pathSegments[0]?.toLowerCase() === "v1" &&
    pathSegments[1]?.toLowerCase() === "datasource" &&
    pathSegments[2]
  ) {
    return pathSegments[2];
  }

  const marker = pathSegments.findIndex((segment) =>
    [
      "kb",
      "knowledge-bases",
      "knowledge_base",
      "datasources",
      "data-sources",
    ].includes(segment.toLowerCase()),
  );
  if (marker >= 0 && pathSegments[marker + 1]) return pathSegments[marker + 1];
  return null;
}

function isDatasourceDeleteRequest(
  method: string,
  pathSegments: string[],
): boolean {
  return (
    method === "DELETE" &&
    pathSegments.join("/").toLowerCase() === "v1/datasource"
  );
}

const INGEST_PATH_SOURCE_TYPES: Record<string, IngestionSourceType> = {
  "v1/ingest/slack/channel": "slack_channel",
  "v1/ingest/slack/reload": "slack_channel",
  "v1/ingest/confluence/page": "confluence_space",
  "v1/ingest/confluence/preview": "confluence_space",
  "v1/ingest/confluence/reload": "confluence_space",
  "v1/ingest/jira/project": "jira_project",
  "v1/ingest/jira/preview": "jira_project",
  "v1/ingest/jira/reload": "jira_project",
  "v1/ingest/webloader/url": "web_url",
  "v1/ingest/webloader/preview": "web_url",
  "v1/ingest/webloader/reload": "web_url",
  "v1/ingest/webex/space": "webex_space",
  "v1/ingest/webex/reload": "webex_space",
};

async function enforceIngestRequestLimits(
  targetPath: string,
  body: unknown,
): Promise<void> {
  const sourceType = INGEST_PATH_SOURCE_TYPES[targetPath];
  if (!sourceType || !isRecord(body)) return;
  const limits = await getRagIngestorLimits();

  // A reload body contains only datasource_id. Resolve DB-managed source
  // settings so lowering a platform limit governs subsequent reloads too.
  if (targetPath.endsWith("/reload")) {
    const datasourceId = normalizeString(body.datasource_id);
    if (!datasourceId) return;
    const sources = await getCollection<IngestionSourceConfig>(
      "rag_ingestion_sources",
    );
    const source = await sources.findOne({ source_id: datasourceId } as never);
    if (!source) return; // Legacy/env source: the RAG server's hard limits remain authoritative.
    enforceRagIngestorLimits(
      source.source_type,
      source as unknown as Record<string, unknown>,
      limits,
    );
    return;
  }
  enforceRagIngestorLimits(sourceType, body, limits, { applyDefaults: true });
}

/**
 * Require RBAC for the proxy, then build headers for the upstream RAG server.
 */
interface AuthorizedRagContext {
  headers: Record<string, string>;
  session: {
    accessToken?: string;
    sub?: unknown;
    org?: string;
    role?: string;
    isServiceAccount?: boolean;
    user?: { email?: string | null };
  };
  pendingKnowledgeBaseOwnership?: {
    knowledgeBaseId: string;
    ownerSubject: string | null;
    ownerTeamSlug: string | null;
    /** Keycloak sub of the creator — persisted to the datasource config for
     *  provenance/audit (spec 2026-06-03, US2/US5). */
    creatorSubject: string | null;
  };
  /**
   * Populated for `PUT /v1/mcp/custom-tools/<tool_id>`. The proxy
   * writes the `mcp_tool:<tool_id>` tuples after a successful upstream
   * response so the new tool is visible to the owner team's members in
   * the filtered list endpoint.
   */
  pendingMcpToolOwnership?: {
    toolId: string;
    ownerSubject: string | null;
    ownerTeamSlug: string | null;
    creatorSubject: string | null;
    /** Teams the tool is shared with (from the request body). */
    sharedTeamSlugs: string[];
    /** Previously-persisted shared teams, read from config for the revoke diff. */
    previousSharedTeamSlugs: string[];
    /** Previously-persisted owner team, read from config. When the owner team
     *  changes, this is passed to the reconciler so the old team's grants are
     *  revoked instead of orphaned. */
    previousOwnerTeamSlug: string | null;
    /** Org-wide sharing requested in the body (organization#member grants). */
    sharedWithOrg: boolean;
    /** Previously-persisted org-wide state, for the revoke diff. */
    previousSharedWithOrg: boolean;
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function principalFromSession(
  session: AuthorizedRagContext["session"],
): string | null {
  const subject = normalizeString(session.sub);
  if (!subject) return null;
  return session.isServiceAccount === true
    ? `service_account:${subject}`
    : `user:${subject}`;
}

const TEAM_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

/** Normalize a list of team slugs: trim, drop blanks/invalid, dedupe. */
function normalizeSlugList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || !TEAM_SLUG_PATTERN.test(trimmed) || seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function localFileDatasourceId(form: FormData): Promise<string> {
  const files = form
    .getAll("file")
    .filter((value): value is File => value instanceof File);
  if (files.length === 0) {
    throw new ApiError(
      "At least one file is required",
      400,
      "INVALID_FILE_UPLOAD",
    );
  }
  return computeLocalFileDatasourceId(files);
}

function multipartIdList(
  form: FormData,
  field: string,
  maximum: number,
): string[] {
  const values = form.getAll(field);
  if (values.length > maximum) {
    throw new ApiError(
      `${field} cannot contain more than ${maximum} values`,
      400,
      "INVALID_FILE_UPLOAD",
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate || !TEAM_SLUG_PATTERN.test(candidate)) {
      throw new ApiError(
        `${field} contains an invalid identifier`,
        400,
        "INVALID_FILE_UPLOAD",
      );
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

interface LocalFilePublicationContext {
  sourceId: string;
  publication: Awaited<ReturnType<typeof prepareRagPublication>>;
  publicationRequest: PublicationRequestDocument | null;
}

async function localFileDatasourceExists(
  accessToken: string | undefined,
  sourceId: string,
  ownerTeamSlug: string | null,
): Promise<boolean> {
  if (!accessToken) {
    throw new ApiError(
      "A Keycloak access token is required to upload files",
      401,
      "NO_TOKEN",
    );
  }
  const target = new URL(
    `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(sourceId)}/exists`,
  );
  if (ownerTeamSlug) target.searchParams.set("owner_team_slug", ownerTeamSlug);
  let response: Response;
  try {
    response = await fetch(target, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new ApiError(
      "Unable to verify whether this file set already exists",
      503,
      "COLLISION_CHECK_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      "Unable to verify whether this file set already exists",
      503,
      "COLLISION_CHECK_UNAVAILABLE",
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    exists?: boolean;
  } | null;
  return payload?.exists === true;
}

async function rollbackLocalFilePublication(
  context: LocalFilePublicationContext,
): Promise<void> {
  await Promise.allSettled([
    deleteAllIngestionSourceRelationshipTuples(context.sourceId),
    deleteAllKnowledgeBaseRelationshipTuples(context.sourceId),
    deleteAllDataSourceRelationshipTuples(context.sourceId),
  ]);
  if (context.publicationRequest) {
    await invalidatePublicationRequests(
      context.publication.resource,
      context.publication.actor,
      "The file upload failed before the datasource was created.",
    ).catch((error) => {
      console.error(
        "[RAG Proxy] Failed to invalidate file publication request",
        error,
      );
    });
  }
}

async function prepareLocalFilePublication(
  form: FormData,
  session: AuthorizedRagContext["session"],
  maximumSearchTeams: number,
): Promise<LocalFilePublicationContext> {
  const sourceId = await localFileDatasourceId(form);
  const ownerTeamSlug = normalizeString(form.get("owner_team_slug"));
  const requestedSearchTeamSlugs = multipartIdList(
    form,
    "search_team_slugs",
    maximumSearchTeams,
  );
  const requestedSearchUserSubjects = multipartIdList(
    form,
    "search_user_subjects",
    50,
  );
  const [searchTeams, searchUsers] = await Promise.all([
    requestedSearchTeamSlugs.length > 0
      ? getCollection<{ slug: string }>("teams").then((teams) =>
          teams
            .find({ slug: { $in: requestedSearchTeamSlugs } } as never)
            .project({ _id: 0, slug: 1 })
            .toArray(),
        )
      : [],
    resolveUserIdentitiesBySubject(requestedSearchUserSubjects),
  ]);
  const existingSearchTeams = new Set(searchTeams.map((team) => team.slug));
  if (requestedSearchTeamSlugs.some((slug) => !existingSearchTeams.has(slug))) {
    throw new ApiError(
      "One or more Search teams do not exist",
      404,
      "SEARCH_TEAM_NOT_FOUND",
    );
  }
  if (
    requestedSearchUserSubjects.some((userSubject) => !searchUsers.has(userSubject))
  ) {
    throw new ApiError(
      "One or more Search users do not exist",
      404,
      "SEARCH_USER_NOT_FOUND",
    );
  }
  const subject = normalizeString(session.sub);
  if (!subject) {
    throw new ApiError(
      "A stable user subject is required for datasource ownership",
      401,
      "NO_SUBJECT",
    );
  }
  const authzSession: ResourceAuthzSession = {
    sub: subject,
    role: session.role,
    user: session.user,
    isServiceAccount: session.isServiceAccount,
  };
  if (ownerTeamSlug && !(await canUseTeam(authzSession, ownerTeamSlug))) {
    throw new ApiError(
      "You must belong to the Owner team to assign it",
      403,
      "OWNER_TEAM_FORBIDDEN",
    );
  }
  if (
    await localFileDatasourceExists(
      session.accessToken,
      sourceId,
      ownerTeamSlug,
    )
  ) {
    throw new ApiError(
      "This file set is already ingested. Delete the existing datasource before uploading it again.",
      409,
      "SOURCE_ALREADY_EXISTS",
    );
  }

  const files = form
    .getAll("file")
    .filter((value): value is File => value instanceof File);
  const firstName = localUploadFilename(files[0]?.name ?? "uploaded-file");
  const sourceName =
    files.length === 1 ? firstName : `${firstName} + ${files.length - 1} files`;
  const draftSource = {
    source_id: sourceId,
    source_type: "local_file",
    name: sourceName,
    description: normalizeString(form.get("description")) ?? "",
    status: "pending",
    default_chunk_size: Number(form.get("chunk_size") ?? 10000),
    default_chunk_overlap: Number(form.get("chunk_overlap") ?? 2000),
    reload_interval: 0,
    config_driven: false,
    config_import_adopted: false,
    visibility: "team",
    creator_subject: subject,
    owner_subject: ownerTeamSlug ? undefined : subject,
    owner_team_slug: ownerTeamSlug ?? undefined,
    search_with_teams: [],
    search_with_users: [],
    shared_with_teams: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as IngestionSourceConfig;
  const publication = await prepareRagPublication({
    session,
    source: draftSource,
    currentSearchTeamSlugs: [],
    currentSearchUserSubjects: [],
    requestedSearchTeamSlugs,
    requestedSearchUserSubjects,
  });
  const effectiveSearch = publication.plan
    .effective_state as unknown as RagPublicationState;
  let policyStarted = false;
  try {
    policyStarted = true;
    await reconcileIngestionSourceRelationships({
      sourceId,
      creatorSubject: subject,
      ownerSubject: ownerTeamSlug ? null : subject,
      ownerTeamSlug,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
    });
    await reconcileKnowledgeBaseRelationships({
      knowledgeBaseId: sourceId,
      creatorSubject: subject,
      ownerSubject: ownerTeamSlug ? null : subject,
      ownerTeamSlug: null,
      nextSharedTeamSlugs: effectiveSearch.search_team_slugs,
      previousSharedTeamSlugs: [],
      nextSharedUserSubjects: effectiveSearch.search_user_subjects,
      previousSharedUserSubjects: [],
    });
    await reconcileDataSourceRelationships({
      dataSourceId: sourceId,
      creatorSubject: subject,
      parentKnowledgeBaseId: sourceId,
    });
  } catch (error) {
    if (policyStarted) {
      await Promise.allSettled([
        deleteAllIngestionSourceRelationshipTuples(sourceId),
        deleteAllKnowledgeBaseRelationshipTuples(sourceId),
        deleteAllDataSourceRelationshipTuples(sourceId),
      ]);
    }
    throw error;
  }

  form.delete("search_team_slugs");
  form.delete("search_user_subjects");
  for (const slug of effectiveSearch.search_team_slugs) {
    form.append("search_team_slugs", slug);
  }
  for (const userSubject of effectiveSearch.search_user_subjects) {
    form.append("search_user_subjects", userSubject);
  }
  form.set("ownership_preprovisioned", "true");
  form.set("preprovisioned_datasource_id", sourceId);

  const resourceRevision = publicationResourceRevision({
    source_id: sourceId,
    owner_team_slug: ownerTeamSlug,
    owner_subject: ownerTeamSlug ? null : subject,
    creator_subject: subject,
    search_team_slugs: effectiveSearch.search_team_slugs,
    search_user_subjects: effectiveSearch.search_user_subjects,
  });
  let publicationRequest: PublicationRequestDocument | null = null;
  try {
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
    } else if (
      publication.plan.risk_facts.added_team_slugs?.length ||
      publication.plan.risk_facts.added_user_subjects?.length
    ) {
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
  } catch (error) {
    await Promise.allSettled([
      deleteAllIngestionSourceRelationshipTuples(sourceId),
      deleteAllKnowledgeBaseRelationshipTuples(sourceId),
      deleteAllDataSourceRelationshipTuples(sourceId),
    ]);
    throw error;
  }

  return { sourceId, publication, publicationRequest };
}

/** Boolean membership check (`team:<slug>#can_use` or `#can_manage`) for owner writes. */
async function canUseTeam(
  session: ResourceAuthzSession,
  slug: string,
): Promise<boolean> {
  try {
    await requireResourcePermission(session, {
      type: "team",
      id: slug,
      action: "use",
    });
    return true;
  } catch {
    // assisted-by Codex Codex-sonnet-4-6
    // Team admins/owners are valid destination members even when an older
    // projection has manage but lacks the derived can_use edge.
    try {
      await requireResourcePermission(session, {
        type: "team",
        id: slug,
        action: "manage",
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Read the previously-persisted MCP tool config (owner/creator/shared) from
 * the RAG server, used to compute the reconcile diff and preserve the
 * set-once creator. Returns empties when unavailable (new tool / no token).
 */
async function loadMcpToolConfig(
  toolId: string,
  session: { accessToken?: string; org?: string },
): Promise<{
  creatorSubject: string | null;
  ownerTeamSlug: string | null;
  sharedTeamSlugs: string[];
  sharedWithOrg: boolean;
}> {
  const empty = {
    creatorSubject: null,
    ownerTeamSlug: null,
    sharedTeamSlugs: [] as string[],
    sharedWithOrg: false,
  };
  if (!session.accessToken) return empty;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (session.org) headers["X-Tenant-Id"] = session.org;
  let response: Response;
  try {
    response = await fetch(`${getRagServerUrl()}/v1/mcp/custom-tools`, {
      method: "GET",
      headers,
    });
  } catch {
    return empty;
  }
  if (!response.ok) return empty;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return empty;
  }
  const list = Array.isArray(data) ? data : [];
  const match = list.find(
    (t): t is Record<string, unknown> => isRecord(t) && t.tool_id === toolId,
  );
  if (!match) return empty;
  return {
    creatorSubject: normalizeString(match.creator_subject),
    ownerTeamSlug: normalizeString(match.owner_team_slug),
    sharedTeamSlugs: normalizeSlugList(match.shared_with_teams),
    sharedWithOrg: match.shared_with_org === true,
  };
}

/**
 * Enforce `mcp_tool#can_call` on the invocation path (spec 2026-06-03, US6 /
 * FR-029). The BFF resolves the target custom tool from the invoke body's
 * `tool_name`, and denies with a tool-specific 403 if the caller (the session
 * user, or an agent principal for agent-initiated calls) lacks `can_call`.
 *
 * Built-in tool names (search, fetch_document, …) have no `mcp_tool` object —
 * they are NOT gated here (the RAG server's own role check applies). Only a
 * `tool_name` that matches a persisted custom tool is gated. Org admins
 * bypass (same `bypassForOrgAdmin` convention as the other RAG surfaces).
 */
async function requireMcpToolCallPermission(
  session: AuthorizedRagContext["session"],
  headers: Record<string, string>,
  pathSegments: string[],
  body: unknown,
): Promise<void> {
  if (pathSegments.join("/") !== "v1/mcp/invoke") return;
  if (!isRecord(body)) return;
  const toolName = normalizeString(body.tool_name);
  if (!toolName) return;

  // Only custom tools have an mcp_tool object. Resolve the custom-tool set
  // from the RAG server; a tool_name not in it is built-in → not gated. The
  // gate is FAIL-CLOSED: if we cannot determine whether `tool_name` is a
  // custom tool (listing error/parse failure), we deny rather than forward,
  // so a transient RAG-server error cannot be used to bypass `can_call`.
  let customToolIds: Set<string>;
  try {
    const response = await fetch(`${getRagServerUrl()}/v1/mcp/custom-tools`, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw new ApiError(
        "Unable to verify tool-call permission. Please retry.",
        503,
        "mcp_tool#call_unavailable",
      );
    }
    const data = await response.json();
    const list = Array.isArray(data) ? data : [];
    customToolIds = new Set(
      list
        .filter(isRecord)
        .map((t) => (typeof t.tool_id === "string" ? t.tool_id : ""))
        .filter(Boolean),
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "Unable to verify tool-call permission. Please retry.",
      503,
      "mcp_tool#call_unavailable",
    );
  }
  if (!customToolIds.has(toolName)) return; // built-in tool — not gated

  // Org admins bypass (kill-switchable), matching the other RAG surfaces.
  if (await isOrgAdminSession(session)) return;

  // Principal: an agent-initiated call carries `agent:<id>`; otherwise the
  // session user. The agent id is conveyed via the `X-Agent-Id` header set by
  // the dynamic-agent runtime when proxying tool calls on an agent's behalf.
  const agentId = normalizeString(
    headers["X-Agent-Id"] ?? headers["x-agent-id"],
  );
  const principal = agentId
    ? `agent:${agentId}`
    : principalFromSession(session);
  if (!principal) {
    throw new ApiError(
      "A stable principal is required to invoke this tool.",
      401,
      "NO_SUBJECT",
    );
  }

  let allowed = false;
  try {
    const result = await checkOpenFgaTuple({
      user: principal,
      relation: "can_call",
      object: `mcp_tool:${toolName}`,
    });
    allowed = result.allowed === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new ApiError(
      `You do not have permission to call the "${toolName}" tool.`,
      403,
      "mcp_tool#call",
    );
  }
}

/**
 * Enforce the explicit org-level `can_search` capability on the search data
 * path (spec 2026-06-03-explicit-search-capability). Applies to BOTH `/v1/query`
 * and `/v1/mcp/invoke` (built-in `search`/`fetch_document` AND custom search
 * tools like `caipe_kb`). This is the feature-level gate, layered ABOVE the
 * narrower per-tool `mcp_tool#can_call` and per-datasource `data_source#can_read`
 * checks — holding `can_call` on a shared tool does NOT, by itself, permit
 * search. Org admins bypass (kill-switchable). Fails closed on OpenFGA error.
 */
async function requireSearchCapability(
  session: AuthorizedRagContext["session"],
  pathSegments: string[],
): Promise<void> {
  const targetPath = pathSegments.join("/");
  if (targetPath !== "v1/query" && targetPath !== "v1/mcp/invoke") return;

  // Org admins bypass (same convention as the other RAG surfaces).
  if (await isOrgAdminSession(session)) return;

  const principal = principalFromSession(session);
  if (!principal) {
    throw new ApiError(
      "A stable principal is required to search.",
      401,
      "NO_SUBJECT",
    );
  }

  let allowed = false;
  try {
    const result = await checkOpenFgaTuple({
      user: principal,
      relation: "can_search",
      object: organizationObjectId(),
    });
    allowed = result.allowed === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new ApiError(
      "You do not have permission to search. Ask an administrator to enable search access.",
      403,
      "organization#can_search",
    );
  }
}

/** Reconcile the OpenFGA projection for an MCP tool create/update, including
 *  the creator tuple and the owner ∪ shared team-grant diff (spec US6). */
async function reconcileMcpToolForOwnership(pending: {
  toolId: string;
  ownerSubject: string | null;
  ownerTeamSlug: string | null;
  creatorSubject: string | null;
  sharedTeamSlugs: string[];
  previousSharedTeamSlugs: string[];
  previousOwnerTeamSlug: string | null;
  sharedWithOrg: boolean;
  previousSharedWithOrg: boolean;
}): Promise<void> {
  // `previousOwnerTeamSlug` is already non-null only on a transfer (set by the
  // shared `resolveShareableOwnershipWrite` decision), so the reconciler
  // revokes the old team's grants instead of orphaning them.
  const previousOwnerTeamSlug = pending.previousOwnerTeamSlug ?? undefined;
  await reconcileMcpToolRelationships({
    toolId: pending.toolId,
    ownerSubject: pending.ownerSubject,
    ownerTeamSlug: pending.ownerTeamSlug,
    creatorSubject: pending.creatorSubject,
    nextSharedTeamSlugs: pending.sharedTeamSlugs,
    previousSharedTeamSlugs: pending.previousSharedTeamSlugs,
    previousOwnerTeamSlug,
    sharedWithOrg: pending.sharedWithOrg,
    previousSharedWithOrg: pending.previousSharedWithOrg,
  });
}

function isDatasourceCreateRequest(
  method: string,
  pathSegments: string[],
): boolean {
  const path = pathSegments.join("/").toLowerCase();
  return (
    method === "POST" && (path === "v1/datasource" || path === "v1/datasources")
  );
}

/**
 * Detect `PUT /v1/mcp/custom-tools/<tool_id>` — the RAG server's upsert
 * endpoint for custom MCP tools. The path's last segment is the
 * tool id when this returns true, mirroring `extractMcpToolId`.
 */
function isMcpToolUpsertRequest(
  method: string,
  pathSegments: string[],
): boolean {
  const path = pathSegments.join("/").toLowerCase();
  return (
    method === "PUT" &&
    path.startsWith("v1/mcp/custom-tools/") &&
    pathSegments.length === 4
  );
}

/**
 * Detect `POST /v1/mcp/custom-tools` — the RAG server's create endpoint for
 * custom MCP tools. The tool id is in the request body (not the path).
 */
function isMcpToolCreateRequest(
  method: string,
  pathSegments: string[],
): boolean {
  return (
    method === "POST" &&
    pathSegments.join("/").toLowerCase() === "v1/mcp/custom-tools"
  );
}

/**
 * Return the `tool_id` for an MCP-tool upsert path
 * (`v1/mcp/custom-tools/<tool_id>`). Returns null when the path doesn't
 * match the upsert pattern.
 */
function extractMcpToolId(pathSegments: string[]): string | null {
  if (
    pathSegments.length === 4 &&
    pathSegments[0] === "v1" &&
    pathSegments[1] === "mcp" &&
    pathSegments[2] === "custom-tools"
  ) {
    const candidate = pathSegments[3]?.trim();
    return candidate && candidate.length > 0 ? candidate : null;
  }
  return null;
}

async function getAuthorizedRagContext(
  method: string,
  pathSegments: string[],
  request: NextRequest,
  body?: unknown,
): Promise<AuthorizedRagContext> {
  const { user, session } = await getAuthFromBearerOrSession(request);

  await requireRbacPermission(
    session,
    "rag",
    scopeForRagProxyMethod(method, pathSegments),
  );

  const kbId = extractKnowledgeBaseId(request, pathSegments, body);
  let pendingKnowledgeBaseOwnership: AuthorizedRagContext["pendingKnowledgeBaseOwnership"];
  if (kbId && isDatasourceCreateRequest(method, pathSegments)) {
    const ownerTeamSlug = isRecord(body)
      ? normalizeString(body.owner_team_slug)
      : null;
    if (ownerTeamSlug) {
      const canUseOwnerTeam = await canUseTeam(
        {
          sub: session.sub,
          role: session.role,
          user: session.user,
          isServiceAccount: session.isServiceAccount,
        },
        ownerTeamSlug,
      );
      if (!canUseOwnerTeam) {
        throw new ApiError(
          "You must belong to the owner team to assign it.",
          403,
          "OWNER_TEAM_FORBIDDEN",
        );
      }
    }
    const ownerSubject = normalizeString(session.sub);
    if (!ownerSubject) {
      throw new ApiError(
        "A stable user subject is required for knowledge base ownership.",
        401,
        "NO_SUBJECT",
      );
    }
    pendingKnowledgeBaseOwnership = {
      knowledgeBaseId: kbId,
      ownerSubject: ownerTeamSlug ? null : ownerSubject,
      ownerTeamSlug,
      creatorSubject: ownerSubject,
    };
  } else if (kbId) {
    const authzSession = {
      sub: session.sub,
      role: session.role,
      user: session.user,
      isServiceAccount: session.isServiceAccount,
    };
    const target = {
      type: resourceTypeForRagRequest(pathSegments),
      id: kbId,
      action: actionForRagRequest(method, pathSegments),
    };
    try {
      await requireResourcePermission(authzSession, target, {
        bypassForOrgAdmin: true,
      });
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.statusCode !== 403 ||
        target.type !== "data_source" ||
        (target.action !== "admin" && target.action !== "ingest")
      ) {
        throw error;
      }
      // Owner authority is independent from indexed-data access. Owners may
      // reload, edit, or delete without receiving team Search grants. The RAG
      // server repeats the same operation-specific check and remains
      // authoritative.
      await requireResourcePermission(
        authzSession,
        { type: "ingestion_source", id: kbId, action: "manage" },
        { bypassForOrgAdmin: true },
      );
    }
  }

  let pendingMcpToolOwnership: AuthorizedRagContext["pendingMcpToolOwnership"];
  if (
    isMcpToolUpsertRequest(method, pathSegments) ||
    isMcpToolCreateRequest(method, pathSegments)
  ) {
    // PUT carries the tool_id in the path; POST (create) carries it in the body.
    const toolId =
      extractMcpToolId(pathSegments) ??
      (isRecord(body) ? normalizeString(body.tool_id) : null);
    if (toolId) {
      const ownerSubject = normalizeString(session.sub);
      const authzSession = {
        sub: session.sub,
        role: session.role,
        user: session.user,
        isServiceAccount: session.isServiceAccount,
      };
      // Config is the source of truth: read the previous owner/creator/shared
      // (and org-wide) state so the shared resolver can keep set-once fields,
      // emit revoke deletes for removed teams/org grants, and detect an
      // ownership transfer.
      const previous = await loadMcpToolConfig(toolId, {
        accessToken: session.accessToken,
        org: session.org,
      });

      // Single decision path shared with the agent + KB routes: creator
      // set-once, transfer guard (owner-team admin/org admin) + not-a-member
      // confirm, first-set membership, shared-team + org-scope diff. The MCP
      // proxy persists config via the upstream body (pre-call) and reconciles
      // OpenFGA post-success, so we resolve here and apply each half in phase.
      const resolved = await resolveShareableOwnershipWrite(
        {
          objectType: "mcp_tool",
          objectId: toolId,
          session: authzSession,
          requestedOwnerTeamSlug: isRecord(body)
            ? normalizeString(body.owner_team_slug)
            : null,
          requestedSharedTeamSlugs: isRecord(body)
            ? normalizeSlugList(body.shared_with_teams)
            : null,
          requestedSharedWithOrg: isRecord(body)
            ? body.shared_with_org === true
            : null,
          confirmedNotMember:
            isRecord(body) && body.confirm_not_member === true,
          loadPrevious: async () => previous,
          persist: async () => {},
          canUseOwnerTeam: (slug) => canUseTeam(authzSession, slug),
        },
        previous,
      );

      pendingMcpToolOwnership = {
        toolId,
        ownerSubject,
        ownerTeamSlug: resolved.ownerTeamSlug,
        creatorSubject: resolved.creatorSubject ?? ownerSubject,
        sharedTeamSlugs: resolved.sharedTeamSlugs,
        previousSharedTeamSlugs: resolved.previousSharedTeamSlugs,
        previousOwnerTeamSlug: resolved.transferred
          ? resolved.previousOwnerTeamSlug
          : null,
        sharedWithOrg: resolved.sharedWithOrg,
        previousSharedWithOrg: resolved.previousSharedWithOrg,
      };
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session.accessToken) {
    headers["Authorization"] = `Bearer ${session.accessToken}`;
  }
  if (session.org) {
    headers["X-Tenant-Id"] = session.org;
  }
  // RAG derives the user's team membership from OpenFGA at request time
  // using the bearer-token subject (see `_kb_cel_context` on the server
  // side), so this proxy does not forward X-Team-Id or active_team.
  return {
    headers,
    session: { ...session, user: session.user ?? user },
    pendingKnowledgeBaseOwnership,
    pendingMcpToolOwnership,
  };
}

function isDatasourceListRequest(
  method: string,
  pathSegments: string[],
): boolean {
  return method === "GET" && pathSegments.join("/") === "v1/datasources";
}

function datasourceId(resource: Record<string, unknown>): string {
  const value = resource.datasource_id ?? resource.id;
  return typeof value === "string" ? value : "";
}

function redactDatasourceConfiguration(
  resource: Record<string, unknown>,
  canManageQueryPolicy: boolean,
): Record<string, unknown> {
  const visible: Record<string, unknown> = {};
  for (const key of [
    "datasource_id",
    "name",
    "description",
    "source_type",
    "last_updated",
  ]) {
    if (Object.prototype.hasOwnProperty.call(resource, key)) {
      visible[key] = resource[key];
    }
  }

  // A legacy query-policy manager may administer Search Access without
  // gaining connector configuration. Preserve only the ownership fields the
  // sharing panel needs, matching the RAG server's own redaction contract.
  if (canManageQueryPolicy) {
    for (const key of [
      "creator_subject",
      "owner_subject",
      "owner_team_slug",
      "shared_with_teams",
      "search_with_teams",
      "search_with_users",
      "owner_display_name",
      "owner_email",
      "search_user_display_names",
    ]) {
      if (Object.prototype.hasOwnProperty.call(resource, key)) {
        visible[key] = resource[key];
      }
    }
  }

  if (isRecord(resource._permissions)) {
    visible._permissions = Object.fromEntries(
      [
        "can_read_content",
        "can_ingest",
        "can_manage_query",
        "can_read_source_config",
        "can_manage_source",
      ].map((key) => [key, resource._permissions[key] === true]),
    );
  }
  return visible;
}

/**
 * Detect `GET /v1/mcp/custom-tools`. Used by `filterMcpToolListResponse`
 * to gate the BFF response on `mcp_tool#can_read` per row, with
 * org-admin bypass enabled. The RAG server doesn't yet enforce per-tool
 * ReBAC, so the filtering is BFF-side until PR4-server.
 */
function isMcpToolListRequest(method: string, pathSegments: string[]): boolean {
  return method === "GET" && pathSegments.join("/") === "v1/mcp/custom-tools";
}

function mcpToolIdOf(resource: Record<string, unknown>): string {
  const value = resource.tool_id ?? resource.id;
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function configuredIngestionSourceIds(
  datasourceIds: string[],
): Promise<Set<string> | null> {
  if (datasourceIds.length === 0) return new Set();

  try {
    const sources = await getCollection<{ source_id: string }>(
      "rag_ingestion_sources",
    );
    const configured = await sources
      .find(
        { source_id: { $in: datasourceIds } },
        { projection: { _id: 0, source_id: 1 } },
      )
      .toArray();
    return new Set(configured.map((source) => source.source_id));
  } catch (error) {
    // Datasource discovery should remain available if MongoDB is temporarily
    // unavailable. The UI treats an unknown source-policy state conservatively
    // and only exposes controls backed by ingestion_source#can_manage.
    console.warn(
      "Could not resolve RAG ingestion-source configuration markers",
      error,
    );
    return null;
  }
}

async function filterDatasourceListResponse(
  session: AuthorizedRagContext["session"],
  pathSegments: string[],
  data: unknown,
): Promise<unknown> {
  if (
    !isDatasourceListRequest("GET", pathSegments) ||
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { datasources?: unknown }).datasources)
  ) {
    return data;
  }

  const envelope = data as {
    datasources: Array<Record<string, unknown>>;
    count?: number;
  };
  const candidates = envelope.datasources.filter((resource) =>
    datasourceId(resource),
  );
  // Management of an ingestion source and access to its indexed content are
  // independent grants. Keep rows visible through either graph, matching the
  // RAG server's union, while preserving the upstream order. A management-only
  // row must remain visible so its owner can edit/retry/delete it without being
  // granted data_source#can_read.
  const [contentVisible, sourceVisible, queryPolicyManageable] =
    await Promise.all([
      filterResourcesByPermission(
        session,
        candidates,
        {
          type: "data_source",
          action: "read",
          id: datasourceId,
        },
        { bypassForOrgAdmin: true },
      ),
      filterResourcesByPermission(
        session,
        candidates,
        {
          type: "ingestion_source",
          action: "read",
          id: datasourceId,
        },
        { bypassForOrgAdmin: true },
      ),
      filterResourcesByPermission(
        session,
        candidates,
        {
          type: "data_source",
          action: "manage",
          id: datasourceId,
        },
        { bypassForOrgAdmin: true },
      ),
    ]);
  const sourceVisibleIds = new Set(
    sourceVisible.map(datasourceId).filter(Boolean),
  );
  const queryManageableIds = new Set(
    queryPolicyManageable.map(datasourceId).filter(Boolean),
  );
  const visibleIds = new Set(
    [...contentVisible, ...sourceVisible].map(datasourceId).filter(Boolean),
  );
  const visible = candidates
    .filter((resource) => visibleIds.has(datasourceId(resource)))
    .map((resource) => {
      const id = datasourceId(resource);
      return sourceVisibleIds.has(id)
        ? resource
        : redactDatasourceConfiguration(resource, queryManageableIds.has(id));
    });
  const configuredIds = await configuredIngestionSourceIds(
    visible.map(datasourceId),
  );
  const markedDatasources = configuredIds
    ? visible.map((resource) => ({
        ...resource,
        has_source_config: configuredIds.has(datasourceId(resource)),
      }))
    : visible;

  const subjects = Array.from(
    new Set(
      markedDatasources.flatMap((resource) => {
        const owner =
          typeof resource.owner_subject === "string"
            ? resource.owner_subject.trim()
            : !resource.owner_team_slug &&
                typeof resource.creator_subject === "string"
              ? resource.creator_subject.trim()
              : "";
        const shared = Array.isArray(resource.search_with_users)
          ? resource.search_with_users.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        return [owner, ...shared].filter(Boolean);
      }),
    ),
  );
  let identities = new Map<
    string,
    { display_name: string; email: string | null }
  >();
  try {
    identities = await resolveUserIdentitiesBySubject(subjects);
  } catch (error) {
    console.warn("Could not resolve RAG datasource identity labels", error);
  }
  const sessionSubject =
    typeof session.sub === "string" ? session.sub.trim() : "";
  const collectionLabels = await visibleRagCollectionsByDatasource(
    session,
    markedDatasources.map(datasourceId),
  ).catch(() => new Map());
  const datasources = markedDatasources.map((resource) => {
    const ownerSubject =
      typeof resource.owner_subject === "string"
        ? resource.owner_subject.trim()
        : !resource.owner_team_slug &&
            typeof resource.creator_subject === "string"
          ? resource.creator_subject.trim()
          : "";
    const ownerIdentity = identities.get(ownerSubject);
    const ownerEmail =
      ownerIdentity?.email ??
      (ownerSubject && ownerSubject === sessionSubject
        ? session.user?.email?.trim() || null
        : null);
    const searchUsers = Array.isArray(resource.search_with_users)
      ? resource.search_with_users.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      ...resource,
      rag_collections: collectionLabels.get(datasourceId(resource)) ?? [],
      ...(ownerSubject
        ? {
            owner_display_name:
              ownerIdentity?.display_name ?? ownerEmail ?? "Unknown user",
            owner_email: ownerEmail,
          }
        : {}),
      ...(Array.isArray(resource.search_with_users)
        ? {
            search_user_display_names: searchUsers.map(
              (subject) =>
                identities.get(subject)?.display_name ?? "Unknown user",
            ),
          }
        : {}),
    };
  });

  return { ...envelope, datasources, count: datasources.length };
}

/**
 * Filter the `GET /v1/mcp/custom-tools` response to only the tools a
 * non-admin caller has `mcp_tool#can_read` on. Org admins see every
 * row (via `bypassForOrgAdmin: true`). RAG server returns a bare JSON
 * array of `MCPToolConfig`, so we filter the array in place and pass
 * through the array (rather than wrapping it in an envelope) to avoid
 * a breaking schema change for the UI.
 *
 * If the kill switch `RAG_ADMIN_BYPASS_DISABLED` is on, admins go
 * through the same per-tool filter as everyone else.
 * assisted-by Cursor claude-opus-4-7
 */
async function filterMcpToolListResponse(
  session: AuthorizedRagContext["session"],
  pathSegments: string[],
  data: unknown,
): Promise<unknown> {
  if (!isMcpToolListRequest("GET", pathSegments) || !Array.isArray(data)) {
    return data;
  }
  const candidates = (data as Array<Record<string, unknown>>).filter(
    (resource) => isRecord(resource) && mcpToolIdOf(resource).length > 0,
  );
  if (candidates.length === 0) return data;

  return await filterResourcesByPermission(
    session,
    candidates,
    {
      type: "mcp_tool",
      action: "read",
      id: mcpToolIdOf,
    },
    { bypassForOrgAdmin: true },
  );
}

async function loadReadableDatasourceIds(
  session: AuthorizedRagContext["session"],
  headers: Record<string, string>,
): Promise<string[]> {
  const targetUrl = `${getRagServerUrl()}/v1/datasources`;
  const response = await fetch(targetUrl, { method: "GET", headers });
  if (!response.ok) {
    throw new ApiError(
      `Failed to resolve readable data sources: ${response.status}`,
      response.status,
    );
  }

  const data = await response.json();
  if (!isRecord(data) || !Array.isArray(data.datasources)) return [];

  const candidates = data.datasources
    .filter(isRecord)
    .filter((resource) => datasourceId(resource));
  const datasources = await filterResourcesByPermission(
    session,
    candidates,
    {
      type: "data_source",
      action: "read",
      id: datasourceId,
    },
    { bypassForOrgAdmin: true },
  );

  return datasources.map(datasourceId).filter(Boolean);
}

function constrainDatasourceFilter(
  value: Record<string, unknown>,
  allowedDatasourceIds: string[],
): Record<string, unknown> {
  if (allowedDatasourceIds.length === 0) {
    throw new ApiError(
      "No readable data sources are assigned to this user.",
      403,
      "data_source#read",
    );
  }

  const filters = isRecord(value.filters) ? { ...value.filters } : {};
  const existing = filters.datasource_id ?? value.datasource_id;

  if (typeof existing === "string") {
    if (!allowedDatasourceIds.includes(existing)) {
      throw new ApiError(
        "You do not have permission to search this data source.",
        403,
        "data_source#read",
      );
    }
    filters.datasource_id = existing;
  } else if (Array.isArray(existing)) {
    const intersection = existing.filter(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        allowedDatasourceIds.includes(candidate),
    );
    if (intersection.length === 0) {
      throw new ApiError(
        "You do not have permission to search these data sources.",
        403,
        "data_source#read",
      );
    }
    filters.datasource_id =
      intersection.length === 1 ? intersection[0] : intersection;
  } else {
    filters.datasource_id =
      allowedDatasourceIds.length === 1
        ? allowedDatasourceIds[0]
        : allowedDatasourceIds;
  }

  const { datasource_id, ...rest } = value;
  void datasource_id;
  return { ...rest, filters };
}

function isOrgAdminBypassKillSwitchEnabled(): boolean {
  const raw = process.env.RAG_ADMIN_BYPASS_DISABLED;
  if (!raw) return false;
  return raw === "1" || raw.trim().toLowerCase() === "true";
}

async function isOrgAdminSession(
  session: AuthorizedRagContext["session"],
): Promise<boolean> {
  if (isOrgAdminBypassKillSwitchEnabled()) return false;
  const principal = principalFromSession(session);
  if (!principal) return false;
  try {
    const result = await checkOpenFgaTuple({
      user: principal,
      relation: "can_manage",
      object: organizationObjectId(),
    });
    return result.allowed === true;
  } catch {
    return false;
  }
}

async function constrainSearchBody(
  session: AuthorizedRagContext["session"],
  headers: Record<string, string>,
  pathSegments: string[],
  body: unknown,
): Promise<unknown> {
  if (!isRecord(body)) {
    return body;
  }

  const targetPath = pathSegments.join("/");
  if (targetPath !== "v1/query" && targetPath !== "v1/mcp/invoke") {
    return body;
  }

  // Org admins (per OpenFGA `organization#admin`) skip the per-KB filter
  // injection on KB-aware search. The kill-switch env var disables this
  // bypass. See `bypassForOrgAdmin` in resource-authz.ts.
  if (await isOrgAdminSession(session)) {
    return body;
  }

  const allowedDatasourceIds = await loadReadableDatasourceIds(
    session,
    headers,
  );
  if (targetPath === "v1/query") {
    return constrainDatasourceFilter(body, allowedDatasourceIds);
  }

  const args = body.arguments;
  if (!isRecord(args) || typeof args.query !== "string") {
    return body;
  }

  return {
    ...body,
    arguments: constrainDatasourceFilter(args, allowedDatasourceIds),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const ragServerUrl = getRagServerUrl();
    const targetPath = path.join("/");
    const targetUrl = new URL(`${ragServerUrl}/${targetPath}`);

    const searchParams = request.nextUrl.searchParams;
    searchParams.forEach((value, key) => {
      targetUrl.searchParams.append(key, value);
    });

    if (request.method === "GET" && targetPath === "healthz") {
      // assisted-by Codex Codex-sonnet-4-6
      // Health is a readiness probe, not a data operation. Keep KB/query/admin
      // routes RBAC-gated, but let UI status checks verify that RAG is up even
      // when the browser session has no downstream Keycloak access token.
      const response = await fetch(targetUrl.toString(), { method: "GET" });
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    const { headers, session } = await getAuthorizedRagContext(
      "GET",
      path,
      request,
    );
    const response = await fetch(targetUrl.toString(), {
      method: "GET",
      headers,
    });

    const data = await response.json();
    let filteredData = await filterDatasourceListResponse(session, path, data);
    filteredData = await filterMcpToolListResponse(session, path, filteredData);
    return NextResponse.json(filteredData, { status: response.status });
  } catch (error) {
    if (error instanceof ApiError) {
      return handleApiError(error);
    }
    console.error("[RAG Proxy] GET error:", error);
    return NextResponse.json(
      { error: "Failed to connect to RAG server", details: String(error) },
      { status: 502 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const ragServerUrl = getRagServerUrl();
    const targetPath = path.join("/");
    const targetUrl = `${ragServerUrl}/${targetPath}`;
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType
      .toLowerCase()
      .includes("multipart/form-data");

    // Parse the JSON body when present. We attempt a parse whenever a
    // content-length is absent-but-nonempty OR positive, because the
    // `mcp_tool#can_call` gate below needs the `tool_name` and some clients
    // omit content-length on small JSON payloads. A parse failure leaves
    // body undefined (the gate then no-ops, falling back to the RAG server's
    // own role check).
    let body: unknown = undefined;
    let multipartBody: FormData | undefined;
    let localFilePublication: LocalFilePublicationContext | null = null;
    const contentLength = request.headers.get("content-length");
    const hasBody = contentLength === null || parseInt(contentLength) > 0;
    if (hasBody && !isMultipart) {
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
    }

    const {
      headers,
      session,
      pendingKnowledgeBaseOwnership,
      pendingMcpToolOwnership,
    } = await getAuthorizedRagContext("POST", path, request, body);

    // Enforce the org-level `can_search` capability on the search data path
    // (spec 2026-06-03-explicit-search-capability) BEFORE the narrower per-tool
    // gate. Covers `/v1/query` and `/v1/mcp/invoke` (built-in + custom tools).
    await requireSearchCapability(session, path);

    // Enforce `mcp_tool#can_call` before forwarding a custom-tool invocation
    // (spec 2026-06-03, US6 / FR-029). Built-in tools have no mcp_tool object
    // and are not gated here.
    await requireMcpToolCallPermission(session, headers, path, body);

    body = await constrainSearchBody(session, headers, path, body);

    if (isMultipart) {
      multipartBody = await request.formData();
      if (targetPath === "v1/ingest/local-file") {
        const limits = await getRagIngestorLimits();
        enforceRagFileUploadLimits(multipartBody, limits);
        localFilePublication = await prepareLocalFilePublication(
          multipartBody,
          session,
          limits.shared.max_search_teams,
        );
      }
    } else {
      await enforceIngestRequestLimits(targetPath, body);
    }

    // Persist owner/creator to the datasource config (the source of truth):
    // inject the captured ownership fields into the body forwarded to the RAG
    // server so its `DataSourceInfo` (OwnedResourceMixin) stores them. OpenFGA
    // is reconciled below as the derived projection (spec 2026-06-03, US5).
    if (pendingKnowledgeBaseOwnership && isRecord(body)) {
      if (pendingKnowledgeBaseOwnership.ownerTeamSlug) {
        body.owner_team_slug = pendingKnowledgeBaseOwnership.ownerTeamSlug;
      }
      if (pendingKnowledgeBaseOwnership.creatorSubject) {
        body.creator_subject = pendingKnowledgeBaseOwnership.creatorSubject;
      }
      if (pendingKnowledgeBaseOwnership.ownerSubject) {
        body.owner_subject = pendingKnowledgeBaseOwnership.ownerSubject;
      }
    }

    // Same for an MCP tool create (POST /v1/mcp/custom-tools): inject the
    // captured owner/creator/shared so the server's MCPToolConfig persists
    // them (spec 2026-06-03, US6).
    if (pendingMcpToolOwnership && isRecord(body)) {
      if (pendingMcpToolOwnership.ownerTeamSlug) {
        body.owner_team_slug = pendingMcpToolOwnership.ownerTeamSlug;
      }
      if (pendingMcpToolOwnership.creatorSubject) {
        body.creator_subject = pendingMcpToolOwnership.creatorSubject;
      }
      if (pendingMcpToolOwnership.ownerSubject) {
        body.owner_subject = pendingMcpToolOwnership.ownerSubject;
      }
      body.shared_with_teams = pendingMcpToolOwnership.sharedTeamSlugs;
      body.shared_with_org = pendingMcpToolOwnership.sharedWithOrg;
    }

    const fetchOptions: RequestInit = {
      method: "POST",
      headers,
    };

    if (isMultipart) {
      delete headers["Content-Type"];
      fetchOptions.body = multipartBody;
    } else if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(targetUrl, fetchOptions);
    } catch (error) {
      if (localFilePublication) {
        await rollbackLocalFilePublication(localFilePublication);
      }
      throw error;
    }

    if (response.status === 204) {
      if (pendingMcpToolOwnership) {
        await reconcileMcpToolForOwnership(pendingMcpToolOwnership);
      }
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    if (!response.ok && localFilePublication) {
      await rollbackLocalFilePublication(localFilePublication);
    }
    if (response.ok && localFilePublication) {
      if (
        !isRecord(data) ||
        normalizeString(data.datasource_id) !== localFilePublication.sourceId
      ) {
        await rollbackLocalFilePublication(localFilePublication);
        throw new ApiError(
          "The RAG server returned an unexpected datasource id for this file set",
          502,
          "INGEST_DATASOURCE_ID_MISMATCH",
        );
      }
      if (localFilePublication.publicationRequest) {
        data._publication_request = {
          id: localFilePublication.publicationRequest._id,
          status: localFilePublication.publicationRequest.status,
          reason: localFilePublication.publication.plan.reason,
        };
      }
    }
    if (response.ok && pendingKnowledgeBaseOwnership) {
      // Source management and indexed-data access are independent. A personal
      // creator owns both graphs; a selected team owns only the source config.
      await reconcileIngestionSourceRelationships({
        sourceId: pendingKnowledgeBaseOwnership.knowledgeBaseId,
        ownerSubject: pendingKnowledgeBaseOwnership.ownerSubject,
        ownerTeamSlug: pendingKnowledgeBaseOwnership.ownerTeamSlug,
        creatorSubject: pendingKnowledgeBaseOwnership.creatorSubject,
      });
      await reconcileKnowledgeBaseRelationships({
        knowledgeBaseId: pendingKnowledgeBaseOwnership.knowledgeBaseId,
        ownerSubject: pendingKnowledgeBaseOwnership.ownerSubject,
        ownerTeamSlug: null,
        creatorSubject: pendingKnowledgeBaseOwnership.creatorSubject,
      });
      await reconcileDataSourceRelationships({
        dataSourceId: pendingKnowledgeBaseOwnership.knowledgeBaseId,
        creatorSubject: pendingKnowledgeBaseOwnership.creatorSubject,
        parentKnowledgeBaseId: pendingKnowledgeBaseOwnership.knowledgeBaseId,
      });
    }
    if (response.ok && pendingMcpToolOwnership) {
      await reconcileMcpToolForOwnership(pendingMcpToolOwnership);
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    if (error instanceof ApiError) {
      return handleApiError(error);
    }
    console.error("[RAG Proxy] POST error:", error);
    return NextResponse.json(
      { error: "Failed to connect to RAG server", details: String(error) },
      { status: 502 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const ragServerUrl = getRagServerUrl();
    const targetPath = path.join("/");
    const targetUrl = `${ragServerUrl}/${targetPath}`;

    // Parse the JSON body when present. Mirror the POST handler: attempt a
    // parse whenever content-length is absent-but-nonempty OR positive, because
    // the ownership/transfer logic below needs the body fields and some clients
    // omit content-length on small JSON payloads. A parse failure leaves body
    // undefined.
    let body: unknown = undefined;
    const contentLength = request.headers.get("content-length");
    const hasBody = contentLength === null || parseInt(contentLength) > 0;
    if (hasBody) {
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
    }

    const { headers, pendingMcpToolOwnership } = await getAuthorizedRagContext(
      "PUT",
      path,
      request,
      body,
    );

    // Persist owner/creator/shared to the MCP tool config (source of truth).
    // The RAG server replaces the whole config on PUT, so inject the captured
    // ownership fields into the body or they'd be wiped (spec 2026-06-03, US6).
    if (pendingMcpToolOwnership && isRecord(body)) {
      if (pendingMcpToolOwnership.ownerTeamSlug) {
        body.owner_team_slug = pendingMcpToolOwnership.ownerTeamSlug;
      }
      if (pendingMcpToolOwnership.creatorSubject) {
        body.creator_subject = pendingMcpToolOwnership.creatorSubject;
      }
      if (pendingMcpToolOwnership.ownerSubject) {
        body.owner_subject = pendingMcpToolOwnership.ownerSubject;
      }
      body.shared_with_teams = pendingMcpToolOwnership.sharedTeamSlugs;
      body.shared_with_org = pendingMcpToolOwnership.sharedWithOrg;
    }

    const fetchOptions: RequestInit = {
      method: "PUT",
      headers,
    };

    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    if (response.status === 204) {
      if (pendingMcpToolOwnership) {
        await reconcileMcpToolForOwnership(pendingMcpToolOwnership);
      }
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    if (response.ok && pendingMcpToolOwnership) {
      await reconcileMcpToolForOwnership(pendingMcpToolOwnership);
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    if (error instanceof ApiError) {
      return handleApiError(error);
    }
    console.error("[RAG Proxy] PUT error:", error);
    return NextResponse.json(
      { error: "Failed to connect to RAG server", details: String(error) },
      { status: 502 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const ragServerUrl = getRagServerUrl();
    const targetPath = path.join("/");
    const targetUrl = new URL(`${ragServerUrl}/${targetPath}`);

    const searchParams = request.nextUrl.searchParams;
    searchParams.forEach((value, key) => {
      targetUrl.searchParams.append(key, value);
    });

    const { headers } = await getAuthorizedRagContext("DELETE", path, request);
    const response = await fetch(targetUrl.toString(), {
      method: "DELETE",
      headers,
    });

    // After a successful upstream delete of a custom MCP tool, remove ALL
    // `mcp_tool:<id>` grants so no orphan tuples remain (spec 2026-06-03, US6
    // / FR-028). Best-effort: a cleanup failure is logged but does not fail
    // the delete (the config — source of truth — is already gone).
    if (response.ok || response.status === 204) {
      // `extractMcpToolId` is method-agnostic — it matches the
      // `v1/mcp/custom-tools/<tool_id>` path shape regardless of verb.
      const deletedToolId = extractMcpToolId(path);
      if (deletedToolId) {
        await deleteAllMcpToolRelationshipTuples(deletedToolId).catch((err) => {
          console.warn(
            "[RAG Proxy] failed to clean up mcp_tool tuples after delete:",
            err,
          );
        });
      }
    }

    const deletedDatasourceId = isDatasourceDeleteRequest("DELETE", path)
      ? extractKnowledgeBaseId(request, path)
      : null;
    if (deletedDatasourceId && (response.ok || response.status === 404)) {
      try {
        // Remove collection membership first: deleting all KB tuples also
        // targets the parent_collection edges, and racing two exact deletes
        // would make an otherwise-idempotent cleanup fail spuriously.
        await removeDatasourceFromRagCollections(deletedDatasourceId);
        await removeDatasourceFromAgentPins(deletedDatasourceId);
        await Promise.all([
          deleteAllIngestionSourceRelationshipTuples(deletedDatasourceId),
          deleteAllKnowledgeBaseRelationshipTuples(deletedDatasourceId),
          deleteAllDataSourceRelationshipTuples(deletedDatasourceId),
        ]);
      } catch (error) {
        // The upstream record may already be gone. Return an actionable error
        // and allow the same DELETE to retry tuple cleanup on the upstream 404;
        // silently leaving grants would let a later source with the same
        // deterministic id inherit stale access.
        console.error(
          `[RAG Proxy] Failed to clean up access policy for deleted datasource ${deletedDatasourceId}:`,
          error,
        );
        throw new ApiError(
          "The datasource was deleted, but its access policy could not be cleaned up. Retry the delete.",
          503,
          "DATASOURCE_POLICY_CLEANUP_FAILED",
        );
      }
      if (response.status === 404) {
        return NextResponse.json(
          {
            success: true,
            datasource_id: deletedDatasourceId,
            already_deleted: true,
          },
          { status: 200 },
        );
      }
    }

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    if (error instanceof ApiError) {
      return handleApiError(error);
    }
    console.error("[RAG Proxy] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to connect to RAG server", details: String(error) },
      { status: 502 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const ragServerUrl = getRagServerUrl();
    const targetPath = path.join("/");
    const targetUrl = `${ragServerUrl}/${targetPath}`;

    let body: unknown = undefined;
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 0) {
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
    }

    const { headers } = await getAuthorizedRagContext(
      "PATCH",
      path,
      request,
      body,
    );
    const fetchOptions: RequestInit = { method: "PATCH", headers };
    if (body !== undefined) fetchOptions.body = JSON.stringify(body);

    const response = await fetch(targetUrl, fetchOptions);
    if (response.status === 204) return new NextResponse(null, { status: 204 });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    if (error instanceof ApiError) return handleApiError(error);
    console.error("[RAG Proxy] PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to connect to RAG server", details: String(error) },
      { status: 502 },
    );
  }
}

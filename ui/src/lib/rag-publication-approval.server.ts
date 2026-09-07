import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import {
  listPublicationActorTeamSlugs,
  planRagPublication,
  publicationActorFromSession,
  publicationResourceRevision,
  type PublicationSession,
  type RagPublicationState,
} from "@/lib/publication-approval.server";
import { getPublicationApprovalSettings } from "@/lib/publication-approval-settings";
import { loadLatestSuccessfulIngestionStats } from "@/lib/rag-ingestion-stats.server";
import { readOpenFgaTuples } from "@/lib/rbac/openfga";
import {
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import type {
  PublicationActor,
  PublicationPolicyPlan,
  PublicationRequestDocument,
  PublicationResourceRef,
} from "@/types/publication-approval";

const SOURCE_COLLECTION = "rag_ingestion_sources";
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

const APPROVAL_GATED_SOURCE_FIELDS = new Set([
  "lookback_days",
  "include_bots",
  "jql",
  "include_comments",
  "include_links",
  "custom_fields",
  "get_child_pages",
  "allowed_title_patterns",
  "denied_title_patterns",
  "settings",
]);

const RAG_MUTABLE_SOURCE_FIELDS = new Set([
  "name",
  "description",
  "default_chunk_size",
  "default_chunk_overlap",
  "reload_interval",
  ...APPROVAL_GATED_SOURCE_FIELDS,
]);

export interface PreparedRagPublication {
  actor: PublicationActor;
  requesterTeamSlugs: string[];
  requestedState: RagPublicationState;
  plan: PublicationPolicyPlan;
  resource: PublicationResourceRef;
  resourceRevision: string;
}

interface PrepareRagPublicationInput {
  session: PublicationSession;
  source: IngestionSourceConfig;
  currentSearchTeamSlugs: string[];
  currentSearchUserSubjects: string[];
  requestedSearchTeamSlugs: string[];
  requestedSearchUserSubjects: string[];
  sourceUpdate?: Record<string, unknown>;
  ownerUpdate?: {
    owner_team_slug: string | null;
    owner_subject: string | null;
  };
  materialChange?: boolean;
  externalAudienceTeamSlugs?: string[];
  externalBroadAudience?: boolean;
  externalOrganizationWide?: boolean;
}

interface RagPublicationOwnershipSnapshot {
  datasource_id: string;
  owner_team_slug: string | null;
  owner_subject: string | null;
  creator_subject: string | null;
}

function strings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())),
  ).sort();
}

function sourceRecord(source: IngestionSourceConfig): Record<string, unknown> {
  return source as unknown as Record<string, unknown>;
}

export function sourceDomainForPublication(source: IngestionSourceConfig): string | null {
  const record = sourceRecord(source);
  const candidate = [record.url, record.start_page_url, record.confluence_url]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (!candidate) return null;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function estimatedSourceItemsForPublication(
  source: IngestionSourceConfig,
): number | undefined {
  const record = sourceRecord(source);
  const settings = record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
    ? record.settings as Record<string, unknown>
    : {};
  const candidates = [
    record.document_count,
    record.documents_count,
    record.page_count,
    settings.max_pages,
  ];
  return candidates.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
}

function revisionSourceProjection(source: IngestionSourceConfig): Record<string, unknown> {
  const record = sourceRecord(source);
  const projection: Record<string, unknown> = {
    source_id: source.source_id,
    source_type: source.source_type,
    owner_team_slug: record.owner_team_slug ?? null,
    owner_subject: record.owner_subject ?? record.creator_subject ?? null,
  };
  for (const field of [
    "channel_id",
    "confluence_url",
    "space_key",
    "start_page_url",
    "whole_space",
    "page_configs",
    "project_key",
    "source_slug",
    "url",
    "space_id",
    ...RAG_MUTABLE_SOURCE_FIELDS,
  ]) {
    if (record[field] !== undefined) projection[field] = record[field];
  }
  return projection;
}

/** Material source/ownership projection used by collection approval snapshots. */
export function ragDatasourcePublicationDependencyRevision(
  source: IngestionSourceConfig,
): string {
  return publicationResourceRevision(revisionSourceProjection(source));
}

export function ragPublicationRevision(
  source: IngestionSourceConfig,
  effectiveState: RagPublicationState,
): string {
  return publicationResourceRevision({
    source: revisionSourceProjection(source),
    search_team_slugs: strings(effectiveState.search_team_slugs),
    search_user_subjects: strings(effectiveState.search_user_subjects),
  });
}

export function hasApprovalGatedSourceChange(update: Record<string, unknown>): boolean {
  return Object.keys(update).some((field) => APPROVAL_GATED_SOURCE_FIELDS.has(field));
}

export function approvalGatedSourceUpdate(
  update: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).filter(([field]) => APPROVAL_GATED_SOURCE_FIELDS.has(field)),
  );
}

function normalizedApprovalGatedWebSettings(value: unknown): Record<string, unknown> {
  const settings = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    crawl_mode: settings.crawl_mode ?? "single",
    max_depth: settings.max_depth ?? 2,
    max_pages: settings.max_pages ?? 2000,
    follow_external_links: settings.follow_external_links === true,
    allowed_url_patterns: strings(settings.allowed_url_patterns),
    denied_url_patterns: strings(settings.denied_url_patterns),
  };
}

function normalizedApprovalGatedValue(field: string, value: unknown): unknown {
  switch (field) {
    case "include_comments":
    case "include_links":
      return value !== false;
    case "include_bots":
    case "get_child_pages":
      return value === true;
    case "allowed_title_patterns":
    case "denied_title_patterns":
      return strings(value);
    case "custom_fields":
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    case "settings":
      // Publication review covers settings that select which content enters
      // a broadly shared datasource. Runtime mechanics such as JavaScript
      // rendering, selectors, timeouts, concurrency, request identity, and
      // internal-network reachability remain governed by connector policy and
      // do not change the datasource's approved audience or declared scope.
      return normalizedApprovalGatedWebSettings(value);
    case "jql":
      return typeof value === "string" ? value.trim() : value;
    default:
      return value;
  }
}

/**
 * Return only source settings whose effective value actually changed.
 * Edit forms submit connector defaults, so field presence alone is not a
 * reliable signal that a publication review is needed.
 */
export function changedApprovalGatedSourceUpdate(
  source: IngestionSourceConfig,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const current = sourceRecord(source);
  return Object.fromEntries(
    Object.entries(approvalGatedSourceUpdate(update)).filter(([field, value]) =>
      publicationResourceRevision(normalizedApprovalGatedValue(field, value)) !==
      publicationResourceRevision(
        normalizedApprovalGatedValue(field, current[field]),
      ),
    ),
  );
}

export async function prepareRagPublication(
  input: PrepareRagPublicationInput,
): Promise<PreparedRagPublication> {
  const actor = publicationActorFromSession(input.session);
  const [settings, requesterTeamSlugs, ingestionStats] = await Promise.all([
    getPublicationApprovalSettings(),
    listPublicationActorTeamSlugs(actor),
    loadLatestSuccessfulIngestionStats(
      {
        accessToken: input.session.accessToken,
        org: input.session.org,
      },
      [input.source.source_id],
    ),
  ]);
  const currentState: RagPublicationState = {
    search_team_slugs: strings(input.currentSearchTeamSlugs),
    search_user_subjects: strings(input.currentSearchUserSubjects),
  };
  const requestedState: RagPublicationState = {
    search_team_slugs: strings(input.requestedSearchTeamSlugs),
    search_user_subjects: strings(input.requestedSearchUserSubjects),
    ...(input.sourceUpdate && Object.keys(input.sourceUpdate).length > 0
      ? { source_update: input.sourceUpdate }
      : {}),
    ...(input.ownerUpdate ? { owner_update: input.ownerUpdate } : {}),
  };
  const ownerTeamSlug = typeof input.source.owner_team_slug === "string"
    ? input.source.owner_team_slug
    : null;
  const ownerSubject = ownerTeamSlug
    ? null
    : typeof input.source.owner_subject === "string"
      ? input.source.owner_subject
      : typeof input.source.creator_subject === "string"
        ? input.source.creator_subject
        : null;
  const plan = planRagPublication({
    settings,
    requester: actor,
    requesterTeamSlugs,
    currentState,
    requestedState,
    ownerTeamSlug,
    ownerSubject,
    sourceType: input.source.source_type,
    sourceDomain: sourceDomainForPublication(input.source),
    estimatedItems:
      ingestionStats.get(input.source.source_id)?.documentCount ??
      estimatedSourceItemsForPublication(input.source),
    materialChange: input.materialChange,
    externalAudienceTeamSlugs: input.externalAudienceTeamSlugs,
    externalBroadAudience: input.externalBroadAudience,
    externalOrganizationWide: input.externalOrganizationWide,
  });
  return {
    actor,
    requesterTeamSlugs,
    requestedState,
    plan,
    resource: {
      kind: "rag_datasource",
      id: input.source.source_id,
      label: input.source.name || input.source.source_id,
    },
    resourceRevision: ragPublicationRevision(
      input.source,
      plan.effective_state as unknown as RagPublicationState,
    ),
  };
}

export async function loadKnowledgeBaseSearchState(kbId: string): Promise<RagPublicationState> {
  const teams = new Set<string>();
  const users = new Set<string>();
  let continuationToken: string | undefined;
  const object = `knowledge_base:${kbId}`;
  do {
    const page = await readOpenFgaTuples({ tuple: { object }, continuationToken });
    for (const tuple of page.tuples) {
      const key = tuple.key;
      if (!key || key.object !== object || key.relation !== "reader") continue;
      const team = /^team:([^#]+)#member$/.exec(key.user)?.[1];
      const user = /^user:(.+)$/.exec(key.user)?.[1];
      if (team) teams.add(team);
      if (user) users.add(user);
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return {
    search_team_slugs: [...teams].sort(),
    search_user_subjects: [...users].sort(),
  };
}

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

async function loadRagPublicationOwnership(
  sourceId: string,
  accessToken: string,
  authorizationPolicyId: string,
): Promise<RagPublicationOwnershipSnapshot | null> {
  let response: Response;
  try {
    response = await fetch(
      `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(sourceId)}/publication-state`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Publication-Authorization-Id": authorizationPolicyId,
        },
      },
    );
  } catch {
    throw new ApiError("The RAG server is unavailable", 503, "RAG_SERVER_UNAVAILABLE");
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ApiError(
      `The approved RAG publication could not be validated (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
      "RAG_PUBLICATION_APPLY_FAILED",
    );
  }
  const payload = await response.json().catch(() => null) as
    | Partial<RagPublicationOwnershipSnapshot>
    | null;
  if (
    !payload ||
    payload.datasource_id !== sourceId ||
    ![payload.owner_team_slug, payload.owner_subject, payload.creator_subject].every(
      (value) => value === null || typeof value === "string",
    )
  ) {
    throw new ApiError(
      "The RAG server returned an invalid publication state",
      502,
      "RAG_PUBLICATION_APPLY_FAILED",
    );
  }
  return {
    datasource_id: sourceId,
    owner_team_slug: payload.owner_team_slug ?? null,
    owner_subject: payload.owner_subject ?? null,
    creator_subject: payload.creator_subject ?? null,
  };
}

async function patchRagServer(
  path: string,
  payload: Record<string, unknown>,
  accessToken: string,
  authorizationPolicyId: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${getRagServerUrl()}${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Publication-Authorization-Id": authorizationPolicyId,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError("The RAG server is unavailable", 503, "RAG_SERVER_UNAVAILABLE");
  }
  if (response.status === 404) return false;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ApiError(
      `The approved RAG publication could not be applied (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
      "RAG_PUBLICATION_APPLY_FAILED",
    );
  }
  return true;
}

function requestRagState(request: PublicationRequestDocument): RagPublicationState {
  const rawOwnerUpdate = request.requested_state.owner_update;
  const ownerUpdate = rawOwnerUpdate &&
    typeof rawOwnerUpdate === "object" &&
    !Array.isArray(rawOwnerUpdate)
    ? rawOwnerUpdate as Record<string, unknown>
    : null;
  return {
    search_team_slugs: strings(request.requested_state.search_team_slugs),
    search_user_subjects: strings(request.requested_state.search_user_subjects),
    ...(request.requested_state.source_update &&
    typeof request.requested_state.source_update === "object" &&
    !Array.isArray(request.requested_state.source_update)
      ? { source_update: request.requested_state.source_update as Record<string, unknown> }
      : {}),
    ...(ownerUpdate
      ? {
          owner_update: {
            owner_team_slug:
              typeof ownerUpdate.owner_team_slug === "string"
                ? ownerUpdate.owner_team_slug.trim() || null
                : null,
            owner_subject:
              typeof ownerUpdate.owner_subject === "string"
                ? ownerUpdate.owner_subject.trim() || null
                : null,
          },
        }
      : {}),
  };
}

function allowedSourceUpdate(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => RAG_MUTABLE_SOURCE_FIELDS.has(field)),
  );
}

function allowedOwnerUpdate(
  value: RagPublicationState["owner_update"],
): RagPublicationState["owner_update"] | null {
  if (!value) return null;
  const ownerTeamSlug = value.owner_team_slug?.trim() || null;
  const ownerSubject = value.owner_subject?.trim() || null;
  if (
    Boolean(ownerTeamSlug) === Boolean(ownerSubject) ||
    (ownerTeamSlug && !OPENFGA_ID_PATTERN.test(ownerTeamSlug)) ||
    (ownerSubject && !OPENFGA_ID_PATTERN.test(ownerSubject))
  ) {
    throw new ApiError(
      "The approved Owner state is invalid",
      409,
      "INVALID_APPROVAL_STATE",
    );
  }
  return {
    owner_team_slug: ownerTeamSlug,
    owner_subject: ownerSubject,
  };
}

function ragPublicationAlreadyApplied(
  source: IngestionSourceConfig | null,
  current: RagPublicationState,
  requested: RagPublicationState,
  sourceUpdate: Record<string, unknown>,
  currentOwner: { owner_team_slug: string | null; owner_subject: string | null },
  ownerUpdate: RagPublicationState["owner_update"] | null,
): boolean {
  if (
    publicationResourceRevision({
      teams: strings(current.search_team_slugs),
      users: strings(current.search_user_subjects),
    }) !==
    publicationResourceRevision({
      teams: strings(requested.search_team_slugs),
      users: strings(requested.search_user_subjects),
    })
  ) {
    return false;
  }
  if (
    ownerUpdate &&
    (ownerUpdate.owner_team_slug !== currentOwner.owner_team_slug ||
      ownerUpdate.owner_subject !== currentOwner.owner_subject)
  ) {
    return false;
  }
  if (Object.keys(sourceUpdate).length === 0) return true;
  if (!source) return false;
  const record = sourceRecord(source);
  const appliedProjection = Object.fromEntries(
    Object.keys(sourceUpdate).map((field) => [field, record[field]]),
  );
  return publicationResourceRevision(appliedProjection) ===
    publicationResourceRevision(sourceUpdate);
}

export async function applyRagPublicationRequest(
  request: PublicationRequestDocument,
  accessToken: string | undefined,
): Promise<void> {
  if (request.resource.kind !== "rag_datasource") {
    throw new ApiError("The request is not a RAG datasource publication", 400);
  }
  if (!accessToken) {
    throw new ApiError("A Keycloak access token is required to apply approval", 401);
  }
  const sourceId = request.resource.id;
  const collection = await getCollection<IngestionSourceConfig>(SOURCE_COLLECTION);
  const source = await collection.findOne({ source_id: sourceId } as never);
  const ownership = source
    ? null
    : await loadRagPublicationOwnership(
        sourceId,
        accessToken,
        request.authorization_policy_id,
      );
  if (!source && !ownership) {
    throw new ApiError(
      "This datasource no longer exists.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  const currentState = source
    ? {
        search_team_slugs: strings(source.search_with_teams),
        search_user_subjects: strings(source.search_with_users),
      }
    : await loadKnowledgeBaseSearchState(sourceId);
  const currentRevision = source
    ? ragPublicationRevision(source, currentState)
    : publicationResourceRevision({
        source_id: sourceId,
        owner_team_slug: ownership?.owner_team_slug ?? null,
        owner_subject: ownership?.owner_subject ?? null,
        creator_subject: ownership?.creator_subject ?? null,
        ...currentState,
      });
  const requested = requestRagState(request);
  const sourceUpdate = allowedSourceUpdate(requested.source_update);
  const ownerTeamSlug = source
    ? typeof source.owner_team_slug === "string"
      ? source.owner_team_slug
      : null
    : ownership?.owner_team_slug ?? null;
  const personalOwner = !ownerTeamSlug
    ? source
      ? typeof source.owner_subject === "string"
        ? source.owner_subject
        : typeof source.creator_subject === "string"
          ? source.creator_subject
          : null
      : ownership?.owner_subject ?? ownership?.creator_subject ?? null
    : null;
  const ownerUpdate = allowedOwnerUpdate(requested.owner_update);
  const nextOwnerTeamSlug = ownerUpdate
    ? ownerUpdate.owner_team_slug
    : ownerTeamSlug;
  const nextPersonalOwner = ownerUpdate
    ? ownerUpdate.owner_subject
    : personalOwner;
  const ownerChanged =
    nextOwnerTeamSlug !== ownerTeamSlug || nextPersonalOwner !== personalOwner;
  if (currentRevision !== request.resource_revision) {
    if (ragPublicationAlreadyApplied(
      source,
      currentState,
      requested,
      sourceUpdate,
      { owner_team_slug: ownerTeamSlug, owner_subject: personalOwner },
      ownerUpdate,
    )) {
      return;
    }
    throw new ApiError(
      "This datasource changed after approval was requested. Review the newer request instead.",
      409,
      "PUBLICATION_REVISION_CONFLICT",
    );
  }
  const creatorSubject = source?.creator_subject ?? ownership?.creator_subject ?? null;
  let configPatched = false;
  let accessPatched = false;
  let managementPolicyPatched = false;
  let searchPolicyWriteStarted = false;
  try {
    if (Object.keys(sourceUpdate).length > 0) {
      configPatched = await patchRagServer(
        `/v1/datasource/${encodeURIComponent(sourceId)}`,
        sourceUpdate,
        accessToken,
        request.authorization_policy_id,
      );
    }
    accessPatched = await patchRagServer(
      `/v1/datasource/${encodeURIComponent(sourceId)}/owner-team`,
      {
        ...(ownerUpdate
          ? {
              owner_team_slug: nextOwnerTeamSlug,
              owner_subject: nextPersonalOwner,
            }
          : {}),
        search_with_teams: requested.search_team_slugs,
        search_with_users: requested.search_user_subjects,
      },
      accessToken,
      request.authorization_policy_id,
    );
    if (ownerChanged) {
      await reconcileIngestionSourceRelationships({
        sourceId,
        creatorSubject,
        ownerSubject: nextPersonalOwner,
        previousOwnerSubject: personalOwner,
        ownerTeamSlug: nextOwnerTeamSlug,
        previousOwnerTeamSlug: ownerTeamSlug,
        nextSharedTeamSlugs: [],
        previousSharedTeamSlugs: source?.shared_with_teams ?? [],
        globalUserAccess: source?.visibility === "global",
        previousGlobalUserAccess: source?.visibility === "global",
      });
      managementPolicyPatched = true;
    }
    // Mark the write before its first OpenFGA mutation. If either the KB
    // reconciliation or its datasource inheritance edge fails partway
    // through, the catch block must restore the previous projection.
    searchPolicyWriteStarted = true;
    await reconcileKnowledgeBaseRelationships({
      knowledgeBaseId: sourceId,
      creatorSubject,
      ownerSubject: nextPersonalOwner,
      previousOwnerSubject: ownerChanged ? personalOwner : undefined,
      ownerTeamSlug: null,
      previousOwnerTeamSlug: ownerChanged
        ? source?.search_owner_team_slug ?? ownerTeamSlug
        : source?.search_owner_team_slug,
      nextSharedTeamSlugs: requested.search_team_slugs,
      previousSharedTeamSlugs: currentState.search_team_slugs,
      nextSharedUserSubjects: requested.search_user_subjects.filter(
        (subject) => subject !== nextPersonalOwner,
      ),
      previousSharedUserSubjects: currentState.search_user_subjects,
    });
    await reconcileDataSourceRelationships({
      dataSourceId: sourceId,
      parentKnowledgeBaseId: sourceId,
    });
    if (source) {
      const setFields: Record<string, unknown> = {
        ...sourceUpdate,
        search_with_teams: requested.search_team_slugs,
        search_with_users: requested.search_user_subjects,
        updated_at: new Date().toISOString(),
      };
      const unsetFields: Record<string, string> = {
        search_owner_team_slug: "",
      };
      if (ownerUpdate) {
        if (nextOwnerTeamSlug) {
          setFields.owner_team_slug = nextOwnerTeamSlug;
          unsetFields.owner_subject = "";
        } else if (nextPersonalOwner) {
          setFields.owner_subject = nextPersonalOwner;
          unsetFields.owner_team_slug = "";
        }
      }
      const updated = await collection.findOneAndUpdate(
        { source_id: sourceId } as never,
        {
          $set: setFields,
          $unset: unsetFields,
        } as never,
        { returnDocument: "after" },
      );
      if (!updated) throw new Error("Datasource config disappeared while applying approval");
    }
  } catch (error) {
    if (searchPolicyWriteStarted) {
      await reconcileKnowledgeBaseRelationships({
        knowledgeBaseId: sourceId,
        creatorSubject,
        ownerSubject: personalOwner,
        previousOwnerSubject: ownerChanged ? nextPersonalOwner : undefined,
        ownerTeamSlug: null,
        previousOwnerTeamSlug: ownerChanged ? nextOwnerTeamSlug : undefined,
        nextSharedTeamSlugs: currentState.search_team_slugs,
        previousSharedTeamSlugs: requested.search_team_slugs,
        nextSharedUserSubjects: currentState.search_user_subjects,
        previousSharedUserSubjects: requested.search_user_subjects,
      }).catch((rollbackError) => {
        console.error("[publication-approval] failed to restore RAG Search policy", rollbackError);
      });
    }
    if (managementPolicyPatched) {
      await reconcileIngestionSourceRelationships({
        sourceId,
        creatorSubject,
        ownerSubject: personalOwner,
        previousOwnerSubject: nextPersonalOwner,
        ownerTeamSlug,
        previousOwnerTeamSlug: nextOwnerTeamSlug,
        nextSharedTeamSlugs: source?.shared_with_teams ?? [],
        previousSharedTeamSlugs: [],
        globalUserAccess: source?.visibility === "global",
        previousGlobalUserAccess: source?.visibility === "global",
      }).catch((rollbackError) => {
        console.error("[publication-approval] failed to restore RAG Owner policy", rollbackError);
      });
    }
    if (accessPatched) {
      await patchRagServer(
        `/v1/datasource/${encodeURIComponent(sourceId)}/owner-team`,
        {
          ...(ownerUpdate
            ? {
                owner_team_slug: ownerTeamSlug,
                owner_subject: personalOwner,
              }
            : {}),
          search_with_teams: currentState.search_team_slugs,
          search_with_users: currentState.search_user_subjects,
        },
        accessToken,
        request.authorization_policy_id,
      ).catch((rollbackError) => {
        console.error("[publication-approval] failed to restore RAG access metadata", rollbackError);
      });
    }
    if (configPatched && source) {
      const previous = Object.fromEntries(
        Object.keys(sourceUpdate)
          .map((field) => [
            field,
            sourceRecord(source)[field] === undefined
              ? null
              : sourceRecord(source)[field],
          ]),
      );
      await patchRagServer(
        `/v1/datasource/${encodeURIComponent(sourceId)}`,
        previous,
        accessToken,
        request.authorization_policy_id,
      ).catch((rollbackError) => {
        console.error("[publication-approval] failed to restore RAG source config", rollbackError);
      });
    }
    throw error;
  }
}

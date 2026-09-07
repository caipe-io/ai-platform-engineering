/**
 * API routes for RAG ingestion-source configuration
 * (spec 2026-07-21-rag-source-config-db).
 *
 * `IngestionSourceConfig` is the pre-ingestion source of truth this series
 * introduces — distinct from the RAG server's `DataSourceInfo`. See
 * docs/docs/specs/2026-07-21-rag-source-config-db/data-model.md.
 *
 * POST creates a UI/API-native record (`config_driven: false`,
 * `visibility: "team"`) — config-driven records are seeded exclusively via
 * `ui/src/lib/seed-config.ts`'s `seedRagSources`, never through this route.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  computeIngestionSourceId,
  type IngestionSourceIdentity,
} from "@/lib/ingestion-source-id";
import { getCollection } from "@/lib/mongodb";
import { parseConfluencePageUrl } from "@/lib/confluence-url";
import {
  createPublicationRequest,
  recordAutoApprovedPublication,
  type RagPublicationState,
} from "@/lib/publication-approval.server";
import { getRagDefaultSearchTeamSlug } from "@/lib/rag-settings";
import {
  enforceRagIngestorLimits,
  getRagIngestorLimits,
} from "@/lib/rag-ingestor-limits.server";
import { visibleRagCollectionsByDatasource } from "@/lib/rag-collections.server";
import {
  prepareRagPublication,
  ragPublicationRevision,
} from "@/lib/rag-publication-approval.server";
import { allowedSourceTypesForIngestorServiceAccount } from "@/lib/rbac/ingestor-service-accounts";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import {
  deleteAllDataSourceRelationshipTuples,
  deleteAllIngestionSourceRelationshipTuples,
  deleteAllKnowledgeBaseRelationshipTuples,
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { resolveUserIdentitiesBySubject } from "@/lib/rbac/user-identity-directory";
import {
  filterResourcesByPermission,
  requireResourcePermission,
} from "@/lib/rbac/resource-authz";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
  WebSourceSettings,
} from "@/types/ingestion-source";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "rag_ingestion_sources";

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

/**
 * Trigger endpoint per source type. These are the same proven on-demand
 * endpoints used by the legacy ingest controls, including webloader.
 */
const INGEST_TRIGGER_PATH: Record<IngestionSourceType, string> = {
  slack_channel: "/v1/ingest/slack/channel",
  confluence_space: "/v1/ingest/confluence/page",
  jira_project: "/v1/ingest/jira/project",
  web_url: "/v1/ingest/webloader/url",
  webex_space: "/v1/ingest/webex/space",
};

/** Map this store's identity/config fields to the RAG server's ingest-request body per type. */
function buildIngestTriggerPayload(
  doc: IngestionSourceConfig,
  ownerTeamSlug: string | null,
): Record<string, unknown> {
  const common = {
    description: doc.description,
    owner_team_slug: ownerTeamSlug || undefined,
    search_team_slugs: doc.search_with_teams ?? [],
    search_user_subjects: doc.search_with_users ?? [],
    ownership_preprovisioned: true,
    config_managed: true,
    default_chunk_size: doc.default_chunk_size,
    default_chunk_overlap: doc.default_chunk_overlap,
    reload_interval: doc.reload_interval,
  };
  switch (doc.source_type) {
    case "slack_channel":
      return {
        ...common,
        channel_id: doc.channel_id,
        channel_name: doc.name,
        lookback_days: doc.lookback_days,
        include_bots: doc.include_bots,
      };
    case "confluence_space":
      if (!doc.start_page_url) {
        throw new ApiError(
          "This adopted whole-space Confluence source can only be reloaded after its datasource exists",
          409,
          "CONFLUENCE_ROOT_PAGE_UNAVAILABLE",
        );
      }
      return {
        ...common,
        name: doc.name,
        url: doc.start_page_url,
        preprovisioned_datasource_id: doc.source_id,
        get_child_pages: doc.get_child_pages ?? false,
        allowed_title_patterns: doc.allowed_title_patterns,
        denied_title_patterns: doc.denied_title_patterns,
      };
    case "jira_project":
      return {
        ...common,
        project_key: doc.project_key,
        source_slug: doc.source_slug,
        name: doc.name,
        jql: doc.jql,
        include_comments: doc.include_comments,
        include_links: doc.include_links,
        custom_fields: doc.custom_fields,
      };
    case "web_url":
      return {
        url: doc.url,
        description: doc.description,
        owner_team_slug: ownerTeamSlug || undefined,
        search_team_slugs: doc.search_with_teams ?? [],
        search_user_subjects: doc.search_with_users ?? [],
        ownership_preprovisioned: true,
        config_managed: true,
        reload_interval: doc.reload_interval,
        settings: {
          ...(doc.settings ?? { crawl_mode: "single" }),
          chunk_size: doc.default_chunk_size,
          chunk_overlap: doc.default_chunk_overlap,
        },
      };
    case "webex_space":
      return {
        ...common,
        space_id: doc.space_id,
        space_name: doc.name,
        include_bots: doc.include_bots,
      };
  }
}

interface IngestionTriggerResult {
  datasource_id: string;
  job_id: string;
}

/** Kick off on-demand ingestion and surface failures to the caller. */
export async function triggerIngestion(
  doc: IngestionSourceConfig,
  accessToken: string | undefined,
  ownerTeamSlug: string | null,
): Promise<IngestionTriggerResult> {
  const path = INGEST_TRIGGER_PATH[doc.source_type];
  if (!accessToken) {
    throw new ApiError("A Keycloak access token is required to start ingestion", 401);
  }
  const response = await fetch(`${getRagServerUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildIngestTriggerPayload(doc, ownerTeamSlug)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(
      `Source was saved, but ingestion could not be started (${response.status})${body ? `: ${body}` : ""}`,
      502,
      "INGEST_TRIGGER_FAILED",
    );
  }
  const result = (await response.json().catch(() => ({}))) as Partial<IngestionTriggerResult>;
  if (result.datasource_id !== doc.source_id) {
    throw new ApiError(
      `Ingestor returned datasource id "${result.datasource_id ?? ""}" for source "${doc.source_id}"`,
      502,
      "INGEST_DATASOURCE_ID_MISMATCH",
    );
  }
  if (typeof result.job_id !== "string" || !result.job_id.trim()) {
    throw new ApiError(
      "Ingestor accepted the request without returning an ingestion job id",
      502,
      "INGEST_JOB_ID_MISSING",
    );
  }
  return { datasource_id: result.datasource_id, job_id: result.job_id };
}

const INGESTION_SOURCE_TYPES: readonly IngestionSourceType[] = [
  "slack_channel",
  "confluence_space",
  "jira_project",
  "web_url",
  "webex_space",
];

const SOURCE_SPECIFIC_INPUT_FIELDS = new Set([
  "channel_id",
  "lookback_days",
  "include_bots",
  "confluence_url",
  "space_key",
  "start_page_url",
  "get_child_pages",
  "allowed_title_patterns",
  "denied_title_patterns",
  "project_key",
  "source_slug",
  "jql",
  "include_comments",
  "include_links",
  "custom_fields",
  "url",
  "settings",
  "space_id",
]);

const ALLOWED_SOURCE_SPECIFIC_INPUT_FIELDS: Record<IngestionSourceType, Set<string>> = {
  slack_channel: new Set(["channel_id", "lookback_days", "include_bots"]),
  confluence_space: new Set([
    "url",
    "confluence_url",
    "space_key",
    "start_page_url",
    "get_child_pages",
    "allowed_title_patterns",
    "denied_title_patterns",
  ]),
  jira_project: new Set([
    "project_key",
    "source_slug",
    "jql",
    "include_comments",
    "include_links",
    "custom_fields",
  ]),
  web_url: new Set(["url", "settings"]),
  webex_space: new Set(["space_id", "include_bots"]),
};

const DEFAULT_CHUNK_SIZE = 10000;
const DEFAULT_CHUNK_OVERLAP = 2000;
const DEFAULT_RELOAD_INTERVAL = 86400;
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

interface TeamOwnershipDoc {
  _id?: unknown;
  slug?: string;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ApiError(`${field} is outside its allowed range`, 400, "INVALID_SOURCE_PAYLOAD");
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(`${field} must be a boolean`, 400, "INVALID_SOURCE_PAYLOAD");
  }
  return value;
}

export function optionalStringList(
  value: unknown,
  field: string,
  maximumItems = 100,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ApiError(`${field} must be an array of at most ${maximumItems} strings`, 400, "INVALID_SOURCE_PAYLOAD");
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 1000) {
      throw new ApiError(`${field} must contain non-empty strings of at most 1000 characters`, 400, "INVALID_SOURCE_PAYLOAD");
    }
    return item.trim();
  });
}

export function optionalStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(`${field} must be an object mapping names to field ids`, 400, "INVALID_SOURCE_PAYLOAD");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) {
    throw new ApiError(`${field} cannot contain more than 100 entries`, 400, "INVALID_SOURCE_PAYLOAD");
  }
  return Object.fromEntries(
    entries.map(([key, item]) => {
      const normalizedKey = key.trim();
      if (!normalizedKey || normalizedKey.length > 120 || typeof item !== "string") {
        throw new ApiError(`${field} must map non-empty names to string field ids`, 400, "INVALID_SOURCE_PAYLOAD");
      }
      const normalizedValue = item.trim();
      if (!normalizedValue || normalizedValue.length > 120) {
        throw new ApiError(`${field} field ids must be between 1 and 120 characters`, 400, "INVALID_SOURCE_PAYLOAD");
      }
      return [normalizedKey, normalizedValue];
    }),
  );
}

export function optionalWebSettings(value: unknown): WebSourceSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("settings must be an object", 400, "INVALID_SOURCE_PAYLOAD");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set<keyof WebSourceSettings>([
    "crawl_mode",
    "max_depth",
    "max_pages",
    "render_javascript",
    "wait_for_selector",
    "page_load_timeout",
    "follow_external_links",
    "allowed_url_patterns",
    "denied_url_patterns",
    "download_delay",
    "concurrent_requests",
    "respect_robots_txt",
    "chunk_size",
    "chunk_overlap",
    "user_agent",
    "allow_non_public_urls",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key as keyof WebSourceSettings)) {
      throw new ApiError(`settings.${key} is not supported`, 400, "INVALID_SOURCE_PAYLOAD");
    }
  }

  const crawlMode = input.crawl_mode ?? "single";
  if (!["single", "sitemap", "recursive"].includes(String(crawlMode))) {
    throw new ApiError("settings.crawl_mode is invalid", 400, "INVALID_SOURCE_PAYLOAD");
  }
  const result: Record<string, unknown> = { crawl_mode: crawlMode };
  const integerRanges: Record<string, [number, number]> = {
    max_depth: [1, 10],
    max_pages: [1, Number.MAX_SAFE_INTEGER],
    page_load_timeout: [5, 120],
    concurrent_requests: [1, 50],
    chunk_size: [100, 100000],
    chunk_overlap: [0, 10000],
  };
  for (const [field, [minimum, maximum]] of Object.entries(integerRanges)) {
    const parsed = optionalInteger(input[field], `settings.${field}`, minimum, maximum);
    if (parsed !== undefined) result[field] = parsed;
  }
  for (const field of [
    "render_javascript",
    "follow_external_links",
    "respect_robots_txt",
    "allow_non_public_urls",
  ]) {
    const parsed = optionalBoolean(input[field], `settings.${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  for (const field of ["allowed_url_patterns", "denied_url_patterns"]) {
    const parsed = optionalStringList(input[field], `settings.${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  for (const field of ["wait_for_selector", "user_agent"]) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === "") {
      if (raw === null) result[field] = null;
      continue;
    }
    if (typeof raw !== "string" || raw.length > 1000) {
      throw new ApiError(`settings.${field} must be a string of at most 1000 characters`, 400, "INVALID_SOURCE_PAYLOAD");
    }
    result[field] = raw;
  }
  if (input.download_delay !== undefined && input.download_delay !== null) {
    if (typeof input.download_delay !== "number" || !Number.isFinite(input.download_delay) || input.download_delay < 0) {
      throw new ApiError("settings.download_delay must be a non-negative number", 400, "INVALID_SOURCE_PAYLOAD");
    }
    result.download_delay = input.download_delay;
  }

  const chunkSize = (result.chunk_size as number | undefined) ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = (result.chunk_overlap as number | undefined) ?? DEFAULT_CHUNK_OVERLAP;
  if (chunkOverlap >= chunkSize) {
    throw new ApiError("settings.chunk_overlap must be smaller than settings.chunk_size", 400, "INVALID_SOURCE_PAYLOAD");
  }
  return result as unknown as WebSourceSettings;
}

function validateSourceSpecificInputFields(body: Record<string, unknown>): void {
  const sourceType = body.source_type as IngestionSourceType | undefined;
  if (!sourceType || !INGESTION_SOURCE_TYPES.includes(sourceType)) return;
  const allowed = ALLOWED_SOURCE_SPECIFIC_INPUT_FIELDS[sourceType];
  for (const field of SOURCE_SPECIFIC_INPUT_FIELDS) {
    if (field in body && !allowed.has(field)) {
      throw new ApiError(
        `${field} is not valid for source_type ${sourceType}`,
        400,
        "INVALID_SOURCE_PAYLOAD",
      );
    }
  }
}

async function loadOwnerTeam(slug: string): Promise<TeamOwnershipDoc | null> {
  const teams = await getCollection<TeamOwnershipDoc>("teams");
  return teams.findOne({ slug } as never);
}

async function canManageOrganization(
  session: Parameters<typeof requireResourcePermission>[0],
): Promise<boolean> {
  try {
    await requireResourcePermission(session, {
      type: "organization",
      id: caipeOrgKey(),
      action: "manage",
    });
    return true;
  } catch {
    return false;
  }
}

async function canIngestForOrganization(
  session: Parameters<typeof requireResourcePermission>[0],
): Promise<boolean> {
  try {
    await requireResourcePermission(session, {
      type: "organization",
      id: caipeOrgKey(),
      action: "ingest",
    });
    return true;
  } catch {
    return false;
  }
}

async function canUseTeamSlug(
  session: Parameters<typeof requireResourcePermission>[0],
  teamSlug: string,
): Promise<boolean> {
  try {
    await requireResourcePermission(session, { type: "team", id: teamSlug, action: "use" });
    return true;
  } catch {
    try {
      await requireResourcePermission(session, { type: "team", id: teamSlug, action: "manage" });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Explicit "data source author" capability check (spec 2026-06-03), mirroring
 * the RAG server's `_team_holds_ingest_capability_filter` /
 * `authorize_datasource_create` (rbac.py) — team membership on the owner
 * team alone is not enough to create a new source; the team must also hold
 * `team:<slug>#member -> ingestor -> organization:<key>`, granted only by an
 * org admin via `PUT /api/admin/teams/[id]/ingest-capability`. Without this
 * gate, any member of ANY team the caller belongs to could author a source
 * scoped to that team.
 */
async function teamHoldsIngestCapability(teamSlug: string): Promise<boolean> {
  try {
    const decision = await checkOpenFgaTuple({
      user: `team:${teamSlug}#member`,
      relation: "ingestor",
      object: `organization:${caipeOrgKey()}`,
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

/**
 * Check whether the RAG server already has a datasource under this exact id
 * (Redis `DataSourceInfo`) — e.g. adopted by a prior migrate run, or
 * ingested directly via env config before this DB-backed path existed. A
 * Mongo-only collision check misses these, so `computeIngestionSourceId`
 * could otherwise silently collide with live data on the RAG server.
 *
 * Uses the privileged `/v1/datasource/{id}/exists` endpoint (existence only,
 * no metadata) rather than `/v1/datasources`, which filters to the caller's
 * accessible set — a caller can't collide-check against a datasource they
 * can't read via that list, but they can still create it and inherit access
 * to its existing data. Fails CLOSED: any error blocks creation rather than
 * silently allowing a potential collision through.
 */
async function ragServerHasDatasource(
  accessToken: string | undefined,
  sourceId: string,
  ownerTeamSlug: string | null,
): Promise<boolean> {
  if (!accessToken) {
    throw new ApiError(
      "Unable to verify source id availability. Please try again.",
      503,
      "COLLISION_CHECK_UNAVAILABLE",
    );
  }
  try {
    const target = new URL(
      `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(sourceId)}/exists`,
    );
    if (ownerTeamSlug) target.searchParams.set("owner_team_slug", ownerTeamSlug);
    const response = await fetch(target, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      throw new ApiError(
        "Unable to verify source id availability. Please try again.",
        503,
        "COLLISION_CHECK_UNAVAILABLE",
      );
    }
    const data = (await response.json()) as { exists?: boolean };
    return data.exists === true;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      "Unable to verify source id availability. Please try again.",
      503,
      "COLLISION_CHECK_UNAVAILABLE",
    );
  }
}

/**
 * UI-only/advisory flag for whether the caller can manage this source — the
 * PATCH/DELETE routes' own `can_manage` check remains authoritative.
 */
async function canManageSource(
  session: Parameters<typeof requireResourcePermission>[0],
  sourceId: string,
): Promise<boolean> {
  try {
    await requireResourcePermission(
      session,
      { type: "ingestion_source", id: sourceId, action: "manage" },
      { bypassForOrgAdmin: true },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve type-specific identity fields required to derive `source_id`, and
 * validate that all required fields for the declared `source_type` are
 * present. Returns `null` if `source_type` is missing/unknown.
 */
function extractSourceIdentity(
  body: Record<string, unknown>,
): { identity: IngestionSourceIdentity; fields: Record<string, unknown> } | null {
  const sourceType = body.source_type as IngestionSourceType | undefined;
  if (!sourceType || !INGESTION_SOURCE_TYPES.includes(sourceType)) return null;

  switch (sourceType) {
    case "slack_channel": {
      const channelId = normalizeString(body.channel_id);
      if (!channelId) return null;
      return {
        identity: { source_type: "slack_channel", channel_id: channelId },
        fields: {
          source_type: sourceType,
          channel_id: channelId,
          lookback_days: body.lookback_days as number | undefined,
          include_bots: body.include_bots as boolean | undefined,
        },
      };
    }
    case "confluence_space": {
      const spaceKey = normalizeString(body.space_key);
      const startPageUrl =
        normalizeString(body.url) ?? normalizeString(body.start_page_url);
      const parsed = startPageUrl
        ? parseConfluencePageUrl(startPageUrl)
        : null;
      if (!spaceKey || !parsed || parsed.spaceKey !== spaceKey) return null;
      const suppliedBaseUrl = normalizeString(body.confluence_url);
      if (suppliedBaseUrl) {
        try {
          const normalizedSuppliedBase = new URL(suppliedBaseUrl)
            .toString()
            .replace(/\/$/, "");
          if (normalizedSuppliedBase !== parsed.baseUrl) return null;
        } catch {
          return null;
        }
      }
      const confluenceUrl = parsed.baseUrl;
      return {
        identity: {
          source_type: "confluence_space",
          confluence_url: confluenceUrl,
          space_key: spaceKey,
          page_id: parsed.pageId,
        },
        fields: {
          source_type: sourceType,
          confluence_url: confluenceUrl,
          space_key: spaceKey,
          start_page_url: startPageUrl,
          get_child_pages: optionalBoolean(body.get_child_pages, "get_child_pages"),
          allowed_title_patterns: optionalStringList(body.allowed_title_patterns, "allowed_title_patterns"),
          denied_title_patterns: optionalStringList(body.denied_title_patterns, "denied_title_patterns"),
        },
      };
    }
    case "jira_project": {
      const projectKey = normalizeString(body.project_key);
      const sourceSlug = normalizeString(body.source_slug);
      if (!projectKey || !sourceSlug) return null;
      return {
        identity: { source_type: "jira_project", project_key: projectKey, source_slug: sourceSlug },
        fields: {
          source_type: sourceType,
          project_key: projectKey,
          source_slug: sourceSlug,
          jql: normalizeString(body.jql) ?? "",
          include_comments: optionalBoolean(body.include_comments, "include_comments"),
          include_links: optionalBoolean(body.include_links, "include_links"),
          custom_fields: optionalStringMap(body.custom_fields, "custom_fields"),
        },
      };
    }
    case "web_url": {
      const url = normalizeString(body.url);
      if (!url) return null;
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return null;
      } catch {
        return null;
      }
      return {
        identity: { source_type: "web_url", url },
        fields: {
          source_type: sourceType,
          url,
          settings: optionalWebSettings(body.settings),
        },
      };
    }
    case "webex_space": {
      const spaceId = normalizeString(body.space_id);
      if (!spaceId) return null;
      return {
        identity: { source_type: "webex_space", space_id: spaceId },
        fields: {
          source_type: sourceType,
          space_id: spaceId,
          include_bots: optionalBoolean(body.include_bots, "include_bots"),
        },
      };
    }
  }
}

interface CreateIngestionSourceInput {
  sourceId: string;
  fields: Record<string, unknown>;
  name: string;
  description: string;
  ownerTeamSlug: string | null;
  sharedWithTeams: string[];
  /** Explicit query/search grants, independent from management ownership. */
  searchWithTeams?: string[];
  /** Explicit individual query/search grants (Keycloak subjects). */
  searchWithUsers?: string[];
  creatorSubject: string | null;
  ownerSubject: string | null;
  /** Initial Search owner. Independent from source management. */
  searchOwnerTeamSlug?: string | null;
  /** Initial Search shares. Independent from source management. */
  searchSharedWithTeams?: string[];
  /** Personal owner of the searchable KB (normally the source creator). */
  searchOwnerSubject?: string | null;
  /** Persisted recovery hint even when an adoption caller owns policy writes. */
  recordedSearchOwnerTeamSlug?: string | null;
  defaultChunkSize?: number;
  defaultChunkOverlap?: number;
  reloadInterval?: number;
  configDriven?: boolean;
  configImportAdopted?: boolean;
  visibility?: string;
}

/**
 * Insert a source-management config row and establish its independent initial
 * Search Access policy. Later edits can reconcile either policy without
 * treating search-only teams as source managers.
 */
export async function createIngestionSource(
  input: CreateIngestionSourceInput,
): Promise<IngestionSourceConfig> {
  const now = new Date().toISOString();
  const doc = {
    source_id: input.sourceId,
    ...input.fields,
    name: input.name,
    description: input.description,
    status: "pending",
    default_chunk_size: input.defaultChunkSize ?? DEFAULT_CHUNK_SIZE,
    default_chunk_overlap: input.defaultChunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
    reload_interval: input.reloadInterval ?? DEFAULT_RELOAD_INTERVAL,
    config_driven: input.configDriven ?? false,
    config_import_adopted: input.configImportAdopted ?? false,
    visibility: input.visibility ?? "team",
    creator_subject: input.creatorSubject ?? undefined,
    owner_subject: input.ownerSubject ?? undefined,
    owner_team_slug: input.ownerTeamSlug ?? undefined,
    search_owner_team_slug:
      input.recordedSearchOwnerTeamSlug ?? input.searchOwnerTeamSlug ?? undefined,
    search_with_teams: input.searchWithTeams ?? input.searchSharedWithTeams ?? [],
    search_with_users: input.searchWithUsers ?? [],
    shared_with_teams: input.sharedWithTeams,
    created_at: now,
    updated_at: now,
  } as unknown as IngestionSourceConfig;

  const collection = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
  await collection.insertOne(doc as never);

  try {
    await reconcileIngestionSourceRelationships({
      sourceId: input.sourceId,
      creatorSubject: doc.creator_subject,
      ownerSubject: doc.owner_subject,
      ownerTeamSlug: input.ownerTeamSlug,
      nextSharedTeamSlugs: input.sharedWithTeams,
      previousSharedTeamSlugs: [],
      globalUserAccess: false,
    });

    // Undefined means an adoption caller already reconciled the policy of an
    // existing datasource. A concrete value provisions a brand-new KB.
    if (input.searchOwnerTeamSlug !== undefined) {
      await reconcileKnowledgeBaseRelationships({
        knowledgeBaseId: input.sourceId,
        creatorSubject: doc.creator_subject,
        // `null` is meaningful: a team-managed source has no implicit
        // personal query owner. `undefined` keeps the legacy create default.
        ownerSubject:
          input.searchOwnerSubject === undefined
            ? doc.creator_subject
            : input.searchOwnerSubject,
        ownerTeamSlug: input.searchOwnerTeamSlug,
        nextSharedTeamSlugs:
          input.searchWithTeams ?? input.searchSharedWithTeams ?? [],
        previousSharedTeamSlugs: [],
        nextSharedUserSubjects: input.searchWithUsers ?? [],
        previousSharedUserSubjects: [],
      });
      await reconcileDataSourceRelationships({
        dataSourceId: input.sourceId,
        parentKnowledgeBaseId: input.sourceId,
      });
    }
  } catch (error) {
    // Keep failed creates retryable. Exact query cleanup is safe only for a
    // normal create, where collision detection proved the objects were new.
    const cleanups: Promise<unknown>[] = [
      deleteAllIngestionSourceRelationshipTuples(input.sourceId),
      collection.deleteOne({ source_id: input.sourceId } as never),
    ];
    if (input.searchOwnerTeamSlug !== undefined) {
      cleanups.push(
        deleteAllKnowledgeBaseRelationshipTuples(input.sourceId),
        deleteAllDataSourceRelationshipTuples(input.sourceId),
      );
    }
    await Promise.allSettled(cleanups);
    throw error;
  }

  return doc;
}

// ═══════════════════════════════════════════════════════════════
// GET — list sources
// ═══════════════════════════════════════════════════════════════

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

  const { searchParams } = new URL(request.url);
  const sourceType = searchParams.get("source_type");
  const ownerTeamSlug = searchParams.get("owner_team_slug");
  const limitParam = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;
  const offsetParam = Number.parseInt(searchParams.get("offset") ?? "", 10);
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  // Recognized ingestor service accounts (RAG_INGESTOR_SERVICE_ACCOUNTS) are
  // scoped by identity, not by OpenFGA per-resource tuples: force
  // source_type to the intersection of the SA's declared allow-list and any
  // explicitly requested type, so a query param can only narrow, never
  // widen, the SA's scope. Skip the OpenFGA filter below entirely for this
  // caller — its scope is fully determined by the forced query.
  const ingestorAllowedTypes = allowedSourceTypesForIngestorServiceAccount(session);

  const query: Record<string, unknown> = {};
  if (ingestorAllowedTypes) {
    const requestedTypes: IngestionSourceType[] = sourceType
      ? [sourceType as IngestionSourceType]
      : Array.from(ingestorAllowedTypes);
    const effectiveTypes = requestedTypes.filter((t) => ingestorAllowedTypes.has(t));
    query.source_type = effectiveTypes.length === 1 ? effectiveTypes[0] : { $in: effectiveTypes };
  } else if (sourceType) {
    query.source_type = sourceType;
  }
  if (ownerTeamSlug) query.owner_team_slug = ownerTeamSlug;

  const collection = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
  const cursor = collection
    .find(query as never)
    .sort({ updated_at: -1, source_id: 1 });
  if (offset > 0) cursor.skip(offset);
  const results = await cursor.limit(limit).toArray();

  const visibleResults = ingestorAllowedTypes
    ? results
    : await filterResourcesByPermission(
        session,
        results,
        { type: "ingestion_source", action: "read", id: (source) => source.source_id },
        { bypassForOrgAdmin: true },
      );

  const sourceSubjects = Array.from(new Set(visibleResults.flatMap((source) => [
    source.owner_subject,
    source.creator_subject,
    ...((source.search_with_users ?? []) as string[]),
  ].filter((subject): subject is string => typeof subject === "string" && Boolean(subject.trim())))));
  const identityBySubject = await resolveUserIdentitiesBySubject(sourceSubjects).catch(() => new Map());

  const sourcesWithPermissions = await Promise.all(
    visibleResults.map(async (source) => {
      const effectiveOwnerSubject = source.owner_team_slug
        ? null
        : source.owner_subject ?? source.creator_subject ?? null;
      return {
        ...source,
        ...(effectiveOwnerSubject
          ? {
              owner_subject: effectiveOwnerSubject,
              owner_display_name:
                identityBySubject.get(effectiveOwnerSubject)?.display_name ?? "Unknown user",
              owner_email: identityBySubject.get(effectiveOwnerSubject)?.email ?? null,
            }
          : {}),
        ...(source.creator_subject
          ? {
              creator_display_name:
                identityBySubject.get(source.creator_subject)?.display_name ?? "Unknown user",
              creator_email: identityBySubject.get(source.creator_subject)?.email ?? null,
            }
          : {}),
        search_user_display_names: (source.search_with_users ?? []).map(
          (subject) => identityBySubject.get(subject)?.display_name ?? "Unknown user",
        ),
        _permissions: { can_manage: await canManageSource(session, source.source_id) },
      };
    }),
  );

  // Ingestor service accounts are identity-scoped transports, not interactive
  // collection readers. Their forced source-type allow-list is the complete
  // authorization boundary, so do not perform (or expose) collection lookups.
  const collectionLabels = ingestorAllowedTypes
    ? new Map<string, string[]>()
    : await visibleRagCollectionsByDatasource(
        session,
        sourcesWithPermissions.map((source) => source.source_id),
      ).catch(() => new Map());
  return successResponse({
    sources: sourcesWithPermissions.map((source) => ({
      ...source,
      rag_collections: collectionLabels.get(source.source_id) ?? [],
    })),
    pagination: {
      offset,
      limit,
      has_more: results.length === limit,
      next_offset: results.length === limit ? offset + limit : null,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// POST — create source
// ═══════════════════════════════════════════════════════════════

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const ingestorLimits = await getRagIngestorLimits();

  let rawBody: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("Request body must be an object", 400, "INVALID_SOURCE_PAYLOAD");
    }
    rawBody = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
  }
  // config_driven/visibility are server-controlled on this path; never
  // accept caller-supplied values for either.
  const body = { ...rawBody };
  delete body.config_driven;
  delete body.visibility;

  const name = normalizeString(body.name);
  if (!name) {
    throw new ApiError("name is required", 400, "INVALID_SOURCE_PAYLOAD");
  }
  if (name.length > 120) {
    throw new ApiError("name must not exceed 120 characters", 400, "INVALID_SOURCE_PAYLOAD");
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new ApiError("description must be a string", 400, "INVALID_SOURCE_PAYLOAD");
  }
  if (typeof body.description === "string" && body.description.length > 2000) {
    throw new ApiError(
      "description must not exceed 2000 characters",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  validateSourceSpecificInputFields(body);
  const defaultChunkSize = optionalInteger(
    body.default_chunk_size,
    "default_chunk_size",
    100,
    100000,
  ) ?? DEFAULT_CHUNK_SIZE;
  const defaultChunkOverlap = optionalInteger(
    body.default_chunk_overlap,
    "default_chunk_overlap",
    0,
    10000,
  ) ?? DEFAULT_CHUNK_OVERLAP;
  if (defaultChunkOverlap >= defaultChunkSize) {
    throw new ApiError(
      "default_chunk_overlap must be smaller than default_chunk_size",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const reloadInterval = optionalInteger(
    body.reload_interval,
    "reload_interval",
    60,
  );
  if (reloadInterval === undefined) {
    throw new ApiError(
      "reload_interval is required",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  body.default_chunk_size = defaultChunkSize;
  body.default_chunk_overlap = defaultChunkOverlap;
  body.reload_interval = reloadInterval;
  if (body.source_type === "slack_channel") {
    body.lookback_days = optionalInteger(body.lookback_days, "lookback_days", 0) ?? 30;
    body.include_bots = optionalBoolean(body.include_bots, "include_bots") ?? false;
  } else if (body.source_type === "webex_space") {
    body.include_bots = optionalBoolean(body.include_bots, "include_bots") ?? false;
  } else if (body.source_type === "jira_project") {
    body.include_comments = optionalBoolean(body.include_comments, "include_comments") ?? true;
    body.include_links = optionalBoolean(body.include_links, "include_links") ?? true;
    if (!normalizeString(body.jql)) {
      throw new ApiError("jql is required", 400, "INVALID_SOURCE_PAYLOAD");
    }
  } else if (body.source_type === "confluence_space") {
    body.get_child_pages = optionalBoolean(body.get_child_pages, "get_child_pages") ?? false;
  } else if (body.source_type === "web_url") {
    body.settings = optionalWebSettings(body.settings) ?? { crawl_mode: "single" };
  }

  const extracted = extractSourceIdentity(body);
  if (!extracted) {
    throw new ApiError(
      "source_type is missing/unknown, or a required identity field for the declared source_type is missing",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }

  const ownerTeamSlug = normalizeString(body.owner_team_slug);
  if (ownerTeamSlug && !OPENFGA_ID_PATTERN.test(ownerTeamSlug)) {
    throw new ApiError(
      "owner_team_slug must be a valid team slug or null",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const isOrgAdmin = await canManageOrganization(session);
  if (!isOrgAdmin && !(await canIngestForOrganization(session))) {
    throw new ApiError(
      "You do not have permission to create RAG data sources",
      403,
      "FORBIDDEN_INGEST_CAPABILITY",
    );
  }
  if (ownerTeamSlug) {
    const ownerTeam = await loadOwnerTeam(ownerTeamSlug);
    if (!ownerTeam) {
      throw new ApiError("Owner team not found", 404, "OWNER_TEAM_NOT_FOUND");
    }
  }
  if (!isOrgAdmin && ownerTeamSlug) {
    const [canUseOwner, ownerTeamOptedIn] = await Promise.all([
      canUseTeamSlug(session, ownerTeamSlug),
      teamHoldsIngestCapability(ownerTeamSlug),
    ]);
    if (!canUseOwner) {
      throw new ApiError(
        "You must belong to the owner team to create this source",
        403,
        "FORBIDDEN_OWNER_TEAM",
      );
    }
    // Mirrors the RAG server's `authorize_datasource_create` (rbac.py):
    // team membership alone is not enough — the owner team must also hold
    // the org-admin-granted "data-source author" capability.
    if (!ownerTeamOptedIn) {
      throw new ApiError(
        "You are not allowed to create a data source for this team. You must be a member of a team that has the data-source author capability.",
        403,
        "FORBIDDEN_INGEST_CAPABILITY",
      );
    }
  }

  if (body.search_team_slugs !== undefined && !Array.isArray(body.search_team_slugs)) {
    throw new ApiError(
      "search_team_slugs must be an array of team slugs",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const configuredDefaultSearchTeam =
    body.search_team_slugs === undefined && ingestorLimits.shared.max_search_teams > 0
      ? await getRagDefaultSearchTeamSlug()
      : null;
  const searchTeamSlugs = Array.from(
    new Set(
      (
        (body.search_team_slugs as unknown[] | undefined) ??
        (configuredDefaultSearchTeam ? [configuredDefaultSearchTeam] : [])
      ).map((value) => {
        const slug = normalizeString(value);
        if (!slug) {
          throw new ApiError("search_team_slugs must contain team slugs", 400, "INVALID_SOURCE_PAYLOAD");
        }
        if (!OPENFGA_ID_PATTERN.test(slug)) {
          throw new ApiError("search_team_slugs must contain valid team slugs", 400, "INVALID_SOURCE_PAYLOAD");
        }
        return slug;
      }),
    ),
  );
  if (searchTeamSlugs.length > ingestorLimits.shared.max_search_teams) {
    throw new ApiError(
      `A source cannot grant search access to more than ${ingestorLimits.shared.max_search_teams} teams`,
      400,
      "RAG_INGESTOR_LIMIT_EXCEEDED",
    );
  }
  const resolvedSearchTeams = await Promise.all(
    searchTeamSlugs.map((slug) => loadOwnerTeam(slug)),
  );
  if (resolvedSearchTeams.some((team) => !team)) {
    throw new ApiError("One or more search teams do not exist", 404, "SEARCH_TEAM_NOT_FOUND");
  }

  if (body.search_user_subjects !== undefined && !Array.isArray(body.search_user_subjects)) {
    throw new ApiError(
      "search_user_subjects must be an array of user subjects",
      400,
      "INVALID_SOURCE_PAYLOAD",
    );
  }
  const searchUserSubjects = Array.from(new Set(
    ((body.search_user_subjects as unknown[] | undefined) ?? []).map((value) => {
      const subject = normalizeString(value);
      if (!subject || !OPENFGA_ID_PATTERN.test(subject)) {
        throw new ApiError(
          "search_user_subjects must contain valid user subjects",
          400,
          "INVALID_SOURCE_PAYLOAD",
        );
      }
      return subject;
    }),
  ));
  if (searchUserSubjects.length > 50) {
    throw new ApiError(
      "A source cannot grant search access to more than 50 people",
      400,
      "RAG_INGESTOR_LIMIT_EXCEEDED",
    );
  }
  const searchUsers = await resolveUserIdentitiesBySubject(searchUserSubjects);
  if (searchUserSubjects.some((subject) => !searchUsers.has(subject))) {
    throw new ApiError("One or more search users do not exist", 404, "SEARCH_USER_NOT_FOUND");
  }

  enforceRagIngestorLimits(
    extracted.identity.source_type,
    { ...body, search_team_slugs: searchTeamSlugs },
    ingestorLimits,
  );

  const sourceId = computeIngestionSourceId(extracted.identity);
  if (!OPENFGA_ID_PATTERN.test(sourceId)) {
    throw new ApiError(
      "The source identity produces an id that cannot be represented in the authorization model",
      400,
      "INVALID_SOURCE_ID",
    );
  }
  const collection = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
  const [existing, ragServerHasId] = await Promise.all([
    collection.findOne({ source_id: sourceId } as never),
    ragServerHasDatasource(session.accessToken, sourceId, ownerTeamSlug),
  ]);
  if (existing || ragServerHasId) {
    throw new ApiError(
      `A source with id "${sourceId}" already exists`,
      409,
      "SOURCE_ALREADY_EXISTS",
    );
  }

  const creatorSubject = normalizeString(session.sub);
  const draftSource = {
    source_id: sourceId,
    ...extracted.fields,
    name,
    description: normalizeString(body.description) ?? "",
    status: "pending",
    default_chunk_size: defaultChunkSize,
    default_chunk_overlap: defaultChunkOverlap,
    reload_interval: reloadInterval,
    config_driven: false,
    config_import_adopted: false,
    visibility: "team",
    creator_subject: creatorSubject ?? undefined,
    owner_subject: ownerTeamSlug ? undefined : creatorSubject ?? undefined,
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
    requestedSearchTeamSlugs: searchTeamSlugs,
    requestedSearchUserSubjects: searchUserSubjects,
  });
  const effectiveSearch = publication.plan.effective_state as unknown as RagPublicationState;
  const doc = await createIngestionSource({
    sourceId,
    fields: extracted.fields,
    name,
    description: normalizeString(body.description) ?? "",
    ownerTeamSlug,
    // Management is intentionally singular: personal owner OR one owner
    // team. Search grants are the independent multi-team control below.
    sharedWithTeams: [],
    searchWithTeams: effectiveSearch.search_team_slugs,
    searchWithUsers: effectiveSearch.search_user_subjects,
    creatorSubject,
    ownerSubject: ownerTeamSlug ? null : creatorSubject,
    // A personal source implicitly belongs to its creator in the query graph.
    // Once management is assigned to a team, query access is only the
    // separately selected Search Access teams.
    searchOwnerSubject: ownerTeamSlug ? null : creatorSubject,
    searchOwnerTeamSlug: null,
    recordedSearchOwnerTeamSlug: null,
    searchSharedWithTeams: effectiveSearch.search_team_slugs,
    defaultChunkSize,
    defaultChunkOverlap,
    reloadInterval,
  });

  let publicationRequest: Awaited<ReturnType<typeof createPublicationRequest>> | null = null;
  if (publication.plan.requires_approval) {
    publicationRequest = await createPublicationRequest({
      resource: publication.resource,
      resourceRevision: ragPublicationRevision(doc, effectiveSearch),
      requestedState: publication.requestedState as unknown as Record<string, unknown>,
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
      resourceRevision: ragPublicationRevision(doc, effectiveSearch),
      requestedState: publication.requestedState as unknown as Record<string, unknown>,
      effectiveState: effectiveSearch as unknown as Record<string, unknown>,
      riskFacts: publication.plan.risk_facts,
      requester: publication.actor,
      requesterTeamSlugs: publication.requesterTeamSlugs,
      approverTeamSlugs: publication.plan.approver_team_slugs,
      approverUserSubjects: publication.plan.approver_user_subjects,
    });
  }

  // Start ingestion immediately through the same RAG endpoint used by the
  // legacy UI. Retain an explicit failure state so the row remains visible
  // and retryable instead of silently sitting in "pending" forever.
  const collectionForStatus = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
  try {
    const trigger = await triggerIngestion(doc, session.accessToken, ownerTeamSlug);
    const statusUpdate = {
      status: "ingesting",
      ingestion_job_id: trigger.job_id,
      updated_at: new Date().toISOString(),
    };
    await collectionForStatus.updateOne(
      { source_id: sourceId } as never,
      { $set: statusUpdate, $unset: { last_error: "" } } as never,
    );
    return successResponse({
      ...doc,
      ...statusUpdate,
      ...(publicationRequest
        ? {
            _publication_request: {
              id: publicationRequest._id,
              status: publicationRequest.status,
              reason: publication.plan.reason,
            },
          }
        : {}),
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start ingestion";
    const failureUpdate = {
      status: "failed",
      last_error: message.slice(0, 2000),
      updated_at: new Date().toISOString(),
    };
    await collectionForStatus.updateOne(
      { source_id: sourceId } as never,
      { $set: failureUpdate } as never,
    );
    console.error(`[rag/sources] Failed to trigger ingestion for ${sourceId}:`, error);
    return successResponse({
      ...doc,
      ...failureUpdate,
      ...(publicationRequest
        ? {
            _publication_request: {
              id: publicationRequest._id,
              status: publicationRequest.status,
              reason: publication.plan.reason,
            },
          }
        : {}),
    }, 201);
  }
});

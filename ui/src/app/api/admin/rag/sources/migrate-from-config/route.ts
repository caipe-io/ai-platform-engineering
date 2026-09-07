/**
 * `POST /api/admin/rag/sources/migrate-from-config` — admin action to adopt
 * already-ingested RAG datasources into the DB as permanent, delegable
 * config rows (spec 2026-07-21-rag-source-config-db, US5 / rag-source-mgmt-ui
 * migrate workstream).
 *
 * The BFF cannot read ingestor-pod env vars (spec FR-007 blocker), so
 * "migrate" means "adopt what has already ingested" rather than "import
 * declared-but-not-yet-ingested YAML config": the preview enumerates the
 * Redis `DataSourceInfo` records the BFF already reads via the RAG server's
 * `GET /v1/datasources` (same fetch pattern as `loadOwnerFromConfig` in
 * `kbs/[id]/sharing/route.ts`), and cross-references each `datasource_id`
 * against `rag_ingestion_sources`. A row is importable when a legacy-global
 * `DataSourceInfo` exists but there is no config row yet. Post-migration
 * personal/team sources carry explicit ownership or search metadata and are
 * deliberately excluded, even when their connector does not use a Mongo
 * config row (for example local-file uploads).
 *
 * Apply imports into the selected collection (Platform RAG by default). The
 * collection's current Owner and Search policy remains authoritative, while
 * supported source configurations become editable in the UI.
 */

import { NextRequest } from "next/server";

import { createIngestionSource } from "@/app/api/rag/sources/route";
import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  bootstrapPlatformRagCollection,
  RAG_COLLECTION_ID_PATTERN,
  RAG_COLLECTIONS_COLLECTION,
  replaceCollectionSources,
} from "@/lib/rag-collections.server";
import { adoptConfigImportedRagSources } from "@/lib/seed-config";
import {
  deleteAllDataSourceRelationshipTuples,
  deleteAllIngestionSourceRelationshipTuples,
  deleteAllKnowledgeBaseRelationshipTuples,
  reconcileDataSourceRelationships,
  reconcileIngestionSourceRelationships,
  reconcileKnowledgeBaseRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
  WebSourceSettings,
} from "@/types/ingestion-source";
import {
  PLATFORM_RAG_COLLECTION_ID,
  type RagCollection,
} from "@/types/rag-collection";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;
const MAX_MIGRATION_SOURCES = 500;

interface MigratePreviewSource {
  source_id: string;
  name: string;
  source_type: string;
  /** A config row for this source_id already exists in Mongo. */
  in_db: boolean;
  /** Already adopted by a prior migration run — excluded from the apply batch. */
  already_adopted: boolean;
  /** Can be converted to editable DB configuration by this migration. */
  importable: boolean;
  /** Why a legacy source cannot be added to a managed collection. */
  unavailable_reason?: "unsupported_legacy_id";
}

type MigrateSkipReason =
  | "not_found_in_redis"
  | "missing_identity_fields"
  | "already_in_db"
  | "unsupported_legacy_id";

interface MigrateSkip {
  source_id: string;
  reason: MigrateSkipReason;
}

interface MigrateFromConfigResult {
  sources: MigratePreviewSource[];
  adopted?: string[];
  skipped?: MigrateSkip[];
  legacy_source_count: number;
  compatible_source_count: number;
  destination_collection: {
    id: string;
    source_count: number;
    agents_updated: number;
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter(
      (item): item is string =>
        typeof item === "string" && Boolean(item.trim()),
    )
    .map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => {
      const normalizedKey = key.trim();
      const normalizedValue = normalizeString(item);
      return normalizedKey && normalizedValue
        ? [[normalizedKey, normalizedValue] as const]
        : [];
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const WEB_SETTING_KEYS: ReadonlyArray<keyof WebSourceSettings> = [
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
];

function webSettings(value: unknown): WebSourceSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const crawlMode = input.crawl_mode;
  if (
    crawlMode !== "single" &&
    crawlMode !== "sitemap" &&
    crawlMode !== "recursive"
  ) {
    return undefined;
  }
  const output: Record<string, unknown> = { crawl_mode: crawlMode };
  for (const key of WEB_SETTING_KEYS) {
    if (key === "crawl_mode" || !(key in input)) continue;
    const item = input[key];
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      item === null ||
      (Array.isArray(item) && item.every((entry) => typeof entry === "string"))
    ) {
      output[key] = item;
    }
  }
  return output as unknown as WebSourceSettings;
}

function confluencePageUrl(
  baseUrl: string,
  spaceKey: string,
  pageId: string,
): string | null {
  try {
    const base = new URL(baseUrl);
    const prefix = base.pathname.replace(/\/$/, "");
    base.pathname = `${prefix}/spaces/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(pageId)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  } catch {
    return null;
  }
}

function parseSourceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      "source_ids must be an array",
      400,
      "INVALID_SOURCE_IDS",
    );
  }
  const ids = Array.from(
    new Set(
      raw.map((value) => {
        const id = normalizeString(value);
        // A stale browser may submit an older datasource id that is present in
        // Redis but cannot be represented in the authorization model. Accept a
        // bounded identifier here so the apply path can skip that one source
        // without failing the rest of the import.
        if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
          throw new ApiError(
            "source_ids must contain datasource ids",
            400,
            "INVALID_SOURCE_IDS",
          );
        }
        return id;
      }),
    ),
  );
  if (ids.length > MAX_MIGRATION_SOURCES) {
    throw new ApiError(
      `A migration can include at most ${MAX_MIGRATION_SOURCES} sources`,
      400,
      "TOO_MANY_SOURCE_IDS",
    );
  }
  return ids;
}

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

/**
 * Redis' short `source_type` values → this store's long discriminant.
 * Anything absent (e.g. `argocdv3`, `aws`, `backstage`, `github`,
 * `kubernetes`, `s3`, `dummy_structured_entities`) is not a self-service
 * ingestion source and is excluded from the preview entirely.
 */
const SOURCE_TYPE_MAP: Record<string, IngestionSourceType> = {
  slack: "slack_channel",
  confluence: "confluence_space",
  jira: "jira_project",
  web: "web_url",
  webex: "webex_space",
};

interface RedisDataSource {
  datasource_id: string;
  name?: string;
  description?: string;
  source_type: string;
  metadata?: Record<string, unknown> | null;
  reload_interval?: number;
  default_chunk_size?: number;
  default_chunk_overlap?: number;
  owner_team_slug?: string | null;
  owner_subject?: string | null;
  creator_subject?: string | null;
  shared_with_teams?: string[];
  search_with_teams?: string[];
  search_with_users?: string[];
}

/**
 * Distinguish post-RBAC sources from the unscoped corpus that existed before
 * datasource-level access control. Some direct sources (notably local files)
 * intentionally have no `rag_ingestion_sources` row, so Mongo absence alone
 * cannot mean "legacy global".
 */
function hasExplicitAccessScope(datasource: RedisDataSource): boolean {
  return Boolean(
    normalizeString(datasource.owner_team_slug) ||
      normalizeString(datasource.owner_subject) ||
      normalizeString(datasource.creator_subject) ||
      stringList(datasource.shared_with_teams)?.length ||
      stringList(datasource.search_with_teams)?.length ||
      stringList(datasource.search_with_users)?.length ||
      datasource.metadata?.config_managed === true ||
      datasource.metadata?.ownership_preprovisioned === true,
  );
}

async function fetchRedisDatasources(session: {
  accessToken?: string;
  org?: string;
}): Promise<RedisDataSource[]> {
  if (!session.accessToken) {
    throw new ApiError(
      "A Keycloak access token is required for migration",
      401,
      "NOT_SIGNED_IN",
    );
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
    throw new ApiError(
      "The RAG datasource service is unavailable",
      503,
      "RAG_DATASOURCES_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      `Failed to load RAG datasources (${response.status})`,
      response.status === 401 || response.status === 403
        ? response.status
        : 502,
      "RAG_DATASOURCES_LOAD_FAILED",
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "The RAG datasource response was invalid",
      502,
      "RAG_DATASOURCES_INVALID",
    );
  }
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { datasources?: unknown }).datasources)
  ) {
    throw new ApiError(
      "The RAG datasource response was invalid",
      502,
      "RAG_DATASOURCES_INVALID",
    );
  }
  return (data as { datasources: RedisDataSource[] }).datasources;
}

/**
 * Recover this store's type-specific identity fields from a Redis
 * `DataSourceInfo`'s `metadata`. Returns `null` when a required field is
 * absent, so the caller can skip the row the same way `extractSourceIdentity`
 * (`ui/src/app/api/rag/sources/route.ts`) skips malformed create payloads.
 *
 * Jira has no independent slug field in `metadata` — the ingestor derives
 * `datasource_id` as `jira-{project_key.lower()}-{slugify(name)}`, so
 * `source_slug` is recovered by stripping that known prefix rather than
 * re-deriving it from the (possibly since-renamed) `name`. Every other type
 * reuses `ds.datasource_id` verbatim as `source_id` rather than recomputing
 * it via `computeIngestionSourceId`, so the adopted row keeps the exact id
 * already used in Milvus/Redis regardless of any TS/Python id-formula drift.
 */
function extractFieldsFromRedis(
  ds: RedisDataSource,
  sourceType: IngestionSourceType,
): Record<string, unknown> | null {
  const meta = ds.metadata ?? {};

  switch (sourceType) {
    case "slack_channel": {
      const channelId = normalizeString(meta.channel_id);
      if (!channelId) return null;
      return {
        source_type: sourceType,
        channel_id: channelId,
        lookback_days: meta.lookback_days as number | undefined,
        include_bots:
          typeof meta.include_bots === "boolean"
            ? meta.include_bots
            : undefined,
      };
    }
    case "confluence_space": {
      const confluenceUrl = normalizeString(meta.confluence_url);
      const spaceKey = normalizeString(meta.space_key);
      const request = meta.confluence_ingest_request as
        | Record<string, unknown>
        | undefined;
      const rawPageConfigs = Array.isArray(meta.page_configs)
        ? (meta.page_configs as Array<Record<string, unknown>>)
        : [];
      const pageConfigs = rawPageConfigs.flatMap((page) => {
        const pageId =
          normalizeString(page.page_id) ??
          (typeof page.page_id === "number" ? String(page.page_id) : null);
        if (!pageId) return [];
        return [
          {
            page_id: pageId,
            source: normalizeString(page.source),
            get_child_pages:
              typeof page.get_child_pages === "boolean"
                ? page.get_child_pages
                : false,
          },
        ];
      });
      const startPageUrl =
        normalizeString(request?.url) ??
        normalizeString(pageConfigs[0]?.source) ??
        (confluenceUrl && spaceKey && pageConfigs[0]?.page_id
          ? confluencePageUrl(confluenceUrl, spaceKey, pageConfigs[0].page_id)
          : null);
      if (!confluenceUrl || !spaceKey) return null;
      const allowedTitlePatterns =
        stringList(meta.allowed_title_patterns) ??
        stringList(request?.allowed_title_patterns);
      const deniedTitlePatterns =
        stringList(meta.denied_title_patterns) ??
        stringList(request?.denied_title_patterns);
      return {
        source_type: sourceType,
        confluence_url: confluenceUrl,
        space_key: spaceKey,
        ...(startPageUrl
          ? { start_page_url: startPageUrl }
          : { whole_space: true }),
        get_child_pages:
          typeof request?.get_child_pages === "boolean"
            ? request.get_child_pages
            : pageConfigs[0]?.get_child_pages,
        ...(allowedTitlePatterns
          ? { allowed_title_patterns: allowedTitlePatterns }
          : {}),
        ...(deniedTitlePatterns
          ? { denied_title_patterns: deniedTitlePatterns }
          : {}),
        page_configs: pageConfigs,
      };
    }
    case "jira_project": {
      const projectKey = normalizeString(meta.project_key);
      if (!projectKey) return null;
      const prefix = `jira-${projectKey.toLowerCase()}-`;
      if (!ds.datasource_id.startsWith(prefix)) return null;
      const sourceSlug = ds.datasource_id.slice(prefix.length);
      if (!sourceSlug) return null;
      return {
        source_type: sourceType,
        project_key: projectKey,
        source_slug: sourceSlug,
        jql: normalizeString(meta.jql) ?? "",
        include_comments:
          typeof meta.include_comments === "boolean"
            ? meta.include_comments
            : undefined,
        include_links:
          typeof meta.include_links === "boolean"
            ? meta.include_links
            : undefined,
        custom_fields: stringMap(meta.custom_fields),
      };
    }
    case "web_url": {
      const urlIngestRequest = meta.url_ingest_request as
        | Record<string, unknown>
        | undefined;
      const url = normalizeString(urlIngestRequest?.url);
      if (!url) return null;
      return {
        source_type: sourceType,
        url,
        settings: webSettings(urlIngestRequest?.settings),
      };
    }
    case "webex_space": {
      const spaceId = normalizeString(meta.space_id);
      if (!spaceId) return null;
      return {
        source_type: sourceType,
        space_id: spaceId,
        include_bots:
          typeof meta.include_bots === "boolean"
            ? meta.include_bots
            : undefined,
      };
    }
  }
}

async function persistDatasourceAccessPolicy(
  datasource: RedisDataSource,
  managementOwner: {
    ownerSubject: string | null;
    ownerTeamSlug: string | null;
  },
  session: { accessToken?: string; org?: string },
): Promise<void> {
  if (!session.accessToken) {
    throw new ApiError(
      "A Keycloak access token is required for migration",
      401,
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (session.org) headers["X-Tenant-Id"] = session.org;
  let response: Response;
  try {
    response = await fetch(`${getRagServerUrl()}/v1/datasource`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...datasource,
        metadata: {
          ...(datasource.metadata ?? {}),
          config_managed: true,
          config_import_adopted: true,
        },
        // This metadata is management ownership only. Query access comes from
        // `search_with_teams` and its separate knowledge_base projection.
        owner_team_slug: managementOwner.ownerTeamSlug,
        owner_subject: managementOwner.ownerSubject,
        shared_with_teams: [],
        // Search access is inherited through the destination collection. Keeping the
        // datasource-level list empty avoids two policy sources that can
        // drift apart later when the collection audience changes.
        search_with_teams: [],
      }),
    });
  } catch {
    throw new ApiError(
      "The datasource access policy could not be persisted because the RAG service is unavailable",
      503,
      "SEARCH_OWNER_PERSIST_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new ApiError(
      `Failed to persist datasource access policy (${response.status})${details ? `: ${details}` : ""}`,
      502,
      "SEARCH_OWNER_PERSIST_FAILED",
    );
  }
}

interface AdoptableEntry {
  ds: RedisDataSource;
  fields: Record<string, unknown>;
}

async function previewSourcesFromRedis(session: {
  accessToken?: string;
  org?: string;
}): Promise<{
  preview: MigratePreviewSource[];
  adoptable: Map<string, AdoptableEntry>;
  /** Legacy-global sources that belong in the selected destination collection. */
  platformSources: RedisDataSource[];
  /** Sources without a DB row whose ownership policy still needs adoption. */
  unmanagedSources: RedisDataSource[];
  /** All legacy sources found, including ones that cannot be imported. */
  migrationCandidateCount: number;
}> {
  const redisSources = await fetchRedisDatasources(session);
  if (redisSources.length === 0) {
    return {
      preview: [],
      adoptable: new Map(),
      platformSources: [],
      unmanagedSources: [],
      migrationCandidateCount: 0,
    };
  }

  const migratableIds = redisSources
    .map((ds) => ds.datasource_id)
    .filter((id): id is string => Boolean(id));

  const collection = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  const existingDocs = migratableIds.length
    ? await collection
        .find({ source_id: { $in: migratableIds } } as never)
        .project({ source_id: 1, config_driven: 1, config_import_adopted: 1 })
        .toArray()
    : [];
  const existingById = new Map(existingDocs.map((doc) => [doc.source_id, doc]));

  const preview: MigratePreviewSource[] = [];
  const adoptable = new Map<string, AdoptableEntry>();
  const platformSources: RedisDataSource[] = [];
  const unmanagedSources: RedisDataSource[] = [];
  let migrationCandidateCount = 0;

  for (const ds of redisSources) {
    if (!ds.datasource_id) continue;
    const existing = existingById.get(ds.datasource_id);
    const isLegacyConfigSource = existing?.config_driven === true;
    const alreadyAdopted = existing?.config_import_adopted === true;
    const policyAlreadyAdopted = ds.metadata?.config_import_adopted === true;
    const isUnscopedLegacySource = !existing && !hasExplicitAccessScope(ds);
    const isMigrationCandidate =
      isLegacyConfigSource ||
      alreadyAdopted ||
      policyAlreadyAdopted ||
      isUnscopedLegacySource;

    // Explicit prior-adoption markers keep retries recoverable. Otherwise,
    // only the genuinely unscoped, pre-RBAC corpus belongs in Platform RAG.
    // A scoped direct datasource may have no Mongo config row and must never
    // be interpreted as legacy-global merely because of that absence.
    if (!isMigrationCandidate) continue;
    migrationCandidateCount += 1;

    const sourceType = SOURCE_TYPE_MAP[ds.source_type];
    if (!OPENFGA_ID_PATTERN.test(ds.datasource_id)) {
      preview.push({
        source_id: ds.datasource_id,
        name: ds.name ?? ds.datasource_id,
        source_type: sourceType ?? ds.source_type,
        in_db: Boolean(existing),
        already_adopted: alreadyAdopted,
        importable: false,
        unavailable_reason: "unsupported_legacy_id",
      });
      continue;
    }

    platformSources.push(ds);
    if (
      (isUnscopedLegacySource || (isLegacyConfigSource && !alreadyAdopted)) &&
      !policyAlreadyAdopted
    ) {
      unmanagedSources.push(ds);
    }

    if (!sourceType) continue;
    // Sources created in the UI already have editable settings and are not
    // part of this one-time environment-config import.
    preview.push({
      source_id: ds.datasource_id,
      name: ds.name ?? ds.datasource_id,
      source_type: sourceType,
      in_db: Boolean(existing),
      already_adopted: alreadyAdopted,
      importable:
        !alreadyAdopted &&
        isMigrationCandidate &&
        (!existing || isLegacyConfigSource),
    });

    if (!existing && isMigrationCandidate) {
      const fields = extractFieldsFromRedis(ds, sourceType);
      if (fields) adoptable.set(ds.datasource_id, { ds, fields });
    }
  }

  return {
    preview,
    adoptable,
    platformSources,
    unmanagedSources,
    migrationCandidateCount,
  };
}

async function attachLegacyAgentsToCollection(
  collectionId: string,
): Promise<number> {
  const agents = await getCollection<Record<string, unknown>>("dynamic_agents");
  const result = await agents.updateMany(
    {
      "allowed_tools.knowledge-base": { $exists: true, $ne: false },
      $and: [
        {
          $or: [
            { rag_collection_ids: { $exists: false } },
            { rag_collection_ids: null },
          ],
        },
        {
          $or: [
            { datasource_ids: { $exists: false } },
            { datasource_ids: null },
          ],
        },
      ],
    } as never,
    {
      $set: {
        rag_collection_ids: [collectionId],
        updated_at: new Date().toISOString(),
      },
    },
  );
  return result.modifiedCount;
}

async function loadMigrationDestination(rawId: unknown): Promise<RagCollection> {
  const id = normalizeString(rawId) ?? PLATFORM_RAG_COLLECTION_ID;
  if (!RAG_COLLECTION_ID_PATTERN.test(id)) {
    throw new ApiError(
      "destination_collection_id is invalid",
      400,
      "INVALID_DESTINATION_COLLECTION_ID",
    );
  }
  if (id === PLATFORM_RAG_COLLECTION_ID) {
    return bootstrapPlatformRagCollection();
  }
  const collections = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const destination = await collections.findOne({ _id: id } as never);
  if (!destination) {
    throw new ApiError(
      "Destination collection not found",
      404,
      "DESTINATION_COLLECTION_NOT_FOUND",
    );
  }
  return destination;
}

function managementOwnerForCollection(collection: RagCollection): {
  ownerSubject: string | null;
  ownerTeamSlug: string | null;
} {
  const ownerTeamSlug = collection.maintainer_team_slugs?.[0] ?? null;
  const ownerSubject = ownerTeamSlug
    ? null
    : normalizeString(collection.owner_subject);
  if (!ownerTeamSlug && !ownerSubject) {
    throw new ApiError(
      "The destination collection needs an Owner before sources can be imported",
      409,
      "DESTINATION_COLLECTION_HAS_NO_OWNER",
    );
  }
  return { ownerSubject, ownerTeamSlug };
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const actorSubject = normalizeString(session.sub);
  if (!actorSubject) {
    throw new ApiError(
      "A stable user subject is required for migration",
      401,
      "NO_SUBJECT",
    );
  }
  await requireRbacPermission(session, "admin_ui", "admin");
  // This operation replaces policy for arbitrary datasources, so access to
  // the admin UI alone is insufficient: the caller must also be an OpenFGA
  // organization manager.
  await requireResourcePermission(session, {
    type: "organization",
    id: caipeOrgKey(),
    action: "manage",
  });
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("Request body must be an object", 400, "INVALID_BODY");
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
  }
  const dryRun = body.dry_run !== false;

  const destination = await loadMigrationDestination(
    body.destination_collection_id,
  );

  const {
    preview,
    adoptable,
    platformSources,
    unmanagedSources,
    migrationCandidateCount,
  } =
    await previewSourcesFromRedis({
      accessToken: session.accessToken,
      org: session.org,
    });

  if (dryRun) {
    return successResponse<MigrateFromConfigResult>({
      sources: preview,
      legacy_source_count: migrationCandidateCount,
      compatible_source_count: platformSources.length,
      destination_collection: {
        id: destination._id,
        source_count: destination.source_ids?.length ?? 0,
        agents_updated: 0,
      },
    });
  }

  const previewById = new Map(preview.map((s) => [s.source_id, s]));
  const requestedIds = Object.prototype.hasOwnProperty.call(body, "source_ids")
    ? parseSourceIds(body.source_ids)
    : preview.filter((s) => s.importable).map((s) => s.source_id);

  const managementOwner = managementOwnerForCollection(destination);
  const adopted: string[] = [];
  const skipped: MigrateSkip[] = [];

  // First establish source-level management for every legacy-global source,
  // including connector types that do not yet have a self-service form. The
  // Search access comes from Platform RAG below rather than being copied to
  // every datasource.
  for (const datasource of unmanagedSources) {
    const sourceId = datasource.datasource_id;
    await deleteAllDataSourceRelationshipTuples(sourceId);
    await deleteAllKnowledgeBaseRelationshipTuples(sourceId);
    await deleteAllIngestionSourceRelationshipTuples(sourceId);
    await reconcileIngestionSourceRelationships({
      sourceId,
      creatorSubject: datasource.creator_subject,
      ownerSubject: managementOwner.ownerSubject,
      ownerTeamSlug: managementOwner.ownerTeamSlug,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
      globalUserAccess: false,
    });
    await reconcileKnowledgeBaseRelationships({
      knowledgeBaseId: sourceId,
      creatorSubject: datasource.creator_subject,
      ownerSubject: null,
      // Management is intentionally independent. The collection supplies read
      // access to the selected audience through parent_collection.
      ownerTeamSlug: null,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
    });
    await reconcileDataSourceRelationships({
      dataSourceId: sourceId,
      parentKnowledgeBaseId: sourceId,
    });
    await persistDatasourceAccessPolicy(datasource, managementOwner, {
      accessToken: session.accessToken,
      org: session.org,
    });
  }

  const seededConfigIds: string[] = [];
  for (const sourceId of requestedIds) {
    const previewEntry = previewById.get(sourceId);
    if (!previewEntry) {
      skipped.push({ source_id: sourceId, reason: "not_found_in_redis" });
      continue;
    }
    if (previewEntry.unavailable_reason === "unsupported_legacy_id") {
      skipped.push({ source_id: sourceId, reason: "unsupported_legacy_id" });
      continue;
    }
    if (previewEntry.already_adopted || !previewEntry.importable) {
      skipped.push({ source_id: sourceId, reason: "already_in_db" });
      continue;
    }
    if (previewEntry.in_db) {
      seededConfigIds.push(sourceId);
      continue;
    }
    const entry = adoptable.get(sourceId);
    if (!entry) {
      skipped.push({ source_id: sourceId, reason: "missing_identity_fields" });
      continue;
    }

    // Query/management policy for every unmanaged datasource was reconciled
    // above. This loop adopts the selected connectors into editable Mongo
    // configuration and establishes the independent source-management object.
    await deleteAllIngestionSourceRelationshipTuples(sourceId);

    await createIngestionSource({
      sourceId,
      fields: entry.fields,
      name: entry.ds.name ?? sourceId,
      description: entry.ds.description ?? "",
      ownerTeamSlug: managementOwner.ownerTeamSlug,
      sharedWithTeams: [],
      searchWithTeams: [],
      creatorSubject: entry.ds.creator_subject ?? null,
      ownerSubject: managementOwner.ownerSubject,
      recordedSearchOwnerTeamSlug: null,
      defaultChunkSize: entry.ds.default_chunk_size,
      defaultChunkOverlap: entry.ds.default_chunk_overlap,
      reloadInterval: entry.ds.reload_interval,
      configImportAdopted: true,
    });
    adopted.push(sourceId);
  }

  if (seededConfigIds.length > 0) {
    const seededResult = await adoptConfigImportedRagSources(seededConfigIds, {
      ownerTeamSlug: managementOwner.ownerTeamSlug,
      ownerSubject: managementOwner.ownerSubject,
    });
    adopted.push(...seededResult.adopted);
    skipped.push(
      ...seededResult.skipped.map((item) => ({
        source_id: item.source_id,
        reason: "already_in_db" as const,
      })),
    );
  }

  const updatedDestination = await replaceCollectionSources(
    destination._id,
    Array.from(
      new Set([
        ...(destination.source_ids ?? []),
        ...platformSources.map((source) => source.datasource_id),
      ]),
    ),
  );
  const agentsUpdated = await attachLegacyAgentsToCollection(destination._id);

  return successResponse<MigrateFromConfigResult>({
    sources: preview,
    adopted,
    skipped,
    legacy_source_count: migrationCandidateCount,
    compatible_source_count: platformSources.length,
    destination_collection: {
      id: updatedDestination._id,
      source_count: updatedDestination.source_ids.length,
      agents_updated: agentsUpdated,
    },
  });
});

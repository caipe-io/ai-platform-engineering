// GET /api/admin/platform-config — read platform-wide config (any authenticated user)
// PATCH /api/admin/platform-config — update platform config (admin only)

// assisted-by claude code claude-sonnet-4-6

import { ApiError,requireRbacPermission,withAuth,withErrorHandler } from '@/lib/api-middleware';
import { getCollection } from '@/lib/mongodb';
import {
normalizePlatformDefaultAgentId,
PLATFORM_AGENT_ID_PATTERN,
PLATFORM_CONFIG_ID,
type PlatformDefaultAgentDocument,
} from '@/lib/platform-default-agent';
import {
DEFAULT_DISCOVERY_CACHE_TTL_MINUTES,
MAX_DISCOVERY_CACHE_TTL_MINUTES,
MIN_DISCOVERY_CACHE_TTL_MINUTES,
normalizeDiscoveryCacheTtlMinutes,
} from '@/lib/rbac/discovery-cache-config';
import { writeOpenFgaTuples,type OpenFgaTupleKey } from '@/lib/rbac/openfga';
import { requireResourcePermission } from '@/lib/rbac/resource-authz';
import {
createJsonResponseCacheStore,
envTtlMs,
withJsonResponseCache,
} from '@/lib/server-response-cache';
import {
normalizeRagDefaultSearchTeamSlug,
RAG_TEAM_SLUG_PATTERN,
} from '@/lib/rag-settings';
import { normalizeRagIngestorLimits } from '@/lib/rag-ingestor-limits';
import { NextRequest,NextResponse } from 'next/server';
import { projectsEnabledFromEnvironment } from '@/lib/projects-config';

const platformConfigCache = createJsonResponseCacheStore();

interface PlatformConfigDoc extends PlatformDefaultAgentDocument {
  schedule_editor_agent_id?: unknown;
  slack_victorops_escalation_agent_id?: unknown;
  release_notes?: unknown;
  slack_discovery_cache_ttl_minutes?: unknown;
  webex_discovery_cache_ttl_minutes?: unknown;
  remote_mcp_catalog?: unknown;
  projects?: unknown;
  rag_default_search_team_slug?: unknown;
  rag_ingestor_limits?: unknown;
}

interface TeamConfigDoc {
  slug?: string;
}

export interface CustomMCPCatalogEntry {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  logo_url?: string;
  provider_key: string;
}

export interface RemoteMCPCatalogConfig {
  enabled_providers: string[] | null;
  custom_entries: CustomMCPCatalogEntry[];
}

function normalizeCustomMCPEntry(entry: unknown, idx: number): CustomMCPCatalogEntry | null {
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) return null;
  const endpoint = typeof entry.endpoint === 'string' ? entry.endpoint.trim() : '';
  if (!endpoint) return null;
  try { new URL(endpoint); } catch { return null; }
  const provider_key = typeof entry.provider_key === 'string' ? entry.provider_key.trim().toLowerCase() : '';
  if (!provider_key) return null;
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `custom-${idx}`;
  return {
    id,
    name,
    description: typeof entry.description === 'string' ? entry.description.trim() : '',
    endpoint,
    logo_url: typeof entry.logo_url === 'string' && entry.logo_url.trim() ? entry.logo_url.trim() : undefined,
    provider_key,
  };
}

// `defaultEnabledProviders` only applies when the input has no
// `enabled_providers` key at all (e.g. no config document has ever been
// saved). An explicit `enabled_providers: null` — the "Enable all" admin
// action — always means "show every built-in provider", not "unset".
function normalizeRemoteMCPCatalog(
  input: unknown,
  defaultEnabledProviders: string[] | null = null,
): RemoteMCPCatalogConfig {
  const source = isRecord(input) ? input : {};
  let enabled_providers: string[] | null = defaultEnabledProviders;
  if (Array.isArray(source.enabled_providers)) {
    enabled_providers = (source.enabled_providers as unknown[])
      .filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
      .map((v) => v.trim().toLowerCase());
  } else if (Object.prototype.hasOwnProperty.call(source, 'enabled_providers')) {
    enabled_providers = null;
  }
  const custom_entries: CustomMCPCatalogEntry[] = [];
  if (Array.isArray(source.custom_entries)) {
    for (let i = 0; i < (source.custom_entries as unknown[]).length; i++) {
      const entry = normalizeCustomMCPEntry((source.custom_entries as unknown[])[i], i);
      if (entry) custom_entries.push(entry);
    }
  }
  return { enabled_providers, custom_entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVictoropsAgentId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ApiError('slack_victorops_escalation_agent_id must be a string or null', 400, 'INVALID_VICTOROPS_AGENT_ID');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PLATFORM_AGENT_ID_PATTERN.test(trimmed)) {
    throw new ApiError('slack_victorops_escalation_agent_id is not a valid OpenFGA object id', 400, 'INVALID_VICTOROPS_AGENT_ID');
  }
  return trimmed;
}

function normalizeScheduleEditorAgentId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ApiError(
      'schedule_editor_agent_id must be a string or null',
      400,
      'INVALID_SCHEDULE_EDITOR_AGENT_ID',
    );
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!PLATFORM_AGENT_ID_PATTERN.test(trimmed)) {
    throw new ApiError(
      'schedule_editor_agent_id is not a valid OpenFGA object id',
      400,
      'INVALID_SCHEDULE_EDITOR_AGENT_ID',
    );
  }
  return trimmed;
}

function defaultAgentTuple(agentId: string): OpenFgaTupleKey {
  return { user: 'user:*', relation: 'user', object: `agent:${agentId}` };
}

async function reconcileDefaultAgentGrant(previousAgentId: string | null, nextAgentId: string | null): Promise<void> {
  const writes = nextAgentId ? [defaultAgentTuple(nextAgentId)] : [];
  const deletes = previousAgentId && previousAgentId !== nextAgentId ? [defaultAgentTuple(previousAgentId)] : [];
  if (writes.length === 0 && deletes.length === 0) return;
  await writeOpenFgaTuples({ writes, deletes });
}

// Release notes is a single platform-wide on/off switch. The announcement
// always targets the currently deployed version, and dismissal is permanent
// per-version, so there is no version/revision/toast/CTA config to store.
function normalizeReleaseNotesConfig(input: unknown = {}) {
  const source = isRecord(input) ? input : {};
  return {
    enabled: source.enabled !== false,
  };
}

function normalizeProjectsConfig(input: unknown, fallback = false) {
  const source = isRecord(input) ? input : {};
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withJsonResponseCache(request, platformConfigCache, () => getPlatformConfig(request), {
    ttlMs: envTtlMs('PLATFORM_CONFIG_CACHE_TTL_MS', 10_000),
    cacheableStatus: (status) => status === 200 || status === 403,
    maxEntries: 512,
  });
});

async function getPlatformConfig(request: NextRequest) {
  return await withAuth(request, async (_req, _user, session) => {
    await requireResourcePermission(session, {
      type: 'system_config',
      id: PLATFORM_CONFIG_ID,
      action: 'read',
    });
    const col = await getCollection<PlatformConfigDoc>('platform_config');
    const doc = await col.findOne({ _id: PLATFORM_CONFIG_ID } as never);

    const defaultAgentId = normalizePlatformDefaultAgentId(doc?.default_agent_id);
    const envFallback = process.env.DEFAULT_AGENT_ID || null;
    const scheduleEditorAgentId = normalizeScheduleEditorAgentId(
      doc?.schedule_editor_agent_id,
    );
    const scheduleEditorEnvFallback = process.env.SCHEDULE_EDITOR_AGENT_ID?.trim() || null;
    const slackDiscoveryTtlMinutes =
      normalizeDiscoveryCacheTtlMinutes(doc?.slack_discovery_cache_ttl_minutes) ??
      normalizeDiscoveryCacheTtlMinutes(process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES) ??
      DEFAULT_DISCOVERY_CACHE_TTL_MINUTES;
    const webexDiscoveryTtlMinutes =
      normalizeDiscoveryCacheTtlMinutes(doc?.webex_discovery_cache_ttl_minutes) ??
      normalizeDiscoveryCacheTtlMinutes(process.env.WEBEX_DISCOVERY_CACHE_TTL_MINUTES) ??
      DEFAULT_DISCOVERY_CACHE_TTL_MINUTES;

    const victoropsAgentId = normalizeVictoropsAgentId(doc?.slack_victorops_escalation_agent_id);
    const victoropsEnvFallback = process.env.SLACK_INTEGRATION_VICTOROPS_AGENT_ID || null;
    const ragIngestorLimits = normalizeRagIngestorLimits(doc?.rag_ingestor_limits);

    return NextResponse.json({
      success: true,
      data: {
        default_agent_id: defaultAgentId ?? envFallback,
        source: defaultAgentId ? 'db' : (envFallback ? 'env' : 'fallback'),
        schedule_editor_agent_id: scheduleEditorAgentId ?? scheduleEditorEnvFallback,
        schedule_editor_agent_source: scheduleEditorAgentId
          ? 'db'
          : (scheduleEditorEnvFallback ? 'env' : 'fallback'),
        slack_victorops_escalation_agent_id: victoropsAgentId ?? victoropsEnvFallback,
        slack_victorops_escalation_agent_source: victoropsAgentId ? 'db' : (victoropsEnvFallback ? 'env' : 'fallback'),
        release_notes: normalizeReleaseNotesConfig(doc?.release_notes),
        projects: normalizeProjectsConfig(doc?.projects, projectsEnabledFromEnvironment()),
        projects_source: isRecord(doc?.projects) && typeof doc.projects.enabled === 'boolean'
          ? 'db'
          : (process.env.PROJECTS_ENABLED ? 'env' : 'fallback'),
        slack_discovery_cache_ttl_minutes: slackDiscoveryTtlMinutes,
        webex_discovery_cache_ttl_minutes: webexDiscoveryTtlMinutes,
        // Default (no config saved yet) is "disable all" — operators opt in
        // per provider rather than every built-in showing up unconfigured.
        remote_mcp_catalog: normalizeRemoteMCPCatalog(doc?.remote_mcp_catalog, []),
        rag_default_search_team_slug:
          ragIngestorLimits.shared.max_search_teams > 0
            ? normalizeRagDefaultSearchTeamSlug(doc?.rag_default_search_team_slug)
            : null,
        rag_ingestor_limits: ragIngestorLimits,
      },
    });
  });
}

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return await withAuth(request, async (_req, user, session) => {
    await requireRbacPermission(session, 'admin_ui', 'admin');
    await requireResourcePermission(session, {
      type: 'system_config',
      id: PLATFORM_CONFIG_ID,
      action: 'admin',
    });

    const rawBody = await request.json().catch(() => ({}));
    const body = isRecord(rawBody) ? rawBody : {};
    const update: Record<string, unknown> = {
      updated_at: new Date(),
      updated_by: user.email,
    };

    const hasDefaultAgentUpdate = Object.prototype.hasOwnProperty.call(body, 'default_agent_id');
    const nextDefaultAgentId = hasDefaultAgentUpdate ? normalizePlatformDefaultAgentId(body.default_agent_id) : null;
    if (hasDefaultAgentUpdate) update.default_agent_id = nextDefaultAgentId;

    // The scheduler editor agent only selects which existing agent opens when
    // an admin clicks "Chat with agent". It does not grant agent access.
    const hasScheduleEditorUpdate = Object.prototype.hasOwnProperty.call(
      body,
      'schedule_editor_agent_id',
    );
    const nextScheduleEditorAgentId = hasScheduleEditorUpdate
      ? normalizeScheduleEditorAgentId(body.schedule_editor_agent_id)
      : null;
    if (hasScheduleEditorUpdate) update.schedule_editor_agent_id = nextScheduleEditorAgentId;

    // Slack VictorOps escalation agent (Admin → Integrations → Slack →
    // Advanced). Unlike the platform default this does NOT grant any user
    // access — it is only the agent the Slack bot queries for on-call
    // lookups — so there is no `user:*` tuple to reconcile or ack to require.
    const hasVictoropsUpdate = Object.prototype.hasOwnProperty.call(body, 'slack_victorops_escalation_agent_id');
    const nextVictoropsAgentId = hasVictoropsUpdate
      ? normalizeVictoropsAgentId(body.slack_victorops_escalation_agent_id)
      : null;
    if (hasVictoropsUpdate) update.slack_victorops_escalation_agent_id = nextVictoropsAgentId;

    if (body.release_notes) {
      update.release_notes = normalizeReleaseNotesConfig(body.release_notes);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'projects')) {
      if (!isRecord(body.projects) || typeof body.projects.enabled !== 'boolean') {
        throw new ApiError('projects.enabled must be a boolean', 400, 'INVALID_PROJECTS_CONFIG');
      }
      update.projects = normalizeProjectsConfig(body.projects);
    }

    // Slack and Webex discovery caches are configured independently.
    if (Object.prototype.hasOwnProperty.call(body, 'remote_mcp_catalog')) {
      update.remote_mcp_catalog = normalizeRemoteMCPCatalog(body.remote_mcp_catalog);
    }

    for (const field of [
      'slack_discovery_cache_ttl_minutes',
      'webex_discovery_cache_ttl_minutes',
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const raw = body[field];
      if (raw === null) {
        update[field] = null;
        continue;
      }
      const asNumber = typeof raw === 'number' ? raw : Number(raw);
      if (
        !Number.isFinite(asNumber) ||
        !Number.isInteger(asNumber) ||
        asNumber < MIN_DISCOVERY_CACHE_TTL_MINUTES ||
        asNumber > MAX_DISCOVERY_CACHE_TTL_MINUTES
      ) {
        throw new ApiError(
          `${field} must be an integer between ${MIN_DISCOVERY_CACHE_TTL_MINUTES} and ${MAX_DISCOVERY_CACHE_TTL_MINUTES}`,
          400,
          'INVALID_DISCOVERY_CACHE_TTL',
        );
      }
      update[field] = asNumber;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'rag_default_search_team_slug')) {
      const rawTeamSlug = body.rag_default_search_team_slug;
      if (
        rawTeamSlug !== null &&
        rawTeamSlug !== '' &&
        (typeof rawTeamSlug !== 'string' || !RAG_TEAM_SLUG_PATTERN.test(rawTeamSlug.trim()))
      ) {
        throw new ApiError(
          'rag_default_search_team_slug must be a valid team slug or null',
          400,
          'INVALID_RAG_DEFAULT_SEARCH_TEAM',
        );
      }
      const teamSlug = normalizeRagDefaultSearchTeamSlug(rawTeamSlug);
      if (teamSlug) {
        const teams = await getCollection<TeamConfigDoc>('teams');
        const existingTeam = await teams.findOne({ slug: teamSlug } as never);
        if (!existingTeam) {
          throw new ApiError(
            'The selected default RAG search team does not exist',
            404,
            'RAG_DEFAULT_SEARCH_TEAM_NOT_FOUND',
          );
        }
      }
      update.rag_default_search_team_slug = teamSlug;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'rag_ingestor_limits')) {
      try {
        const nextLimits = normalizeRagIngestorLimits(
          body.rag_ingestor_limits,
          { strict: true },
        );
        update.rag_ingestor_limits = nextLimits;
        if (nextLimits.shared.max_search_teams === 0) {
          update.rag_default_search_team_slug = null;
        }
      } catch (error) {
        throw new ApiError(
          error instanceof Error ? error.message : 'rag_ingestor_limits is invalid',
          400,
          'INVALID_RAG_INGESTOR_LIMITS',
        );
      }
    }

    const col = await getCollection<PlatformConfigDoc>('platform_config');
    const previousDoc = hasDefaultAgentUpdate
      ? await col.findOne({ _id: PLATFORM_CONFIG_ID } as never)
      : null;
    const previousDefaultAgentId = normalizePlatformDefaultAgentId(previousDoc?.default_agent_id);
    const defaultAgentChanged = hasDefaultAgentUpdate && previousDefaultAgentId !== nextDefaultAgentId;

    // Selecting a non-null default agent grants `user:*` `can_use` on it,
    // i.e. every signed-in user can chat with that agent. Require an
    // explicit ack from the caller so scripts/curl/MCP tools can't flip
    // an agent public by accident. Clearing the default (next=null) is
    // safe — we just revoke the previous wildcard — so we don't require
    // the ack there.
    if (defaultAgentChanged && nextDefaultAgentId !== null) {
      if (body.acknowledge_public_access !== true) {
        throw new ApiError(
          'Setting a platform default agent makes it available to all signed-in users. Confirm in the UI before saving.',
          400,
          'PUBLIC_ACCESS_NOT_ACKNOWLEDGED',
        );
      }
    }

    if (hasDefaultAgentUpdate) {
      await reconcileDefaultAgentGrant(previousDefaultAgentId, nextDefaultAgentId);
      if (defaultAgentChanged) {
        // No shared audit helper exists in this codebase yet; emit a
        // structured console line so existing log shippers (loki, etc.)
        // can grep on `[AUDIT] platform_default_agent_changed`.
        console.info(
          '[AUDIT] platform_default_agent_changed',
          JSON.stringify({
            actor: user.email ?? null,
            previous: previousDefaultAgentId,
            next: nextDefaultAgentId,
            at: new Date().toISOString(),
          }),
        );
      }
    }
    await col.updateOne(
      { _id: PLATFORM_CONFIG_ID } as never,
      {
        $set: update,
      },
      { upsert: true },
    );
    platformConfigCache.responses.clear();
    platformConfigCache.inflight.clear();

    return NextResponse.json({
      success: true,
      data: {
        ...(Object.prototype.hasOwnProperty.call(update, 'default_agent_id')
          ? { default_agent_id: update.default_agent_id }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'schedule_editor_agent_id')
          ? {
              schedule_editor_agent_id:
                update.schedule_editor_agent_id ??
                process.env.SCHEDULE_EDITOR_AGENT_ID?.trim() ??
                null,
              schedule_editor_agent_source: update.schedule_editor_agent_id
                ? 'db'
                : (process.env.SCHEDULE_EDITOR_AGENT_ID?.trim() ? 'env' : 'fallback'),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'slack_victorops_escalation_agent_id')
          ? { slack_victorops_escalation_agent_id: update.slack_victorops_escalation_agent_id }
          : {}),
        ...(update.release_notes ? { release_notes: update.release_notes } : {}),
        ...(update.projects ? { projects: update.projects, projects_source: 'db' } : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'slack_discovery_cache_ttl_minutes')
          ? { slack_discovery_cache_ttl_minutes: update.slack_discovery_cache_ttl_minutes }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'webex_discovery_cache_ttl_minutes')
          ? { webex_discovery_cache_ttl_minutes: update.webex_discovery_cache_ttl_minutes }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'remote_mcp_catalog')
          ? { remote_mcp_catalog: update.remote_mcp_catalog }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'rag_default_search_team_slug')
          ? { rag_default_search_team_slug: update.rag_default_search_team_slug }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(update, 'rag_ingestor_limits')
          ? { rag_ingestor_limits: update.rag_ingestor_limits }
          : {}),
      },
    });
  });
});

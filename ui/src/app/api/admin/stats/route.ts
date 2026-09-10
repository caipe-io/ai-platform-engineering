// GET /api/admin/stats - Get platform usage statistics

import {
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import {
resolveAuthorizedAdminSimulationScope,
simulationSubjectCanManageAdminSurface,
} from '@/lib/rbac/admin-simulation-server';
import { resolveInsightsUserFilter } from '@/lib/rbac/insights-user-filter';
import { requireAdminSurfaceManage } from '@/lib/rbac/require-openfga';
import { getAgentsByIds, getAllAgents, getOwnedAgentConversationIds, getOwnedAgents, getReadableSlackChannelNames, getReadableWebexSpaceIds, type OwnedAgent } from '@/lib/rbac/user-insights-scope';
import {
createJsonResponseCacheStore,
envTtlMs,
withJsonResponseCache,
} from '@/lib/server-response-cache';
import { ADMIN_STATS_SECTIONS,type AdminStatsOwnerType,type AdminStatsSection } from '@/types/admin-stats';
import type { Collection,Document } from 'mongodb';
import { NextRequest,NextResponse } from 'next/server';

const adminStatsCache = createJsonResponseCacheStore();
let botOwnerIdsCache: { expiresAt: number; promise: Promise<string[]> } | null = null;
const TOP_USERS_PAGE_SIZE = 10;
const VALID_TOP_USER_OWNER_STAGE = {
  $match: { _id: { $nin: [null, ''] } },
};

interface SlackStats {
  channels: {
    ai_enabled?: number;
    alerts_enabled?: number;
    qanda_enabled?: number;
    total?: number;
  };
  configured_channels?: number;
  configured_channels_daily?: Array<{
    date: string;
    total: number;
  }>;
  daily: Array<{
    date: string;
    escalated: number;
    interactions: number;
    unique_users: number;
  }>;
  top_channels: Array<{
    channel_name: string;
    interactions: number;
  }>;
  total_interactions: number;
  unique_users: number;
}

interface ChannelStatsDocument extends Document {
  _id: string;
  ai_enabled?: number;
  alerts_enabled?: number;
  qanda_enabled?: number;
  total?: number;
}

interface WebexStats {
  configured_spaces?: number;
  configured_spaces_daily?: Array<{
    date: string;
    total: number;
  }>;
  daily: Array<{
    date: string;
    interactions: number;
    unique_users: number;
  }>;
  top_spaces: Array<{
    space_name: string;
    interactions: number;
  }>;
  total_interactions: number;
  unique_users: number;
}

interface ApiStats {
  daily: Array<{
    date: string;
    interactions: number;
    unique_users: number;
  }>;
  total_interactions: number;
  unique_users: number;
  // Direct MCP Activity — sourced from the audit-service (agent_gateway
  // OK_LOCAL_AGENT_CONTEXT events), not the conversations/messages
  // collections above. Admin-only; see `isFullAdmin` gating below.
  mcp_activity?: {
    total_events: number;
    unique_users: number;
    daily: Array<{ date: string; events: number; unique_users: number }>;
    unavailable?: boolean;
    range_capped?: boolean;
  };
}

type BucketUnit = 'minute' | 'hour' | 'day';

function parseStatsSection(searchParams: URLSearchParams): AdminStatsSection | 'all' | null {
  const section = searchParams.get('section');
  if (!section) return 'all';
  return (ADMIN_STATS_SECTIONS as readonly string[]).includes(section)
    ? section as AdminStatsSection
    : null;
}

function parsePositivePage(searchParams: URLSearchParams, key: string): number {
  const parsed = Number.parseInt(searchParams.get(key) ?? '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Identity classification for a Top Users leaderboard owner (see classifyOwner). */
type OwnerType = AdminStatsOwnerType;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Ranges this short bucket by 5-minute intervals so 1h/12h-style short
// windows show more than a single point (a single hourly bucket would
// otherwise collapse a 1h range to exactly one data point).
const MINUTE_BUCKET_THRESHOLD_MS = 2 * HOUR_MS;
const MINUTE_BUCKET_STEP_MIN = 5;

/** Mongo $dateToString format for a bucket granularity (UTC, matches Date#toISOString below). */
const BUCKET_DATE_FORMAT: Record<BucketUnit, string> = {
  minute: '%Y-%m-%dT%H:%M',
  hour: '%Y-%m-%dT%H:00',
  day: '%Y-%m-%d',
};

/** Render a bucket start Date into the same key format $dateToString produces above. */
function bucketDateKey(d: Date, unit: BucketUnit): string {
  if (unit === 'minute') return d.toISOString().slice(0, 16);
  if (unit === 'hour') return `${d.toISOString().slice(0, 13)}:00`;
  return d.toISOString().split('T')[0];
}

/** Floor `d` down to the start of the bucket it falls in, mutating a copy. */
function floorToBucket(d: Date, unit: BucketUnit): Date {
  const floored = new Date(d);
  if (unit === 'minute') {
    floored.setSeconds(0, 0);
    floored.setMinutes(Math.floor(floored.getMinutes() / MINUTE_BUCKET_STEP_MIN) * MINUTE_BUCKET_STEP_MIN);
  } else if (unit === 'hour') {
    floored.setMinutes(0, 0, 0);
  } else {
    floored.setHours(0, 0, 0, 0);
  }
  return floored;
}

/** Generate the ordered (oldest → newest) list of bucket keys covering `now` back `count` buckets of `unit` size. */
function generateBucketKeys(now: Date, count: number, unit: BucketUnit): string[] {
  const stepMs = unit === 'minute' ? MINUTE_BUCKET_STEP_MIN * MINUTE_MS : unit === 'hour' ? HOUR_MS : DAY_MS;
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = floorToBucket(new Date(now.getTime() - i * stepMs), unit);
    keys.push(bucketDateKey(d, unit));
  }
  return keys;
}

// ── Direct MCP Activity (audit-service) ─────────────────────────────────────
// Unlike every other card on this page, this one is not a Mongo aggregation —
// it queries the audit-service's own HTTP API for agent_gateway
// OK_LOCAL_AGENT_CONTEXT events (one per MCP tools/call from a local-agent-context
// client such as Claude Code/Codex — NOT CAIPE's own Dynamic Agents, and NOT a
// direct API caller, neither of which go through AgentGateway). Reuses the same
// base-URL resolution as /api/admin/audit-events.
function auditServiceBaseUrl(): string {
  return (process.env.AUDIT_SERVICE_URL ?? process.env.AUDIT_LOG_SERVICE_URL ?? 'http://audit-service:8010').replace(/\/$/, '');
}

// The audit-service caps a query's since→until span (`read_max_days`, default
// 31) and rejects a wider range with an HTTP 400. Mirror that cap here so a
// dashboard range wider than 31 days (e.g. the 90d preset) still succeeds —
// clamped to the most recent 31 days — rather than failing the whole section.
const AUDIT_MCP_ACTIVITY_MAX_DAYS = 31;

async function fetchMcpActivityStats(rangeStart: Date, rangeEnd: Date): Promise<ApiStats['mcp_activity']> {
  const cappedSince = new Date(Math.max(rangeStart.getTime(), rangeEnd.getTime() - AUDIT_MCP_ACTIVITY_MAX_DAYS * DAY_MS));
  const rangeCapped = cappedSince.getTime() > rangeStart.getTime();
  const dayCount = Math.max(1, Math.ceil((rangeEnd.getTime() - cappedSince.getTime()) / DAY_MS));
  const dayKeys = generateBucketKeys(rangeEnd, dayCount, 'day');
  const zeroDaily = dayKeys.map((date) => ({ date, events: 0, unique_users: 0 }));

  try {
    const params = new URLSearchParams({
      since: cappedSince.toISOString(),
      until: rangeEnd.toISOString(),
      reason_code: 'OK_LOCAL_AGENT_CONTEXT',
      limit: '10000',
    });
    const response = await fetch(`${auditServiceBaseUrl()}/v1/audit/events?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      console.warn(`Direct MCP Activity: audit-service returned HTTP ${response.status}`);
      return { total_events: 0, unique_users: 0, daily: zeroDaily, unavailable: true, range_capped: rangeCapped };
    }
    const body = (await response.json()) as {
      records?: Array<{ ts?: string; subject_ref?: string }>;
      total?: number;
    };
    const records = body.records ?? [];

    // A record with no `subject_ref` (predates the bridge's identity fix, or
    // simply has none) contributes to the event count but never to the
    // unique-user tally — degrade gracefully rather than erroring.
    const uniqueSubjects = new Set<string>();
    const dayCounts = new Map<string, number>();
    const daySubjects = new Map<string, Set<string>>();
    for (const record of records) {
      if (!record.ts) continue;
      const ts = new Date(record.ts);
      if (Number.isNaN(ts.getTime())) continue;
      const key = bucketDateKey(floorToBucket(ts, 'day'), 'day');
      dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
      if (typeof record.subject_ref === 'string' && record.subject_ref) {
        uniqueSubjects.add(record.subject_ref);
        if (!daySubjects.has(key)) daySubjects.set(key, new Set());
        daySubjects.get(key)!.add(record.subject_ref);
      }
    }

    const daily = dayKeys.map((key) => ({
      date: key,
      events: dayCounts.get(key) ?? 0,
      unique_users: daySubjects.get(key)?.size ?? 0,
    }));

    return {
      // `total` is the audit-service's full matching count, unaffected by the
      // `records` array being capped at `limit` — the event total stays
      // accurate even when the per-day/unique-user breakdown (below) is
      // necessarily derived from only the returned page.
      total_events: typeof body.total === 'number' ? body.total : records.length,
      unique_users: uniqueSubjects.size,
      daily,
      range_capped: rangeCapped,
    };
  } catch (err) {
    console.warn('Direct MCP Activity: audit-service unavailable', err);
    return { total_events: 0, unique_users: 0, daily: zeroDaily, unavailable: true, range_capped: rangeCapped };
  }
}

/**
 * Parse range params into bounded endpoints plus chart bucket metadata. Supports
 * preset strings and explicit from/to ISO dates. Short ranges bucket at finer
 * granularity (minute for ≤2h, hour for ≤1d) rather than clamping to
 * day-granularity, so 1h/12h/24h charts show more than one data point.
 */
function parseRange(searchParams: URLSearchParams): {
  rangeStart: Date;
  rangeEnd: Date;
  days: number;
  bucketUnit: BucketUnit;
  bucketCount: number;
} {
  const now = new Date();
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  let rangeStart: Date;
  let rangeEnd = now;
  let ms: number;

  if (fromParam) {
    const from = new Date(fromParam);
    const to = toParam ? new Date(toParam) : now;
    ms = to.getTime() - from.getTime();
    rangeStart = from;
    rangeEnd = to;
  } else {
    const range = searchParams.get('range');
    switch (range) {
      case '1h':  ms = HOUR_MS; break;
      case '12h': ms = 12 * HOUR_MS; break;
      case '24h':
      case '1d':  ms = DAY_MS; break;
      case '7d':  ms = 7 * DAY_MS; break;
      case '90d': ms = 90 * DAY_MS; break;
      case '30d':
      default:    ms = 30 * DAY_MS; break;
    }
    rangeStart = new Date(now.getTime() - ms);
  }

  const days = Math.max(1, Math.round(ms / DAY_MS));
  const bucketUnit: BucketUnit = ms <= MINUTE_BUCKET_THRESHOLD_MS ? 'minute' : ms <= DAY_MS ? 'hour' : 'day';
  const bucketCount =
    bucketUnit === 'minute' ? Math.max(1, Math.round(ms / (MINUTE_BUCKET_STEP_MIN * MINUTE_MS))) :
    bucketUnit === 'hour' ? Math.max(1, Math.round(ms / HOUR_MS)) :
    days;
  return { rangeStart, rangeEnd, days, bucketUnit, bucketCount };
}

// ── Human vs. bot identity ──────────────────────────────────────────────────
// "Top users" should reflect people, not the bot/service identities that own
// automated Slack posts (alerts, scheduled pipelines, MR bots). Human owners
// are keyed by email (contain '@'); Slack bot posters surface as bot IDs
// ("B0…"), the literal "unknown", the Slackbot sentinel, or platform service
// accounts. We exclude those so the leaderboard is people-only.
const BOT_OWNER_EXACT = ['unknown', 'USLACKBOT'];

async function getBotOwnerIds(conversations: Collection<Document>): Promise<string[]> {
  // Every independently loaded people/latency section needs the same global
  // bot-owner lookup. Coalesce those concurrent requests and keep the result for
  // the same short window as the stats response cache.
  if (process.env.NODE_ENV !== 'test' && botOwnerIdsCache && botOwnerIdsCache.expiresAt > Date.now()) {
    return botOwnerIdsCache.promise;
  }

  const promise = conversations.distinct('owner_id', {
    'metadata.owner_is_bot': true,
  }).then((ids) => ids.filter((id): id is string => typeof id === 'string' && id.length > 0));

  if (process.env.NODE_ENV !== 'test') {
    const cacheEntry = {
      expiresAt: Date.now() + envTtlMs('ADMIN_STATS_CACHE_TTL_MS', 15_000),
      promise,
    };
    botOwnerIdsCache = cacheEntry;
    promise.catch(() => {
      if (botOwnerIdsCache === cacheEntry) botOwnerIdsCache = null;
    });
  }

  return promise;
}

/** Mongo match fragment (spread into a $match) that keeps only human owners. */
const HUMAN_OWNER_MATCH: Record<string, unknown> = {
  $and: [
    { _id: { $nin: BOT_OWNER_EXACT } },
    // Bot user IDs are "B" + uppercase/digits (e.g. B04741LSXBJ); real Slack
    // user IDs start "U"/"W" and web owners are emails, so this only drops bots.
    { _id: { $not: /^B[A-Z0-9]{6,}$/ } },
    { _id: { $not: /^service-account-/ } },
  ],
};

/** Turn an internal agent id/name into a display label ("agent-gitlab-agent" → "Gitlab Agent"). */
function humanizeAgentName(raw: string): string {
  const stripped = raw.replace(/^agent-/, '').replace(/[-_]+/g, ' ').trim();
  if (!stripped) return raw;
  return stripped.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Merge `clause` into an existing Mongo filter without clobbering keys. When
 * `target` already has conditions we wrap both in `$and` (rather than spreading,
 * which would silently drop a duplicate key like `$or`). Mutates `target`.
 */
function andInto(target: Record<string, unknown>, clause: Record<string, unknown>): void {
  const existingKeys = Object.keys(target);
  if (existingKeys.length === 0) {
    Object.assign(target, clause);
    return;
  }
  const saved = { ...target };
  for (const k of existingKeys) delete target[k];
  target.$and = [saved, clause];
}

// GET /api/admin/stats
//
// `section=<name>` returns one independently cacheable metric group so clients
// can paint cards as their queries finish. Omitting `section` preserves the
// original complete response for existing callers.
export const GET = withErrorHandler(async (request: NextRequest) => {
  return withJsonResponseCache(request, adminStatsCache, () => getAdminStats(request), {
    ttlMs: envTtlMs('ADMIN_STATS_CACHE_TTL_MS', 15_000),
    // A filtered dashboard now occupies one small entry per section instead of
    // one large entry. Keep roughly the same number of complete dashboard views
    // resident without forcing hot sections to evict each other immediately.
    maxEntries: 2_048,
  });
});

async function getAdminStats(request: NextRequest) {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - admin features require MongoDB',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }

  const { session } = await getAuthFromBearerOrSession(request);
  const { searchParams } = request.nextUrl;
  const requestedSection = parseStatsSection(searchParams);
  if (!requestedSection) {
    return NextResponse.json(
      {
        success: false,
        error: `Invalid stats section. Expected one of: ${ADMIN_STATS_SECTIONS.join(', ')}`,
        code: 'INVALID_STATS_SECTION',
      },
      { status: 400 },
    );
  }
  const includesSection = (section: AdminStatsSection): boolean => (
    requestedSection === 'all' || requestedSection === section
  );
  const simulationScope = await resolveAuthorizedAdminSimulationScope(searchParams, session);
  const isFullAdmin = simulationScope
    ? await simulationSubjectCanManageAdminSurface(simulationScope, 'stats')
    : await requireAdminSurfaceManage(session, 'stats').then(() => true, () => false);

  // Non-admin: scope to their readable Slack channels, their readable Webex
  // spaces, their own web conversations, AND the agents they own (directly or
  // via a team). The owned-agent axis lets an agent owner see usage of their
  // agent even in channels/spaces they can't read / web chats that aren't
  // theirs.
  let nonAdminScope: { channelNames: string[]; ownerEmail: string; ownedAgents: OwnedAgent[]; sub: string; webexSpaceIds: string[] } | null = null;
  if (!isFullAdmin) {
    const openfgaUser = simulationScope?.openfgaUser ?? (
      typeof session.sub === 'string' && session.sub.trim()
        ? `user:${session.sub.trim()}`
        : ''
    );
    const email = simulationScope?.ownerEmail ?? (
      typeof session.user?.email === 'string' ? session.user.email.trim() : ''
    );
    if (!openfgaUser && !email) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
        { status: 401 }
      );
    }
    const [channelNames, ownedAgents, webexSpaceIds] = await Promise.all([
      openfgaUser ? getReadableSlackChannelNames(openfgaUser) : Promise.resolve([]),
      openfgaUser ? getOwnedAgents(openfgaUser) : Promise.resolve([]),
      openfgaUser ? getReadableWebexSpaceIds(openfgaUser) : Promise.resolve([]),
    ]);
    // workflow_runs are owner-keyed by JWT sub (owner_subject.id), not email —
    // openfgaUser is `user:<sub>`, so strip the prefix to recover the raw sub.
    const sub = openfgaUser.startsWith('user:') ? openfgaUser.slice('user:'.length) : '';
    nonAdminScope = { channelNames, ownerEmail: email, ownedAgents, sub, webexSpaceIds };
  }

    const { rangeStart, rangeEnd, days, bucketUnit, bucketCount } = parseRange(searchParams);
    const rangeDateMatch = { $gte: rangeStart, $lte: rangeEnd };

    // Optional filters
    const sourceFilter = searchParams.get('source'); // 'web' | 'slack' | 'webex' | null (all)
    const userFilter = searchParams.get('user'); // comma-separated emails | null (all)
    const teamFilter = searchParams.get('team'); // comma-separated team slugs | null (all)
    const { active: hasUserFilter, emails: userEmails } = await resolveInsightsUserFilter(
      userFilter,
      teamFilter,
    );
    const channelFilter = searchParams.get('channel'); // comma-separated channel names (slack only)
    const channelNames = channelFilter ? channelFilter.split(',').map((c) => c.trim()).filter(Boolean) : [];
    const agentFilter = searchParams.get('agent'); // comma-separated agent ids (dynamic agents)
    const agentIds = agentFilter ? agentFilter.split(',').map((a) => a.trim()).filter(Boolean) : [];
    // Top-users leaderboard: by default we hide bot/service identities (alert
    // posters, MR bots, service accounts). `include_bots=true` shows them —
    // surfaced as a "Show Bot Users" toggle in the UI.
    const includeBots = searchParams.get('include_bots') === 'true';
    const topConversationsPage = parsePositivePage(searchParams, 'top_conversations_page');
    const topMessagesPage = parsePositivePage(searchParams, 'top_messages_page');
    // Populated after the collections are available (below): a no-op $match
    // spread when bots are included, else a $match that drops bot/service
    // identities — both those detectable by ID pattern (HUMAN_OWNER_MATCH) and
    // Slack bot/app owners flagged at ingestion (metadata.owner_is_bot), whose
    // "U…"-prefixed IDs are indistinguishable from humans.
    let topUserOwnerMatch: Record<string, unknown>[] = [];

    // Build reusable filter fragments for conversations and messages.
    // Message analytics measure platform output, so human and system rows stay
    // available for chat history/audit without inflating Insights metrics.
    // Support both legacy (source/slack_meta) and new (client_type/metadata) schemas.
    const SLACK_CONV_MATCH = { $or: [{ source: 'slack' }, { client_type: 'slack' }] };
    // Webex is new-only — no legacy `source`/`*_meta` schema predates it.
    const WEBEX_CONV_MATCH = { client_type: 'webex' };
    // API is new-only too — forced onto a conversation by POST
    // /api/chat/conversations whenever a Bearer-token caller doesn't
    // self-declare slack/webex (see that route). No legacy schema predates it.
    const API_CONV_MATCH = { client_type: 'api' };
    const AI_MESSAGE_MATCH: Document = { role: 'assistant' };

    // A non-admin view is always "filtered" — DAU/MAU and daily-user activity
    // must derive from the scoped conversations, never from the platform-wide
    // users collection (which would leak global active-user counts).
    const hasFilters = !!sourceFilter
      || hasUserFilter
      || channelNames.length > 0
      || agentIds.length > 0
      || !!nonAdminScope;
    const convSourceFilter: Document = {};
    const msgOwnerFilter: Document = {};
    if (sourceFilter === 'web') {
      // Neither legacy Slack rows, Webex rows, nor API rows (client_type-only,
      // no legacy `source`) are "web" — exclude all three so none inflate the
      // Web-only view.
      convSourceFilter.source = { $nin: ['slack', 'webex'] };
      convSourceFilter.client_type = { $nin: ['slack', 'webex', 'api'] };
      msgOwnerFilter['metadata.source'] = 'web';
    } else if (sourceFilter === 'slack') {
      Object.assign(convSourceFilter, SLACK_CONV_MATCH);
      msgOwnerFilter['metadata.source'] = 'slack';
      // Channel filter: check both old slack_meta and new metadata paths
      if (channelNames.length > 0) {
        const names = channelNames.length === 1 ? channelNames[0] : { $in: channelNames };
        const channelMatch = { $or: [
          { 'slack_meta.channel_name': names },
          { 'metadata.channel_name': names },
        ]};
        delete convSourceFilter.$or;
        convSourceFilter.$and = [SLACK_CONV_MATCH, channelMatch];
        // Current Slack messages carry channel_name directly. Applying the
        // same selection here keeps message totals, latency, leaderboards, and
        // the hourly heatmap aligned with conversation-based cards.
        msgOwnerFilter['metadata.channel_name'] = names;
      }
    } else if (sourceFilter === 'webex') {
      Object.assign(convSourceFilter, WEBEX_CONV_MATCH);
      msgOwnerFilter['metadata.source'] = 'webex';
    } else if (sourceFilter === 'api') {
      Object.assign(convSourceFilter, API_CONV_MATCH);
      // Unlike Slack/Webex, a message inside an API conversation is NOT
      // reliably tagged metadata.source:'api' — the message-write route
      // (PUT .../messages/route.ts) defaults an unset caller-supplied
      // metadata.source to 'web', and there's no bot integration for direct
      // API callers that stamps it otherwise. A metadata.source match here
      // would therefore silently match nothing (or worse, misleadingly match
      // ordinary web messages). Scope message-level cards via a
      // conversation_id join instead, the same join already used for
      // owned-agent/feedback scoping elsewhere in this route.
      const apiConversationIds = await (await getCollection('conversations'))
        .distinct('_id', API_CONV_MATCH);
      msgOwnerFilter.conversation_id = { $in: apiConversationIds.length > 0 ? apiConversationIds : [null] };
    }
    if (hasUserFilter) {
      const owners = userEmails.length === 1 ? userEmails[0] : { $in: userEmails };
      convSourceFilter.owner_id = owners;
      msgOwnerFilter.owner_id = owners;
    }

    // Non-admin scope, reused by every query below so the whole payload stays
    // within the caller's visibility:
    //   - `convSourceFilter` / `msgOwnerFilter` get an $or of the caller's
    //     readable Slack channels, their readable Webex spaces, their own
    //     conversations, AND their owned agents (using each collection's
    //     canonical fields).
    //   - `nonAdminChannelNames` / `nonAdminWebexSpaceIds` bound
    //     channel/space-keyed queries (feedback, the Slack/Webex blocks,
    //     available_channels).
    const nonAdminChannelNames = nonAdminScope?.channelNames ?? [];
    const nonAdminOwnedAgents = nonAdminScope?.ownedAgents ?? [];
    const nonAdminWebexSpaceIds = nonAdminScope?.webexSpaceIds ?? [];
    if (nonAdminScope) {
      const { channelNames: scopeChannelNames, ownerEmail, ownedAgents, webexSpaceIds: scopeWebexSpaceIds } = nonAdminScope;
      const convScopeClauses: Record<string, unknown>[] = [];
      const msgScopeClauses: Record<string, unknown>[] = [];
      if (scopeChannelNames.length > 0) {
        const names = scopeChannelNames.length === 1 ? scopeChannelNames[0] : { $in: scopeChannelNames };
        convScopeClauses.push({
          $and: [
            { $or: [{ source: 'slack' }, { client_type: 'slack' }] },
            { $or: [
              { 'slack_meta.channel_name': names },
              { 'metadata.channel_name': names },
            ]},
          ],
        });
        msgScopeClauses.push({
          'metadata.source': 'slack',
          'metadata.channel_name': names,
        });
      }
      if (scopeWebexSpaceIds.length > 0) {
        const spaceIds = scopeWebexSpaceIds.length === 1 ? scopeWebexSpaceIds[0] : { $in: scopeWebexSpaceIds };
        convScopeClauses.push({
          client_type: 'webex',
          'metadata.webex_space_id': spaceIds,
        });
        msgScopeClauses.push({
          'metadata.source': 'webex',
          'metadata.webex_space_id': spaceIds,
        });
      }
      if (ownerEmail) {
        convScopeClauses.push({ owner_id: ownerEmail });
        msgScopeClauses.push({ owner_id: ownerEmail });
      }

      // Owned-agent scope supports both Slack's metadata and the participant /
      // top-level fields used by web and scheduled conversations.
      const ownedAgentIds = ownedAgents.map((a) => a.id);
      const ownedAgentNames = ownedAgents.map((a) => a.name);
      if (ownedAgentIds.length > 0) {
        convScopeClauses.push({
          $or: [
            { 'metadata.thread_owner_agent_id': { $in: ownedAgentIds } },
            { participants: { $elemMatch: { type: 'agent', id: { $in: ownedAgentIds } } } },
            { agent_id: { $in: ownedAgentIds } },
          ],
        });
        msgScopeClauses.push({
          $or: [
            { 'metadata.agent_name': { $in: ownedAgentNames } },
            { 'metadata.agent_id': { $in: ownedAgentIds } },
          ],
        });
      }

      if (convScopeClauses.length === 0 && msgScopeClauses.length === 0) {
        return successResponse({
          range: searchParams.get('range') || '30d',
          days,
          platform_summary: { satisfaction_rate: 0 },
          overview: {
            total_users: 0,
            total_conversations: 0,
            total_messages: 0,
            shared_conversations: 0,
            dau: 0,
            mau: 0,
            conversations_today: 0,
            messages_today: 0,
            avg_messages_per_conversation: 0,
          },
          daily_activity: [],
          top_users: {
            by_conversations: [],
            by_messages: [],
            pagination: {
              by_conversations: {
                page: topConversationsPage,
                limit: TOP_USERS_PAGE_SIZE,
                total: 0,
                total_pages: 0,
              },
              by_messages: {
                page: topMessagesPage,
                limit: TOP_USERS_PAGE_SIZE,
                total: 0,
                total_pages: 0,
              },
            },
          },
          top_agents: [],
          feedback_summary: {
            positive: 0,
            negative: 0,
            total: 0,
            satisfaction_rate: 0,
            by_source: {},
            categories: [],
            daily: [],
          },
          response_time: { avg_ms: 0, min_ms: 0, max_ms: 0, sample_count: 0, samples: [] },
          hourly_heatmap: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
          completed_workflows: {
            total: 0,
            today: 0,
            failed: 0,
            completion_rate: 0,
            avg_steps_per_workflow: 0,
          },
          available_channels: [],
          available_agents: [],
        });
      }

      const convFilter = convScopeClauses.length === 1 ? convScopeClauses[0] : { $or: convScopeClauses };
      const msgFilter = msgScopeClauses.length === 1 ? msgScopeClauses[0] : { $or: msgScopeClauses };
      andInto(convSourceFilter, convFilter);
      andInto(msgOwnerFilter, msgFilter);
    }

    // ── Agent filter (dropdown) ─────────────────────────────────────
    // Narrow the whole payload to specific dynamic agents. Keyed per-collection
    // like the owned-agent scope: conversations carry the agent id (Slack), web
    // messages carry the display name. For non-admins the requested ids are
    // intersected with their owned agents so the filter can never widen scope;
    // admins can select any agent. Resolved to {id,name} so both surfaces match.
    let selectedAgents: OwnedAgent[] = [];
    if (agentIds.length > 0) {
      if (nonAdminScope) {
        const ownedById = new Map(nonAdminOwnedAgents.map((a) => [a.id, a]));
        selectedAgents = agentIds.map((id) => ownedById.get(id)).filter((a): a is OwnedAgent => !!a);
      } else {
        selectedAgents = await getAgentsByIds(agentIds);
      }
      const selIds = selectedAgents.map((a) => a.id);
      const selNames = selectedAgents.map((a) => a.name);
      // A requested-but-unresolvable agent set must match nothing, not fall
      // through to the unfiltered payload.
      andInto(convSourceFilter, {
        $or: [
          // Slack routes are persisted on the conversation metadata.
          { 'metadata.thread_owner_agent_id': { $in: selIds } },
          // Web conversations persist the selected agent as a participant.
          { participants: { $elemMatch: { type: 'agent', id: { $in: selIds } } } },
          // Scheduled/API-created conversations may also carry a top-level id.
          { agent_id: { $in: selIds } },
        ],
      });
      andInto(msgOwnerFilter, {
        $or: [
          { 'metadata.agent_name': { $in: selNames } },
          { 'metadata.agent_id': { $in: selIds } },
        ],
      });
    }

    const users = await getCollection('users');
    const conversations = await getCollection('conversations');
    const messages = await getCollection('messages');
    const workflowRuns = await getCollection('workflow_runs');

    // Bot/service exclusion for the whole "Top Users" section — the block that
    // spans both Top-Users leaderboards, Top Agents, Response Time, and Activity
    // by Hour. Off when the caller opted into "Show bot users". Otherwise drop:
    //   1. Owners whose ID itself is bot-shaped (HUMAN_OWNER_MATCH / the owner_id
    //      pattern rules below).
    //   2. Slack bot/app owners flagged at ingestion (metadata.owner_is_bot) —
    //      e.g. the GitLab app, whose "U…" user ID looks human. Their owner_ids
    //      are collected here and excluded by value.
    // The Overview cards and activity charts ABOVE the section keep using the
    // unfiltered convSourceFilter/msgOwnerFilter, so the toggle governs only the
    // Top Users section.
    const sectionConvMatch: Document = { ...convSourceFilter };
    const sectionMsgMatch: Document = { ...msgOwnerFilter };
    const needsHumanOwnerFilter = (
      includesSection('top_users')
      || includesSection('top_agents')
      || includesSection('response_time')
      || includesSection('hourly_heatmap')
    );
    if (!includeBots && needsHumanOwnerFilter) {
      const botOwnerIds = await getBotOwnerIds(conversations);
      // Post-group $match for the leaderboards, which group on owner_id → _id.
      const humanOwnerMatch = botOwnerIds.length > 0
        ? { $and: [HUMAN_OWNER_MATCH, { _id: { $nin: botOwnerIds } }] }
        : HUMAN_OWNER_MATCH;
      topUserOwnerMatch = [{ $match: humanOwnerMatch }];
      // Row-level exclusion for the section's non-grouped aggregations (Top
      // Agents, Response Time, Activity by Hour), which filter documents before
      // grouping. Same rules as HUMAN_OWNER_MATCH but keyed on the owner_id
      // field, plus the ingestion-flagged Slack bot/app owners. Documents with
      // no owner_id (legacy rows) are kept — $nin/$not treat a missing field as
      // a non-match, so only genuine bot owners are dropped.
      const ownerFieldExclusion: Record<string, unknown> = {
        $and: [
          { owner_id: { $nin: BOT_OWNER_EXACT } },
          { owner_id: { $not: /^B[A-Z0-9]{6,}$/ } },
          { owner_id: { $not: /^service-account-/ } },
          ...(botOwnerIds.length > 0 ? [{ owner_id: { $nin: botOwnerIds } }] : []),
        ],
      };
      andInto(sectionConvMatch, ownerFieldExclusion);
      andInto(sectionMsgMatch, ownerFieldExclusion);
    }

    // ── workflow_runs scope ─────────────────────────────────────────
    // The Completed Workflows metric reads the real `workflow_runs` collection
    // (the workflow engine), NOT finished chats. Runs are owner-keyed by JWT
    // sub in `owner_subject.id`, not by email, so this filter is built
    // separately from msgOwnerFilter/convSourceFilter:
    //   - source=slack   → workflows are web-only; match nothing.
    //   - non-admin      → only the caller's own runs (owner_subject.id = sub).
    //   - admin + user=  → resolve the requested emails to Keycloak subs.
    //   - admin, no user → all runs.
    let workflowRunFilter: Document | null = null;
    if (includesSection('completed_workflows')) {
      workflowRunFilter = {};
      if (sourceFilter === 'slack') {
        workflowRunFilter = null; // web-only concept; skip the queries entirely
      } else if (nonAdminScope) {
        const includesCaller = !hasUserFilter || userEmails.some(
          (email) => email.toLowerCase() === nonAdminScope.ownerEmail.toLowerCase(),
        );
        workflowRunFilter = includesCaller && nonAdminScope.sub
          ? { 'owner_subject.type': 'user', 'owner_subject.id': nonAdminScope.sub }
          : null;
      } else if (hasUserFilter) {
        const owners = userEmails.length > 0
          ? await users
              .find(
                { email: { $in: userEmails } },
                { projection: { keycloak_sub: 1, 'metadata.keycloak_sub': 1 } },
              )
              .toArray()
          : [];
        const subs = [
          ...new Set(
            owners
              .map((u) => u.keycloak_sub || u.metadata?.keycloak_sub)
              .filter((s): s is string => typeof s === 'string' && s.length > 0),
          ),
        ];
        workflowRunFilter = subs.length > 0
          ? { 'owner_subject.type': 'user', 'owner_subject.id': { $in: subs } }
          : null; // requested users have no resolvable sub → match nothing
      }
      if (workflowRunFilter && agentIds.length > 0) {
        // A workflow is attributable to every agent used by one of its steps.
        // Keep an explicitly requested but unresolved set fail-closed via $in: [].
        andInto(workflowRunFilter, {
          'steps.agent_id': { $in: selectedAgents.map((agent) => agent.id) },
        });
      }
    }

    const now = new Date();
    // "Today"/DAU and "This Month"/MAU are rolling windows (last 24h / last
    // 30d from now), not calendar-aligned ones — a calendar-aligned window
    // (midnight-to-now, 1st-of-month-to-now) would contradict the rolling
    // windows used elsewhere on the dashboard as the day/month progresses
    // (e.g. MAU showing all of a prior calendar month on the 1st of a new
    // one, next to a "This Month" card that's rolling).
    const rollingToday = new Date(now.getTime() - DAY_MS);
    const rollingMonth = new Date(now.getTime() - 30 * DAY_MS);
    // A shorter selected window must still narrow them. For example, the 1h
    // preset must not quietly show all activity from the last 24h.
    const todayRangeStart = new Date(Math.max(rollingToday.getTime(), rangeStart.getTime()));
    const monthRangeStart = new Date(Math.max(rollingMonth.getTime(), rangeStart.getTime()));

    // ═══════════════════════════════════════════════════════════════
    // OVERVIEW STATS (parallel queries for speed)
    // ═══════════════════════════════════════════════════════════════
    let totalUsers = 0;
    let totalConversations = 0;
    let totalMessages = 0;
    let dau = 0;
    let mau = 0;
    let conversationsToday = 0;
    let messagesToday = 0;
    let sharedConversations = 0;

    if (includesSection('overview')) {
      [
        totalUsers,
        totalConversations,
        totalMessages,
        dau,
        mau,
        conversationsToday,
        messagesToday,
        sharedConversations,
      ] = await Promise.all([
        // Total users is range-aware like the conversation and message totals.
        // Any dimension filter must derive it from matching conversations;
        // otherwise agent/source/channel selections would leave this card at
        // the platform-wide users count. Unfiltered admins retain the existing
        // last-login activity source.
        nonAdminScope || hasFilters
          ? conversations.aggregate([
              { $match: { updated_at: rangeDateMatch, ...convSourceFilter } },
              { $group: { _id: '$owner_id' } },
              { $count: 'total' },
            ]).toArray().then((r) => r[0]?.total || 0)
          : users.countDocuments({ last_login: rangeDateMatch }),
        // Scoped to the selected date range (rangeStart), matching daily_activity
        // and every other range-aware metric below — previously these were
        // always lifetime totals regardless of the selected range.
        conversations.countDocuments({ created_at: rangeDateMatch, ...convSourceFilter }),
        // Count only assistant rows (messages sent by the AI platform).
        // msgOwnerFilter also carries metadata.source when explicitly filtered;
        // without a source filter, assistant rows from every source are counted.
        messages.countDocuments({ created_at: rangeDateMatch, ...AI_MESSAGE_MATCH, ...msgOwnerFilter }),
        // DAU/MAU: derive from conversations when filters are applied, otherwise from users
        hasFilters
          ? conversations.aggregate([
              { $match: { updated_at: { $gte: todayRangeStart, $lte: rangeEnd }, ...convSourceFilter } },
              { $group: { _id: '$owner_id' } },
              { $count: 'total' },
            ]).toArray().then((r) => r[0]?.total || 0)
          : users.countDocuments({ last_login: { $gte: todayRangeStart, $lte: rangeEnd } }),
        hasFilters
          ? conversations.aggregate([
              { $match: { updated_at: { $gte: monthRangeStart, $lte: rangeEnd }, ...convSourceFilter } },
              { $group: { _id: '$owner_id' } },
              { $count: 'total' },
            ]).toArray().then((r) => r[0]?.total || 0)
          : users.countDocuments({ last_login: { $gte: monthRangeStart, $lte: rangeEnd } }),
        conversations.countDocuments({ created_at: { $gte: todayRangeStart, $lte: rangeEnd }, ...convSourceFilter }),
        messages.countDocuments({ created_at: { $gte: todayRangeStart, $lte: rangeEnd }, ...AI_MESSAGE_MATCH, ...msgOwnerFilter }),
        // `andInto` rather than spreading a literal `$or` — the non-admin scope
        // can itself be an `$or`, which a spread would clobber (leaking shared
        // conversation counts outside the caller's scope).
        conversations.countDocuments(
          (() => {
            const sharedFilter: Record<string, unknown> = {
              created_at: rangeDateMatch,
              ...convSourceFilter,
            };
            andInto(sharedFilter, {
              $or: [
                { 'sharing.shared_with.0': { $exists: true } },
                { 'sharing.shared_with_teams.0': { $exists: true } },
                { 'sharing.share_link_enabled': true },
              ],
            });
            return sharedFilter;
          })()
        ),
      ]);
    }

    // ═══════════════════════════════════════════════════════════════
    // PARALLEL BATCH — all independent aggregations in one shot
    // ═══════════════════════════════════════════════════════════════
    const includeFeedbackSection = includesSection('feedback');
    const feedbackColl = includeFeedbackSection ? await getCollection('feedback') : null;
    const fbFilter: Document = { created_at: rangeDateMatch };

    if (includeFeedbackSection) {
      if (sourceFilter === 'web') fbFilter.source = 'web';
      else if (sourceFilter === 'slack') {
        fbFilter.source = 'slack';
        if (channelNames.length === 1) {
          fbFilter.channel_name = channelNames[0];
        } else if (channelNames.length > 1) {
          fbFilter.channel_name = { $in: channelNames };
        }
      }
      if (hasUserFilter) {
        fbFilter.user_email = userEmails.length === 1 ? userEmails[0] : { $in: userEmails };
      }

      // Non-admin: feedback is keyed by channel_name (slack) / user_email (web),
      // so scope it directly rather than via the conversation-shaped scope filter.
      // Owned agents add a third clause: feedback rows have no agent field, so we
      // match by the conversation_ids routed to those agents (both surfaces).
      if (nonAdminScope) {
        const fbScope: Record<string, unknown>[] = [];
        if (nonAdminChannelNames.length > 0) {
          fbScope.push({
            source: 'slack',
            channel_name: nonAdminChannelNames.length === 1
              ? nonAdminChannelNames[0]
              : { $in: nonAdminChannelNames },
          });
        }
        if (nonAdminScope.ownerEmail) fbScope.push({ user_email: nonAdminScope.ownerEmail });
        if (nonAdminOwnedAgents.length > 0) {
          const { ids: ownedConvIds } = await getOwnedAgentConversationIds(nonAdminOwnedAgents);
          if (ownedConvIds.length > 0) {
            fbScope.push({ conversation_id: { $in: ownedConvIds } });
          }
        }
        // Fail-closed: if the caller resolves to no feedback-bearing scope (e.g.
        // owns agents that have produced no conversations, and has no channels or
        // own email), match nothing rather than leaking unscoped feedback.
        if (fbScope.length === 0) fbScope.push({ _id: null });
        andInto(fbFilter, fbScope.length === 1 ? fbScope[0] : { $or: fbScope });
      }

      // Agent-filter the feedback summary the same way: feedback carries no agent
      // field, so match the conversation_ids routed to the selected agents. An
      // empty result must match nothing (the filter was explicitly requested).
      if (agentIds.length > 0) {
        const { ids: selectedConvIds } = await getOwnedAgentConversationIds(selectedAgents);
        andInto(fbFilter, { conversation_id: selectedConvIds.length > 0 ? { $in: selectedConvIds } : { $in: [null] } });
      }
    }

    const [
      dailyUserActivity,
      dailyConvActivity,
      dailyMsgActivity,
      rawTopByConvs,
      rawTopByMsgs,
      rawTopByConvsTotal,
      rawTopByMsgsTotal,
      topAgents,
      fbOverall,
      fbBySource,
      fbCategories,
      fbDaily,
      latencyAgg,
      latencyDaily,
      workflowRunAgg,
      completedToday,
      hourlyActivity,
      availableChannelsResult,
    ] = await Promise.all([
      // Daily active users
      includesSection('activity')
        ? hasFilters
          ? conversations.aggregate([
              { $match: { updated_at: rangeDateMatch, ...convSourceFilter } },
              { $group: { _id: { date: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$updated_at' } }, user: '$owner_id' } } },
              { $group: { _id: '$_id.date', active_users: { $sum: 1 } } },
            ]).toArray()
          : users.aggregate([
              { $match: { last_login: rangeDateMatch } },
              { $group: { _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$last_login' } }, active_users: { $sum: 1 } } },
            ]).toArray()
        : Promise.resolve([]),

      // Daily conversations
      includesSection('activity')
        ? conversations.aggregate([
            { $match: { created_at: rangeDateMatch, ...convSourceFilter } },
            { $group: { _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } }, conversations: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Daily AI messages. Human prompts remain persisted but are excluded by
      // the assistant-role invariant in AI_MESSAGE_MATCH.
      includesSection('activity')
        ? messages.aggregate([
            { $match: { created_at: rangeDateMatch, ...AI_MESSAGE_MATCH, ...msgOwnerFilter } },
            { $group: { _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } }, messages: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Top users by conversations. Bots/service accounts are dropped via
      // HUMAN_OWNER_MATCH unless the caller passed include_bots=true.
      includesSection('top_users')
        ? conversations.aggregate([
            { $match: { created_at: rangeDateMatch, ...convSourceFilter } },
            { $group: { _id: '$owner_id', count: { $sum: 1 } } },
            VALID_TOP_USER_OWNER_STAGE,
            ...topUserOwnerMatch,
            { $sort: { count: -1, _id: 1 } },
            { $skip: (topConversationsPage - 1) * TOP_USERS_PAGE_SIZE },
            { $limit: TOP_USERS_PAGE_SIZE },
          ]).toArray()
        : Promise.resolve([]),

      // Top users by AI messages ($lookup for legacy owner_id). Same bot handling.
      includesSection('top_users')
        ? messages.aggregate([
            { $match: { created_at: rangeDateMatch, ...AI_MESSAGE_MATCH, ...msgOwnerFilter } },
            { $lookup: { from: 'conversations', localField: 'conversation_id', foreignField: '_id', as: '_conv' } },
            { $addFields: { _owner: { $ifNull: ['$owner_id', { $arrayElemAt: ['$_conv.owner_id', 0] }] } } },
            { $match: { _owner: { $ne: null } } },
            { $group: { _id: '$_owner', count: { $sum: 1 } } },
            VALID_TOP_USER_OWNER_STAGE,
            ...topUserOwnerMatch,
            { $sort: { count: -1, _id: 1 } },
            { $skip: (topMessagesPage - 1) * TOP_USERS_PAGE_SIZE },
            { $limit: TOP_USERS_PAGE_SIZE },
          ]).toArray()
        : Promise.resolve([]),

      // Separate count pipelines keep pagination compatible with DocumentDB,
      // which does not support the $facet approach commonly used to return
      // rows and totals in one aggregation.
      includesSection('top_users')
        ? conversations.aggregate([
            { $match: { created_at: rangeDateMatch, ...convSourceFilter } },
            { $group: { _id: '$owner_id' } },
            VALID_TOP_USER_OWNER_STAGE,
            ...topUserOwnerMatch,
            { $count: 'total' },
          ]).toArray()
        : Promise.resolve([]),

      includesSection('top_users')
        ? messages.aggregate([
            { $match: { created_at: rangeDateMatch, ...AI_MESSAGE_MATCH, ...msgOwnerFilter } },
            { $lookup: { from: 'conversations', localField: 'conversation_id', foreignField: '_id', as: '_conv' } },
            { $addFields: { _owner: { $ifNull: ['$owner_id', { $arrayElemAt: ['$_conv.owner_id', 0] }] } } },
            { $match: { _owner: { $ne: null } } },
            { $group: { _id: '$_owner' } },
            VALID_TOP_USER_OWNER_STAGE,
            ...topUserOwnerMatch,
            { $count: 'total' },
          ]).toArray()
        : Promise.resolve([]),

      // Top agents — dynamic-agent usage across BOTH surfaces, since each records
      // the routed agent in a different place:
      //   • Slack routes per-conversation → conversations.metadata.thread_owner_agent_id
      //     (e.g. "agent-hello-agent")
      //   • Web routes per-message        → messages.metadata.agent_name
      //     (e.g. "Hello Agent")
      // We count DISTINCT conversations per agent on each side (comparable units),
      // humanize both to a common display label, and merge by that label below.
      // Exclude only empty sentinels ('', null, 'unknown'); the "Default" agent
      // (id 'default') is a real configured dynamic_agent, so it counts.
      includesSection('top_agents')
        ? Promise.all([
            conversations.aggregate([
              { $match: { created_at: rangeDateMatch, 'metadata.thread_owner_agent_id': { $nin: [null, '', 'unknown'] }, ...sectionConvMatch } },
              { $group: { _id: '$metadata.thread_owner_agent_id', count: { $sum: 1 } } },
            ]).toArray(),
            // Count DISTINCT conversations per agent via a two-stage $group
            // (group by agent+conversation, then tally per agent). This avoids
            // $project/$size — DocumentDB supports $group/$sum but not all
            // aggregation expression operators — mirroring the pattern used
            // elsewhere in this route.
            //
            // Slack messages also carry metadata.agent_name now, but Slack agent
            // usage is counted from conversations.thread_owner_agent_id above — so
            // the messages side must EXCLUDE Slack to avoid double-counting. When
            // the caller explicitly filters source=slack there is no web side at
            // all, so skip this aggregation entirely.
            sourceFilter === 'slack'
              ? Promise.resolve([] as { _id: string; count: number }[])
              : messages.aggregate([
                  { $match: { ...AI_MESSAGE_MATCH, 'metadata.source': { $ne: 'slack' }, 'metadata.agent_name': { $nin: [null, '', 'unknown'] }, created_at: rangeDateMatch, ...sectionMsgMatch } },
                  { $group: { _id: { agent: '$metadata.agent_name', conv: '$conversation_id' } } },
                  { $group: { _id: '$_id.agent', count: { $sum: 1 } } },
                ]).toArray(),
          ]).then(([slackAgents, webAgents]) => {
            const byLabel = new Map<string, number>();
            for (const row of [...slackAgents, ...webAgents] as Array<{ _id: string; count: number }>) {
              const label = humanizeAgentName(String(row._id));
              byLabel.set(label, (byLabel.get(label) ?? 0) + row.count);
            }
            return [...byLabel.entries()]
              .map(([label, count]) => ({ _id: label, count }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 10);
          })
        : Promise.resolve([]),

      // Feedback: overall counts
      includeFeedbackSection
        ? feedbackColl!.aggregate([
            { $match: fbFilter },
            { $group: { _id: '$rating', count: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Feedback: by source
      includeFeedbackSection
        ? feedbackColl!.aggregate([
            { $match: fbFilter },
            { $group: { _id: { source: '$source', rating: '$rating' }, count: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Feedback: negative categories
      includeFeedbackSection
        ? feedbackColl!.aggregate([
            { $match: { ...fbFilter, rating: 'negative', value: { $nin: ['thumbs_down'] } } },
            { $group: { _id: '$value', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ]).toArray()
        : Promise.resolve([]),

      // Feedback: daily trend
      includeFeedbackSection
        ? feedbackColl!.aggregate([
            { $match: fbFilter },
            { $group: { _id: { date: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } }, rating: '$rating' }, count: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Response latency (overall)
      includesSection('response_time')
        ? messages.aggregate([
            { $match: { ...AI_MESSAGE_MATCH, 'metadata.latency_ms': { $exists: true, $gt: 0 }, created_at: rangeDateMatch, ...sectionMsgMatch } },
            { $group: { _id: null, avg_latency: { $avg: '$metadata.latency_ms' }, min_latency: { $min: '$metadata.latency_ms' }, max_latency: { $max: '$metadata.latency_ms' }, count: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Latency trend, bucketed at the range's granularity (minute/hour/day)
      // so the x-axis scales with the selected window: per-minute for ≤2h,
      // per-hour for ≤1d, per-day beyond. Each bucket carries the MEAN latency
      // of its messages; the UI plots one point per bucket and draws the
      // average line client-side. Same filter as the overall latency stat.
      includesSection('response_time')
        ? messages.aggregate([
            { $match: { ...AI_MESSAGE_MATCH, 'metadata.latency_ms': { $exists: true, $gt: 0 }, created_at: rangeDateMatch, ...sectionMsgMatch } },
            { $group: { _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } }, avg_latency: { $avg: '$metadata.latency_ms' } } },
          ]).toArray()
        : Promise.resolve([]),

      // Completed Workflows metric — real workflow-engine runs (workflow_runs
      // collection), NOT finished chats. A "workflow" is one document in
      // workflow_runs; "completed"/"failed" come from its `status`. Range is
      // keyed on `started_at` (the only always-present timestamp). Returns
      // total runs, completed, failed (failed+cancelled), and — over completed
      // runs only — the step count needed for the avg-steps card.
      // `workflowRunFilter` is null when this scope produces no runs (Slack-only
      // view, or a user filter that resolves to no subject), so the metric is 0.
      includesSection('completed_workflows') && workflowRunFilter
        ? workflowRuns.aggregate([
            { $match: { started_at: rangeDateMatch, ...workflowRunFilter } },
            { $group: {
              _id: null,
              total_runs: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'cancelled']] }, 1, 0] } },
              completed_steps: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $size: { $ifNull: ['$steps', []] } }, 0] } },
            } },
          ]).toArray()
        : Promise.resolve([]),

      // Completed workflows today — runs that reached `completed` today.
      includesSection('completed_workflows') && workflowRunFilter
        ? workflowRuns.countDocuments({ status: 'completed', completed_at: { $gte: todayRangeStart, $lte: rangeEnd }, ...workflowRunFilter })
        : Promise.resolve(0),

      // Hourly AI-message heatmap, combined with the section's owner filters.
      includesSection('hourly_heatmap')
        ? messages.aggregate([
            { $match: { created_at: rangeDateMatch, ...AI_MESSAGE_MATCH, ...sectionMsgMatch } },
            { $addFields: { _ts: { $toDate: '$created_at' } } },
            { $group: { _id: { $hour: '$_ts' }, count: { $sum: 1 } } },
          ]).toArray()
        : Promise.resolve([]),

      // Available channel names (both schema variants). Non-admins get exactly
      // their readable channels (resolved after this batch) — a platform-wide
      // distinct would enumerate every channel name, so skip it for them.
      !includesSection('filters')
        ? Promise.resolve([[], []] as [string[], string[]])
        : nonAdminScope
        ? Promise.resolve([[], []] as [string[], string[]])
        : Promise.all([
            conversations.distinct('slack_meta.channel_name', { source: 'slack', 'slack_meta.channel_name': { $ne: null } }),
            conversations.distinct('metadata.channel_name', { client_type: 'slack', 'metadata.channel_name': { $ne: null } }),
          ]),
    ]);

    // ── Post-process daily activity ─────────────────────────────────
    const msgMap = new Map<string, number>();
    for (const d of dailyMsgActivity) msgMap.set(d._id, (msgMap.get(d._id) || 0) + d.messages);

    const userMap = new Map(dailyUserActivity.map((d) => [d._id, d.active_users]));
    const convMap = new Map(dailyConvActivity.map((d) => [d._id, d.conversations]));

    const dailyActivity = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => ({
      date: dateKey,
      active_users: userMap.get(dateKey) || 0,
      conversations: convMap.get(dateKey) || 0,
      messages: msgMap.get(dateKey) || 0,
    }));

    // ── Top users: resolve display names ───────────────────────────
    const topOwnerIds = [...new Set([
      ...rawTopByConvs.map((u) => u._id),
      ...rawTopByMsgs.map((u) => u._id),
    ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];

    const userDocs = topOwnerIds.length > 0
      ? await users.find(
          { $or: [{ email: { $in: topOwnerIds } }, { slack_user_id: { $in: topOwnerIds } }] },
          { projection: { email: 1, name: 1, slack_user_id: 1 } },
        ).toArray()
      : [];

    const nameByOwner = new Map<string, string>();
    // Owners with a `users` row are linked (federated) identities — a known
    // person regardless of the surface they chat from.
    const linkedOwnerIds = new Set<string>();
    for (const u of userDocs) {
      if (u.email) { nameByOwner.set(u.email, u.name || u.email); linkedOwnerIds.add(u.email); }
      if (u.slack_user_id) { nameByOwner.set(u.slack_user_id, u.name || u.email); linkedOwnerIds.add(u.slack_user_id); }
    }

    // Bot/app owners (e.g. GitLab) aren't rows in `users`. The Slack bot flags
    // their threads (metadata.owner_is_bot) and persists the app's display name
    // (metadata.owner_display_name). Query both over the top owners so we can
    // (a) label the "U…" id with "GitLab" and (b) classify the row as a bot.
    // Users-collection names win, so a real user is never shadowed by a bot label.
    const botOwnerIdSet = new Set<string>();
    if (topOwnerIds.length > 0) {
      const botOwnerDocs = await conversations
        .find(
          { owner_id: { $in: topOwnerIds }, 'metadata.owner_is_bot': true },
          { projection: { owner_id: 1, 'metadata.owner_display_name': 1 } },
        )
        .toArray();
      for (const d of botOwnerDocs) {
        if (typeof d.owner_id !== 'string') continue;
        botOwnerIdSet.add(d.owner_id);
        const label = d.metadata?.owner_display_name;
        if (typeof label === 'string' && label && !nameByOwner.has(d.owner_id)) {
          nameByOwner.set(d.owner_id, label);
        }
      }
    }

    // Classify each leaderboard owner so the UI can badge it. Order matters:
    //   • service_account — a platform API caller (service-account-* owner id).
    //     NOT a Slack bot — it's the SA identity behind automated API access.
    //   • slack_bot        — a Slack bot/app poster: flagged owner_is_bot, or an
    //     ID-shaped Slack bot id (B-prefixed / USLACKBOT sentinel).
    //   • linked           — a federated person: has a `users` row, or a web
    //     email owner.
    //   • unlinked_slack    — a raw Slack user id ("U…"/"W…") with no `users`
    //     row: a real person who never linked their account.
    const classifyOwner = (id: string): OwnerType => {
      if (id.startsWith('service-account-')) return 'service_account';
      if (
        botOwnerIdSet.has(id) ||
        BOT_OWNER_EXACT.includes(id) ||
        /^B[A-Z0-9]{6,}$/.test(id)
      ) return 'slack_bot';
      if (linkedOwnerIds.has(id) || id.includes('@')) return 'linked';
      return 'unlinked_slack';
    };

    // Legacy activity can have a missing owner_id. Wider windows (notably 90d)
    // are more likely to include those rows, so discard them before calling
    // string-only identity helpers such as classifyOwner().
    const enrichTopUsers = (raw: typeof rawTopByConvs) =>
      raw.flatMap((u) => {
        if (typeof u._id !== 'string' || !u._id.trim()) return [];
        return [{
          _id: u._id,
          count: u.count,
          name: nameByOwner.get(u._id) || u._id,
          owner_type: classifyOwner(u._id),
        }];
      });

    const topUsersByConversations = enrichTopUsers(rawTopByConvs);
    const topUsersByMessages = enrichTopUsers(rawTopByMsgs);
    const topUsersByConversationsTotal = Number(rawTopByConvsTotal[0]?.total ?? 0);
    const topUsersByMessagesTotal = Number(rawTopByMsgsTotal[0]?.total ?? 0);

    // ── Post-process feedback ───────────────────────────────────────
    const fbMap = new Map(fbOverall.map((f) => [f._id, f.count]));
    const positive = fbMap.get('positive') || 0;
    const negative = fbMap.get('negative') || 0;
    const total = positive + negative;

    // Build by_source breakdown
    const bySource: Record<string, { positive: number; negative: number }> = {};
    for (const row of fbBySource) {
      const src = row._id.source || 'unknown';
      if (!bySource[src]) bySource[src] = { positive: 0, negative: 0 };
      bySource[src][row._id.rating as 'positive' | 'negative'] = row.count;
    }

    // Build categories array
    const categories = fbCategories.map((c) => ({
      category: c._id || 'unknown',
      count: c.count,
    }));

    // Build daily trend
    const dailyFbMap = new Map<string, { positive: number; negative: number }>();
    for (const row of fbDaily) {
      const date = row._id.date;
      if (!dailyFbMap.has(date)) dailyFbMap.set(date, { positive: 0, negative: 0 });
      dailyFbMap.get(date)![row._id.rating as 'positive' | 'negative'] = row.count;
    }
    const dailyFeedback = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => {
      const entry = dailyFbMap.get(dateKey);
      return {
        date: dateKey,
        positive: entry?.positive || 0,
        negative: entry?.negative || 0,
      };
    });

    const feedbackSummary = {
      positive,
      negative,
      total,
      satisfaction_rate: total > 0 ? Math.round((positive / total) * 1000) / 10 : 0,
      by_source: bySource,
      categories,
      daily: dailyFeedback,
    };

    // ── Post-process latency / workflows / heatmap ─────────────────
    const avgMsgsPerConv = totalConversations > 0
      ? Math.round((totalMessages / totalConversations) * 10) / 10
      : 0;

    // Latency trend points, oldest→newest, one per non-empty bucket. `ts` is
    // the bucket key ($dateToString format), which formatBucketLabel renders
    // as a date for day buckets ("Jul 20") and a time for hour/minute buckets
    // ("10:00 AM"). Empty buckets are omitted rather than plotted as 0ms so the
    // client-side average line reflects only real samples. Ordered by bucket
    // key, which is lexicographically chronological for every granularity.
    const latencyByBucket = new Map<string, number>(
      latencyDaily.map((s) => [String(s._id), Math.round(s.avg_latency)]),
    );
    const latencySamples = generateBucketKeys(rangeEnd, bucketCount, bucketUnit)
      .filter((key) => latencyByBucket.has(key))
      .map((key) => ({ ts: key, latency_ms: latencyByBucket.get(key)! }));

    const responseTime = latencyAgg[0]
      ? {
          avg_ms: Math.round(latencyAgg[0].avg_latency),
          min_ms: latencyAgg[0].min_latency,
          max_ms: latencyAgg[0].max_latency,
          sample_count: latencyAgg[0].count,
          samples: latencySamples,
        }
      : { avg_ms: 0, min_ms: 0, max_ms: 0, sample_count: 0, samples: [] };

    // Completed Workflows — derived from workflow_runs (see the aggregation
    // above). completion_rate = completed / total runs; avg_steps is over
    // completed runs only.
    const wfRun = workflowRunAgg[0] || { total_runs: 0, completed: 0, failed: 0, completed_steps: 0 };
    const totalRuns = wfRun.total_runs || 0;
    const completedCount = wfRun.completed || 0;
    const completedTodayCount = completedToday || 0;
    const failedCount = wfRun.failed || 0;
    const completionRate = totalRuns > 0
      ? Math.round((completedCount / totalRuns) * 1000) / 10
      : 0;
    const avgStepsCompleted = completedCount > 0
      ? Math.round((wfRun.completed_steps / completedCount) * 10) / 10
      : 0;

    const hourlyMap = new Map<number, number>();
    for (const h of hourlyActivity) hourlyMap.set(h._id, (hourlyMap.get(h._id) || 0) + h.count);

    const hourlyHeatmap = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hourlyMap.get(hour) || 0,
    }));

    // ═══════════════════════════════════════════════════════════════
    // SLACK STATS (from conversations with source:"slack" or client_type:"slack")
    // ═══════════════════════════════════════════════════════════════
    let slack: SlackStats | undefined;
    const skipSlackBlock = !!nonAdminScope && nonAdminChannelNames.length === 0;

    if (includesSection('slack') && sourceFilter !== 'web' && !skipSlackBlock) {
      try {
        // Start with the same conversation filter used by every other card, then
        // constrain it to Slack. This carries source, channel, user, agent, and
        // non-admin scope into all Slack interaction cards without maintaining a
        // second, subtly different filter implementation.
        const slackFilter: Document = { ...SLACK_CONV_MATCH, created_at: rangeDateMatch };
        if (Object.keys(convSourceFilter).length > 0) {
          andInto(slackFilter, convSourceFilter);
        }
        if (nonAdminScope) {
          const readableNames = nonAdminChannelNames.length === 1
            ? nonAdminChannelNames[0]
            : { $in: nonAdminChannelNames };
          andInto(slackFilter, {
            $or: [
              { 'slack_meta.channel_name': readableNames },
              { 'metadata.channel_name': readableNames },
            ],
          });
        }
        const slackHasData = await conversations.countDocuments(SLACK_CONV_MATCH, { limit: 1 });

        if (slackHasData > 0) {
          const platformConfig = await getCollection<ChannelStatsDocument>('platform_config');

          // Helper: coalesce old slack_meta and new metadata fields.
          const userId = { $ifNull: ['$metadata.user_id', '$slack_meta.user_id'] };
          const escalated = { $ifNull: ['$metadata.escalated', '$slack_meta.escalated'] };
          const channelName = { $ifNull: ['$metadata.channel_name', '$slack_meta.channel_name'] };
          const channelId = { $ifNull: ['$metadata.channel_id', '$slack_meta.channel_id'] };

          const channelMappingColl = await getCollection<{
            slack_channel_id?: string;
            channel_name?: string;
            created_at?: string | Date;
            active?: boolean;
          }>('channel_team_mappings');
          const requestedReadableChannels = nonAdminScope
            ? (channelNames.length > 0
                ? nonAdminChannelNames.filter((name) => channelNames.includes(name))
                : nonAdminChannelNames)
            : channelNames;
          const mappingFilter: Document = { slack_channel_id: { $ne: null } };
          if (requestedReadableChannels.length > 0) {
            mappingFilter.channel_name = { $in: requestedReadableChannels };
          } else if (nonAdminScope) {
            // Configuration is channel-scoped and cannot be attributed through
            // the owned-agent/user axes without revealing unreadable channels.
            mappingFilter._id = null;
          }

          const selectedAgentIds = selectedAgents.map((agent) => agent.id);
          const [
            configDoc,
            slackTotal,
            slackUniqueUsers,
            slackDailyAgg,
            slackTopChannels,
            channelMappings,
            selectedAgentRoutes,
          ] = await Promise.all([
            platformConfig.findOne({ _id: 'channel_stats' }),
            conversations.countDocuments(slackFilter),
            conversations.aggregate([
              { $match: slackFilter },
              { $group: { _id: userId } },
              { $count: 'total' },
            ]).toArray(),
            conversations.aggregate([
              { $match: slackFilter },
              {
                $group: {
                  _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } },
                  interactions: { $sum: 1 },
                  unique_users: { $addToSet: userId },
                  escalated: { $sum: { $cond: [escalated, 1, 0] } },
                },
              },
              { $sort: { _id: 1 } },
            ]).toArray(),
            conversations.aggregate([
              { $match: slackFilter },
              { $addFields: { _channelId: channelId, _channelName: channelName } },
              { $match: { _channelId: { $ne: null } } },
              {
                $group: {
                  _id: '$_channelId',
                  name: { $first: '$_channelName' },
                  interactions: { $sum: 1 },
                },
              },
              { $sort: { interactions: -1 } },
              { $limit: 10 },
            ]).toArray(),
            channelMappingColl.find(
              mappingFilter,
              { projection: { slack_channel_id: 1, channel_name: 1, created_at: 1, active: 1 } },
            ).toArray(),
            agentIds.length > 0
              ? getCollection<{ channel_id?: string }>('slack_channel_agent_routes')
                  .then((routes) => routes.find(
                    {
                      agent_id: { $in: selectedAgentIds },
                      enabled: { $ne: false },
                      status: 'active',
                    },
                    { projection: { channel_id: 1 } },
                  ).toArray())
              : Promise.resolve([]),
          ]);

          // Normalize a channel name: strip a leading '#', fall back to null
          // when the "name" is really just the raw id.
          const normalizeChannelName = (name: unknown, id: string): string | null => {
            if (typeof name !== 'string' || !name.trim() || name === id) return null;
            return name.replace(/^#/, '').trim();
          };
          const channelNameById = new Map<string, string>();
          for (const mapping of channelMappings) {
            const clean = normalizeChannelName(mapping.channel_name, mapping.slack_channel_id);
            if (mapping.slack_channel_id && clean) {
              channelNameById.set(mapping.slack_channel_id, clean);
            }
          }

          // Configured Channels is configuration data, not user activity. It is
          // omitted for a user filter; channel, agent, and date filters do apply.
          const selectedAgentChannelIds = new Set(
            selectedAgentRoutes.flatMap((route) => route.channel_id ? [route.channel_id] : []),
          );
          const activeMappings = channelMappings.filter((mapping) => {
            if (mapping.active === false || !mapping.slack_channel_id) return false;
            if (agentIds.length > 0 && !selectedAgentChannelIds.has(mapping.slack_channel_id)) return false;
            const created = mapping.created_at ? new Date(mapping.created_at) : null;
            return !created || Number.isNaN(created.getTime()) || created <= rangeEnd;
          });
          const configuredChannelsTotal = new Set(
            activeMappings.map((mapping) => mapping.slack_channel_id),
          ).size;

          const configuredBeforeRange = new Set<string>();
          const configuredByBucket = new Map<string, Set<string>>();
          for (const mapping of activeMappings) {
            const created = mapping.created_at ? new Date(mapping.created_at) : null;
            if (!created || Number.isNaN(created.getTime()) || created < rangeStart) {
              configuredBeforeRange.add(mapping.slack_channel_id);
              continue;
            }
            const key = bucketDateKey(floorToBucket(created, bucketUnit), bucketUnit);
            if (!configuredByBucket.has(key)) configuredByBucket.set(key, new Set());
            configuredByBucket.get(key)!.add(mapping.slack_channel_id);
          }
          let runningConfigured = configuredBeforeRange.size;
          const configuredChannelsDaily = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => {
            runningConfigured += configuredByBucket.get(dateKey)?.size ?? 0;
            return { date: dateKey, total: runningConfigured };
          });

          const slackDailyMap = new Map(
            slackDailyAgg.map((day) => [day._id, {
              interactions: day.interactions,
              unique_users: day.unique_users?.length || 0,
              escalated: day.escalated,
            }]),
          );
          const slackDaily = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => {
            const entry = slackDailyMap.get(dateKey);
            return {
              date: dateKey,
              interactions: entry?.interactions || 0,
              unique_users: entry?.unique_users || 0,
              escalated: entry?.escalated || 0,
            };
          });

          slack = {
            channels: configDoc
              ? { total: configDoc.total, qanda_enabled: configDoc.qanda_enabled, alerts_enabled: configDoc.alerts_enabled, ai_enabled: configDoc.ai_enabled }
              : { total: 0, qanda_enabled: 0, alerts_enabled: 0, ai_enabled: 0 },
            ...(!hasUserFilter ? {
              configured_channels: configuredChannelsTotal,
              configured_channels_daily: configuredChannelsDaily,
            } : {}),
            total_interactions: slackTotal,
            unique_users: slackUniqueUsers[0]?.total || 0,
            daily: slackDaily,
            top_channels: slackTopChannels.map((channel) => {
              const id: string = channel._id;
              return {
                channel_name: channelNameById.get(id) || normalizeChannelName(channel.name, id) || id,
                interactions: channel.interactions,
              };
            }),
          };
        }
      } catch (err) {
        // Slack data may not exist yet — silently skip
        console.warn('Slack stats query failed:', err);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // WEBEX STATS (from conversations with client_type:"webex") — mirrors
    // the Slack block above, keyed by space id rather than channel name
    // since Webex conversations/messages carry no space display name.
    // ═══════════════════════════════════════════════════════════════
    let webex: WebexStats | undefined;
    const skipWebexBlock = !!nonAdminScope && nonAdminWebexSpaceIds.length === 0;

    if (includesSection('webex') && sourceFilter !== 'web' && !skipWebexBlock) {
      try {
        // Start with the same conversation filter used by every other card, then
        // constrain it to Webex. This carries source, user, agent, and
        // non-admin scope into all Webex interaction cards without maintaining a
        // second, subtly different filter implementation.
        const webexFilter: Document = { ...WEBEX_CONV_MATCH, created_at: rangeDateMatch };
        if (Object.keys(convSourceFilter).length > 0) {
          andInto(webexFilter, convSourceFilter);
        }
        if (nonAdminScope) {
          const readableSpaceIds = nonAdminWebexSpaceIds.length === 1
            ? nonAdminWebexSpaceIds[0]
            : { $in: nonAdminWebexSpaceIds };
          andInto(webexFilter, { 'metadata.webex_space_id': readableSpaceIds });
        }
        const webexHasData = await conversations.countDocuments(WEBEX_CONV_MATCH, { limit: 1 });

        if (webexHasData > 0) {
          const spaceMappingColl = await getCollection<{
            webex_space_id?: string;
            space_name?: string;
            space_title?: string;
            created_at?: string | Date;
            active?: boolean;
          }>('webex_space_team_mappings');
          const mappingFilter: Document = { webex_space_id: { $ne: null } };
          if (nonAdminScope) {
            // Configuration is space-scoped and cannot be attributed through
            // the owned-agent/user axes without revealing unreadable spaces.
            mappingFilter.webex_space_id = { $in: nonAdminWebexSpaceIds };
          }

          const selectedAgentIds = selectedAgents.map((agent) => agent.id);
          const [
            webexTotal,
            webexUniqueUsers,
            webexDailyAgg,
            webexTopSpaces,
            spaceMappings,
            selectedAgentRoutes,
          ] = await Promise.all([
            conversations.countDocuments(webexFilter),
            conversations.aggregate([
              { $match: webexFilter },
              { $group: { _id: '$owner_id' } },
              { $match: { _id: { $nin: [null, ''] } } },
              { $count: 'total' },
            ]).toArray(),
            conversations.aggregate([
              { $match: webexFilter },
              {
                $group: {
                  _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } },
                  interactions: { $sum: 1 },
                  unique_users: { $addToSet: '$owner_id' },
                },
              },
              { $sort: { _id: 1 } },
            ]).toArray(),
            conversations.aggregate([
              {
                $match: {
                  ...webexFilter,
                  'metadata.webex_space_id': { $ne: null },
                  // 1:1 DMs are not spaces — keep them out of the Top Spaces
                  // ranking (they're still counted in total_interactions/
                  // unique_users above via webexFilter, which applies no
                  // such exclusion).
                  'metadata.webex_is_direct': { $ne: true },
                },
              },
              {
                $group: {
                  _id: '$metadata.webex_space_id',
                  interactions: { $sum: 1 },
                },
              },
              { $sort: { interactions: -1 } },
              { $limit: 10 },
            ]).toArray(),
            spaceMappingColl.find(
              mappingFilter,
              { projection: { webex_space_id: 1, space_name: 1, space_title: 1, created_at: 1, active: 1 } },
            ).toArray(),
            agentIds.length > 0
              ? getCollection<{ space_id?: string }>('webex_space_agent_routes')
                  .then((routes) => routes.find(
                    {
                      agent_id: { $in: selectedAgentIds },
                      enabled: { $ne: false },
                      status: 'active',
                    },
                    { projection: { space_id: 1 } },
                  ).toArray())
              : Promise.resolve([]),
          ]);

          // Normalize a space name: fall back to null when the "name" is
          // really just the raw id (unnamed/never-renamed mapping).
          const normalizeSpaceName = (name: unknown, id: string): string | null => {
            if (typeof name !== 'string' || !name.trim() || name === id) return null;
            return name.trim();
          };
          const spaceNameById = new Map<string, string>();
          for (const mapping of spaceMappings) {
            const clean = normalizeSpaceName(mapping.space_name ?? mapping.space_title, mapping.webex_space_id ?? '');
            if (mapping.webex_space_id && clean) {
              spaceNameById.set(mapping.webex_space_id, clean);
            }
          }

          // Configured Spaces is configuration data, not user activity. It is
          // omitted for a user filter; agent and date filters do apply.
          const selectedAgentSpaceIds = new Set(
            selectedAgentRoutes.flatMap((route) => route.space_id ? [route.space_id] : []),
          );
          const activeMappings = spaceMappings.filter((mapping) => {
            if (mapping.active === false || !mapping.webex_space_id) return false;
            if (agentIds.length > 0 && !selectedAgentSpaceIds.has(mapping.webex_space_id)) return false;
            const created = mapping.created_at ? new Date(mapping.created_at) : null;
            return !created || Number.isNaN(created.getTime()) || created <= rangeEnd;
          });
          const configuredSpacesTotal = new Set(
            activeMappings.map((mapping) => mapping.webex_space_id),
          ).size;

          const configuredBeforeRange = new Set<string>();
          const configuredByBucket = new Map<string, Set<string>>();
          for (const mapping of activeMappings) {
            const created = mapping.created_at ? new Date(mapping.created_at) : null;
            if (!created || Number.isNaN(created.getTime()) || created < rangeStart) {
              configuredBeforeRange.add(mapping.webex_space_id as string);
              continue;
            }
            const key = bucketDateKey(floorToBucket(created, bucketUnit), bucketUnit);
            if (!configuredByBucket.has(key)) configuredByBucket.set(key, new Set());
            configuredByBucket.get(key)!.add(mapping.webex_space_id as string);
          }
          let runningConfiguredSpaces = configuredBeforeRange.size;
          const configuredSpacesDaily = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => {
            runningConfiguredSpaces += configuredByBucket.get(dateKey)?.size ?? 0;
            return { date: dateKey, total: runningConfiguredSpaces };
          });

          const webexDailyMap = new Map(
            webexDailyAgg.map((day) => [day._id, {
              interactions: day.interactions,
              unique_users: day.unique_users?.length || 0,
            }]),
          );
          const webexDaily = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => {
            const entry = webexDailyMap.get(dateKey);
            return {
              date: dateKey,
              interactions: entry?.interactions || 0,
              unique_users: entry?.unique_users || 0,
            };
          });

          webex = {
            ...(!hasUserFilter ? {
              configured_spaces: configuredSpacesTotal,
              configured_spaces_daily: configuredSpacesDaily,
            } : {}),
            total_interactions: webexTotal,
            unique_users: webexUniqueUsers[0]?.total || 0,
            daily: webexDaily,
            top_spaces: webexTopSpaces.map((space) => {
              const id: string = space._id;
              return {
                space_name: spaceNameById.get(id) || id,
                interactions: space.interactions,
              };
            }),
          };
        }
      } catch (err) {
        // Webex data may not exist yet — silently skip
        console.warn('Webex stats query failed:', err);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // API STATS (from conversations with client_type:"api") — mirrors the
    // Slack/Webex blocks above but simpler: a generic API caller has no
    // channel/space concept, so there's no "Configured X" or "Top X"
    // breakdown, just total interactions/unique users/daily activity. Also
    // carries the unrelated, audit-service-backed "Direct MCP Activity" data
    // (mcp_activity below), which is admin-only regardless of whether any
    // api-classified conversations exist.
    // ═══════════════════════════════════════════════════════════════
    let api: ApiStats | undefined;

    if (includesSection('api') && sourceFilter !== 'web') {
      let apiActivity: Pick<ApiStats, 'total_interactions' | 'unique_users' | 'daily'> | null = null;
      try {
        // Start with the same conversation filter used by every other card,
        // then constrain it to API. Non-admins are already scoped by the
        // generic owner_id clause folded into convSourceFilter above (there is
        // no channel/space concept to further restrict by for a direct API
        // caller — see the RBAC note on `mcp_activity` below for the axis that
        // DOES need extra scoping).
        const apiFilter: Document = { ...API_CONV_MATCH, created_at: rangeDateMatch };
        if (Object.keys(convSourceFilter).length > 0) {
          andInto(apiFilter, convSourceFilter);
        }
        const apiHasData = await conversations.countDocuments(API_CONV_MATCH, { limit: 1 });

        if (apiHasData > 0) {
          const [apiTotal, apiUniqueUsers, apiDailyAgg] = await Promise.all([
            conversations.countDocuments(apiFilter),
            conversations.aggregate([
              { $match: apiFilter },
              { $group: { _id: '$owner_id' } },
              { $match: { _id: { $nin: [null, ''] } } },
              { $count: 'total' },
            ]).toArray(),
            conversations.aggregate([
              { $match: apiFilter },
              {
                $group: {
                  _id: { $dateToString: { format: BUCKET_DATE_FORMAT[bucketUnit], date: '$created_at' } },
                  interactions: { $sum: 1 },
                  unique_users: { $addToSet: '$owner_id' },
                },
              },
              { $sort: { _id: 1 } },
            ]).toArray(),
          ]);

          const apiDailyMap = new Map(
            apiDailyAgg.map((day) => [day._id, {
              interactions: day.interactions,
              unique_users: day.unique_users?.length || 0,
            }]),
          );
          const apiDaily = generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((dateKey) => {
            const entry = apiDailyMap.get(dateKey);
            return {
              date: dateKey,
              interactions: entry?.interactions || 0,
              unique_users: entry?.unique_users || 0,
            };
          });

          apiActivity = {
            total_interactions: apiTotal,
            unique_users: apiUniqueUsers[0]?.total || 0,
            daily: apiDaily,
          };
        }
      } catch (err) {
        // API data may not exist yet — silently skip
        console.warn('API stats query failed:', err);
      }

      // ── Direct MCP Activity ─────────────────────────────────────────
      // RBAC: this surfaces real subject_ref identities platform-wide, with
      // no channel/space/owner scoping axis the way Slack/Webex/API Activity
      // above are implicitly scoped — a local-agent-context MCP call is not
      // attributable to any team/channel a non-admin might otherwise be
      // scoped to. Gate strictly on `isFullAdmin` so a non-admin (even one
      // who legitimately sees their own API conversations above) never
      // receives this key.
      const mcpActivity = isFullAdmin ? await fetchMcpActivityStats(rangeStart, rangeEnd) : undefined;

      if (apiActivity || mcpActivity) {
        api = {
          total_interactions: apiActivity?.total_interactions ?? 0,
          unique_users: apiActivity?.unique_users ?? 0,
          daily: apiActivity?.daily ?? generateBucketKeys(rangeEnd, bucketCount, bucketUnit).map((date) => ({
            date,
            interactions: 0,
            unique_users: 0,
          })),
          ...(mcpActivity ? { mcp_activity: mcpActivity } : {}),
        };
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // PLATFORM SUMMARY — respects source/user filters
    // ═══════════════════════════════════════════════════════════════
    const [oldChannels, newChannels] = availableChannelsResult;
    const availableChannels = includesSection('filters')
      ? nonAdminScope
        ? [...new Set(nonAdminChannelNames)]
        : [...new Set([...oldChannels, ...newChannels])]
      : [];

    // Agent filter options: a non-admin sees only the agents they own; a full
    // admin sees every dynamic agent. Shape { id, name } so the UI can label by
    // name while filtering by the stable id.
    const availableAgents = includesSection('filters')
      ? (nonAdminScope ? nonAdminOwnedAgents : await getAllAgents())
          .map((a) => ({ id: a.id, name: a.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    const platformSummary = {
      satisfaction_rate: feedbackSummary.satisfaction_rate || 0,
    };

    return successResponse({
      range: searchParams.get('range') || '30d',
      days,
      ...(includesSection('overview') ? {
        overview: {
          total_users: totalUsers,
          total_conversations: totalConversations,
          total_messages: totalMessages,
          shared_conversations: sharedConversations,
          dau,
          mau,
          conversations_today: conversationsToday,
          messages_today: messagesToday,
          avg_messages_per_conversation: avgMsgsPerConv,
        },
      } : {}),
      ...(includesSection('activity') ? { daily_activity: dailyActivity } : {}),
      ...(includesSection('top_users') ? {
        top_users: {
          by_conversations: topUsersByConversations,
          by_messages: topUsersByMessages,
          pagination: {
            by_conversations: {
              page: topConversationsPage,
              limit: TOP_USERS_PAGE_SIZE,
              total: topUsersByConversationsTotal,
              total_pages: Math.ceil(topUsersByConversationsTotal / TOP_USERS_PAGE_SIZE),
            },
            by_messages: {
              page: topMessagesPage,
              limit: TOP_USERS_PAGE_SIZE,
              total: topUsersByMessagesTotal,
              total_pages: Math.ceil(topUsersByMessagesTotal / TOP_USERS_PAGE_SIZE),
            },
          },
        },
      } : {}),
      ...(includesSection('top_agents') ? { top_agents: topAgents } : {}),
      ...(includeFeedbackSection ? {
        platform_summary: platformSummary,
        feedback_summary: feedbackSummary,
      } : {}),
      ...(includesSection('response_time') ? { response_time: responseTime } : {}),
      ...(includesSection('hourly_heatmap') ? { hourly_heatmap: hourlyHeatmap } : {}),
      ...(includesSection('completed_workflows') ? {
        completed_workflows: {
          total: completedCount,
          today: completedTodayCount,
          failed: failedCount,
          completion_rate: completionRate,
          avg_steps_per_workflow: avgStepsCompleted,
        },
      } : {}),
      ...(slack ? { slack } : {}),
      ...(webex ? { webex } : {}),
      ...(api ? { api } : {}),
      ...(includesSection('filters') ? {
        available_channels: availableChannels.sort(),
        available_agents: availableAgents,
      } : {}),
    });
}

/**
 * Spec 098 US9 — Slack channel discovery for the team-assignment UI.
 *
 * GET /api/admin/slack/available-channels
 *   Returns Slack channels the bot can see, with server-side search + paging
 *   so the picker scales to workspaces with thousands of channels.
 *
 * Query params:
 *   - `q`            — case-insensitive substring filter on channel name.
 *   - `member_only`  — legacy compatibility only; discovery is always
 *                      restricted to channels the bot is a member of.
 *   - `limit`        — page size (default 200, max 500).
 *   - `cursor`       — opaque alphabetical cursor returned in the previous
 *                      response. Empty/absent ⇒ first page.
 *   - `refresh`      — `1` invalidates the in-process cache before serving.
 *
 * Auth: requires read access to the Slack admin surface. Every signed-in
 * member receives this baseline grant so self-service onboarding can discover
 * only channels the bot has already joined; management remains separately
 * protected.
 *
 * Caching strategy:
 *   We pull a snapshot of channels from Slack once per bot token and keep
 *   it in-process for the configured TTL. Filtering, sorting, and paging happen
 *   here on the cached snapshot so the UI can search/scroll instantly without
 *   hammering Slack's rate limits. Admins can force a refresh via `?refresh=1`.
 *
 *   Endpoint selection (fixes #1506): we only use `users.conversations`
 *   (Tier 3, ~50 req/min). It returns ONLY channels the bot is a member of,
 *   which keeps the picker aligned with dispatch behavior and avoids listing
 *   channels where the bot cannot actually operate.
 *
 *   The Slack walk handles HTTP 429 with the `Retry-After` header so a busy
 *   workspace doesn't break discovery.
 *
 * Failure modes:
 *   - SLACK_BOT_TOKEN unset → 503 (UI falls back to manual channel-ID entry).
 *   - Slack API error → 502 with upstream error code.
 *
 * assisted-by Claude Claude-opus-4-7
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getDiscoveryCacheTtlMs } from "@/lib/rbac/discovery-cache-config";
import {
  activeConnectorPublicationRequestsByItemId,
  connectorPublicationRequestView,
  publicationActorFromSession,
} from "@/lib/publication-approval.server";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { configuredSlackChannelsById } from "@/lib/rbac/slack-channel-configured-directory";
import { NextRequest } from "next/server";

interface SlackConversation {
  id: string;
  name?: string;
  is_archived?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  num_members?: number;
}

interface SlackListResponse {
  ok: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

interface NormalizedChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  num_members: number;
}

interface CacheEntry {
  channels: NormalizedChannel[];
  fetched_at: number;
  endpoint: "users.conversations";
}

// Channel lists rarely change between admin actions. The TTL is admin-
// configurable in Admin → Platform Settings → Discovery cache TTL and is
// read live from `platform_config` via getDiscoveryCacheTtlMs(); the
// default is 60 minutes. A value of 0 disables caching entirely (every
// request hits Slack), which is useful when an admin just added the bot
// to a brand-new channel and wants the picker to reflect that without
// clicking "Refresh from Slack now".
// Slack max page size is 999 for users.conversations, but Slack recommends
// <=200 for stability. We pull at 200 internally regardless of the UI page
// size (which is just a slice on top of the cache).
const SLACK_PAGE_SIZE = 200;
// Hard ceiling on how many Slack pages we'll walk: 200 * 50 = 10k channels,
// far more than any sane bot membership.
const MAX_SLACK_PAGES_MEMBER = 50;
// Defensive ceiling on how long we'll sleep waiting for Slack rate limits
// before giving up and 502'ing. Prevents a single request from holding a
// Next.js worker forever.
const MAX_RATE_LIMIT_WAIT_MS = 15_000;
// UI page size caps.
const DEFAULT_UI_LIMIT = 200;
const MAX_UI_LIMIT = 500;

const cache = new Map<string, CacheEntry>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test-only helper. Lets us reset the in-process cache between unit tests so
 * one test's snapshot doesn't bleed into the next. Not exported in production
 * code paths — it's a no-op for callers that don't import it.
 */
export function __resetAvailableChannelsCacheForTests(): void {
  cache.clear();
}

/**
 * Walk Slack `users.conversations` and accumulate normalized bot-member channels.
 */
async function walkBotMemberSlackConversations(token: string): Promise<NormalizedChannel[]> {
  const out: NormalizedChannel[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_SLACK_PAGES_MEMBER; page++) {
    const endpoint = "users.conversations";
    const url = new URL(`https://slack.com/api/${endpoint}`);
    url.searchParams.set("limit", String(SLACK_PAGE_SIZE));
    url.searchParams.set("exclude_archived", "true");
    // public + private; DMs/MPIMs are not assignable to teams.
    url.searchParams.set("types", "public_channel,private_channel");
    if (cursor) url.searchParams.set("cursor", cursor);

    // Wrap the network call so we can surface the underlying reason (DNS,
    // TLS, ECONNREFUSED, proxy refusal, …) instead of Node's opaque
    // top-level "fetch failed". undici stashes the real error on `cause`,
    // and without this the admin UI just shows {"error":"fetch failed"}
    // and operators have no way to tell whether Slack is down, egress is
    // blocked, or the token is malformed.
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      const causeMessage =
        cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : cause != null
            ? String(cause)
            : (err instanceof Error ? err.message : String(err));
      // The Slack token is sensitive, so don't include the URL's
      // Authorization header in any log/response. The path + endpoint
      // identifier is enough to triage the failure.
      console.error(
        `[Admin SlackChannels] network failure calling ${endpoint} (page=${page}): ${causeMessage}`,
        cause
      );
      throw new ApiError(
        `Slack discovery network failure (${endpoint}): ${causeMessage}`,
        502
      );
    }

    // Honor Slack rate-limit responses. Even on Tier 3 this can happen if
    // multiple admins click Refresh simultaneously across UI replicas.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      const waitMs = Math.min(Math.max(retryAfter, 1) * 1000, MAX_RATE_LIMIT_WAIT_MS);
      console.warn(
        `[Admin SlackChannels] rate-limited by Slack ${endpoint}, sleeping ${waitMs}ms (page=${page})`
      );
      await sleep(waitMs);
      continue; // retry same cursor
    }

    // During Slack incidents the gateway sometimes returns HTML (Cloudflare
    // 5xx page) with a JSON content-type lie. Catching the parse error
    // gives operators a clearer signal than a generic 500.
    let data: SlackListResponse;
    try {
      data = (await res.json()) as SlackListResponse;
    } catch (err) {
      const parseMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[Admin SlackChannels] failed to parse Slack response from ${endpoint} (status=${res.status}, page=${page}): ${parseMessage}`
      );
      throw new ApiError(
        `Slack discovery returned a non-JSON response from ${endpoint} (status ${res.status}): ${parseMessage}`,
        502
      );
    }
    if (!data.ok) {
      throw new ApiError(
        `Slack API error: ${data.error ?? "unknown"} (status ${res.status})`,
        502
      );
    }

    if (data.channels) {
      for (const c of data.channels) {
        if (c.is_archived) continue;
        out.push({
          id: c.id,
          name: c.name ?? c.id,
          is_private: Boolean(c.is_private),
          // `users.conversations` omits `is_member` (per Slack docs) since by
          // definition every row is one the bot is in. Default accordingly so
          // downstream filters and the UI's `channel.is_member !== false`
          // check both behave correctly.
          is_member: c.is_member ?? true,
          num_members: c.num_members ?? 0,
        });
      }
    }

    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  // Sort once at fetch time so cursor-based paging downstream is stable.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Find the next item strictly greater than `cursor` (alphabetical) in the
 * sorted list. Cursor is just the channel name of the last returned row.
 */
function applyCursor(
  channels: NormalizedChannel[],
  cursor: string | undefined
): NormalizedChannel[] {
  if (!cursor) return channels;
  // O(log n) would need binary search; n <= ~20k so linear is fine and
  // avoids subtle locale-collation bugs.
  const idx = channels.findIndex((c) => c.name.localeCompare(cursor) > 0);
  return idx < 0 ? [] : channels.slice(idx);
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  await requireResourcePermission(
    session,
    { type: "admin_surface", id: "slack", action: "read" },
    { bypassForOrgAdmin: true },
  );

  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) {
    throw new ApiError(
      "SLACK_BOT_TOKEN is not configured on the UI service. Channel discovery is unavailable; admins can still paste channel IDs manually.",
      503
    );
  }

  const params = request.nextUrl.searchParams;
  const refresh = params.get("refresh") === "1";
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const cursor = params.get("cursor") ?? undefined;
  const requestedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_UI_LIMIT)
      : DEFAULT_UI_LIMIT;

  const scope = "member_only";
  const endpoint = "users.conversations";

  const now = Date.now();
  // last 12 chars uniquely identifies the token without logging it.
  const cacheKey = token.slice(-12);
  const cached = cache.get(cacheKey);
  const cacheTtlMs = await getDiscoveryCacheTtlMs("slack");

  let snapshot: NormalizedChannel[];
  let cacheHit = false;
  let fetchedAt: number;

  // ttl=0 disables caching entirely (admin-controlled debug knob).
  if (!refresh && cacheTtlMs > 0 && cached && now - cached.fetched_at < cacheTtlMs) {
    snapshot = cached.channels;
    fetchedAt = cached.fetched_at;
    cacheHit = true;
  } else {
    snapshot = await walkBotMemberSlackConversations(token);
    fetchedAt = now;
    if (cacheTtlMs > 0) {
      cache.set(cacheKey, { channels: snapshot, fetched_at: fetchedAt, endpoint });
    } else {
      // Caching disabled — drop any stale entry so a future TTL increase
      // can't be served from a snapshot fetched while caching was off.
      cache.delete(cacheKey);
    }
  }

  // Filter pipeline runs in-process against the cached snapshot. The snapshot
  // is already members-only (`users.conversations` returns only those rows);
  // keep the membership filter as defense-in-depth against provider drift.
  let filtered = snapshot.filter((c) => c.is_member);
  if (q) {
    filtered = filtered.filter((c) => c.name.toLowerCase().includes(q));
  }

  const totalMatches = filtered.length;
  const afterCursor = applyCursor(filtered, cursor);
  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;
  const nextCursor = hasMore ? page[page.length - 1].name : null;
  const actor = publicationActorFromSession(session);
  const pageIds = page.map((channel) => channel.id);
  const [configuredById, pendingById] = await Promise.all([
    configuredSlackChannelsById(pageIds),
    activeConnectorPublicationRequestsByItemId("slack_channel", pageIds),
  ]);
  const channels = page.map((channel) => {
    const configured = configuredById.get(channel.id);
    const pending = pendingById.get(channel.id);
    return {
      ...channel,
      configured: Boolean(configured),
      ...(configured?.teamSlug
        ? { configured_team_slug: configured.teamSlug }
        : {}),
      ...(configured?.teamName
        ? { configured_team_name: configured.teamName }
        : {}),
      ...(configured?.agentId
        ? { configured_agent_id: configured.agentId }
        : {}),
      ...(configured?.agentName
        ? { configured_agent_name: configured.agentName }
        : {}),
      ...(!configured && pending
        ? { pending_publication: connectorPublicationRequestView(pending, actor) }
        : {}),
    };
  });

  console.log(
    `[Admin SlackChannels] discovery ok scope=${scope} endpoint=${endpoint} total=${snapshot.length} matches=${totalMatches} returned=${page.length} q="${q}" cache=${cacheHit ? "hit" : "miss"} by=${user.email}`
  );

  return successResponse({
    channels,
    total_matches: totalMatches,
    total_visible: snapshot.length,
    next_cursor: nextCursor,
    has_more: hasMore,
    cached: cacheHit,
    fetched_at: fetchedAt,
    scope,
    endpoint,
    query: { q, member_only: true, limit },
  });
});

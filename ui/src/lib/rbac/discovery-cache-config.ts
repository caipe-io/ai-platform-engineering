// Reads the connector-specific discovery cache TTL used by Slack channel or
// Webex space discovery.
//
// Background: both routes maintain an in-process snapshot of the
// provider's room/channel list so admins can search/scroll without
// hammering Slack/Webex API rate limits. The TTL used to be hard-coded
// to 10 minutes, which was too short for stable workspaces and too long
// for ad-hoc bot-membership changes (e.g. an admin just added the bot
// to a brand-new private channel; that channel didn't appear in the
// picker for up to 10 minutes).
//
// Each TTL has its own field in `platform_config`:
//   - `slack_discovery_cache_ttl_minutes`
//   - `webex_discovery_cache_ttl_minutes`
//   - default 60 minutes (good for typical admin workflows)
//   - range 0..1440 — 0 disables the cache entirely (every request hits
//     the upstream API; useful for debugging bot-membership rollouts)
//   - admins force a fresh snapshot at any time with the route's
//     existing `?refresh=1` query param, which both routes already honor
//
// This helper hot-caches the read for `MEMO_TTL_MS` so that a single
// discovery request doesn't make two extra Mongo round trips per page
// it walks (the routes call us once per Slack/Webex page). It is fine
// for an admin TTL change to take a few seconds to propagate — much
// faster than rolling the UI workers, but slower than per-call reads.
//
// assisted-by Cursor claude-opus-4-7

import { getCollection } from "@/lib/mongodb";

const CONFIG_ID = "platform_settings";

/** Default if the admin hasn't configured one yet. Matches the docs. */
export const DEFAULT_DISCOVERY_CACHE_TTL_MINUTES = 60;
/** Upper bound (24 h). Past this we'd risk operators forgetting the cache exists. */
export const MAX_DISCOVERY_CACHE_TTL_MINUTES = 1440;
/** Lower bound. 0 means "no cache" — every request goes to Slack/Webex. */
export const MIN_DISCOVERY_CACHE_TTL_MINUTES = 0;

/**
 * Hot-cache the platform_config read so a single discovery request that
 * walks N upstream pages doesn't trigger N+1 reads of the same Mongo
 * document. 30 s is short enough that an admin who tweaks the TTL sees
 * it apply nearly immediately on their next click. The memo is keyed on
 * Node process memory, so it auto-resets on UI worker restart.
 */
const MEMO_TTL_MS = 30_000;
export type DiscoveryCacheProvider = "slack" | "webex";

const memoizedByProvider = new Map<
  DiscoveryCacheProvider,
  { cachedAt: number; milliseconds: number }
>();

interface PlatformConfigDoc {
  _id?: string;
  slack_discovery_cache_ttl_minutes?: unknown;
  webex_discovery_cache_ttl_minutes?: unknown;
}

const CONFIG_FIELD_BY_PROVIDER: Record<
  DiscoveryCacheProvider,
  keyof PlatformConfigDoc
> = {
  slack: "slack_discovery_cache_ttl_minutes",
  webex: "webex_discovery_cache_ttl_minutes",
};

const ENV_FIELD_BY_PROVIDER: Record<DiscoveryCacheProvider, string> = {
  slack: "SLACK_DISCOVERY_CACHE_TTL_MINUTES",
  webex: "WEBEX_DISCOVERY_CACHE_TTL_MINUTES",
};

/**
 * Validates and clamps a raw value (from Mongo, the env, or a PATCH
 * body) to a sane minute count. Returns null if the value isn't a
 * positive integer-like number so callers can fall back to defaults.
 */
export function normalizeDiscoveryCacheTtlMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < MIN_DISCOVERY_CACHE_TTL_MINUTES) return null;
  if (floored > MAX_DISCOVERY_CACHE_TTL_MINUTES) return MAX_DISCOVERY_CACHE_TTL_MINUTES;
  return floored;
}

/**
 * Returns the configured TTL in milliseconds. 0 means "don't cache" and
 * is honored by callers as a per-request live read.
 *
 * Resolution order:
 *   1. The provider's `platform_config` field (admin-set)
 *   2. The provider's environment variable
 *   3. `DEFAULT_DISCOVERY_CACHE_TTL_MINUTES` (60 min)
 *
 * Any failure to reach Mongo falls back through (2) → (3) so a failed
 * Mongo lookup doesn't break the discovery picker.
 */
export async function getDiscoveryCacheTtlMs(
  provider: DiscoveryCacheProvider,
): Promise<number> {
  const now = Date.now();
  const memoized = memoizedByProvider.get(provider);
  if (memoized && now - memoized.cachedAt < MEMO_TTL_MS) {
    return memoized.milliseconds;
  }
  let minutes = await readMongoMinutes(provider);
  if (minutes === null) {
    minutes = normalizeDiscoveryCacheTtlMinutes(
      process.env[ENV_FIELD_BY_PROVIDER[provider]],
    );
  }
  if (minutes === null) {
    minutes = DEFAULT_DISCOVERY_CACHE_TTL_MINUTES;
  }
  const ms = minutes * 60_000;
  memoizedByProvider.set(provider, { cachedAt: now, milliseconds: ms });
  return ms;
}

async function readMongoMinutes(
  provider: DiscoveryCacheProvider,
): Promise<number | null> {
  try {
    const col = await getCollection<PlatformConfigDoc>("platform_config");
    const doc = await col.findOne({ _id: CONFIG_ID } as never);
    return normalizeDiscoveryCacheTtlMinutes(
      doc?.[CONFIG_FIELD_BY_PROVIDER[provider]],
    );
  } catch {
    // If Mongo is unreachable, fall through to env/default. Discovery
    // pickers should keep working in that scenario; only the TTL itself
    // is degraded.
    return null;
  }
}

/**
 * Test-only escape hatch so jest specs can flush the memo between
 * cases without restarting the Node process. Production callers should
 * not import this.
 */
export function __resetDiscoveryCacheConfigForTests(): void {
  memoizedByProvider.clear();
}

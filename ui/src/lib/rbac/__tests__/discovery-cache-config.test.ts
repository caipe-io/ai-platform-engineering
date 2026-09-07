/**
 * Unit tests for the discovery cache TTL helper.
 *
 * Why this file:
 *   - Hardcoded 10-minute TTL used to live in two route files. We moved
 *     it into platform_config and exposed it in the admin UI. The helper
 *     is the single source of truth for resolving the live value, so it
 *     needs explicit coverage for fallback ordering and bound clamping.
 *   - The helper short-circuits with an in-process memo. The test below
 *     uses the test-only reset hook so cases don't bleed into each other.
 *
 * assisted-by Cursor claude-opus-4-7
 */

const mockGetCollection = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import {
  DEFAULT_DISCOVERY_CACHE_TTL_MINUTES,
  MAX_DISCOVERY_CACHE_TTL_MINUTES,
  __resetDiscoveryCacheConfigForTests,
  getDiscoveryCacheTtlMs,
  normalizeDiscoveryCacheTtlMinutes,
} from "../discovery-cache-config";

function mockMongoTtls(slack: unknown, webex: unknown = undefined): void {
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue({
      _id: "platform_settings",
      slack_discovery_cache_ttl_minutes: slack,
      webex_discovery_cache_ttl_minutes: webex,
    }),
  });
}

describe("normalizeDiscoveryCacheTtlMinutes", () => {
  it("returns null for null/undefined/empty so callers can fall back to defaults", () => {
    expect(normalizeDiscoveryCacheTtlMinutes(null)).toBeNull();
    expect(normalizeDiscoveryCacheTtlMinutes(undefined)).toBeNull();
    expect(normalizeDiscoveryCacheTtlMinutes("")).toBeNull();
  });

  it("returns null for non-numeric input (admins shouldn't be able to wedge the helper)", () => {
    expect(normalizeDiscoveryCacheTtlMinutes("nope")).toBeNull();
    expect(normalizeDiscoveryCacheTtlMinutes({})).toBeNull();
    expect(normalizeDiscoveryCacheTtlMinutes(Number.NaN)).toBeNull();
  });

  it("returns null for negative values (0 means 'no cache', negatives are nonsense)", () => {
    expect(normalizeDiscoveryCacheTtlMinutes(-1)).toBeNull();
    expect(normalizeDiscoveryCacheTtlMinutes("-5")).toBeNull();
  });

  it("accepts 0 to mean caching disabled", () => {
    expect(normalizeDiscoveryCacheTtlMinutes(0)).toBe(0);
    expect(normalizeDiscoveryCacheTtlMinutes("0")).toBe(0);
  });

  it("clamps values above the upper bound (defensive against a typo'd PATCH)", () => {
    expect(normalizeDiscoveryCacheTtlMinutes(MAX_DISCOVERY_CACHE_TTL_MINUTES + 1)).toBe(
      MAX_DISCOVERY_CACHE_TTL_MINUTES,
    );
    expect(normalizeDiscoveryCacheTtlMinutes(100_000)).toBe(MAX_DISCOVERY_CACHE_TTL_MINUTES);
  });

  it("floors fractional inputs so the cache window is always whole minutes", () => {
    expect(normalizeDiscoveryCacheTtlMinutes(59.9)).toBe(59);
    expect(normalizeDiscoveryCacheTtlMinutes("12.5")).toBe(12);
  });
});

describe("getDiscoveryCacheTtlMs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES;
    delete process.env.WEBEX_DISCOVERY_CACHE_TTL_MINUTES;
    __resetDiscoveryCacheConfigForTests();
  });

  it("uses the Mongo-backed value when one is configured", async () => {
    mockMongoTtls(30, 90);
    expect(await getDiscoveryCacheTtlMs("slack")).toBe(30 * 60_000);
    expect(await getDiscoveryCacheTtlMs("webex")).toBe(90 * 60_000);
  });

  it("uses separate provider environment fallbacks", async () => {
    mockMongoTtls(undefined, undefined);
    process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES = "15";
    process.env.WEBEX_DISCOVERY_CACHE_TTL_MINUTES = "25";
    expect(await getDiscoveryCacheTtlMs("slack")).toBe(15 * 60_000);
    expect(await getDiscoveryCacheTtlMs("webex")).toBe(25 * 60_000);
  });

  it("falls back to the default 60 minutes when neither Mongo nor env is set", async () => {
    mockMongoTtls(undefined, undefined);
    expect(await getDiscoveryCacheTtlMs("slack")).toBe(DEFAULT_DISCOVERY_CACHE_TTL_MINUTES * 60_000);
    expect(await getDiscoveryCacheTtlMs("webex")).toBe(DEFAULT_DISCOVERY_CACHE_TTL_MINUTES * 60_000);
  });

  it("honours 0 from Mongo as 'caching disabled' (does NOT fall through to env)", async () => {
    mockMongoTtls(0, 45);
    process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES = "999";
    expect(await getDiscoveryCacheTtlMs("slack")).toBe(0);
    expect(await getDiscoveryCacheTtlMs("webex")).toBe(45 * 60_000);
  });

  it("clamps an out-of-range Mongo value rather than crashing the picker", async () => {
    mockMongoTtls(99_999);
    expect(await getDiscoveryCacheTtlMs("slack")).toBe(MAX_DISCOVERY_CACHE_TTL_MINUTES * 60_000);
  });

  it("falls back to defaults when Mongo throws (so a Mongo outage doesn't break discovery)", async () => {
    mockGetCollection.mockRejectedValue(new Error("mongo unreachable"));
    process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES = "20";
    expect(await getDiscoveryCacheTtlMs("slack")).toBe(20 * 60_000);
  });

  it("memoises the read so back-to-back calls in the same request hit Mongo only once", async () => {
    mockMongoTtls(45, 75);
    await getDiscoveryCacheTtlMs("slack");
    await getDiscoveryCacheTtlMs("slack");
    await getDiscoveryCacheTtlMs("webex");
    await getDiscoveryCacheTtlMs("webex");
    expect(mockGetCollection).toHaveBeenCalledTimes(2);
  });
});

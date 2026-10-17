/** @jest-environment node */

import { NextRequest, NextResponse } from "next/server";

import { feedbackRangeBounds, insightsFilterKey, insightsScopeKey, withInsightsResponseCache } from "@/lib/insights-cache";
import { resetServerCacheForTests } from "@/lib/server-cache";
import { createJsonResponseCacheStore, withJsonResponseCache } from "@/lib/server-response-cache";

describe("Insights cache boundaries", () => {
  beforeEach(async () => {
    delete process.env.CAIPE_CACHE_REDIS_URL;
    process.env.ADMIN_STATS_CACHE_TTL_MS = "60000";
    await resetServerCacheForTests();
  });

  afterEach(() => {
    delete process.env.ADMIN_STATS_CACHE_TTL_MS;
    jest.restoreAllMocks();
  });

  it("canonicalizes set filters without session or refresh values", () => {
    expect(insightsFilterKey(new URLSearchParams("team=secondary,primary&refresh=true&page=1&include_bots=false")))
      .toEqual({ team: "primary,secondary" });
    expect(insightsFilterKey(new URLSearchParams("rating=negative&page=2&limit=50&source=slack"), ["rating", "page", "limit"]))
      .toEqual({ source: "slack" });
  });

  it("shares full-admin scope and isolates personal and simulation scope", () => {
    expect(insightsScopeKey({ fullAdmin: true, subject: "primary" }))
      .toBe(insightsScopeKey({ fullAdmin: true, subject: "secondary" }));
    expect(insightsScopeKey({ fullAdmin: false, subject: "primary", channelNames: ["example"] }))
      .not.toBe(insightsScopeKey({ fullAdmin: false, subject: "secondary", channelNames: ["example"] }));
    expect(insightsScopeKey({ fullAdmin: true, simulation: "primary" }))
      .not.toBe(insightsScopeKey({ fullAdmin: true }));
    expect(insightsScopeKey({ fullAdmin: false, subject: "primary", channelNames: ["primary", "secondary"] }))
      .toBe(insightsScopeKey({ fullAdmin: false, subject: "primary", channelNames: ["secondary", "primary"] }));
  });

  it("preserves scalar whitespace when route parsing treats it as significant", () => {
    expect(insightsFilterKey(new URLSearchParams("source=slack%20")))
      .not.toEqual(insightsFilterKey(new URLSearchParams("source=slack")));
    expect(insightsFilterKey(new URLSearchParams("include_bots=%20true")))
      .not.toEqual(insightsFilterKey(new URLSearchParams("include_bots=true")));
  });

  it("uses relative presets and preserves exact custom ranges", () => {
    const bounds = feedbackRangeBounds(new URLSearchParams("range=7d"));
    expect(Date.parse(bounds.to!) - Date.parse(bounds.from!)).toBe(7 * 86_400_000);
    expect(feedbackRangeBounds(new URLSearchParams("from=2026-01-01T00:00:00.001Z&to=2026-01-02T00:00:00.002Z")))
      .toEqual({ from: "2026-01-01T00:00:00.001Z", to: "2026-01-02T00:00:00.002Z" });
    expect(() => feedbackRangeBounds(new URLSearchParams("range=invalid"))).toThrow("Invalid feedback date range");
    expect(() => feedbackRangeBounds(new URLSearchParams("from=invalid"))).toThrow("Invalid feedback date range");
  });

  it("shares authorized data across caller headers and exposes data age", async () => {
    const load = jest.fn(async () => NextResponse.json({ success: true, data: { total: 3 } }));
    const first = new NextRequest("https://example.test/api/admin/stats?section=overview", { headers: { authorization: "Bearer primary" } });
    const second = new NextRequest(first.url, { headers: { cookie: "session=secondary" } });
    await withInsightsResponseCache(first, "insights.stats", { fullAdmin: true }, load);
    const result = await withInsightsResponseCache(second, "insights.stats", { fullAdmin: true }, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.headers.get("x-caipe-cache")).toBe("hit");
    expect(result.headers.get("x-caipe-cache-age")).toBe("0");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not retry or cache a failed computation", async () => {
    const load = jest.fn(async () => NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "2" } }));
    const request = new NextRequest("https://example.test/api/admin/stats");
    const response = await withInsightsResponseCache(request, "insights.stats", { fullAdmin: true }, load);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(load).toHaveBeenCalledTimes(1);
    await withInsightsResponseCache(request, "insights.stats", { fullAdmin: true }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("returns an uncacheable legacy response without a second database call", async () => {
    const load = jest.fn(async () => NextResponse.json({ error: "unavailable" }, { status: 503 }));
    const request = new NextRequest("https://example.test/api/example");
    const response = await withJsonResponseCache(request, createJsonResponseCacheStore(), load, { ttlMs: 60000 });
    expect(response.status).toBe(503);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("does not cache a degraded successful response", async () => {
    const load = jest.fn(async () => NextResponse.json({ data: {} }, { headers: { "x-caipe-cache-bypass": "degraded" } }));
    const request = new NextRequest("https://example.test/api/admin/stats");
    await withInsightsResponseCache(request, "insights.stats", { fullAdmin: true }, load);
    await withInsightsResponseCache(request, "insights.stats", { fullAdmin: true }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

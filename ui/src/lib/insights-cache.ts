import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/api-error";
import { getOrLoad, type CacheResult } from "@/lib/server-cache";
import { envTtlMs } from "@/lib/server-response-cache";

export const INSIGHTS_QUERY_TIMEOUT_MS = 15_000;

export interface InsightsScope {
  fullAdmin: boolean;
  subject?: string;
  ownerEmail?: string | null;
  channelNames?: string[] | null;
  webexSpaceIds?: string[];
  ownedAgents?: Array<{ id: string; name: string }>;
  simulation?: unknown;
}

const SET_FILTERS = new Set(["user", "team", "channel", "agent", "search"]);
const CONTROL_PARAMS = new Set(["refresh"]);
const PRESET_MS: Record<string, number> = {
  "1h": 3_600_000,
  "12h": 43_200_000,
  "24h": 86_400_000,
  "1d": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  "90d": 7_776_000_000,
};

function sorted(values: string[] | null | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function insightsScopeKey(scope: InsightsScope): string {
  return createHash("sha256").update(JSON.stringify({
    fullAdmin: scope.fullAdmin,
    ...(scope.fullAdmin ? {} : {
      subject: scope.subject ?? "",
      ownerEmail: scope.ownerEmail ?? "",
      channels: sorted(scope.channelNames),
      spaces: sorted(scope.webexSpaceIds),
      agents: (scope.ownedAgents ?? []).map(({ id, name }) => [id, name]).sort(),
    }),
    simulation: scope.simulation ?? null,
  })).digest("hex");
}

export function insightsFilterKey(
  params: URLSearchParams,
  omit: readonly string[] = [],
): Record<string, string> {
  const ignored = new Set([...CONTROL_PARAMS, ...omit]);
  const result: Record<string, string> = {};
  for (const key of [...new Set(params.keys())].sort()) {
    if (ignored.has(key)) continue;
    let value = params.get(key) ?? "";
    if (!value) continue;
    if ((key === "include_bots" || key === "include_service_accounts") && value !== "true") continue;
    if (key.endsWith("page") && value === "1") continue;
    if (SET_FILTERS.has(key)) value = sorted(value.split(",").map((part) => part.trim()).filter(Boolean)).join(",");
    result[key] = value;
  }
  return result;
}

export function feedbackRangeBounds(params: URLSearchParams): { from: string | null; to: string | null } {
  const from = params.get("from");
  const to = params.get("to");
  if (from || to) {
    if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) {
      throw new ApiError("Invalid feedback date range", 400);
    }
    if (from && to && Date.parse(from) > Date.parse(to)) throw new ApiError("Invalid feedback date range", 400);
    return { from, to };
  }
  const preset = params.get("range");
  if (!preset) return { from: null, to: null };
  const duration = PRESET_MS[preset];
  if (!duration) throw new ApiError("Invalid feedback date range", 400);
  const end = new Date();
  return { from: new Date(end.getTime() - duration).toISOString(), to: end.toISOString() };
}

export async function cachedInsights<T>(
  request: NextRequest,
  namespace: string,
  scope: InsightsScope,
  key: unknown,
  loader: () => Promise<T>,
): Promise<CacheResult<T>> {
  const env = namespace.startsWith("insights.feedback") ? "ADMIN_FEEDBACK_CACHE_TTL_MS" : "ADMIN_STATS_CACHE_TTL_MS";
  const freshMs = envTtlMs(env, 60_000);
  return getOrLoad({
    namespace,
    freshMs,
    staleMs: Math.max(300_000, freshMs),
    maxEntries: 2_048,
    forceRefresh: ["1", "true"].includes(request.nextUrl.searchParams.get("refresh") ?? ""),
  }, { scope: insightsScopeKey(scope), filters: key }, loader);
}

interface JsonPayload {
  body: unknown;
  status: number;
  headers: Array<[string, string]>;
}

class UncacheableResponse extends Error {
  constructor(readonly response: NextResponse) {
    super("Response is not cacheable");
  }
}

export function applyInsightsCacheHeaders(response: NextResponse, result: Pick<CacheResult<unknown>, "state" | "computedAt">): NextResponse {
  response.headers.set("x-caipe-cache", result.state);
  response.headers.set("x-caipe-computed-at", new Date(result.computedAt).toISOString());
  response.headers.set("x-caipe-cache-age", String(Math.max(0, Math.floor((Date.now() - result.computedAt) / 1000))));
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function withInsightsResponseCache(
  request: NextRequest,
  namespace: string,
  scope: InsightsScope,
  compute: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const result = await cachedInsights<JsonPayload>(request, namespace, scope, insightsFilterKey(request.nextUrl.searchParams), async () => {
      const response = await compute();
      if (!response.ok || response.headers.has("set-cookie") || response.headers.has("x-caipe-cache-bypass")) throw new UncacheableResponse(response);
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        throw new UncacheableResponse(response);
      }
      return { body, status: response.status, headers: [...response.headers.entries()] };
    });
    return applyInsightsCacheHeaders(NextResponse.json(result.value.body, {
      status: result.value.status,
      headers: result.value.headers,
    }), result);
  } catch (error) {
    if (error instanceof UncacheableResponse) return error.response.clone() as NextResponse;
    throw error;
  }
}

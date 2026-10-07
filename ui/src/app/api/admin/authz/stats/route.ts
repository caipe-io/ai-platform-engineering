// assisted-by Codex Codex-sonnet-4-6
//
// GET /api/admin/authz/stats — CAS health + decision statistics.
//
//   engine    — live, per-replica adapter snapshot (circuit state, cache).
//   decisions — durable aggregation over audit-service cas_decision events in
//               a time window: totals, deny rate, by-reason, top-denied.
//
// Gated by the same baseline "metrics" admin surface as /api/admin/metrics.

import { NextRequest, NextResponse } from "next/server";

import { ApiError, getAuthFromBearerOrSession, withErrorHandler } from "@/lib/api-middleware";
import { getAuditReader } from "@/lib/audit/reader";
import { getEngineStats } from "@/lib/authz";
import { requireAdminSurfaceManage } from "@/lib/rbac/require-openfga";

const WINDOWS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};
const MAX_RANGE_SECONDS = 366 * 24 * 60 * 60;
const QUERY_LIMIT = 10_000;

function parseTime(value: string, parameter: string): Date {
  const numeric = Number(value);
  const milliseconds = Number.isFinite(numeric)
    ? numeric * (Math.abs(numeric) < 1_000_000_000_000 ? 1000 : 1)
    : Date.parse(value);
  const parsed = new Date(milliseconds);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(`\`${parameter}\` must be a unix timestamp or RFC3339 date`, 400, "VALIDATION_ERROR");
  }
  return parsed;
}

function resolveTimeRange(searchParams: URLSearchParams): {
  since: Date;
  until: Date;
  windowLabel: string;
} {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from || to) {
    if (!from || !to) {
      throw new ApiError("`from` and `to` must be provided together", 400, "VALIDATION_ERROR");
    }
    const since = parseTime(from, "from");
    const until = parseTime(to, "to");
    if (until <= since) {
      throw new ApiError("`to` must be later than `from`", 400, "VALIDATION_ERROR");
    }
    if (until.getTime() - since.getTime() > MAX_RANGE_SECONDS * 1000) {
      throw new ApiError(
        `Custom authorization ranges cannot exceed ${MAX_RANGE_SECONDS} seconds`,
        400,
        "VALIDATION_ERROR",
      );
    }
    return { since, until, windowLabel: `${since.toISOString()}/${until.toISOString()}` };
  }

  const rangeSecondsValue = searchParams.get("rangeSeconds");
  if (rangeSecondsValue !== null) {
    const rangeSeconds = Number(rangeSecondsValue);
    if (
      !Number.isFinite(rangeSeconds)
      || rangeSeconds <= 0
      || rangeSeconds > MAX_RANGE_SECONDS
    ) {
      throw new ApiError(
        `\`rangeSeconds\` must be between 1 and ${MAX_RANGE_SECONDS}`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const until = new Date();
    const since = new Date(until.getTime() - Math.floor(rangeSeconds) * 1000);
    return { since, until, windowLabel: `${Math.floor(rangeSeconds)}s` };
  }

  const windowKey = searchParams.get("window") ?? "24h";
  const windowMs = WINDOWS[windowKey];
  if (!windowMs) {
    throw new ApiError(`\`window\` must be one of: ${Object.keys(WINDOWS).join(", ")}`, 400, "VALIDATION_ERROR");
  }
  const until = new Date();
  const since = new Date(until.getTime() - windowMs);
  return { since, until, windowLabel: windowKey };
}

function increment(map: Map<string, number>, key: string | undefined, by = 1): void {
  map.set(key ?? "UNKNOWN", (map.get(key ?? "UNKNOWN") ?? 0) + by);
}

/**
 * Decisions per row. Routine allows are aggregated into periodic rollup rows
 * carrying `count` (see lib/authz/audit.ts), so a row is not always one
 * decision; denials are never aggregated and always carry no `count`.
 */
function decisionCount(row: Record<string, unknown>): number {
  return typeof row.count === "number" && Number.isFinite(row.count) && row.count > 0 ? row.count : 1;
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Denial reason → count for a bulk-evaluation row. Falls back to the row's own
 * `reason_code` when the breakdown is absent, so the denials still land under a
 * real reason rather than vanishing from `byReason`.
 */
function batchDeniedReasons(row: Record<string, unknown>): Record<string, number> {
  const reasons = row.denied_reasons;
  if (reasons && typeof reasons === "object" && !Array.isArray(reasons)) {
    const entries = Object.entries(reasons as Record<string, unknown>)
      .map(([key, value]) => [key, numericField(value)] as const)
      .filter(([, value]) => value > 0);
    if (entries.length > 0) return Object.fromEntries(entries);
  }
  const fallback = typeof row.reason_code === "string" ? row.reason_code : "NO_CAPABILITY";
  return { [fallback]: numericField(row.denied_count) };
}

function topCounts(map: Map<string, number>, label: "reason" | "resource"): Record<string, string | number>[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, label === "resource" ? 10 : undefined)
    .map(([key, count]) => ({ [label]: key || "unknown", count }));
}

export const GET = withErrorHandler(async (request: NextRequest): Promise<NextResponse> => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireAdminSurfaceManage(session, "metrics");

  const url = new URL(request.url);
  const { since, until, windowLabel } = resolveTimeRange(url.searchParams);

  const engine = getEngineStats();
  const org = (session as { org?: string } | null)?.org;
  const auditReader = getAuditReader();
  if (auditReader.backendName !== "service") {
    return NextResponse.json(
      { engine, window: windowLabel, persistence: false, decisions: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const rows = await auditReader.query({
    since,
    until,
    type: "cas_decision",
    tenantId: org,
    limit: QUERY_LIMIT,
    timeoutMs: 15_000,
  });

  let allow = 0;
  let deny = 0;
  let unavailable = 0;
  const byReason = new Map<string, number>();
  const topDenied = new Map<string, number>();

  for (const row of rows) {
    const outcome = row.outcome;
    const reason = typeof row.reason_code === "string" ? row.reason_code : undefined;

    // A bulk evaluation or a list-objects lookup carries both sides of one
    // filter/lookup, so read its own tallies instead of attributing the whole
    // row to `outcome`. Counting a filter over N resources as a single
    // decision — or worse, as N policy denials — is what made the deny rate
    // meaningless. Both row shapes use the same evaluated/allowed/denied
    // fields; only how they were computed (per-candidate check vs. one
    // reverse lookup) differs.
    if (row.batch === true || row.list_objects === true) {
      const allowedCount = numericField(row.allowed_count);
      const deniedCount = numericField(row.denied_count);
      allow += allowedCount;
      deny += deniedCount;
      if (allowedCount > 0) increment(byReason, "OK", allowedCount);
      if (deniedCount > 0) {
        for (const [deniedReason, reasonCount] of Object.entries(batchDeniedReasons(row))) {
          increment(byReason, deniedReason, reasonCount);
          if (deniedReason === "AUTHZ_UNAVAILABLE") unavailable += reasonCount;
        }
      }
      // Deliberately not in `topDenied`: a filter's resource_ref is the
      // collection (`agent:*`), so it would crowd out the real per-resource
      // denials that surface an actual access problem.
      continue;
    }

    const count = decisionCount(row);
    if (outcome === "allow") allow += count;
    if (outcome === "deny") {
      deny += count;
      if (reason !== "AUTHZ_UNAVAILABLE") {
        increment(topDenied, typeof row.resource_ref === "string" ? row.resource_ref : undefined, count);
      }
    }
    if (reason === "AUTHZ_UNAVAILABLE") unavailable += count;
    increment(byReason, reason, count);
  }

  const total = allow + deny;
  const policyDeny = Math.max(0, deny - unavailable);

  return NextResponse.json(
    {
      engine,
      window: windowLabel,
      persistence: true,
      decisions: {
        total,
        allow,
        deny,
        denyRate: total > 0 ? deny / total : 0,
        policyDeny,
        policyDenyRate: total > 0 ? policyDeny / total : 0,
        unavailable,
        unavailableRate: total > 0 ? unavailable / total : 0,
        truncated: rows.length >= QUERY_LIMIT,
        byReason: topCounts(byReason, "reason"),
        topDenied: topCounts(topDenied, "resource"),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

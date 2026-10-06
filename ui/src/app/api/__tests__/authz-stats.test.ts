/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockGetAuth = jest.fn();
const mockRequireManage = jest.fn();
const mockGetEngineStats = jest.fn();
const mockAuditQuery = jest.fn();
let mockAuditBackend = "service";

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(message: string, public statusCode = 500, public code?: string) {
      super(message);
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: (...a: unknown[]) => mockGetAuth(...a),
    withErrorHandler:
      <T,>(h: (...a: unknown[]) => Promise<T>) =>
      async (...a: unknown[]) => {
        try {
          return await h(...a);
        } catch (e) {
          return Response.json(
            { success: false, error: e instanceof Error ? e.message : "error" },
            { status: (e as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});
jest.mock("@/lib/rbac/require-openfga", () => ({
  requireAdminSurfaceManage: (...a: unknown[]) => mockRequireManage(...a),
}));
jest.mock("@/lib/authz", () => ({ getEngineStats: (...a: unknown[]) => mockGetEngineStats(...a) }));
jest.mock("@/lib/audit/reader", () => ({
  getAuditReader: () => ({
    backendName: mockAuditBackend,
    query: (...a: unknown[]) => mockAuditQuery(...a),
  }),
}));

import { GET } from "../admin/authz/stats/route";

function req(qs = ""): NextRequest {
  return new NextRequest(new URL(`/api/admin/authz/stats${qs}`, "http://localhost:3000"));
}

const ENGINE = { circuitState: "closed", cacheSize: 3, cacheHits: 7, cacheMisses: 3, cacheHitRatio: 0.7 };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuditBackend = "service";
  mockGetAuth.mockResolvedValue({ session: { org: "acme" } });
  mockRequireManage.mockResolvedValue(undefined);
  mockGetEngineStats.mockReturnValue(ENGINE);
  mockAuditQuery.mockResolvedValue([]);
});

it("aggregates decision stats from audit-service and includes the live engine snapshot", async () => {
  mockAuditQuery.mockResolvedValue([
    ...Array.from({ length: 8 }, () => ({ outcome: "allow", reason_code: "OK" })),
    { outcome: "deny", reason_code: "NO_CAPABILITY", resource_ref: "agent:pe" },
    { outcome: "deny", reason_code: "NO_CAPABILITY", resource_ref: "agent:pe" },
  ]);

  const res = await GET(req("?window=24h"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.engine).toEqual(ENGINE);
  expect(body.persistence).toBe(true);
  expect(body.decisions).toMatchObject({
    total: 10,
    allow: 8,
    deny: 2,
    denyRate: 0.2,
    policyDeny: 2,
    policyDenyRate: 0.2,
    unavailable: 0,
    unavailableRate: 0,
    truncated: false,
    byReason: [{ reason: "OK", count: 8 }, { reason: "NO_CAPABILITY", count: 2 }],
    topDenied: [{ resource: "agent:pe", count: 2 }],
  });
  expect(mockAuditQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "cas_decision", tenantId: "acme" }));
});

it("sums aggregated allow counts so the deny rate is not inflated", async () => {
  // One aggregated allow row standing for 98 decisions, plus two per-decision
  // denials. Counting rows would report a 67% deny rate instead of 2%.
  mockAuditQuery.mockResolvedValue([
    { outcome: "allow", reason_code: "OK", count: 98 },
    { outcome: "deny", reason_code: "NO_CAPABILITY", resource_ref: "agent:pe" },
    { outcome: "deny", reason_code: "NO_CAPABILITY", resource_ref: "agent:pe" },
  ]);

  const res = await GET(req("?window=24h"));
  const body = await res.json();
  expect(body.decisions).toMatchObject({
    total: 100,
    allow: 98,
    deny: 2,
    denyRate: 0.02,
    byReason: [{ reason: "OK", count: 98 }, { reason: "NO_CAPABILITY", count: 2 }],
  });
});

it("counts a row without an explicit count as one decision", async () => {
  mockAuditQuery.mockResolvedValue([
    { outcome: "allow", reason_code: "OK", count: 3 },
    { outcome: "allow", reason_code: "OK" },
    { outcome: "deny", reason_code: "AUTHZ_UNAVAILABLE", resource_ref: "resource:primary", count: 2 },
  ]);

  const res = await GET(req("?window=24h"));
  const body = await res.json();
  expect(body.decisions).toMatchObject({
    total: 6,
    allow: 4,
    deny: 2,
    // AUTHZ_UNAVAILABLE is infrastructure failure, not a policy denial.
    policyDeny: 0,
    unavailable: 2,
  });
});

it("reads a bulk-evaluation row from its own counts, not from outcome", async () => {
  // One list filter over 500 agents: 12 accessible, 488 not. Attributing the
  // whole row to `outcome` would count this as a single decision; the old
  // per-id rows counted it as 488 policy denials.
  mockAuditQuery.mockResolvedValue([
    {
      outcome: "allow",
      reason_code: "OK",
      batch: true,
      resource_ref: "agent:*",
      evaluated_count: 500,
      allowed_count: 12,
      denied_count: 488,
      denied_reasons: { NO_CAPABILITY: 488 },
    },
  ]);

  const res = await GET(req("?window=24h"));
  const body = await res.json();
  expect(body.decisions).toMatchObject({
    total: 500,
    allow: 12,
    deny: 488,
    byReason: [{ reason: "NO_CAPABILITY", count: 488 }, { reason: "OK", count: 12 }],
  });
  // A filter's resource_ref is the collection, so it must not crowd out real
  // per-resource denials in topDenied.
  expect(body.decisions.topDenied).toEqual([]);
});

it("counts a PDP outage inside a bulk evaluation as unavailable, not policy denial", async () => {
  mockAuditQuery.mockResolvedValue([
    {
      outcome: "deny",
      reason_code: "AUTHZ_UNAVAILABLE",
      batch: true,
      resource_ref: "agent:*",
      evaluated_count: 10,
      allowed_count: 0,
      denied_count: 10,
      denied_reasons: { AUTHZ_UNAVAILABLE: 10 },
    },
  ]);

  const res = await GET(req("?window=24h"));
  const body = await res.json();
  expect(body.decisions).toMatchObject({
    total: 10,
    deny: 10,
    unavailable: 10,
    policyDeny: 0,
  });
});

it("falls back to reason_code when a bulk row has no denied_reasons breakdown", async () => {
  mockAuditQuery.mockResolvedValue([
    {
      outcome: "deny",
      reason_code: "NO_CAPABILITY",
      batch: true,
      resource_ref: "agent:*",
      evaluated_count: 4,
      allowed_count: 0,
      denied_count: 4,
    },
  ]);

  const res = await GET(req("?window=24h"));
  const body = await res.json();
  expect(body.decisions).toMatchObject({ deny: 4, byReason: [{ reason: "NO_CAPABILITY", count: 4 }] });
});

it("returns zero decision stats when audit-service has no rows", async () => {
  const res = await GET(req("?window=1h"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    engine: ENGINE,
    persistence: true,
    decisions: {
      total: 0,
      allow: 0,
      deny: 0,
      denyRate: 0,
      policyDeny: 0,
      policyDenyRate: 0,
      unavailable: 0,
      unavailableRate: 0,
      truncated: false,
      byReason: [],
      topDenied: [],
    },
  });
});

it("accepts the shared custom date range", async () => {
  const res = await GET(req("?from=1780272000&to=1780444800"));

  expect(res.status).toBe(200);
  expect(mockAuditQuery).toHaveBeenCalledWith(expect.objectContaining({
    since: new Date("2026-06-01T00:00:00.000Z"),
    until: new Date("2026-06-03T00:00:00.000Z"),
  }));
});

it("accepts rolling ranges used by the shared preset filter", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-06-03T00:00:00.000Z"));
  try {
    const res = await GET(req("?rangeSeconds=43200"));

    expect(res.status).toBe(200);
    expect(mockAuditQuery).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date("2026-06-02T12:00:00.000Z"),
      until: new Date("2026-06-03T00:00:00.000Z"),
    }));
  } finally {
    jest.useRealTimers();
  }
});

it("separates policy denials from authorization unavailability", async () => {
  mockAuditQuery.mockResolvedValue([
    { outcome: "allow", reason_code: "OK" },
    { outcome: "deny", reason_code: "NO_CAPABILITY", resource_ref: "resource:primary" },
    { outcome: "deny", reason_code: "AUTHZ_UNAVAILABLE", resource_ref: "resource:secondary" },
  ]);

  const res = await GET(req("?window=1h"));
  const body = await res.json();

  expect(body.decisions).toMatchObject({
    total: 3,
    policyDeny: 1,
    policyDenyRate: 1 / 3,
    unavailable: 1,
    unavailableRate: 1 / 3,
  });
});

it("reports unavailable history when durable audit storage is off", async () => {
  mockAuditBackend = "off";

  const res = await GET(req("?window=24h"));
  const body = await res.json();

  expect(body).toMatchObject({ persistence: false, decisions: null });
  expect(mockAuditQuery).not.toHaveBeenCalled();
});

it("rejects an invalid window with 400", async () => {
  const res = await GET(req("?window=99y"));
  expect(res.status).toBe(400);
});

it("enforces the metrics admin surface gate", async () => {
  await GET(req("?window=24h"));
  expect(mockRequireManage).toHaveBeenCalledWith(expect.anything(), "metrics");
});

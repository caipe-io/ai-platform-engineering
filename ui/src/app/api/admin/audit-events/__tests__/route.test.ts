/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

import { NextRequest } from "next/server";
import { createHash } from "crypto";

const mockGetServerSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockCollections: Record<string, unknown[]> = {};

jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
}));

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status = 500, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    ApiError,
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    withErrorHandler:
      <T,>(handler: (request: NextRequest, context?: unknown) => Promise<T>) =>
      (request: NextRequest, context?: unknown) =>
        handler(request, context),
  };
});

function collectionRows(name: string, filter?: Record<string, unknown>): unknown[] {
  const rows = mockCollections[name] ?? [];
  if (name === "users") {
    const subjectFilters = ((filter?.$or as Array<Record<string, { $in?: string[] }>> | undefined) ?? [])
      .flatMap((clause) => Object.values(clause).flatMap((value) => value.$in ?? []));
    if (subjectFilters.length === 0) return rows;
    return rows.filter((row) => {
      const doc = row as { keycloak_sub?: string; metadata?: { keycloak_sub?: string } };
      return subjectFilters.includes(doc.keycloak_sub ?? "") || subjectFilters.includes(doc.metadata?.keycloak_sub ?? "");
    });
  }
  if (name === "team_membership_sources") {
    const subjects = (filter?.user_subject as { $in?: string[] } | undefined)?.$in ?? [];
    return rows.filter((row) => {
      const doc = row as { user_subject?: string; status?: string };
      return subjects.includes(doc.user_subject ?? "") && doc.status === "active";
    });
  }
  if (name === "service_accounts") {
    const subjects = (filter?.sa_sub as { $in?: string[] } | undefined)?.$in ?? [];
    return rows.filter((row) => subjects.includes((row as { sa_sub?: string }).sa_sub ?? ""));
  }
  return rows;
}

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

interface TestAuditDoc {
  ts: Date;
  type: string;
  tenant_id: string;
  subject_hash: string;
  subject_ref?: string;
  user_email?: string;
  action: string;
  outcome: string;
  correlation_id: string;
  source: string;
  agent_name?: string;
  tool_name?: string;
  actor_hash?: string;
  actor_ref?: string;
  caller_ref?: string;
  grantee_ref?: string;
  operation?: string;
  reason_code?: string;
  resource_ref?: string;
  resource_type?: string;
  resource_id?: string;
  workflow_run_id?: string;
  decision_via?: string;
  component?: string;
  pdp?: string;
}

const SUBJECT_SALT = process.env.AUDIT_SUBJECT_SALT ?? "caipe-098-audit";

function hashSubject(id: string): string {
  return "sha256:" + createHash("sha256").update(`${SUBJECT_SALT}:${id}`).digest("hex");
}

const docs: TestAuditDoc[] = [
  {
    ts: new Date("2026-05-17T16:59:23.000Z"),
    type: "auth",
    tenant_id: "default",
    subject_hash: "sha256:workflow-owner",
    user_email: "operator@example.test",
    action: "admin_ui#view",
    outcome: "allow",
    correlation_id: "admin-view-correlation",
    source: "webui_backend",
  },
  {
    ts: new Date("2026-05-17T16:59:24.000Z"),
    type: "auth",
    tenant_id: "default",
    subject_hash: hashSubject("admin-sub"),
    action: "admin_ui#audit.view",
    outcome: "allow",
    correlation_id: "audit-view-correlation",
    source: "webui_backend",
  },
  {
    ts: new Date("2026-05-17T16:59:25.000Z"),
    type: "auth",
    tenant_id: "default",
    subject_hash: "hash-system-config",
    subject_ref: "user:profile-sub",
    actor_ref: "user:profile-sub",
    action: "system_config#read",
    outcome: "allow",
    correlation_id: "system-config-correlation",
    source: "webui_backend",
  },
  {
    ts: new Date("2026-05-17T16:59:26.000Z"),
    type: "tool_action",
    tenant_id: "default",
    subject_hash: "hash-tool",
    action: "argocd_list_applications",
    outcome: "success",
    correlation_id: "tool-correlation",
    source: "dynamic_agents",
    agent_name: "argocd",
    tool_name: "argocd_list_applications",
  },
  {
    ts: new Date("2026-05-17T16:59:27.000Z"),
    type: "agent_delegation",
    tenant_id: "default",
    subject_hash: "hash-delegation",
    action: "delegate_to_argocd",
    outcome: "success",
    correlation_id: "delegation-correlation",
    source: "dynamic_agents",
    agent_name: "argocd",
  },
  {
    ts: new Date("2026-05-17T16:59:28.000Z"),
    type: "openfga_rebac",
    tenant_id: "default",
    subject_hash: "hash-openfga",
    action: "agent#use",
    outcome: "allow",
    correlation_id: "openfga-correlation",
    source: "webui_backend",
  },
  {
    ts: new Date("2026-05-17T16:59:28.500Z"),
    type: "cas_decision",
    tenant_id: "default",
    subject_hash: "sha256:workflow-owner",
    subject_ref: "user:workflow-owner",
    action: "use",
    outcome: "allow",
    correlation_id: "wfrun-20260517165928-abc",
    source: "cas",
    reason_code: "OK",
    resource_ref: "agent:hello-world",
    resource_type: "agent",
    resource_id: "hello-world",
    workflow_run_id: "wfrun-20260517165928-abc",
    decision_via: "tuple",
    component: "cas",
    pdp: "openfga",
  },
  {
    ts: new Date("2026-05-17T16:59:28.700Z"),
    type: "cas_decision",
    tenant_id: "default",
    subject_hash: "sha256:bulk-subject",
    subject_ref: "user:bulk-subject",
    action: "discover",
    outcome: "allow",
    correlation_id: "batch:bulk-correlation",
    source: "cas",
    reason_code: "OK",
    resource_ref: "agent:*",
    resource_type: "agent",
    component: "cas",
    pdp: "openfga",
    batch: true,
    evaluated_count: 500,
    allowed_count: 2,
    denied_count: 498,
    allowed_ids: ["agent-a", "agent-b"],
    allowed_truncated: false,
    denied_reasons: { NO_CAPABILITY: 498 },
  },
  {
    ts: new Date("2026-05-17T16:59:28.800Z"),
    type: "cas_decision",
    tenant_id: "default",
    subject_hash: "sha256:rollup-subject",
    subject_ref: "user:rollup-subject",
    action: "read",
    outcome: "allow",
    correlation_id: "rollup:rollup-correlation",
    source: "cas",
    reason_code: "OK",
    resource_ref: "agent:rolled-up",
    resource_type: "agent",
    resource_id: "rolled-up",
    component: "cas",
    pdp: "openfga",
    count: 37,
    window_start: new Date("2026-05-17T16:58:28.800Z"),
    window_end: new Date("2026-05-17T16:59:28.800Z"),
  },
  {
    ts: new Date("2026-05-17T16:59:29.000Z"),
    type: "cas_grant",
    tenant_id: "acme",
    subject_hash: "hash-caller",
    subject_ref: "user:alice",
    actor_hash: "hash-caller",
    actor_ref: "user:alice",
    action: "use",
    outcome: "success",
    correlation_id: "grant-success-correlation",
    source: "cas",
    caller_ref: "user:alice",
    grantee_ref: "team:eng",
    operation: "grant",
    resource_ref: "agent:platform-engineer",
    component: "cas",
    pdp: "openfga",
  },
  {
    ts: new Date("2026-05-17T16:59:30.000Z"),
    type: "cas_grant",
    tenant_id: "acme",
    subject_hash: "hash-caller",
    subject_ref: "user:alice",
    actor_hash: "hash-caller",
    actor_ref: "user:alice",
    action: "use",
    outcome: "error",
    correlation_id: "grant-deny-correlation",
    source: "cas",
    caller_ref: "user:alice",
    grantee_ref: "team:eng",
    operation: "grant",
    reason_code: "NO_CAPABILITY",
    resource_ref: "agent:platform-engineer",
    component: "cas",
    pdp: "openfga",
  },
];

function applyServiceFilter(params: URLSearchParams): TestAuditDoc[] {
  return docs.filter((doc) => {
    const type = params.get("type");
    const tenantId = params.get("tenant_id");
    const outcome = params.get("outcome");
    const userEmail = params.get("user_email");
    const agentName = params.get("agent_name");
    const toolName = params.get("tool_name");
    if (type && doc.type !== type) return false;
    if (tenantId && doc.tenant_id !== tenantId) return false;
    if (outcome && doc.outcome !== outcome) return false;
    if (userEmail && doc.user_email !== userEmail) return false;
    if (agentName && doc.agent_name !== agentName) return false;
    if (toolName && doc.tool_name !== toolName) return false;
    return true;
  });
}

function mockAuditServiceFetch() {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const requestUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const url = new URL(requestUrl);
    const filtered = applyServiceFilter(url.searchParams);
    const limit = Number(url.searchParams.get("limit") ?? filtered.length);
    return new Response(
      JSON.stringify({
        records: filtered.slice(0, Number.isFinite(limit) ? limit : filtered.length),
        limit,
        cursor: 'first', next_cursor: null, since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', as_of: '2026-01-02T00:00:00Z',
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCollections.users = [];
  mockCollections.team_membership_sources = [];
  mockCollections.service_accounts = [];
  mockGetCollection.mockImplementation(async (name: string) => ({
    find: (filter?: Record<string, unknown>) => ({
      project: () => ({
        toArray: async () => collectionRows(name, filter),
      }),
      toArray: async () => collectionRows(name, filter),
    }),
  }));
  mockGetServerSession.mockResolvedValue({
    accessToken: "token",
    sub: "admin-sub",
    org: undefined,
    user: { email: "admin@example.com" },
  });
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockAuditServiceFetch();
});

describe("GET /api/admin/audit-events", () => {
  it('surfaces rejected service cursors as a query error rather than empty history', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('invalid cursor', { status: 400 }));
    const { GET } = await import('../route');
    await expect(GET(request('/api/admin/audit-events?cursor=invalid'))).rejects.toMatchObject({ status: 400 });
  });

  it('does not treat an old service response as valid cursor history', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ records: [], total: 0 })));
    const { GET } = await import('../route');
    const response = await GET(request('/api/admin/audit-events'));
    expect(await response.json()).toMatchObject({ auditUnavailable: true, records: [], next_cursor: null });
  });

  it.each(['page=2', 'time_resolution=minute', 'type=auth&type=cas_decision', 'limit=30junk'])(
    'rejects obsolete or ambiguous query parameters: %s', async (query) => {
      const { GET } = await import('../route');
      await expect(GET(request(`/api/admin/audit-events?${query}`))).rejects.toMatchObject({ status: 400 });
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('forwards the opaque cursor and exact page size without slicing earlier records', async () => {
    const { GET } = await import('../route');
    const response = await GET(request('/api/admin/audit-events?cursor=next-token&limit=30&window=48h'));
    const body = await response.json();
    const params = new URL((global.fetch as jest.Mock).mock.calls[0][0]).searchParams;
    expect(params.get('cursor')).toBe('next-token');
    expect(params.get('limit')).toBe('30');
    expect(params.get('window')).toBe('48h');
    expect(params.has('since')).toBe(false);
    expect(body).not.toHaveProperty('total');
    expect(body.cursor).toBe('first');
  });

  it("preserves safe gateway evidence and forwards exact principal/resource/request filters", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ records: [{
      ts: "2026-10-13T12:00:00Z", type: "cas_decision", outcome: "deny", tenant_id: "default",
      subject_ref: "user:test-user", resource_ref: "tool:example/list", actor_ref: "workload:agentgateway",
      correlation_id: "request-1", decision_id: "decision-1", failed_gate: "caller_tool",
      gateway_operation: "tools/call", agent_ref: "agent:example", access_token: "must-not-be-returned",
      gateway_policy: "Caller and agent must independently have access.",
      gateway_checks: [{ gate: "caller_tool", subject_ref: "user:test-user", relation: "can_call", resource_ref: "tool:example/list", decision: "DENY", reason: "NO_CAPABILITY", access_token: "nested-token-must-not-be-returned" }],
    }], limit: 50, cursor: 'first', next_cursor: null, since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', as_of: '2026-01-02T00:00:00Z', })));
    const { GET } = await import("../route");
    const response = await GET(request("/api/admin/audit-events?type=cas_decision&decision_id=decision-1&correlation_id=request-1&subject_ref=user%3Atest-user&resource_ref=tool%3Aexample%2Flist"));
    const body = await response.json();
    expect(body.records[0]).toMatchObject({ decision_id: "decision-1", failed_gate: "caller_tool", gateway_operation: "tools/call", agent_ref: "agent:example" });
    expect(body.records[0]).not.toHaveProperty("access_token");
    expect(body.records[0].gateway_checks).toEqual([{ gate: "caller_tool", subject_ref: "user:test-user", relation: "can_call", resource_ref: "tool:example/list", decision: "DENY", reason: "NO_CAPABILITY" }]);
    expect(body.records[0].gateway_policy).toContain("independently");
    const forwarded = new URL((global.fetch as jest.Mock).mock.calls[0][0]).searchParams;
    expect(Object.fromEntries(forwarded)).toMatchObject({ decision_id: "decision-1", correlation_id: "request-1", subject_ref: "user:test-user", resource_ref: "tool:example/list" });
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(expect.anything(), "admin_ui", "audit.view");
  });

  it("does not query decision evidence when audit permission is denied", async () => {
    mockRequireRbacPermission.mockRejectedValueOnce(new Error("Forbidden"));
    const { GET } = await import("../route");
    await expect(GET(request("/api/admin/audit-events?type=cas_decision"))).rejects.toThrow("Forbidden");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([{ value: "invalid" }, { value: [null] }, { value: [{ gate: "unexpected", subject_ref: "user:test-user", decision: "ALLOW", reason: "OK" }] }])("does not render malformed chain evidence %j", async ({ value: gateway_checks }) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ records: [{ ts: "2026-10-14T12:00:00Z", type: "cas_decision", outcome: "deny", tenant_id: "default", correlation_id: "request-1", gateway_checks }], limit: 50, cursor: 'first', next_cursor: null, since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', as_of: '2026-01-02T00:00:00Z', })));
    const { GET } = await import("../route");
    const response = await GET(request("/api/admin/audit-events?type=cas_decision"));
    expect(response.status).toBe(200);
    expect((await response.json()).records[0]).not.toHaveProperty("gateway_checks");
  });

  it("does not query decision evidence without a session", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const { GET } = await import("../route");
    await expect(GET(request("/api/admin/audit-events?type=cas_decision"))).rejects.toMatchObject({ status: 401 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns all audit event rows by default", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records.map((record: TestAuditDoc) => record.action)).toEqual([
      "admin_ui#view",
      "admin_ui#audit.view",
      "system_config#read",
      "argocd_list_applications",
      "delegate_to_argocd",
      "agent#use",
      "use",
      "discover",
      "read",
      "use",
      "use",
    ]);
    expect(body.records.map((record: TestAuditDoc) => record.type)).toEqual([
      "auth",
      "auth",
      "auth",
      "tool_action",
      "agent_delegation",
      "openfga_rebac",
      "cas_decision",
      "cas_decision",
      "cas_decision",
      "cas_grant",
      "cas_grant",
    ]);
  });

  it("resolves the signed-in principal hash to readable display fields", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=auth"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records[1]).toMatchObject({
      action: "admin_ui#audit.view",
      subject_ref: "user:admin-sub",
      user_email: "admin@example.com",
    });
  });

  it("resolves user refs to canonical display names from Mongo identity stores", async () => {
    mockCollections.users = [
      {
        email: "profile@example.com",
        name: "Profile User",
        keycloak_sub: "profile-sub",
      },
    ];
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=auth"));
    const body = await response.json();
    const systemConfig = body.records.find((record: TestAuditDoc) => record.action === "system_config#read");

    expect(response.status).toBe(200);
    expect(systemConfig).toMatchObject({
      subject_ref: "user:profile-sub",
      actor_ref: "user:profile-sub",
      subject_display: "profile@example.com",
      actor_display: "profile@example.com",
      user_email: "profile@example.com",
    });
  });

  it("forwards a bounded query without recomputing relative dates or scanning previous pages", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?window=15m"));

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("window=15m"),
      expect.objectContaining({ cache: "no-store" }),
    );
    const query = new URL((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(query.searchParams.get('limit')).toBe('50');
    expect(query.searchParams.has('since')).toBe(false);
    expect(query.searchParams.has('until')).toBe(false);
    expect(query.searchParams.has('time_resolution')).toBe(false);
  });

  it("includes admin UI view authorization rows when authorization type is explicitly selected", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=auth"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records.map((record: TestAuditDoc) => record.action)).toEqual([
      "admin_ui#view",
      "admin_ui#audit.view",
      "system_config#read",
    ]);
  });

  it("filters cas_grant policy-change events and maps grant audit fields", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=cas_grant"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records).toHaveLength(2);
    expect(body.records[0]).toMatchObject({
      type: "cas_grant",
      outcome: "success",
      operation: "grant",
      subject_ref: "user:alice",
      actor_ref: "user:alice",
      caller_ref: "user:alice",
      grantee_ref: "team:eng",
      resource_ref: "agent:platform-engineer",
      source: "cas",
      tenant_id: "acme",
    });
    expect(body.records[1]).toMatchObject({
      type: "cas_grant",
      outcome: "error",
      reason_code: "NO_CAPABILITY",
      operation: "grant",
    });
  });

  it("preserves CAS resource and workflow fields for downloadable audit evidence", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=cas_decision"));
    const body = await response.json();

    expect(response.status).toBe(200);
    const workflowRow = body.records.find(
      (r: { workflow_run_id?: string }) => r.workflow_run_id === "wfrun-20260517165928-abc",
    );
    expect(workflowRow).toMatchObject({
      type: "cas_decision",
      outcome: "allow",
      action: "use",
      reason_code: "OK",
      resource_ref: "agent:hello-world",
      resource_type: "agent",
      resource_id: "hello-world",
      subject_ref: "user:workflow-owner",
      workflow_run_id: "wfrun-20260517165928-abc",
      decision_via: "tuple",
      source: "cas",
      component: "cas",
      pdp: "openfga",
    });
  });

  it("preserves aggregate fields on bulk-evaluation and rollup rows", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=cas_decision"));
    const body = await response.json();

    // documentToEvent is an explicit whitelist, so an aggregate field that is
    // not listed there is silently dropped and the row reads back as a single
    // decision — in the tab and in downloaded evidence alike.
    const batchRow = body.records.find((r: { batch?: boolean }) => r.batch === true);
    expect(batchRow).toMatchObject({
      batch: true,
      evaluated_count: 500,
      allowed_count: 2,
      denied_count: 498,
      allowed_ids: ["agent-a", "agent-b"],
      denied_reasons: { NO_CAPABILITY: 498 },
    });

    const rollupRow = body.records.find((r: { count?: number }) => r.count === 37);
    expect(rollupRow).toMatchObject({ count: 37 });
    expect(rollupRow.window_start).toBe("2026-05-17T16:58:28.800Z");
    expect(rollupRow.window_end).toBe("2026-05-17T16:59:28.800Z");
  });

  it("preserves rows when the audit-service event does not include user_email", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=cas_decision"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records[0]).toMatchObject({
      type: "cas_decision",
      subject_hash: "sha256:workflow-owner",
      subject_ref: "user:workflow-owner",
    });
    expect(body.records[0].user_email).toBeUndefined();
  });

  it("maps legacy reconcile source metadata and tuple counts into the unified event", async () => {
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({
          records: [
            {
              ts: "2026-08-27T21:37:47.000Z",
              type: "cas_reconcile",
              tenant_id: "default",
              action: "reconcile",
              outcome: "success",
              correlation_id: "reconcile-correlation",
              source: "team_resources",
              source_system: "cas",
              component: "cas",
              pdp: "openfga",
              writes: 2,
              deletes: 1,
            },
          ],
          limit: 50, cursor: 'first', next_cursor: null, since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', as_of: '2026-01-02T00:00:00Z',
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?type=cas_reconcile"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records[0]).toMatchObject({
      type: "cas_reconcile",
      source: "cas",
      reconcile_scope: "team_resources",
      writes: 2,
      deletes: 1,
    });
    expect(body.records[0].subject_hash).toBeUndefined();
  });

  it("returns an empty warning response when audit-service is unavailable", async () => {
    global.fetch = jest.fn(async () => new Response("unavailable", { status: 503 }));
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      records: [],
      next_cursor: null,
      limit: 50,
      auditUnavailable: true,
    });
    expect(body.warning).toContain("Audit queries unavailable");
  });
});

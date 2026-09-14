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
    user_email: "sraradhy@cisco.com",
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
        total: filtered.length,
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

  it("forwards audit time window and storage resolution to audit-service", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/audit-events?window=15m"));

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("window=15m"),
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("time_resolution=minute"),
      expect.objectContaining({ cache: "no-store" }),
    );
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
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
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
          total: 1,
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
      total: 0,
      page: 1,
      limit: 50,
      auditUnavailable: true,
    });
    expect(body.warning).toContain("Audit service unavailable");
  });
});

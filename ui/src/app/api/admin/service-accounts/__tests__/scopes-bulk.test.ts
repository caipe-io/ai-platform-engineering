/**
 * @jest-environment node
 */

/**
 * POST /api/admin/service-accounts/[id]/scopes/bulk.
 *
 * Unlike the single-scope route, permission-checking and writing are
 * batched: one `batchCheckOpenFgaTuples` call, one `reconcileTupleDiff`
 * call carrying every scope's write tuple, and ONE `refreshSnapshot` at the
 * end — not one of each per scope. Held-scope failures are atomic: if the
 * editor doesn't hold ANY requested scope, nothing is written.
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

const mockCheckOpenFgaTuple = jest.fn();
const mockBatchCheckOpenFgaTuples = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (diff: { writes: unknown[]; deletes: unknown[] }) =>
    mockWriteOpenFgaTuples(diff),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  batchCheckOpenFgaTuples: (...args: unknown[]) =>
    mockBatchCheckOpenFgaTuples(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

const mockLogAudit = jest.fn();
jest.mock("@/lib/rbac/audit", () => ({
  logOpenFgaRebacAuditEvent: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockGetBySub = jest.fn();
const mockUpdateScopesSnapshot = jest.fn();
jest.mock("@/lib/service-accounts", () => ({
  getBySub: (...args: unknown[]) => mockGetBySub(...args),
  updateScopesSnapshot: (...args: unknown[]) =>
    mockUpdateScopesSnapshot(...args),
}));

const mockFindAgentVisibilities = jest.fn();
jest.mock("@/lib/dynamic-agent-visibility", () => ({
  findAgentVisibilities: (...args: unknown[]) =>
    mockFindAgentVisibilities(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: jest.fn().mockReturnValue("organization:example-org"),
}));

const mockListEveryoneKnowledgeScopes = jest.fn();
jest.mock("@/lib/rbac/unlinked-knowledge-access", () => ({
  listEveryoneKnowledgeScopes: (...args: unknown[]) =>
    mockListEveryoneKnowledgeScopes(...args),
  reconcileExistingUnlinkedKnowledgeAccess: jest.fn(),
}));

import { POST } from "../[id]/scopes/bulk/route";

const SESSION = { sub: "editor-sub", user: { email: "editor@example.com" } };
const SA_ID = "sa-123";

function bulkRequest(body: unknown): Request {
  return new NextRequest(
    `http://localhost:3000/api/admin/service-accounts/${SA_ID}/scopes/bulk`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: SA_ID }) };
}

/** can_manage allowed; batch-check holds exactly the named tuples. */
function manageableWithHeld(held: Set<string>) {
  mockCheckOpenFgaTuple.mockImplementation(
    async (t: { relation: string; object: string }) => {
      if (
        t.relation === "can_manage" &&
        t.object.startsWith("service_account:")
      ) {
        return { allowed: true };
      }
      if (t.relation === "can_manage" && t.object.startsWith("organization:")) {
        return { allowed: false };
      }
      return { allowed: held.has(`${t.relation} ${t.object}`) };
    },
  );
  mockBatchCheckOpenFgaTuples.mockImplementation(
    async (tuples: Array<{ relation: string; object: string }>) =>
      tuples.map((t) => held.has(`${t.relation} ${t.object}`)),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockWriteOpenFgaTuples.mockResolvedValue({
    enabled: true,
    writes: 1,
    deletes: 0,
  });
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockReadOpenFgaTuples.mockResolvedValue({
    tuples: [],
    continuationToken: undefined,
  });
  mockGetBySub.mockResolvedValue({ sa_sub: SA_ID, scopes_snapshot: [] });
  mockUpdateScopesSnapshot.mockResolvedValue(true);
  mockFindAgentVisibilities.mockResolvedValue(new Map());
  mockListEveryoneKnowledgeScopes.mockResolvedValue({
    datasourceIds: new Set<string>(),
    collectionIds: new Set<string>(),
  });
});

describe("POST .../[id]/scopes/bulk", () => {
  it("adds every held scope in ONE write call and refreshes the snapshot ONCE", async () => {
    manageableWithHeld(
      new Set([
        "can_call tool:jira/search",
        "can_use agent:incident-resolver",
        "can_read data_source:ds-1",
      ]),
    );

    const res = await POST(
      bulkRequest({
        scopes: [
          { type: "tool", ref: "jira/search" },
          { type: "agent", ref: "incident-resolver" },
          { type: "datasource", ref: "ds-1" },
        ],
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.added_count).toBe(3);
    expect(body.data.added).toEqual([
      { type: "tool", ref: "jira/search" },
      { type: "agent", ref: "incident-resolver" },
      { type: "datasource", ref: "ds-1" },
    ]);

    // One write call, one diff, carrying all three tuples plus the single
    // searcher baseline (not one per knowledge-type scope).
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledTimes(1);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        { user: `service_account:${SA_ID}`, relation: "caller", object: "tool:jira/search" },
        { user: `service_account:${SA_ID}`, relation: "user", object: "agent:incident-resolver" },
        { user: `service_account:${SA_ID}`, relation: "reader", object: "data_source:ds-1" },
        { user: `service_account:${SA_ID}`, relation: "searcher", object: "organization:example-org" },
      ],
      deletes: [],
    });
    // ONE refresh, not one per scope — this is the whole point of the route.
    expect(mockUpdateScopesSnapshot).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "service_account.scope_bulk_add" }),
    );
  });

  it("includes exactly one searcher baseline tuple even with both a datasource and a collection requested", async () => {
    manageableWithHeld(
      new Set(["can_read data_source:ds-1", "can_read rag_collection:coll-1"]),
    );

    const res = await POST(
      bulkRequest({
        scopes: [
          { type: "datasource", ref: "ds-1" },
          { type: "collection", ref: "coll-1" },
        ],
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    const writes = mockWriteOpenFgaTuples.mock.calls[0][0].writes as Array<{
      relation: string;
    }>;
    expect(writes.filter((w) => w.relation === "searcher")).toHaveLength(1);
  });

  it("rejects the WHOLE batch atomically when even one scope is unheld — no partial writes", async () => {
    manageableWithHeld(new Set(["can_call tool:jira/search"])); // holds tool, not the agent

    const res = await POST(
      bulkRequest({
        scopes: [
          { type: "tool", ref: "jira/search" },
          { type: "agent", ref: "incident-resolver" },
        ],
      }),
      ctx(),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.data.rejected_scopes).toEqual([
      { type: "agent", ref: "incident-resolver" },
    ]);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    expect(mockUpdateScopesSnapshot).not.toHaveBeenCalled();
  });

  it("allows a platform admin to bulk-add unheld scopes", async () => {
    mockCheckOpenFgaTuple.mockImplementation(
      async (t: { relation: string; object: string }) => {
        if (t.relation === "can_manage" && t.object === `service_account:${SA_ID}`) {
          return { allowed: true };
        }
        if (t.relation === "can_manage" && t.object === "organization:example-org") {
          return { allowed: true };
        }
        return { allowed: false };
      },
    );

    const res = await POST(
      bulkRequest({
        scopes: [
          { type: "tool", ref: "jira/*" },
          { type: "agent", ref: "incident-resolver" },
        ],
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    // Platform admins bypass the held-scope check entirely — never even called.
    expect(mockBatchCheckOpenFgaTuples).not.toHaveBeenCalled();
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledTimes(1);
  });

  it("400 when scopes is missing", async () => {
    manageableWithHeld(new Set());
    const res = await POST(bulkRequest({}), ctx());
    expect(res.status).toBe(400);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("400 when scopes is an empty array", async () => {
    manageableWithHeld(new Set());
    const res = await POST(bulkRequest({ scopes: [] }), ctx());
    expect(res.status).toBe(400);
  });

  it("400 when scopes exceeds the size cap", async () => {
    manageableWithHeld(new Set());
    const scopes = Array.from({ length: 1001 }, (_, i) => ({
      type: "tool" as const,
      ref: `server/tool-${i}`,
    }));
    const res = await POST(bulkRequest({ scopes }), ctx());
    expect(res.status).toBe(400);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("400 on a genuinely malformed scope anywhere in the array — nothing written", async () => {
    manageableWithHeld(new Set(["can_call tool:jira/search"]));
    const res = await POST(
      bulkRequest({
        scopes: [
          { type: "tool", ref: "jira/search" },
          { type: "tool", ref: "bad ref" },
        ],
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("404 for a non-manager (does not reveal existence)", async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    const res = await POST(
      bulkRequest({ scopes: [{ type: "tool", ref: "jira/search" }] }),
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(
      bulkRequest({ scopes: [{ type: "tool", ref: "jira/search" }] }),
      ctx(),
    );
    expect(res.status).toBe(401);
  });
});

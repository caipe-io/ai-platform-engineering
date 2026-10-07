/**
 * @jest-environment node
 */

import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockCollections: Record<string, unknown> = {};

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    successResponse: (data: unknown) => NextResponse.json({ success: true, data }),
    withErrorHandler:
      (handler: (...args: unknown[]) => Promise<Response>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            { status: error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 500 }
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => mockCollections[name] ?? createMockCollection([])),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

const mockListTeamKbGrants = jest.fn();
jest.mock("@/lib/rbac/team-resource-listing", () => ({
  listTeamKbGrants: (...args: unknown[]) => mockListTeamKbGrants(...args),
}));

const mockReconcileDataSourceRelationships = jest.fn();
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
}));

/**
 * Minimal MongoDB-filter shim. Supports the shapes used by route
 * handlers under test:
 *   - equality:               { team_slug: "x" }
 *   - object id equality:     { _id: <ObjectId> }
 *   - $or with sub-filters:   { $or: [{user_email: ...}, ...] }
 *   - $ne:                    { status: { $ne: "removed" } }
 *   - $in:                    { slug: { $in: [...] } }
 */
function matchesFilter(row: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or" && Array.isArray(value)) {
      return value.some((clause: Record<string, unknown>) => matchesFilter(row, clause));
    }
    if (value instanceof ObjectId) return String(row[key]) === String(value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$ne" in value) return row[key] !== value.$ne;
      if ("$in" in value) return Array.isArray(value.$in) && value.$in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function createMockCollection(rows: unknown[]) {
  // Cursor must support `find().toArray()` so the canonical
  // team-membership reader (post 2026-05-26 canonical-membership refactor)
  // can resolve the calling user's role for KB-permission gates.
  return {
    rows,
    findOne: jest.fn(async (filter: Record<string, unknown>) => rows.find((row) => matchesFilter(row, filter)) ?? null),
    find: jest.fn((filter: Record<string, unknown> = {}) => ({
      toArray: jest.fn(async () => rows.filter((row) => matchesFilter(row, filter))),
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn(async () => rows.filter((row) => matchesFilter(row, filter))),
      }),
    })),
    updateOne: jest.fn(async (filter: Record<string, unknown>, update: unknown, options?: unknown) => {
      const row = rows.find((candidate) => matchesFilter(candidate, filter));
      if (row && update.$set) Object.assign(row, update.$set);
      if (!row && options?.upsert) rows.push({ ...filter, ...(update.$set ?? {}) });
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0, upsertedCount: row ? 0 : 1 };
    }),
  };
}

function request(path: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

const teamId = new ObjectId();

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "admin@example.com", role: "admin" },
    session: { user: { email: "admin@example.com" }, role: "admin" },
  });
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  mockListTeamKbGrants.mockResolvedValue({ kbIds: [], permissions: {} });
  mockReconcileDataSourceRelationships.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  mockCollections.teams = createMockCollection([
    { _id: teamId, slug: "platform", name: "Platform" },
  ]);
});

describe("/api/admin/teams/[id]/kb-assignments", () => {
  it("returns empty assignments when OpenFGA reports no KB grants", async () => {
    // OpenFGA is the source of truth: a team with no `knowledge_base` grants
    // has no KBs.
    mockCollections.teams = createMockCollection([
      { _id: teamId, slug: "platform", name: "Platform" },
    ]);
    mockListTeamKbGrants.mockResolvedValue({ kbIds: [], permissions: {} });
    const { GET } = await import("../route");

    const response = await GET(
      request(`/api/admin/teams/${teamId}/kb-assignments`),
      { params: Promise.resolve({ id: String(teamId) }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListTeamKbGrants).toHaveBeenCalledWith("platform");
    expect(body.data.kb_ids).toEqual([]);
    expect(body.data.kb_permissions).toEqual({});
    expect(body.data.allowed_datasource_ids).toEqual([]);
  });

  it("surfaces KB grants from OpenFGA even for a freshly uploaded datasource", async () => {
    // Regression guard for the upload bug: a datasource granted to the team
    // via RAG-server ownership tuples must appear in the team's KB
    // assignments, sourced from OpenFGA.
    mockCollections.teams = createMockCollection([
      { _id: teamId, slug: "platform", name: "Platform" },
    ]);
    mockListTeamKbGrants.mockResolvedValue({
      kbIds: ["uploaded-ds"],
      permissions: { "uploaded-ds": "ingest" },
    });
    const { GET } = await import("../route");

    const response = await GET(
      request(`/api/admin/teams/${teamId}/kb-assignments`),
      { params: Promise.resolve({ id: String(teamId) }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.kb_ids).toEqual(["uploaded-ds"]);
    expect(body.data.kb_permissions).toEqual({ "uploaded-ds": "ingest" });
    expect(body.data.allowed_datasource_ids).toEqual(["uploaded-ds"]);
  });

  it("rejects legacy assignment writes so publication policy cannot be bypassed", async () => {
    const { PUT } = await import("../route");

    const response = await PUT(
      request(`/api/admin/teams/${teamId}/kb-assignments`, {
        method: "PUT",
        body: JSON.stringify({
          kb_ids: ["source-primary"],
          kb_permissions: { "source-primary": "read" },
        }),
      }),
      { params: Promise.resolve({ id: String(teamId) }) }
    );

    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error).toContain("Manage Search from the datasource settings");
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("rejects legacy assignment deletion for the same canonical-writer rule", async () => {
    const { DELETE } = await import("../route");

    const response = await DELETE(
      request(`/api/admin/teams/${teamId}/kb-assignments?datasource_id=source-primary`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: String(teamId) }) }
    );

    expect(response.status).toBe(409);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment node
 */
import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";

const mockGetAuth = jest.fn();
const mockRequirePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockBatchCheck = jest.fn();
const mockWriteTuples = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
    requireRbacPermission: (...args: unknown[]) => mockRequirePermission(...args),
    successResponse: (data: unknown) => NextResponse.json({ success: true, data }),
    withErrorHandler:
      (handler: (...args: unknown[]) => Promise<Response>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          const status =
            error && typeof error === "object" && "statusCode" in error
              ? Number((error as { statusCode: number }).statusCode)
              : 500;
          return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            { status },
          );
        }
      },
  };
});
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));
jest.mock("@/lib/rbac/openfga", () => ({
  batchCheckOpenFgaTuples: (...args: unknown[]) => mockBatchCheck(...args),
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteTuples(...args),
}));
jest.mock("@/lib/rbac/organization", () => ({ organizationObjectId: () => "organization:caipe" }));

import { GET, PUT } from "@/app/api/admin/autonomous/team-access/route";

const teamA = { _id: new ObjectId(), name: "Alpha", slug: "alpha" };
const teamB = { _id: new ObjectId(), name: "Beta", slug: "beta" };

function collectionFor(documents = [teamA, teamB]) {
  const projected = {
    toArray: async () => documents,
    sort: () => ({
      skip: () => ({
        limit: () => ({ toArray: async () => documents }),
      }),
    }),
  };
  return {
    find: jest.fn(() => ({ project: () => projected })),
    countDocuments: jest.fn(async () => documents.length),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuth.mockResolvedValue({ user: { email: "admin@example.com" }, session: {} });
  mockRequirePermission.mockResolvedValue(undefined);
  mockGetCollection.mockResolvedValue(collectionFor());
  mockBatchCheck.mockResolvedValue([true, false]);
  mockWriteTuples.mockResolvedValue({ enabled: true, writes: 2, deletes: 0 });
});

it("lists active teams with their entitlement state", async () => {
  const response = await GET(
    new NextRequest("http://localhost/api/admin/autonomous/team-access?page=1&page_size=25"),
  );
  const body = await response.json();

  expect(body.data.teams).toEqual([
    { id: String(teamA._id), name: "Alpha", slug: "alpha", enabled: true },
    { id: String(teamB._id), name: "Beta", slug: "beta", enabled: false },
  ]);
  expect(mockBatchCheck).toHaveBeenCalledWith([
    { user: "team:alpha#member", relation: "automation_eligible", object: "organization:caipe" },
    { user: "team:beta#member", relation: "automation_eligible", object: "organization:caipe" },
  ]);
});

it("enables selected teams in one OpenFGA write", async () => {
  mockGetCollection.mockResolvedValue(collectionFor([teamA]));
  const response = await PUT(
    new NextRequest("http://localhost/api/admin/autonomous/team-access", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, team_ids: [String(teamA._id)] }),
    }),
  );

  expect(response.status).toBe(200);
  expect(mockWriteTuples).toHaveBeenCalledWith({
    writes: [
      { user: "team:alpha#member", relation: "automation_eligible", object: "organization:caipe" },
    ],
    deletes: [],
  });
});

it("disables every active team", async () => {
  await PUT(
    new NextRequest("http://localhost/api/admin/autonomous/team-access", {
      method: "PUT",
      body: JSON.stringify({ enabled: false, all: true }),
    }),
  );

  expect(mockWriteTuples).toHaveBeenCalledWith({
    writes: [],
    deletes: [
      { user: "team:alpha#member", relation: "automation_eligible", object: "organization:caipe" },
      { user: "team:beta#member", relation: "automation_eligible", object: "organization:caipe" },
    ],
  });
});

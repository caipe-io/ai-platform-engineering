/** @jest-environment node */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockRemoveRagCollectionFromAgentPins = jest.fn();
const mockReconcileCollectionRelationships = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      (handler: (request: NextRequest) => Promise<Response>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          if (error instanceof actual.ApiError) {
            return Response.json(
              { success: false, error: error.message, code: error.code },
              { status: error.statusCode },
            );
          }
          throw error;
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  RAG_COLLECTION_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  RAG_COLLECTIONS_COLLECTION: "rag_collections",
  collectionRelationshipTuples: jest.fn(() => []),
  removeRagCollectionFromAgentPins: (...args: unknown[]) =>
    mockRemoveRagCollectionFromAgentPins(...args),
  reconcileCollectionRelationships: (...args: unknown[]) =>
    mockReconcileCollectionRelationships(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  deleteExactOpenFgaTuples: jest.fn(),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: jest.fn(),
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  caipeOrgKey: () => "example-org",
}));

jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: jest.fn().mockResolvedValue(false),
}));

import { POST } from "../route";

describe("POST /api/rag/collections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemoveRagCollectionFromAgentPins.mockResolvedValue(0);
    mockReconcileCollectionRelationships.mockResolvedValue(undefined);
  });

  it("does not let a delegated service account create collections", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "automation@example.com" },
      session: {
        sub: "automation-sub",
        isServiceAccount: true,
      },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/rag/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Automation collection" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: "SERVICE_ACCOUNT_COLLECTION_MUTATION_FORBIDDEN",
      }),
    );
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("cleans stale agent pins before reusing a collection slug", async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: "primary" });
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "owner@example.com" },
      session: { sub: "owner-sub", user: { email: "owner@example.com" } },
    });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({
      countDocuments: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
      deleteOne: jest.fn(),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/rag/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "primary", name: "Primary knowledge" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockRemoveRagCollectionFromAgentPins).toHaveBeenCalledWith(
      "primary",
    );
    expect(
      mockRemoveRagCollectionFromAgentPins.mock.invocationCallOrder[0],
    ).toBeLessThan(insertOne.mock.invocationCallOrder[0]);
  });
});

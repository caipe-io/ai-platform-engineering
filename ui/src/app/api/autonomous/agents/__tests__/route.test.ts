/**
 * @jest-environment node
 */
import { NextRequest, NextResponse } from "next/server";

const mockGetAuth = jest.fn();
const mockListObjects = jest.fn();
const mockGetCollection = jest.fn();
const mockCheckTuple = jest.fn();

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
jest.mock("@/lib/rbac/openfga", () => ({
  listOpenFgaObjects: (...args: unknown[]) => mockListObjects(...args),
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckTuple(...args),
}));
jest.mock("@/lib/rbac/organization", () => ({ organizationObjectId: () => "organization:test" }));
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));
jest.mock("@/lib/rbac/resource-authz", () => ({ subjectFromSession: () => "user:sub-1" }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "autonomousAgentsEnabled" }));

import { GET } from "@/app/api/autonomous/agents/route";

const request = (query = "") => new NextRequest(`http://localhost/api/autonomous/agents${query}`);

function mockAgents(documents: Array<Record<string, unknown>>) {
  mockGetCollection.mockResolvedValue({
    find: jest.fn(() => ({
      project: () => ({
        sort: () => ({ toArray: async () => documents }),
      }),
    })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuth.mockResolvedValue({
    user: { email: "user@example.com" },
    session: { role: "user", sub: "sub-1", user: { email: "user@example.com" } },
  });
  mockCheckTuple.mockResolvedValue({ allowed: false });
  mockListObjects.mockResolvedValue({ objects: [] });
  mockAgents([]);
});

it("returns no agents when the user has no Autonomous entitlement", async () => {
  const response = await GET(request());
  const body = await response.json();

  expect(body.data).toEqual({ schedulable: [], eligible: false });
  expect(mockListObjects).not.toHaveBeenCalled();
  expect(mockGetCollection).not.toHaveBeenCalled();
});

it("lists every usable agent for an eligible user, including global agents", async () => {
  mockCheckTuple.mockResolvedValue({ allowed: true });
  mockListObjects.mockResolvedValue({ objects: ["agent:global-agent", "agent:team-agent"] });
  mockAgents([
    { _id: "global-agent", name: "Global Agent" },
    { _id: "team-agent", name: "Team Agent", owner_team_slug: "team-b" },
  ]);

  const response = await GET(request());
  const body = await response.json();

  expect(mockListObjects).toHaveBeenCalledWith({
    user: "user:sub-1",
    relation: "can_use",
    type: "agent",
  });
  expect(body.data.schedulable).toEqual([
    { id: "global-agent", name: "Global Agent", owner_team_slug: null },
    { id: "team-agent", name: "Team Agent", owner_team_slug: "team-b" },
  ]);
});

it("summary mode checks only the user entitlement", async () => {
  mockCheckTuple.mockResolvedValue({ allowed: true });

  const response = await GET(request("?summary=true"));
  const body = await response.json();

  expect(body.data).toEqual({ schedulable: [], eligible: true });
  expect(mockCheckTuple).toHaveBeenCalledWith({
    user: "user:sub-1",
    relation: "can_automate",
    object: "organization:test",
  });
  expect(mockListObjects).not.toHaveBeenCalled();
});

it("fails closed when OpenFGA errors", async () => {
  mockCheckTuple.mockRejectedValue(new Error("OpenFGA down"));
  const response = await GET(request());
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data).toEqual({ schedulable: [], eligible: false });
});

it("404s when the global feature flag is off", async () => {
  jest.resetModules();
  jest.doMock("@/lib/config", () => ({ getConfig: () => false }));
  const { GET: gatedGet } = await import("@/app/api/autonomous/agents/route");
  const response = await gatedGet(request());
  expect(response.status).toBe(404);
});

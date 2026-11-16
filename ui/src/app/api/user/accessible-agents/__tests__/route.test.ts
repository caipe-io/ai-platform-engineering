/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuth = jest.fn();
const mockFilterResources = jest.fn();
const mockGetCollection = jest.fn();
const mockAgentsCollection = {
  find: jest.fn(),
};

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
  };
});

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResources(...args),
}));

import { GET } from "../route";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/user/accessible-agents${query}`);
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/user/accessible-agents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({
      user: { email: "alice@example.com", name: "Alice", role: "user" },
      session: { sub: "alice-sub", org: "default" },
    });
    mockGetCollection.mockResolvedValue(mockAgentsCollection);
    mockAgentsCollection.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { _id: "agent-x", name: "Agent X", description: "X does X", enabled: true },
          {
            _id: "agent-y",
            name: "Agent Y",
            description: "Y does Y",
            enabled: true,
            execution_harness_id: "agentcore",
          },
          {
            _id: "agent-z",
            name: "Agent Z",
            description: "Z does Z",
            enabled: true,
            execution_harness_id: "claude_agent_sdk",
          },
        ]),
      }),
    });
  });

  it("returns the agents the user can use with picker-shaped fields", async () => {
    mockFilterResources.mockImplementation(async (_session, agents) => agents);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json).toMatchObject({ success: true });
    expect((json.data as { agents: unknown }).agents).toEqual([
      {
        id: "agent-x",
        name: "Agent X",
        description: "X does X",
        harness_id: "dynamic_agents",
        harness_name: "LangChain Deep Agents",
      },
      {
        id: "agent-y",
        name: "Agent Y",
        description: "Y does Y",
        harness_id: "agentcore",
        harness_name: "Amazon Bedrock AgentCore",
      },
      {
        id: "agent-z",
        name: "Agent Z",
        description: "Z does Z",
        harness_id: "claude_agent_sdk",
        harness_name: "Claude Agent SDK",
      },
    ]);
  });

  it("returns only the agents that filterResourcesByPermission allows", async () => {
    mockFilterResources.mockImplementation(async (_session, agents) =>
      agents.filter((a: { _id: string }) => a._id !== "agent-y"),
    );

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    const agents = (json.data as { agents: Array<{ id: string }> }).agents;
    expect(agents.map((a) => a.id)).toEqual(["agent-x", "agent-z"]);
  });

  it("returns an empty list when the user has no accessible agents", async () => {
    mockFilterResources.mockResolvedValue([]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect((json.data as { agents: unknown[] }).agents).toEqual([]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetAuth.mockResolvedValue({
      user: { email: "x", name: "y", role: "user" },
      session: {},
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockFilterResources).not.toHaveBeenCalled();
  });

  it("paginates with default page size 25 and respects the page query param", async () => {
    const manyAgents = Array.from({ length: 60 }).map((_, i) => ({
      _id: `agent-${i}`,
      name: `Agent ${i}`,
      description: "",
      enabled: true,
    }));
    mockAgentsCollection.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue(manyAgents),
      }),
    });
    mockFilterResources.mockImplementation(async (_s, a) => a);

    const firstPage = await GET(makeRequest("?page=1"));
    expect(firstPage.status).toBe(200);
    const firstJson = await bodyOf(firstPage);
    const firstAgents = (firstJson.data as { agents: Array<{ id: string }>; total: number; page: number; page_size: number }).agents;
    expect(firstAgents.length).toBe(25);
    expect(firstAgents[0].id).toBe("agent-0");
    expect((firstJson.data as { total: number }).total).toBe(60);

    const thirdPage = await GET(makeRequest("?page=3"));
    const thirdJson = await bodyOf(thirdPage);
    const thirdAgents = (thirdJson.data as { agents: Array<{ id: string }> }).agents;
    expect(thirdAgents.length).toBe(10);
    expect(thirdAgents[0].id).toBe("agent-50");
  });

  it("clamps page_size to a hard max of 100", async () => {
    const manyAgents = Array.from({ length: 200 }).map((_, i) => ({
      _id: `agent-${i}`,
      name: `Agent ${i}`,
      description: "",
      enabled: true,
    }));
    mockAgentsCollection.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue(manyAgents),
      }),
    });
    mockFilterResources.mockImplementation(async (_s, a) => a);

    const response = await GET(makeRequest("?page_size=500"));
    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    const agents = (json.data as { agents: unknown[]; page_size: number }).agents;
    expect(agents.length).toBe(100);
    expect((json.data as { page_size: number }).page_size).toBe(100);
  });

  it("only returns enabled agents", async () => {
    mockAgentsCollection.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { _id: "agent-x", name: "X", description: "", enabled: true },
        ]),
      }),
    });
    mockFilterResources.mockImplementation(async (_s, a) => a);

    await GET(makeRequest());

    expect(mockAgentsCollection.find).toHaveBeenCalledWith({ enabled: true });
  });
});

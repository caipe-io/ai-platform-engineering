// assisted-by Codex Codex-sonnet-4-6
const mockReadOpenFgaTuples = jest.fn();
const mockToArray = jest.fn();

jest.mock("../../openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

jest.mock("../../mongo-collections", () => ({
  getRbacCollection: jest.fn(async () => ({
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({ toArray: mockToArray }),
    }),
  })),
}));

describe("ReBAC graph performance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockToArray.mockResolvedValue([]);
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: Array.from({ length: 500 }, (_, index) => ({
        key: {
          user: `team:team-${index % 20}#member`,
          relation: "user",
          object: `agent:agent-${index}`,
        },
      })),
    });
  });

  it("loads a filtered graph page without scanning beyond the requested page", async () => {
    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({ resourceType: "agent", resourceId: "agent-42", limit: 100 });

    expect(result.edges).toHaveLength(1);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledTimes(1);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "agent:agent-42" },
      pageSize: 100,
      continuationToken: undefined,
    });
  });

  it("loads a selected user's neighborhood and expands team membership", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [
        {
          key: {
            user: "user:alice-sub",
            relation: "member",
            object: "team:platform",
          },
        },
        {
          key: {
            user: "team:platform#member",
            relation: "user",
            object: "agent:incident-agent",
          },
        },
        {
          key: {
            user: "user:bob-sub",
            relation: "user",
            object: "agent:other-agent",
          },
        },
      ],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({ subject: "user:alice-sub", limit: 100 });

    expect(result.edges.map((edge) => [edge.from, edge.relation, edge.to])).toEqual([
      ["user:alice-sub", "member", "team:platform"],
      ["team:platform#member", "user", "agent:incident-agent"],
    ]);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledTimes(2);
  });

  it("expands a selected team into member and admin usersets for effective access", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [
        {
          key: {
            user: "team:platform#member",
            relation: "user",
            object: "agent:incident-agent",
          },
        },
        {
          key: {
            user: "team:platform#admin",
            relation: "manager",
            object: "mcp_server:payments",
          },
        },
        {
          key: {
            user: "team:other#member",
            relation: "user",
            object: "agent:other-agent",
          },
        },
      ],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({ subject: "team:platform", layer: "effective", limit: 100 });
    const effectiveEdges = result.edges.filter((edge) => edge.kind === "effective");

    expect(effectiveEdges.map((edge) => [edge.from, edge.relation, edge.to])).toEqual([
      ["team:platform", "can_use", "agent:incident-agent"],
      ["team:platform", "can_manage", "mcp_server:payments"],
    ]);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledTimes(1);
  });

  it("shows direct service-account effective grants", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [
        {
          key: {
            user: "service_account:sa-sub",
            relation: "user",
            object: "agent:incident-agent",
          },
        },
      ],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({ subject: "service_account:sa-sub", layer: "effective", limit: 100 });
    const effectiveEdges = result.edges.filter((edge) => edge.kind === "effective");

    expect(effectiveEdges.map((edge) => [edge.from, edge.relation, edge.to])).toEqual([
      ["service_account:sa-sub", "can_use", "agent:incident-agent"],
    ]);
  });

  it("keeps user team expansion when an agent resource scope is selected", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [
        {
          key: {
            user: "user:alice-sub",
            relation: "member",
            object: "team:platform",
          },
        },
        {
          key: {
            user: "team:platform#member",
            relation: "user",
            object: "agent:incident-agent",
          },
        },
      ],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({
      subject: "user:alice-sub",
      resourceType: "agent",
      resourceId: "incident-agent",
      layer: "effective",
      limit: 100,
    });
    const effectiveEdges = result.edges.filter((edge) => edge.kind === "effective");

    expect(effectiveEdges.map((edge) => [edge.from, edge.relation, edge.to])).toEqual([
      ["user:alice-sub", "can_use", "agent:incident-agent"],
    ]);
  });

  it("keeps a selected resource node visible when no relationships exist", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({
      resourceType: "skill",
      resourceId: "skill-empty",
      layer: "effective",
      limit: 100,
    });

    expect(result.nodes.map((node) => node.id)).toContain("skill:skill-empty");
    expect(result.edges).toEqual([]);
  });

  it("keeps selected actor and resource nodes visible when no feature grant exists", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({
      subject: "user:alice-sub",
      resourceType: "agent",
      resourceId: "missing-agent",
      layer: "effective",
      limit: 100,
    });

    expect(result.nodes.map((node) => node.id).sort()).toEqual([
      "agent:missing-agent",
      "user:alice-sub",
    ]);
    expect(result.edges).toEqual([]);
  });

  it("continues subject scans until a late resource-scoped grant is found", async () => {
    mockReadOpenFgaTuples.mockImplementation(async (options?: { continuationToken?: string }) => {
      if (options?.continuationToken === "page-2") {
        return {
          continuationToken: undefined,
          tuples: [
            {
              key: {
                user: "user:alice-sub",
                relation: "owner",
                object: "agent:late-agent",
              },
            },
          ],
        };
      }
      return {
        continuationToken: "page-2",
        tuples: Array.from({ length: 100 }, (_, index) => ({
          key: {
            user: "user:alice-sub",
            relation: "user",
            object: `agent:unrelated-agent-${index}`,
          },
        })),
      };
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({
      subject: "user:alice-sub",
      resourceType: "agent",
      resourceId: "late-agent",
      layer: "effective",
      limit: 10,
    });
    const effectiveEdges = result.edges.filter((edge) => edge.kind === "effective");

    expect(effectiveEdges.map((edge) => [edge.from, edge.relation, edge.to])).toEqual([
      ["user:alice-sub", "can_manage", "agent:late-agent"],
    ]);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledTimes(2);
    expect(mockReadOpenFgaTuples).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageSize: 100 }));
    expect(mockReadOpenFgaTuples).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ continuationToken: "page-2", pageSize: 100 })
    );
  });

  it("shows incoming effective relationships for an agent resource scope", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      continuationToken: undefined,
      tuples: [
        {
          key: {
            user: "team:platform#member",
            relation: "user",
            object: "agent:incident-agent",
          },
        },
        {
          key: {
            user: "service_account:sa-sub",
            relation: "manager",
            object: "agent:incident-agent",
          },
        },
        {
          key: {
            user: "team:platform#member",
            relation: "user",
            object: "agent:other-agent",
          },
        },
      ],
    });

    const { queryRebacGraph } = await import("../../rebac-graph");
    const result = await queryRebacGraph({
      resourceType: "agent",
      resourceId: "incident-agent",
      layer: "effective",
      limit: 100,
    });
    const effectiveEdges = result.edges.filter((edge) => edge.kind === "effective");

    expect(effectiveEdges.map((edge) => [edge.from, edge.relation, edge.to])).toEqual([
      ["team:platform#member", "can_use", "agent:incident-agent"],
      ["service_account:sa-sub", "can_manage", "agent:incident-agent"],
    ]);
  });
});

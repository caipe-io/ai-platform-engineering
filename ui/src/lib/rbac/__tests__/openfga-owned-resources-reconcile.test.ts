/**
 * @jest-environment node
 *
 * Server-facing MCP/shareable resource reconciliation — delete cleanup,
 * fail-closed guards, and reconcile wiring.
 */

const mockReconcileTupleDiff = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockIsOpenFgaReconciliationEnabled = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/authz", () => {
  class OpenFgaReconcileRequiredError extends Error {
    constructor(message = "OpenFGA reconciliation is required for this mutation") {
      super(message);
      this.name = "OpenFgaReconcileRequiredError";
    }
  }
  return {
    reconcileTupleDiff: (...args: unknown[]) => mockReconcileTupleDiff(...args),
    OpenFgaReconcileRequiredError,
  };
});

jest.mock("../openfga", () => ({
  isOpenFgaReconciliationEnabled: () => mockIsOpenFgaReconciliationEnabled(),
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
  TEAM_TOOL_WILDCARD_SENTINEL_OBJECT: "tool:*",
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import { OpenFgaReconcileRequiredError } from "@/lib/authz";
import {
  deleteAllMcpServerRelationshipTuples,
  deleteAllMcpToolRelationshipTuples,
  reconcileConfigDrivenMcpServerRelationships,
  reconcileMcpServerRelationships,
} from "../openfga-owned-resources-reconcile";

function tuplePage(
  keys: Array<{ user: string; relation: string; object: string }>,
  continuationToken?: string,
) {
  return {
    tuples: keys.map((key) => ({ key })),
    continuationToken,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOpenFgaReconciliationEnabled.mockReturnValue(true);
  mockReconcileTupleDiff.mockResolvedValue({ enabled: true, writes: 0, deletes: 4 });
  // Default: no `tool:*` wildcard-sentinel teams and no team agents, so the
  // wildcard backfill is a no-op unless a test opts in via seedWildcardTeam().
  mockReadOpenFgaTuples.mockResolvedValue(tuplePage([]));
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockGetCollection.mockResolvedValue({
    find: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    }),
  });
});

describe("deleteAllMcpServerRelationshipTuples", () => {
  it("reads and deletes tuples from every MCP-server-related object pattern", async () => {
    mockReadOpenFgaTuples.mockImplementation(async (options: { tuple?: { object?: string } }) => {
      const object = options?.tuple?.object;
      switch (object) {
        case "mcp_server:mcp-confluence-mcp":
          return tuplePage([
            { user: "user:alice", relation: "owner", object },
            { user: "team:platform#member", relation: "reader", object },
          ]);
        case "mcp_tool:mcp-confluence-mcp_*":
          return tuplePage([
            { user: "team:platform#member", relation: "caller", object },
          ]);
        case "tool:mcp-confluence-mcp_*":
          return tuplePage([
            { user: "team:platform#member", relation: "caller", object },
          ]);
        case "tool:mcp-confluence-mcp/*":
          return tuplePage([
            { user: "team:platform#member", relation: "caller", object },
          ]);
        default:
          return tuplePage([]);
      }
    });

    await deleteAllMcpServerRelationshipTuples("mcp-confluence-mcp", {
      caller: { type: "user", id: "admin-sub" },
      source: "mcp_server_delete",
    });

    expect(mockReadOpenFgaTuples).toHaveBeenCalledTimes(4);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "mcp_server:mcp-confluence-mcp" },
      continuationToken: undefined,
    });
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "mcp_tool:mcp-confluence-mcp_*" },
      continuationToken: undefined,
    });
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "tool:mcp-confluence-mcp_*" },
      continuationToken: undefined,
    });
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "tool:mcp-confluence-mcp/*" },
      continuationToken: undefined,
    });

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: [],
        deletes: expect.arrayContaining([
          { user: "user:alice", relation: "owner", object: "mcp_server:mcp-confluence-mcp" },
          { user: "team:platform#member", relation: "reader", object: "mcp_server:mcp-confluence-mcp" },
          { user: "team:platform#member", relation: "caller", object: "mcp_tool:mcp-confluence-mcp_*" },
          { user: "team:platform#member", relation: "caller", object: "tool:mcp-confluence-mcp_*" },
          { user: "team:platform#member", relation: "caller", object: "tool:mcp-confluence-mcp/*" },
        ]),
      },
      expect.objectContaining({
        source: "mcp_server_delete",
        caller: { type: "user", id: "admin-sub" },
      }),
    );
  });

  it("paginates tuple reads per object before reconciling deletes", async () => {
    mockReadOpenFgaTuples.mockImplementation(async (options: { tuple?: { object?: string }; continuationToken?: string }) => {
      const object = options?.tuple?.object;
      if (object !== "mcp_server:paginated-server") {
        return tuplePage([]);
      }
      if (!options.continuationToken) {
        return tuplePage(
          [{ user: "user:alice", relation: "owner", object }],
          "page-2",
        );
      }
      return tuplePage([{ user: "team:ops#admin", relation: "manager", object }]);
    });

    await deleteAllMcpServerRelationshipTuples("paginated-server");

    const serverReads = mockReadOpenFgaTuples.mock.calls.filter(
      ([arg]) => arg?.tuple?.object === "mcp_server:paginated-server",
    );
    expect(serverReads).toHaveLength(2);
    expect(serverReads[1][0]).toEqual({
      tuple: { object: "mcp_server:paginated-server" },
      continuationToken: "page-2",
    });
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        deletes: [
          { user: "user:alice", relation: "owner", object: "mcp_server:paginated-server" },
          { user: "team:ops#admin", relation: "manager", object: "mcp_server:paginated-server" },
        ],
      }),
      expect.anything(),
    );
  });

  it("throws OpenFgaReconcileRequiredError when reconciliation is disabled", async () => {
    mockIsOpenFgaReconciliationEnabled.mockReturnValue(false);

    await expect(deleteAllMcpServerRelationshipTuples("mcp-ops")).rejects.toThrow(
      OpenFgaReconcileRequiredError,
    );
    expect(mockReadOpenFgaTuples).not.toHaveBeenCalled();
    expect(mockReconcileTupleDiff).not.toHaveBeenCalled();
  });
});

describe("deleteAllMcpToolRelationshipTuples", () => {
  it("deletes every tuple on mcp_tool:<toolId>", async () => {
    mockReadOpenFgaTuples
      .mockResolvedValueOnce(
        tuplePage(
          [{ user: "user:alice", relation: "owner", object: "mcp_tool:custom-search" }],
          "more",
        ),
      )
      .mockResolvedValueOnce(
        tuplePage([
          { user: "team:platform#member", relation: "caller", object: "mcp_tool:custom-search" },
        ]),
      );

    await deleteAllMcpToolRelationshipTuples("custom-search");

    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "mcp_tool:custom-search" },
      continuationToken: undefined,
    });
    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith({
      tuple: { object: "mcp_tool:custom-search" },
      continuationToken: "more",
    });
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: [],
        deletes: [
          { user: "user:alice", relation: "owner", object: "mcp_tool:custom-search" },
          { user: "team:platform#member", relation: "caller", object: "mcp_tool:custom-search" },
        ],
      },
      { source: "mcp_tool_delete" },
    );
  });

  it("throws when reconciliation is disabled", async () => {
    mockIsOpenFgaReconciliationEnabled.mockReturnValue(false);

    await expect(deleteAllMcpToolRelationshipTuples("custom-search")).rejects.toThrow(
      OpenFgaReconcileRequiredError,
    );
  });
});

describe("reconcileMcpServerRelationships", () => {
  // Wildcard intent + team agents now live in OpenFGA (the `team.resources`
  // array is gone): a `tool:*` sentinel caller marks the team as "all servers",
  // and `team#member user agent:<id>` lists its agents.
  function seedWildcardTeam(): void {
    mockReadOpenFgaTuples.mockImplementation(async (options: { tuple?: { object?: string } }) => {
      if (options?.tuple?.object === "tool:*") {
        return tuplePage([{ user: "team:platform#member", relation: "caller", object: "tool:*" }]);
      }
      return tuplePage([]);
    });
    mockListOpenFgaObjects.mockImplementation(
      async (options: { user?: string; relation?: string; type?: string }) => {
        if (
          options?.user === "team:platform#member" &&
          options?.relation === "user" &&
          options?.type === "agent"
        ) {
          return { objects: ["agent:agent-keep", "agent:bad agent id"] };
        }
        return { objects: [] };
      },
    );
  }

  it("backfills wildcard-enabled teams when a new MCP server is reconciled", async () => {
    seedWildcardTeam();

    await reconcileMcpServerRelationships({
      serverId: "mcp-new-tools",
      ownerSubject: "alice-sub",
    });

    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith(
      expect.objectContaining({ tuple: { object: "tool:*" } }),
    );
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: expect.arrayContaining([
          { user: "team:platform#member", relation: "reader", object: "mcp_server:mcp-new-tools" },
          { user: "team:platform#member", relation: "user", object: "mcp_server:mcp-new-tools" },
          { user: "team:platform#member", relation: "invoker", object: "mcp_server:mcp-new-tools" },
          { user: "team:platform#admin", relation: "manager", object: "mcp_server:mcp-new-tools" },
          { user: "team:platform#member", relation: "caller", object: "tool:mcp-new-tools/*" },
          { user: "agent:agent-keep", relation: "caller", object: "tool:mcp-new-tools/*" },
        ]),
        deletes: [],
      },
      expect.objectContaining({
        caller: { type: "user", id: "alice-sub" },
        source: "mcp_server_create",
      }),
    );
    expect(mockReconcileTupleDiff.mock.calls[0][0].writes).not.toEqual(
      expect.arrayContaining([
        { user: "agent:bad agent id", relation: "caller", object: "tool:mcp-new-tools/*" },
      ]),
    );
  });

  it("backfills wildcard-enabled teams when a config-driven MCP server is reconciled", async () => {
    seedWildcardTeam();

    await reconcileConfigDrivenMcpServerRelationships({
      serverId: "mcp-config-sync",
      organizationId: "caipe",
    });

    expect(mockReadOpenFgaTuples).toHaveBeenCalledWith(
      expect.objectContaining({ tuple: { object: "tool:*" } }),
    );
    const diff = mockReconcileTupleDiff.mock.calls[0][0];
    expect(diff).toEqual(
      expect.objectContaining({
        writes: expect.arrayContaining([
          { user: "organization:caipe#member", relation: "reader", object: "mcp_server:mcp-config-sync" },
          { user: "organization:caipe#member", relation: "user", object: "mcp_server:mcp-config-sync" },
          { user: "organization:caipe#admin", relation: "manager", object: "mcp_server:mcp-config-sync" },
          { user: "team:platform#member", relation: "reader", object: "mcp_server:mcp-config-sync" },
          { user: "team:platform#member", relation: "caller", object: "tool:mcp-config-sync/*" },
          { user: "agent:agent-keep", relation: "caller", object: "tool:mcp-config-sync/*" },
        ]),
        deletes: [
          {
            user: "organization:caipe#member",
            relation: "invoker",
            object: "mcp_server:mcp-config-sync",
          },
        ],
      }),
    );
    expect(diff.writes).not.toEqual(
      expect.arrayContaining([
        {
          user: "organization:caipe#member",
          relation: "invoker",
          object: "mcp_server:mcp-config-sync",
        },
      ]),
    );
  });

  it("writes and revokes organization grants for global MCP visibility", async () => {
    await reconcileMcpServerRelationships({
      serverId: "mcp-global-tools",
      globalOrganizationAccess: true,
      previousGlobalOrganizationAccess: true,
    });

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: expect.arrayContaining([
          {
            user: "organization:caipe#member",
            relation: "reader",
            object: "mcp_server:mcp-global-tools",
          },
          {
            user: "organization:caipe#member",
            relation: "user",
            object: "mcp_server:mcp-global-tools",
          },
        ]),
        deletes: expect.arrayContaining([
          {
            user: "organization:caipe#member",
            relation: "invoker",
            object: "mcp_server:mcp-global-tools",
          },
        ]),
      },
      expect.objectContaining({ source: "mcp_server_create" }),
    );
  });

  it("deletes organization grants when a global MCP server is demoted", async () => {
    await reconcileMcpServerRelationships({
      serverId: "mcp-global-tools",
      previousGlobalOrganizationAccess: true,
      ownerTeamSlug: "primary",
    });

    const diff = mockReconcileTupleDiff.mock.calls[0][0];
    expect(diff.deletes).toEqual(expect.arrayContaining([
      { user: "organization:caipe#member", relation: "reader", object: "mcp_server:mcp-global-tools" },
      { user: "organization:caipe#member", relation: "user", object: "mcp_server:mcp-global-tools" },
      { user: "organization:caipe#member", relation: "invoker", object: "mcp_server:mcp-global-tools" },
    ]));
    expect(diff.writes).toEqual(expect.arrayContaining([
      { user: "team:primary#member", relation: "reader", object: "mcp_server:mcp-global-tools" },
    ]));
  });

  it("writes owner tuples with service_account namespace and audit caller", async () => {
    await reconcileMcpServerRelationships(
      {
        serverId: "mcp-bot-tools",
        ownerSubject: "bot-client-id",
        ownerSubjectKind: "service_account",
      },
      { source: "mcp_server_create" },
    );

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: expect.arrayContaining([
          {
            user: "service_account:bot-client-id",
            relation: "owner",
            object: "mcp_server:mcp-bot-tools",
          },
        ]),
        deletes: [],
      },
      expect.objectContaining({
        source: "mcp_server_create",
        caller: { type: "service_account", id: "bot-client-id" },
      }),
    );
  });

  it("defaults owner audit caller to user when ownerSubjectKind is omitted", async () => {
    await reconcileMcpServerRelationships({
      serverId: "mcp-ops-tools",
      ownerSubject: "alice-sub",
    });

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        caller: { type: "user", id: "alice-sub" },
        source: "mcp_server_create",
      }),
    );
  });
});

describe("private MCP wildcard isolation", () => {
  it("does not expand a wildcard team on private creation", async () => {
    mockReadOpenFgaTuples.mockImplementation(async ({ tuple }) => tuplePage(
      tuple.object === "tool:*"
        ? [{ user: "team:primary#member", relation: "caller", object: "tool:*" }]
        : [],
    ));
    await reconcileMcpServerRelationships({ serverId: "example", ownerSubject: "test-user", personalOwnerAccess: true });
    const diff = mockReconcileTupleDiff.mock.calls[0][0];
    expect(diff.writes).toEqual(expect.arrayContaining([
      { user: "user:test-user", relation: "owner", object: "mcp_server:example" },
      { user: expect.stringMatching(/^organization:/), relation: "private_marker", object: "mcp_server:example" },
    ]));
    expect(diff.writes.some((tuple: { user: string }) => tuple.user.startsWith("team:") || tuple.user.startsWith("agent:"))).toBe(false);
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
  });

  it("revokes expanded server and exact/wildcard tool grants when converting to private", async () => {
    const stale = [
      { user: "team:primary#member", relation: "invoker", object: "mcp_server:example" },
      { user: "team:primary#admin", relation: "manager", object: "mcp_server:example" },
      { user: "team:primary#member", relation: "caller", object: "tool:example/*" },
      { user: "agent:unrelated", relation: "caller", object: "tool:example/search" },
    ];
    mockReadOpenFgaTuples.mockImplementation(async ({ tuple }) => tuplePage(stale.filter((entry) =>
      tuple.object.endsWith(":") ? entry.object.startsWith(tuple.object) : entry.object === tuple.object,
    )));
    await reconcileMcpServerRelationships({ serverId: "example", ownerSubject: "test-user", personalOwnerAccess: true,
      previousGlobalOrganizationAccess: true, previousOwnerTeamSlug: "primary" });
    const diff = mockReconcileTupleDiff.mock.calls[0][0];
    expect(diff.deletes).toEqual(expect.arrayContaining(stale));
    expect(diff.writes.some((tuple: { user: string }) => tuple.user.startsWith("team:") || tuple.user === "agent:unrelated")).toBe(false);
    // A later private reconcile must not reintroduce the wildcard team's grants.
    mockReconcileTupleDiff.mockClear();
    await reconcileMcpServerRelationships({ serverId: "example", ownerSubject: "test-user", personalOwnerAccess: true });
    expect(mockReconcileTupleDiff.mock.calls[0][0].writes.some((tuple: { user: string }) => tuple.user.startsWith("team:"))).toBe(false);
  });
});

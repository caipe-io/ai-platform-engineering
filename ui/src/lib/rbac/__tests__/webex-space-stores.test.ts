import {
  WEBEX_SPACE_GRANT_RESOURCE_TYPES,
  webexSpaceSubjectId,
  webexWorkspaceRef,
} from "../webex-space-grant-store";
import { RBAC_COLLECTION_NAMES } from "../mongo-collections";

const getRbacCollection = jest.fn();
const mockCheckUniversalRebacRelationship = jest.fn();

jest.mock("../mongo-collections", () => {
  const actual = jest.requireActual("../mongo-collections");
  return {
    ...actual,
    getRbacCollection: (...args: unknown[]) => getRbacCollection(...args),
  };
});

jest.mock("../openfga", () => ({
  checkUniversalRebacRelationship: (...args: unknown[]) =>
    mockCheckUniversalRebacRelationship(...args),
}));

describe("webex-space stores", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    getRbacCollection.mockReset();
    mockCheckUniversalRebacRelationship.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses WEBEX_WORKSPACE_ALIAS before raw workspace ids", () => {
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    expect(webexWorkspaceRef("org-123")).toBe("CAIPE-WEBEX");
  });

  it("falls back to WEBEX_WORKSPACE_ID then unknown", () => {
    delete process.env.WEBEX_WORKSPACE_ALIAS;
    process.env.WEBEX_WORKSPACE_ID = "deploy-ws";
    expect(webexWorkspaceRef()).toBe("deploy-ws");
    delete process.env.WEBEX_WORKSPACE_ID;
    expect(webexWorkspaceRef()).toBe("unknown");
  });

  it("builds stable Webex space subject ids", () => {
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    expect(webexSpaceSubjectId("org-123", "space-abc")).toBe("CAIPE-WEBEX--space-abc");
  });

  it("registers Webex RBAC collections", () => {
    expect(RBAC_COLLECTION_NAMES.webexSpaceGrants).toBe("webex_space_grants");
    expect(RBAC_COLLECTION_NAMES.webexSpaceAgentRoutes).toBe("webex_space_agent_routes");
    expect(RBAC_COLLECTION_NAMES.webexSpaceTeamMappings).toBe("webex_space_team_mappings");
    expect(RBAC_COLLECTION_NAMES.webexUserMetrics).toBe("webex_user_metrics");
  });

  it("allows the same resource types as Slack channel grants", () => {
    expect(WEBEX_SPACE_GRANT_RESOURCE_TYPES).toEqual(
      new Set(["agent", "tool", "knowledge_base", "skill", "task"])
    );
  });

  it("revokes prior active manual grants but not route-owned grants", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    const toArray = jest.fn().mockResolvedValue([]);
    const sort = jest.fn().mockReturnValue({ toArray });
    const find = jest.fn().mockReturnValue({ sort });
    getRbacCollection.mockResolvedValue({ updateMany, updateOne, find });

    const { replaceWebexSpaceGrants } = await import("../webex-space-grant-store");
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    await replaceWebexSpaceGrants(
      "org-123",
      "space-abc",
      [{ workspace_id: "org-123", space_id: "space-abc", resource: { type: "agent", id: "a1" }, actions: ["use"] }],
      "admin@example.com"
    );

    expect(getRbacCollection).toHaveBeenCalledWith("webexSpaceGrants");
    expect(updateMany).toHaveBeenCalledWith(
      {
        workspace_id: "CAIPE-WEBEX",
        space_id: "space-abc",
        status: "active",
        source_type: { $ne: "route" },
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: "revoked" }) })
    );
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "CAIPE-WEBEX",
        space_id: "space-abc",
        "resource.type": "agent",
        "resource.id": "a1",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          workspace_id: "CAIPE-WEBEX",
          space_id: "space-abc",
          status: "active",
          source_type: "manual",
        }),
      }),
      { upsert: true }
    );
  });

  it("syncs route-owned agent grants without touching manual grants", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    const findOne = jest.fn().mockResolvedValue(null);
    getRbacCollection.mockResolvedValue({ updateMany, updateOne, findOne });

    const { ensureRouteOwnedAgentGrants } = await import("../webex-space-grant-store");
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    await ensureRouteOwnedAgentGrants("org-123", "space-abc", [" agent-a ", "agent-b", "  "], "ops@example.com");

    expect(updateMany).toHaveBeenCalledWith(
      {
        workspace_id: "CAIPE-WEBEX",
        space_id: "space-abc",
        source_type: "route",
        status: "active",
        "resource.type": "agent",
        "resource.id": { $nin: ["agent-a", "agent-b"] },
      },
      expect.objectContaining({ $set: expect.objectContaining({ status: "revoked" }) })
    );
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "route",
        "resource.id": "agent-a",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          source_type: "route",
          resource: { type: "agent", id: "agent-a" },
        }),
      }),
      { upsert: true }
    );
  });

  it("leaves an existing manual agent grant unchanged when syncing route-owned grants", async () => {
    const manualGrant = {
      workspace_id: "CAIPE-WEBEX",
      space_id: "space-abc",
      resource: { type: "agent", id: "shared-agent" },
      actions: ["use", "read"],
      source_type: "manual",
      status: "active",
      created_by: "admin@example.com",
      created_at: "2026-05-01T00:00:00.000Z",
    };
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    const findOne = jest.fn(async (filter: Record<string, unknown>) => {
      if (filter["resource.id"] === "shared-agent") return manualGrant;
      return null;
    });
    getRbacCollection.mockResolvedValue({ updateMany, updateOne, findOne });

    const { ensureRouteOwnedAgentGrants } = await import("../webex-space-grant-store");
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    await ensureRouteOwnedAgentGrants(
      "org-123",
      "space-abc",
      ["shared-agent", "route-only-agent"],
      "ops@example.com"
    );

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "CAIPE-WEBEX",
        space_id: "space-abc",
        status: "active",
        "resource.type": "agent",
        "resource.id": "shared-agent",
      })
    );
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "route",
        "resource.id": "route-only-agent",
      }),
      expect.any(Object),
      { upsert: true }
    );
    expect(updateOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ "resource.id": "shared-agent" }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("stores one mutable agent route per bot and space", async () => {
    const updateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const toArray = jest.fn().mockResolvedValue([]);
    const sort = jest.fn().mockReturnValue({ toArray });
    const find = jest.fn().mockReturnValue({ sort });
    getRbacCollection.mockResolvedValue({ deleteMany, updateOne, find });

    const { replaceWebexSpaceAgentRoutes } = await import("../webex-space-route-store");
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    await replaceWebexSpaceAgentRoutes(
      "org-123",
      "space-abc",
      "primary",
      [
        { workspace_id: "org-123", space_id: "space-abc", agent_id: "  agent-trimmed  " },
        { workspace_id: "org-123", space_id: "space-abc", agent_id: "   " },
      ],
      "admin@example.com"
    );

    expect(getRbacCollection).toHaveBeenCalledWith("webexSpaceAgentRoutes");
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: '["primary","CAIPE-WEBEX","space-abc"]' },
      expect.objectContaining({
        $set: expect.objectContaining({
          bot_id: "primary",
          workspace_id: "CAIPE-WEBEX",
          space_id: "space-abc",
          agent_id: "agent-trimmed",
        }),
      }),
      { upsert: true }
    );
    expect(deleteMany).toHaveBeenCalledWith({
      bot_id: "primary",
      workspace_id: "CAIPE-WEBEX",
      space_id: "space-abc",
      _id: { $ne: '["primary","CAIPE-WEBEX","space-abc"]' },
    });
  });

  it("reads only the newest route when legacy duplicates exist", async () => {
    const toArray = jest.fn().mockResolvedValue([
      {
        bot_id: "primary",
        workspace_id: "CAIPE-WEBEX",
        space_id: "space-abc",
        agent_id: "old-agent",
        status: "active",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        bot_id: "primary",
        workspace_id: "CAIPE-WEBEX",
        space_id: "space-abc",
        agent_id: "new-agent",
        status: "active",
        updated_at: "2026-02-01T00:00:00.000Z",
      },
    ]);
    const sort = jest.fn().mockReturnValue({ toArray });
    const find = jest.fn().mockReturnValue({ sort });
    getRbacCollection.mockResolvedValue({ find });

    const { listWebexSpaceAgentRoutes } = await import("../webex-space-route-store");
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    const routes = await listWebexSpaceAgentRoutes(
      "org-123",
      "space-abc",
      "primary",
    );

    expect(routes).toEqual([
      expect.objectContaining({ agent_id: "new-agent" }),
    ]);
  });

  it("builds webex_space subject refs for OpenFGA relationships", async () => {
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    const { webexSpaceSubjectRef, webexSpaceGrantRelationship } = await import("../webex-space-rebac");

    expect(webexSpaceSubjectRef("org-123", "space-1")).toEqual({
      type: "webex_space",
      id: "CAIPE-WEBEX--space-1",
    });
    expect(webexSpaceGrantRelationship("org-123", "space-1", { type: "agent", id: "a1" }, "use")).toEqual({
      subject: { type: "webex_space", id: "CAIPE-WEBEX--space-1" },
      action: "use",
      resource: { type: "agent", id: "a1" },
    });
  });

  it("checks space and user grants via the access helper", async () => {
    mockCheckUniversalRebacRelationship.mockResolvedValueOnce({ allowed: true });

    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    const { checkWebexSpaceAccess } = await import("../webex-space-rebac");
    const result = await checkWebexSpaceAccess({
      bot_id: "primary",
      workspace_id: "org-123",
      space_id: "space-abc",
      resource: { type: "agent", id: "a1" },
      action: "use",
    });

    expect(result).toEqual({
      allowed: true,
      space_allowed: true,
      reason: "allowed",
    });
    expect(mockCheckUniversalRebacRelationship).toHaveBeenCalledWith({
      subject: {
        type: "webex_bot_installation",
        id: "primary--CAIPE-WEBEX--space-abc",
      },
      action: "use",
      resource: { type: "agent", id: "a1" },
    });
  });

  it("returns false when deleting a route with a blank agent id", async () => {
    const deleteOne = jest.fn();
    getRbacCollection.mockResolvedValue({ deleteOne });

    const { deleteWebexSpaceAgentRoute } = await import("../webex-space-route-store");
    const deleted = await deleteWebexSpaceAgentRoute("org-123", "space-abc", "primary", "   ");

    expect(deleted).toBe(false);
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("trims agent id when deleting a route", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 1 });
    getRbacCollection.mockResolvedValue({ deleteMany });

    const { deleteWebexSpaceAgentRoute } = await import("../webex-space-route-store");
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    await deleteWebexSpaceAgentRoute("org-123", "space-abc", "primary", "  agent-trimmed  ");

    expect(deleteMany).toHaveBeenCalledWith({
      workspace_id: "CAIPE-WEBEX",
      space_id: "space-abc",
      bot_id: "primary",
      agent_id: "agent-trimmed",
    });
  });

  it("denies unsupported resource types with unsupported_resource", async () => {
    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    const { checkWebexSpaceAccess } = await import("../webex-space-rebac");

    const result = await checkWebexSpaceAccess({
      bot_id: "primary",
      workspace_id: "org-123",
      space_id: "space-abc",
      resource: { type: "conversation", id: "c1" },
      action: "use",
    });

    expect(result).toEqual({
      allowed: false,
      space_allowed: false,
      reason: "unsupported_resource",
    });
    expect(mockCheckUniversalRebacRelationship).not.toHaveBeenCalled();
  });

  it("denies access when the space grant is missing", async () => {
    mockCheckUniversalRebacRelationship.mockResolvedValueOnce({ allowed: false });

    process.env.WEBEX_WORKSPACE_ALIAS = "CAIPE-WEBEX";
    const { checkWebexSpaceAccess } = await import("../webex-space-rebac");
    const result = await checkWebexSpaceAccess({
      bot_id: "primary",
      workspace_id: "org-123",
      space_id: "space-abc",
      resource: { type: "agent", id: "a1" },
      action: "use",
    });

    expect(result).toEqual({
      allowed: false,
      space_allowed: false,
      reason: "missing_space_grant",
    });
    expect(mockCheckUniversalRebacRelationship).toHaveBeenCalledTimes(1);
  });
});

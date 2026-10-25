jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/credentials/secret-openfga", () => ({
  reconcileSecretRefOwnerRelationships: jest.fn(),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileConfigDrivenMcpServerRelationships: jest.fn(),
  reconcileMcpServerRelationships: jest.fn(),
}));

import {
  applyPrivateResourceVisibilityMigration,
  classifyLegacyMcpVisibility,
  classifyLegacySecretVisibility,
  derivePrivateResourceVisibilityPlan,
} from "../private-resource-visibility";
import { getCollection } from "@/lib/mongodb";
import { reconcileSecretRefOwnerRelationships } from "@/lib/credentials/secret-openfga";
import {
  reconcileConfigDrivenMcpServerRelationships,
  reconcileMcpServerRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";

describe("private resource visibility migration", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    [{ _id: "mcp-personal", owner_subject: "user-sub" }, "global"],
    [{ _id: "mcp-team", owner_subject: "user-sub", owner_team_slug: "primary" }, "global"],
    [{ _id: "mcp-config", config_driven: true }, "global"],
    [{ _id: "mcp-discovered", agentgateway_discovered: true }, "global"],
    [{ _id: "mcp-service", owner_subject: "service-sub", owner_subject_kind: "service_account" }, "global"],
    [{ _id: "mcp-orphan" }, "global"],
  ] as const)("classifies legacy MCP scope %#", (doc, expected) => {
    expect(classifyLegacyMcpVisibility(doc)).toBe(expected);
  });

  it.each(["private", "team", "global"] as const)(
    "preserves an explicit %s MCP visibility",
    (visibility) => {
      expect(classifyLegacyMcpVisibility({ _id: `mcp-${visibility}`, visibility })).toBe(visibility);
    },
  );

  it.each([
    [{ id: "private-secret", owner: { type: "user", id: "user-sub" }, sharedWithTeams: [] }, "private"],
    [{ id: "shared-secret", owner: { type: "user", id: "user-sub" }, sharedWithTeams: ["primary"] }, "team"],
    [{ id: "team-secret", owner: { type: "team", id: "primary" }, sharedWithTeams: [] }, "team"],
  ] as const)("classifies legacy secret scope %#", (doc, expected) => {
    expect(classifyLegacySecretVisibility(doc)).toBe(expected);
  });

  it("plans every legacy MCP server as global without mutating it", () => {
    const plan = derivePrivateResourceVisibilityPlan({
      mcpServers: [
        { _id: "mcp-private", owner_subject: "user-sub" },
        { _id: "mcp-shared", owner_subject: "user-sub", owner_team_slug: "primary" },
        { _id: "mcp-platform", agentgateway_discovered: true },
        { _id: "mcp-orphan" },
        { _id: "mcp-explicit-private", visibility: "private" },
        { _id: "mcp-explicit-team", visibility: "team" },
        { _id: "mcp-explicit-global", visibility: "global" },
      ],
      secrets: [
        { id: "secret-private", owner: { type: "user", id: "user-sub" }, sharedWithTeams: [] },
        { id: "secret-shared", owner: { type: "user", id: "user-sub" }, sharedWithTeams: ["secondary"] },
      ],
    });

    expect(plan.mcp_updates).toEqual([
      { id: "mcp-private", visibility: "global" },
      { id: "mcp-shared", visibility: "global" },
      { id: "mcp-platform", visibility: "global" },
      { id: "mcp-orphan", visibility: "global" },
    ]);
    expect(plan.secret_updates).toEqual([
      { id: "secret-private", visibility: "private" },
      { id: "secret-shared", visibility: "team" },
    ]);
    expect(plan.counts.unresolved_mcp_servers).toBe(0);
    expect(plan.warnings).toEqual([]);
  });

  it("reconciles legacy owner and team grants to global through one CAS diff", async () => {
    const mcpUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const secretUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const mcpServers = [
      { _id: "mcp-private", owner_subject: "private-owner" },
      {
        _id: "mcp-team",
        owner_subject: "legacy-owner",
        owner_team_slug: "primary",
        shared_with_teams: ["secondary"],
      },
      { _id: "mcp-platform", agentgateway_discovered: true },
    ];
    const secrets = [
      { id: "secret-private", owner: { type: "user" as const, id: "private-owner" } },
    ];
    jest.mocked(getCollection).mockImplementation(async (name: string) => {
      if (name === "mcp_servers") {
        return {
          find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(mcpServers) }),
          updateOne: mcpUpdateOne,
        } as never;
      }
      return {
        find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(secrets) }),
        updateOne: secretUpdateOne,
      } as never;
    });
    jest.mocked(reconcileMcpServerRelationships).mockResolvedValue({} as never);
    jest.mocked(reconcileConfigDrivenMcpServerRelationships).mockResolvedValue({} as never);
    jest.mocked(reconcileSecretRefOwnerRelationships).mockResolvedValue({} as never);

    const result = await applyPrivateResourceVisibilityMigration({
      actor: "test-admin",
      now: "2026-08-13T00:00:00.000Z",
    });

    expect(reconcileMcpServerRelationships).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverId: "mcp-private",
        ownerSubject: "private-owner",
        personalOwnerAccess: false,
        previousPersonalOwnerAccess: true,
        globalOrganizationAccess: true,
      }),
      expect.objectContaining({ source: "private_resource_visibility_migration" }),
    );
    expect(reconcileMcpServerRelationships).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        serverId: "mcp-team",
        ownerSubject: "legacy-owner",
        previousOwnerTeamSlug: "primary",
        personalOwnerAccess: false,
        previousPersonalOwnerAccess: true,
        nextSharedTeamSlugs: [],
        previousSharedTeamSlugs: ["secondary"],
        globalOrganizationAccess: true,
      }),
      expect.objectContaining({ source: "private_resource_visibility_migration" }),
    );
    expect(mcpUpdateOne).toHaveBeenCalledWith(
      { _id: "mcp-team" },
      {
        $set: { visibility: "global", shared_with_teams: [] },
        $unset: { owner_subject: "", owner_subject_kind: "", owner_team_slug: "" },
      },
    );
    expect(reconcileSecretRefOwnerRelationships).toHaveBeenCalledWith({
      secretId: "secret-private",
      owner: { type: "user", id: "private-owner" },
      ownerSubject: "private-owner",
    });
    expect(reconcileConfigDrivenMcpServerRelationships).toHaveBeenCalledWith({
      serverId: "mcp-platform",
    });
    expect(mcpUpdateOne).toHaveBeenCalledWith(
      { _id: "mcp-platform" },
      {
        $set: { visibility: "global", shared_with_teams: [] },
        $unset: { owner_subject: "", owner_subject_kind: "", owner_team_slug: "" },
      },
    );
    expect(result.applied_counts).toEqual({ mcp_servers_updated: 3, secrets_updated: 1 });
  });
});

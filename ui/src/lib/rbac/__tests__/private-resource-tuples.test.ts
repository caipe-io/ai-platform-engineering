import { buildAgentRelationshipTupleDiff } from "../openfga-agent-tools";
import { buildMcpServerRelationshipTupleDiff } from "../openfga-owned-resources";

jest.mock("@/lib/authz", () => ({ reconcileTupleDiff: jest.fn() }));

describe("private resource tuple projections", () => {
  it("gives a private agent only creator and owner access", () => {
    const diff = buildAgentRelationshipTupleDiff({
      agentId: "agent-example",
      nextAllowedTools: {},
      ownerSubject: "test-user",
      creatorSubject: "test-user",
      personalOwnerAccess: true,
      organizationId: "caipe",
    });

    expect(diff.writes).toEqual(expect.arrayContaining([
      { user: "user:test-user", relation: "creator", object: "agent:agent-example" },
      { user: "user:test-user", relation: "owner", object: "agent:agent-example" },
    ]));
    expect(diff.writes).not.toContainEqual(
      { user: "organization:caipe#admin", relation: "manager", object: "agent:agent-example" },
    );
    expect(diff.deletes).toContainEqual(
      { user: "organization:caipe#admin", relation: "manager", object: "agent:agent-example" },
    );
  });

  it("gives a private MCP server creator and owner access without org-admin management", () => {
    const diff = buildMcpServerRelationshipTupleDiff({
      serverId: "mcp-example",
      ownerSubject: "test-user",
      creatorSubject: "test-user",
      personalOwnerAccess: true,
    });

    expect(diff.writes).toEqual(expect.arrayContaining([
      { user: "user:test-user", relation: "creator", object: "mcp_server:mcp-example" },
      { user: "user:test-user", relation: "owner", object: "mcp_server:mcp-example" },
    ]));
    expect(diff.deletes).toContainEqual(
      { user: "organization:caipe#admin", relation: "manager", object: "mcp_server:mcp-example" },
    );
  });

  it("removes personal owner when an MCP server becomes team-owned", () => {
    const diff = buildMcpServerRelationshipTupleDiff({
      serverId: "mcp-example",
      ownerSubject: "test-user",
      ownerTeamSlug: "example-team",
      personalOwnerAccess: false,
      previousPersonalOwnerAccess: true,
    });

    expect(diff.deletes).toContainEqual(
      { user: "user:test-user", relation: "owner", object: "mcp_server:mcp-example" },
    );
  });

  it("removes a legacy owner when broadening visibility", () => {
    const diff = buildMcpServerRelationshipTupleDiff({
      serverId: "mcp-example",
      ownerSubject: "test-user",
      personalOwnerAccess: false,
      previousPersonalOwnerAccess: true,
      globalOrganizationAccess: true,
    });

    expect(diff.deletes).toContainEqual(
      { user: "user:test-user", relation: "owner", object: "mcp_server:mcp-example" },
    );
  });

  it("reconciles additional MCP team grants without granting management", () => {
    const diff = buildMcpServerRelationshipTupleDiff({
      serverId: "mcp-example",
      ownerTeamSlug: "primary",
      previousOwnerTeamSlug: "primary",
      nextSharedTeamSlugs: ["secondary"],
      previousSharedTeamSlugs: ["legacy"],
    });

    expect(diff.writes).toEqual(expect.arrayContaining([
      { user: "team:secondary#member", relation: "reader", object: "mcp_server:mcp-example" },
      { user: "team:secondary#member", relation: "user", object: "mcp_server:mcp-example" },
      { user: "team:secondary#member", relation: "invoker", object: "mcp_server:mcp-example" },
    ]));
    expect(diff.writes).not.toContainEqual(
      { user: "team:secondary#admin", relation: "manager", object: "mcp_server:mcp-example" },
    );
    expect(diff.deletes).toEqual(expect.arrayContaining([
      { user: "team:legacy#member", relation: "reader", object: "mcp_server:mcp-example" },
      { user: "team:legacy#member", relation: "user", object: "mcp_server:mcp-example" },
      { user: "team:legacy#member", relation: "invoker", object: "mcp_server:mcp-example" },
    ]));
  });
});

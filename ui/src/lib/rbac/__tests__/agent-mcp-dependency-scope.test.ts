jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: jest.fn() }));

import { validateAgentMcpDependencyScopes } from "../agent-mcp-dependency-scope";
import type { MCPServerConfig } from "@/types/dynamic-agent";

function server(
  id: string,
  visibility: "private" | "team" | "global",
  extra: Partial<MCPServerConfig> = {},
): MCPServerConfig {
  return {
    _id: id,
    name: id,
    transport: "http",
    enabled: true,
    visibility,
    created_at: "2026-09-08T00:00:00.000Z",
    updated_at: "2026-09-08T00:00:00.000Z",
    ...extra,
  };
}

describe("agent MCP dependency visibility", () => {
  it("allows private dependencies only for a private agent with the same owner", async () => {
    await expect(validateAgentMcpDependencyScopes({
      agent: { visibility: "private", ownerSubject: "user-a" },
      allowedTools: { "mcp-private": true },
      servers: [server("mcp-private", "private", { owner_subject: "user-a" })],
    })).resolves.toBeUndefined();

    await expect(validateAgentMcpDependencyScopes({
      agent: { visibility: "private", ownerSubject: "user-a" },
      allowedTools: { "mcp-private": true },
      servers: [server("mcp-private", "private", { owner_subject: "user-b" })],
    })).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
  });

  it("rejects a team or global agent that references a narrower MCP server", async () => {
    await expect(validateAgentMcpDependencyScopes({
      agent: { visibility: "team", ownerSubject: "user-a", ownerTeamSlug: "primary" },
      allowedTools: { "mcp-private": true },
      servers: [server("mcp-private", "private", { owner_subject: "user-a" })],
    })).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
    await expect(validateAgentMcpDependencyScopes({
      agent: { visibility: "global", ownerSubject: "user-a" },
      allowedTools: { "mcp-team": true },
      servers: [server("mcp-team", "team", { owner_team_slug: "primary" })],
    })).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
  });

  it("requires every team that can use an agent to be covered by its MCP server", async () => {
    const agent = {
      visibility: "team" as const,
      ownerSubject: "user-a",
      ownerTeamSlug: "primary",
      sharedTeamSlugs: ["secondary"],
    };
    await expect(validateAgentMcpDependencyScopes({
      agent,
      allowedTools: { "mcp-team": true },
      servers: [server("mcp-team", "team", {
        owner_team_slug: "primary",
        shared_with_teams: ["secondary"],
      })],
    })).resolves.toBeUndefined();
    await expect(validateAgentMcpDependencyScopes({
      agent,
      allowedTools: { "mcp-team": true },
      servers: [server("mcp-team", "team", { owner_team_slug: "primary" })],
    })).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
  });

  it("requires a private-agent owner to be able to invoke a selected team MCP server", async () => {
    const canInvokeServer = jest.fn(async () => false);
    await expect(validateAgentMcpDependencyScopes({
      agent: { visibility: "private", ownerSubject: "user-a" },
      allowedTools: { "mcp-team": true },
      servers: [server("mcp-team", "team", { owner_team_slug: "primary" })],
      canInvokeServer,
    })).rejects.toMatchObject({ code: "PRIVATE_RESOURCE_DEPENDENCY_DENIED" });
    expect(canInvokeServer).toHaveBeenCalledWith("mcp-team");
  });
});

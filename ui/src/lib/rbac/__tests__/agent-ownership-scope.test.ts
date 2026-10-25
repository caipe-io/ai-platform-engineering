// assisted-by Codex Codex-sonnet-4-6

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async () => ({ findOne: jest.fn(async () => null) })),
  isMongoDBConfigured: false,
}));
jest.mock("@/lib/authz", () => ({
  authorize: jest.fn(),
}));

import { authorize } from "@/lib/authz";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";

import {
  filterAgentsByOwnershipScope,
  filterAgentsByOwnershipScopeForSession,
  filterPrivateAgentsByOwner,
  isPrivateAgentOwner,
  isAgentInOwnershipScope,
  type AgentOwnershipScopeContext,
} from "../agent-ownership-scope";

const mockAuthorize = authorize as jest.MockedFunction<typeof authorize>;

function ctx(overrides: Partial<AgentOwnershipScopeContext> = {}): AgentOwnershipScopeContext {
  return {
    userSub: "generic-sub",
    teamSlugs: new Set(["platform"]),
    platformDefaultAgentId: null,
    ...overrides,
  };
}

function agent(
  overrides: Partial<DynamicAgentConfig> & { _id: string },
): DynamicAgentConfig {
  return {
    name: overrides._id,
    description: "",
    system_prompt: "test",
    allowed_tools: {},
    model: { id: "gpt-4o", provider: "openai" },
    visibility: "team",
    subagents: [],
    skills: [],
    enabled: true,
    owner_id: "owner-sub",
    owner_team_slug: "super-admins",
    shared_with_teams: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as DynamicAgentConfig;
}

describe("isAgentInOwnershipScope", () => {
  it("includes global agents for any user", () => {
    expect(
      isAgentInOwnershipScope(agent({ _id: "hello-world", visibility: "global" }), ctx()),
    ).toBe(true);
  });

  it("includes the configured platform default agent even when team-scoped", () => {
    expect(
      isAgentInOwnershipScope(
        agent({ _id: "sre-agent", visibility: "team", owner_team_slug: "super-admins" }),
        ctx({ platformDefaultAgentId: "sre-agent", teamSlugs: new Set() }),
      ),
    ).toBe(true);
  });

  it("includes team agents owned by the user's teams", () => {
    expect(
      isAgentInOwnershipScope(
        agent({ _id: "team-agent", owner_team_slug: "platform" }),
        ctx(),
      ),
    ).toBe(true);
  });

  it("includes agents explicitly shared with the user's team", () => {
    expect(
      isAgentInOwnershipScope(
        agent({
          _id: "shared-agent",
          owner_team_slug: "super-admins",
          shared_with_teams: ["platform"],
        }),
        ctx(),
      ),
    ).toBe(true);
  });

  it("includes agents owned directly by the user", () => {
    expect(
      isAgentInOwnershipScope(
        agent({ _id: "mine", owner_id: "generic-sub", owner_team_slug: "super-admins" }),
        ctx(),
      ),
    ).toBe(true);
  });

  it("includes a private agent only for its direct owner", () => {
    const privateAgent = agent({
      _id: "private-agent",
      visibility: "private",
      owner_id: "owner@example.test",
      owner_subject: "owner-sub",
      owner_team_slug: undefined,
    });

    expect(isAgentInOwnershipScope(privateAgent, ctx({ userSub: "owner-sub" }))).toBe(true);
    expect(isAgentInOwnershipScope(privateAgent, ctx({ userSub: "other-sub" }))).toBe(false);
  });

  it("does not expose a private agent through the platform-default exception", () => {
    expect(
      isAgentInOwnershipScope(
        agent({
          _id: "private-default",
          visibility: "private",
          owner_subject: "owner-sub",
        }),
        ctx({ userSub: "other-sub", platformDefaultAgentId: "private-default" }),
      ),
    ).toBe(false);
  });

  it("excludes other teams' agents for a generic member", () => {
    expect(
      isAgentInOwnershipScope(
        agent({ _id: "private-project", name: "Private Project Agent", owner_team_slug: "super-admins" }),
        ctx(),
      ),
    ).toBe(false);
    expect(
      isAgentInOwnershipScope(
        agent({ _id: "test4-argocd", name: "Test4 ArgoCD", owner_team_slug: "sre" }),
        ctx(),
      ),
    ).toBe(false);
  });
});

describe("isPrivateAgentOwner", () => {
  it("requires private visibility and a matching stable subject", () => {
    const privateAgent = agent({
      _id: "private-agent",
      visibility: "private",
      owner_subject: "owner-sub",
    });

    expect(isPrivateAgentOwner(privateAgent, "owner-sub")).toBe(true);
    expect(isPrivateAgentOwner(privateAgent, "other-sub")).toBe(false);
    expect(isPrivateAgentOwner({ ...privateAgent, visibility: "team" }, "owner-sub")).toBe(false);
  });
});

describe("filterPrivateAgentsByOwner", () => {
  it("keeps team/global agents for admins but hides private agents they do not own", () => {
    const agents = [
      agent({ _id: "global-agent", visibility: "global" }),
      agent({ _id: "team-agent", visibility: "team" }),
      agent({ _id: "owned-private", visibility: "private", owner_subject: "admin-sub" }),
      agent({ _id: "other-private", visibility: "private", owner_subject: "other-sub" }),
    ];

    expect(filterPrivateAgentsByOwner(agents, "admin-sub").map((item) => item._id)).toEqual([
      "global-agent",
      "team-agent",
      "owned-private",
    ]);
  });

  it("applies the private owner filter when the session is an organization admin", async () => {
    mockAuthorize.mockResolvedValue({ decision: "ALLOW" } as Awaited<ReturnType<typeof authorize>>);
    const agents = [
      agent({ _id: "team-agent", visibility: "team" }),
      agent({ _id: "owned-private", visibility: "private", owner_subject: "admin-sub" }),
      agent({ _id: "other-private", visibility: "private", owner_subject: "other-sub" }),
    ];

    const filtered = await filterAgentsByOwnershipScopeForSession(
      { sub: "admin-sub", role: "admin" },
      agents,
      null,
    );

    expect(filtered.map((item) => item._id)).toEqual(["team-agent", "owned-private"]);
  });
});

describe("filterAgentsByOwnershipScope", () => {
  it("keeps only in-scope agents", () => {
    const agents = [
      agent({ _id: "hello-world", visibility: "global" }),
      agent({ _id: "private-project", owner_team_slug: "super-admins" }),
      agent({ _id: "platform-agent", owner_team_slug: "platform" }),
    ];
    const filtered = filterAgentsByOwnershipScope(agents, ctx());
    expect(filtered.map((a) => a._id)).toEqual(["hello-world", "platform-agent"]);
  });
});

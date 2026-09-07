/**
 * @jest-environment node
 */

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: async (diff: { writes: unknown[]; deletes: unknown[] }) => {
    const { writeOpenFgaTupleDiff } = jest.requireActual("../openfga") as typeof import("../openfga");
    return writeOpenFgaTupleDiff(diff);
  },
}));

// assisted-by Codex Codex-sonnet-4-6
const mockTeamsCollection = {
  find: jest.fn(() => ({ toArray: jest.fn(async () => []) })),
};
const mockGetCollection = jest.fn(async () => mockTeamsCollection);

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildTeamResourceTupleDiff,
  buildUniversalRebacTupleDiff,
  checkOpenFgaTuple,
  checkUniversalRebacRelationship,
  isOpenFgaReconciliationEnabled,
  readOpenFgaTuples,
  resetOpenFgaStoreIdCacheForTests,
  writeOpenFgaTupleDiff,
  writeUniversalRebacTupleDiff,
} from "../openfga";
import {
  buildAgentRelationshipTupleDiff,
  buildAgentToolTupleDiff,
  deleteAllAgentToolTuples,
} from "../openfga-agent-tools";
import {
  buildConfigDrivenLlmModelRelationshipTupleDiff,
  buildConfigDrivenMcpServerRelationshipTupleDiff,
  buildLlmModelRelationshipTupleDiff,
  buildKnowledgeBaseRelationshipTupleDiff,
  buildMcpServerRelationshipTupleDiff,
} from "../openfga-owned-resources";
import { reconcileMcpServerRelationships } from "../openfga-owned-resources-reconcile";

function agentUserTypes(modelPath: string): Array<Record<string, unknown>> {
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as {
    type_definitions?: Array<{
      type?: string;
      metadata?: { relations?: { user?: { directly_related_user_types?: Array<Record<string, unknown>> } } };
    }>;
  };
  return (
    model.type_definitions?.find((definition) => definition.type === "agent")?.metadata?.relations?.user
      ?.directly_related_user_types ?? []
  );
}

function directlyRelatedUserTypes(
  modelPath: string,
  type: string,
  relation: string
): Array<Record<string, unknown>> {
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as {
    type_definitions?: Array<{
      type?: string;
      metadata?: { relations?: Record<string, { directly_related_user_types?: Array<Record<string, unknown>> }> };
    }>;
  };
  return (
    model.type_definitions?.find((definition) => definition.type === type)?.metadata?.relations?.[relation]
      ?.directly_related_user_types ?? []
  );
}

function agentRelationNames(modelPath: string): string[] {
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as {
    type_definitions?: Array<{ type?: string; relations?: Record<string, unknown> }>;
  };
  return Object.keys(model.type_definitions?.find((definition) => definition.type === "agent")?.relations ?? {});
}

function resourceRelationNames(modelPath: string, type: string): string[] {
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as {
    type_definitions?: Array<{ type?: string; relations?: Record<string, unknown> }>;
  };
  return Object.keys(model.type_definitions?.find((definition) => definition.type === type)?.relations ?? {});
}

describe("OpenFGA team resource tuple reconciliation", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    resetOpenFgaStoreIdCacheForTests();
    mockGetCollection.mockClear();
    mockTeamsCollection.find.mockClear();
    delete process.env.OPENFGA_RECONCILE_ENABLED;
    delete process.env.OPENFGA_HTTP;
    delete process.env.OPENFGA_STORE_NAME;
    delete process.env.CAIPE_UNSAFE_RBAC_BYPASS;
  });

  it("maps team members and resource diffs to OpenFGA tuples", () => {
    const diff = buildTeamResourceTupleDiff({
      teamSlug: "platform-engineering",
      agents: { added: ["agent-1"], removed: ["agent-old"] },
      agentAdmins: { added: ["agent-admin"], removed: [] },
      tools: { added: ["jira_*"], removed: ["github_*"] },
      toolWildcard: { added: true, removed: false },
      allMcpServerIds: ["jira", "github"],
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:platform-engineering#member", relation: "user", object: "agent:agent-1" },
        {
          user: "team:platform-engineering#admin",
          relation: "manager",
          object: "agent:agent-admin",
        },
        { user: "team:platform-engineering#member", relation: "reader", object: "mcp_server:jira" },
        { user: "team:platform-engineering#member", relation: "user", object: "mcp_server:jira" },
        { user: "team:platform-engineering#member", relation: "invoker", object: "mcp_server:jira" },
        { user: "team:platform-engineering#admin", relation: "manager", object: "mcp_server:jira" },
        { user: "organization:caipe#admin", relation: "manager", object: "mcp_server:jira" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:jira/*" },
        { user: "agent:agent-1", relation: "caller", object: "tool:jira/*" },
        { user: "agent:agent-1", relation: "caller", object: "tool:github/*" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:github/*" },
      ]),
    );
    expect(diff.writes).not.toEqual(
      expect.arrayContaining([
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:*" },
      ]),
    );
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        {
          user: "team:platform-engineering#member",
          relation: "user",
          object: "agent:agent-old",
        },
        { user: "team:platform-engineering#member", relation: "reader", object: "mcp_server:github" },
        { user: "team:platform-engineering#member", relation: "user", object: "mcp_server:github" },
        { user: "team:platform-engineering#member", relation: "invoker", object: "mcp_server:github" },
        { user: "team:platform-engineering#admin", relation: "manager", object: "mcp_server:github" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:github/*" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:github_*" },
        { user: "team:platform-engineering#member", relation: "reader", object: "mcp_tool:github_*" },
        { user: "team:platform-engineering#member", relation: "user", object: "mcp_tool:github_*" },
        { user: "team:platform-engineering#member", relation: "caller", object: "mcp_tool:github_*" },
        { user: "team:platform-engineering#admin", relation: "manager", object: "mcp_tool:github_*" },
        { user: "agent:agent-old", relation: "caller", object: "tool:jira/*" },
        { user: "agent:agent-old", relation: "caller", object: "tool:github/*" },
      ]),
    );
    expect(diff.deletes).not.toEqual(
      expect.arrayContaining([
        { user: "agent:agent-old", relation: "caller", object: "tool:*" },
      ]),
    );
  });

  it("does not delete org-admin MCP server manager grants when a team unassigns a server", () => {
    // assisted-by Codex Codex-sonnet-4-6
    const diff = buildTeamResourceTupleDiff({
      teamSlug: "platform-engineering",
      agents: { added: [], removed: [] },
      agentAdmins: { added: [], removed: [] },
      tools: { added: ["mcp-confluence-mcp_*"], removed: ["mcp-litellm_*"] },
      toolWildcard: { added: false, removed: false },
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:platform-engineering#admin", relation: "manager", object: "mcp_server:mcp-confluence-mcp" },
        { user: "organization:caipe#admin", relation: "manager", object: "mcp_server:mcp-confluence-mcp" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:mcp-confluence-mcp/*" },
      ]),
    );
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        { user: "team:platform-engineering#admin", relation: "manager", object: "mcp_server:mcp-litellm" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:mcp-litellm/*" },
        { user: "team:platform-engineering#member", relation: "caller", object: "tool:mcp-litellm_*" },
        { user: "team:platform-engineering#member", relation: "caller", object: "mcp_tool:mcp-litellm_*" },
      ]),
    );
    expect(diff.deletes).not.toContainEqual({
      user: "organization:caipe#admin",
      relation: "manager",
      object: "mcp_server:mcp-litellm",
    });
  });

  it("allows tuple checks without OpenFGA when the unsafe bypass flag is enabled", async () => {
    process.env.CAIPE_UNSAFE_RBAC_BYPASS = "true";
    global.fetch = jest.fn();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      checkOpenFgaTuple({
        user: "user:alice",
        relation: "can_manage",
        object: "organization:caipe",
      })
    ).resolves.toEqual({ allowed: true });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("RBAC IS DISABLED"));
    warnSpy.mockRestore();
  });

  it("writes manager grants with admin usersets that match the OpenFGA model", () => {
    const diff = buildTeamResourceTupleDiff({
      teamSlug: "platform-engineering",
      agents: { added: [], removed: [] },
      agentAdmins: { added: ["agent-admin"], removed: ["agent-admin-old"] },
      tools: { added: [], removed: [] },
      knowledgeBases: { added: [], removed: [] },
      toolWildcard: { added: false, removed: false },
    });

    expect(diff.writes).toContainEqual({
      user: "team:platform-engineering#admin",
      relation: "manager",
      object: "agent:agent-admin",
    });
    expect(diff.deletes).toContainEqual({
      user: "team:platform-engineering#admin",
      relation: "manager",
      object: "agent:agent-admin-old",
    });
    expect(diff.writes).not.toContainEqual({
      user: "team:platform-engineering#member",
      relation: "manager",
      object: "agent:agent-admin",
    });
  });

  it("allows typed user wildcards on agent user relation in shipped authorization models", () => {
    const modelPaths = [
      path.join(process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json"),
    ];

    for (const modelPath of modelPaths) {
      expect(agentUserTypes(modelPath)).toContainEqual({ type: "user", wildcard: {} });
    }
  });

  it("defines agent can_delete in shipped authorization models", () => {
    const modelPaths = [
      path.join(process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json"),
    ];

    for (const modelPath of modelPaths) {
      expect(agentRelationNames(modelPath)).toContain("can_delete");
    }
  });

  it("defines self-service ownership relations in shipped authorization models", () => {
    const modelPaths = [
      path.join(process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json"),
    ];

    for (const modelPath of modelPaths) {
      expect(resourceRelationNames(modelPath, "team")).toEqual(
        expect.arrayContaining(["can_read", "can_use", "can_manage"]),
      );
      expect(resourceRelationNames(modelPath, "mcp_server")).toEqual(
        expect.arrayContaining(["owner", "can_delete"]),
      );
      expect(resourceRelationNames(modelPath, "llm_model")).toEqual(
        expect.arrayContaining(["owner", "can_read", "can_write", "can_delete"]),
      );
      expect(resourceRelationNames(modelPath, "secret_ref")).toEqual(
        expect.arrayContaining(["can_read_metadata", "can_use", "can_manage", "can_share", "can_audit"]),
      );
      expect(resourceRelationNames(modelPath, "slack_channel")).toContain("owner");
      expect(resourceRelationNames(modelPath, "webex_space")).toContain("owner");
    }
  });

  it("defines RAG data source and custom MCP tool types in shipped authorization models", () => {
    const modelPaths = [
      path.join(process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json"),
    ];

    for (const modelPath of modelPaths) {
      expect(resourceRelationNames(modelPath, "data_source")).toEqual(
        expect.arrayContaining(["can_read", "can_ingest", "can_manage"]),
      );
      expect(resourceRelationNames(modelPath, "mcp_tool")).toEqual(
        expect.arrayContaining(["can_read", "can_use", "can_call", "can_manage"]),
      );
    }
  });

  it("keeps manager tuple schemas aligned with tuple writers across all packaged models", () => {
    const modelPaths = [
      path.join(process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json"),
    ];

    for (const modelPath of modelPaths) {
      expect(directlyRelatedUserTypes(modelPath, "agent", "manager")).toContainEqual({
        type: "team",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "agent", "manager")).toContainEqual({
        type: "team",
        relation: "member",
      });
      expect(directlyRelatedUserTypes(modelPath, "knowledge_base", "manager")).toContainEqual({
        type: "team",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "slack_channel", "manager")).toContainEqual({
        type: "team",
        relation: "member",
      });
      expect(directlyRelatedUserTypes(modelPath, "mcp_server", "manager")).toContainEqual({
        type: "team",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "mcp_server", "reader")).toContainEqual({
        type: "organization",
        relation: "member",
      });
      expect(directlyRelatedUserTypes(modelPath, "mcp_server", "manager")).toContainEqual({
        type: "organization",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "llm_model", "manager")).toContainEqual({
        type: "team",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "llm_model", "reader")).toContainEqual({
        type: "organization",
        relation: "member",
      });
      expect(directlyRelatedUserTypes(modelPath, "llm_model", "manager")).toContainEqual({
        type: "organization",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "admin_surface", "manager")).toContainEqual({
        type: "organization",
        relation: "admin",
      });
      expect(directlyRelatedUserTypes(modelPath, "secret_ref", "metadata_reader")).toContainEqual({
        type: "team",
        relation: "member",
      });
    }
  });

  it("builds owner and team grant tuples for self-service resources", () => {
    expect(
      buildMcpServerRelationshipTupleDiff({
        serverId: "mcp-team-tools",
        ownerSubject: "alice-sub",
        ownerTeamSlug: "platform",
      }).writes,
    ).toEqual([
      { user: "user:alice-sub", relation: "owner", object: "mcp_server:mcp-team-tools" },
      { user: "team:platform#member", relation: "reader", object: "mcp_server:mcp-team-tools" },
      { user: "team:platform#member", relation: "user", object: "mcp_server:mcp-team-tools" },
      { user: "team:platform#member", relation: "invoker", object: "mcp_server:mcp-team-tools" },
      { user: "team:platform#admin", relation: "manager", object: "mcp_server:mcp-team-tools" },
      { user: "organization:caipe#admin", relation: "manager", object: "mcp_server:mcp-team-tools" },
    ]);
    expect(
      buildMcpServerRelationshipTupleDiff({
        serverId: "mcp-bot-tools",
        ownerSubject: "bot-client-id",
        ownerSubjectKind: "service_account",
      }).writes,
    ).toEqual(
      expect.arrayContaining([
        { user: "service_account:bot-client-id", relation: "owner", object: "mcp_server:mcp-bot-tools" },
      ]),
    );
    expect(
      buildConfigDrivenMcpServerRelationshipTupleDiff({
        serverId: "argocd",
        organizationId: "grid",
      }),
    ).toEqual({
      writes: [
        { user: "organization:grid#member", relation: "reader", object: "mcp_server:argocd" },
        { user: "organization:grid#member", relation: "user", object: "mcp_server:argocd" },
        { user: "organization:grid#admin", relation: "manager", object: "mcp_server:argocd" },
      ],
      deletes: [
        { user: "organization:grid#member", relation: "invoker", object: "mcp_server:argocd" },
      ],
    });
    expect(
      buildLlmModelRelationshipTupleDiff({
        modelId: "anthropic/claude-sonnet",
        ownerSubject: "alice-sub",
        ownerTeamSlug: "platform",
      }).writes,
    ).toEqual([
      { user: "user:alice-sub", relation: "owner", object: "llm_model:anthropic/claude-sonnet" },
      { user: "team:platform#member", relation: "reader", object: "llm_model:anthropic/claude-sonnet" },
      { user: "team:platform#admin", relation: "manager", object: "llm_model:anthropic/claude-sonnet" },
    ]);
    expect(
      buildConfigDrivenLlmModelRelationshipTupleDiff({
        modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        organizationId: "grid",
      }).writes,
    ).toEqual([
      {
        user: "organization:grid#member",
        relation: "reader",
        object: `llm_model:b64_${Buffer.from("global.anthropic.claude-haiku-4-5-20251001-v1:0", "utf8").toString("base64url")}`,
      },
      {
        user: "organization:grid#admin",
        relation: "manager",
        object: `llm_model:b64_${Buffer.from("global.anthropic.claude-haiku-4-5-20251001-v1:0", "utf8").toString("base64url")}`,
      },
    ]);
    expect(
      buildKnowledgeBaseRelationshipTupleDiff({
        knowledgeBaseId: "kb-team",
        ownerSubject: "alice-sub",
        ownerTeamSlug: "platform",
      }).writes,
    ).toEqual([
      { user: "user:alice-sub", relation: "owner", object: "knowledge_base:kb-team" },
      { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-team" },
      { user: "team:platform#admin", relation: "manager", object: "knowledge_base:kb-team" },
    ]);
  });

  it("defaults reconcile on when OpenFGA is configured unless explicitly disabled", () => {
    const previousEnabled = process.env.OPENFGA_RECONCILE_ENABLED;
    const previousUrl = process.env.OPENFGA_HTTP;
    try {
      delete process.env.OPENFGA_RECONCILE_ENABLED;
      process.env.OPENFGA_HTTP = "http://openfga:8080";
      expect(isOpenFgaReconciliationEnabled()).toBe(true);

      process.env.OPENFGA_RECONCILE_ENABLED = "false";
      expect(isOpenFgaReconciliationEnabled()).toBe(false);

      process.env.OPENFGA_RECONCILE_ENABLED = "true";
      delete process.env.OPENFGA_HTTP;
      expect(isOpenFgaReconciliationEnabled()).toBe(false);

      process.env.OPENFGA_HTTP = "http://openfga:8080";
      expect(isOpenFgaReconciliationEnabled()).toBe(true);
    } finally {
      if (previousEnabled === undefined) delete process.env.OPENFGA_RECONCILE_ENABLED;
      else process.env.OPENFGA_RECONCILE_ENABLED = previousEnabled;
      if (previousUrl === undefined) delete process.env.OPENFGA_HTTP;
      else process.env.OPENFGA_HTTP = previousUrl;
    }
  });

  it("filters existing writes and absent deletes before calling OpenFGA write", async () => {
    process.env.OPENFGA_RECONCILE_ENABLED = "true";
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";

    const existingWrite = {
      user: "team:demo#member",
      relation: "user",
      object: "agent:a1",
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }),
      })
      // write tuple already exists (Read) -> do not include in write call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tuples: [{ key: existingWrite }] }),
      })
      // delete tuple absent (Read) -> do not include in write call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tuples: [] }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await writeOpenFgaTupleDiff({
      writes: [existingWrite],
      deletes: [{ user: "team:demo#member", relation: "caller", object: "tool:jira_*" }],
    });

    expect(result).toEqual({ enabled: true, writes: 0, deletes: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "http://openfga:8080/stores/store-1/write",
      expect.anything()
    );
  });

  it("propagates MCP server ownership write failures", async () => {
    // assisted-by Codex Codex-sonnet-4-6
    process.env.OPENFGA_RECONCILE_ENABLED = "true";
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).endsWith("/stores")) {
        return { ok: true, json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }) };
      }
      if (String(url).includes("/read")) {
        return { ok: true, json: async () => ({ tuples: [] }) };
      }
      if (String(url).includes("/write")) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      reconcileMcpServerRelationships({
        serverId: "mcp-confluence-mcp",
        ownerSubject: "alice-sub",
      }),
    ).rejects.toThrow("OpenFGA tuple write failed");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://openfga:8080/stores/store-1/write",
      expect.anything(),
    );
  });

  it("does not use Check for idempotent filtering (skill migration tuples)", async () => {
    process.env.OPENFGA_RECONCILE_ENABLED = "true";
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).endsWith("/stores")) {
        return { ok: true, json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }) };
      }
      if (String(url).includes("/read")) {
        return { ok: true, json: async () => ({ tuples: [] }) };
      }
      if (String(url).includes("/write")) {
        return { ok: true, text: async () => "" };
      }
      if (String(url).includes("/check")) {
        throw new Error("Check must not be used for tuple existence filtering");
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await writeOpenFgaTupleDiff({
      writes: [
        {
          user: "organization:caipe#member",
          relation: "user",
          object: "skill:global-skill",
        },
      ],
      deletes: [{ user: "user:*", relation: "user", object: "skill:legacy" }],
    });

    expect(result).toEqual({ enabled: true, writes: 1, deletes: 0 });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/check"),
      expect.anything(),
    );
  });

  it("rejects materialized can_* relations on tuple writes", async () => {
    process.env.OPENFGA_RECONCILE_ENABLED = "true";
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";

    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      writeOpenFgaTupleDiff({
        writes: [{ user: "team:platform#member", relation: "can_use", object: "agent:a1" }],
        deletes: [],
      })
    ).rejects.toThrow("Materialized relation can_use is not writable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps tuple reads at OpenFGA's maximum page size", async () => {
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tuples: [], continuation_token: "" }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await readOpenFgaTuples({ pageSize: 200 });

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      page_size: 100,
    });
  });

  it("builds universal relationship tuple diffs using base writable relations", () => {
    expect(
      buildUniversalRebacTupleDiff({
        writes: [
          {
            subject: { type: "team", id: "platform", relation: "member" },
            action: "call",
            resource: { type: "tool", id: "argocd" },
          },
        ],
        deletes: [
          {
            subject: { type: "team", id: "platform", relation: "member" },
            action: "use",
            resource: { type: "agent", id: "legacy-agent" },
          },
        ],
      })
    ).toEqual({
      writes: [{ user: "team:platform#member", relation: "caller", object: "tool:argocd" }],
      deletes: [{ user: "team:platform#member", relation: "user", object: "agent:legacy-agent" }],
    });
  });

  it("checks universal relationships through the OpenFGA check endpoint", async () => {
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ allowed: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      checkUniversalRebacRelationship({
        subject: { type: "user", id: "alice-sub" },
        action: "read",
        resource: { type: "knowledge_base", id: "platform-runbooks" },
      })
    ).resolves.toEqual({ allowed: true });

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      tuple_key: {
        user: "user:alice-sub",
        relation: "can_read",
        object: "knowledge_base:platform-runbooks",
      },
    });
  });

  it("writes universal relationship tuple diffs through reconciliation", async () => {
    process.env.OPENFGA_RECONCILE_ENABLED = "true";
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tuples: [] }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      writeUniversalRebacTupleDiff({
        writes: [
          {
            subject: { type: "team", id: "platform", relation: "member" },
            action: "use",
            resource: { type: "agent", id: "platform-engineer" },
          },
        ],
        deletes: [],
      })
    ).resolves.toEqual({ enabled: true, writes: 1, deletes: 0 });

    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      writes: {
        tuple_keys: [
          {
            user: "team:platform#member",
            relation: "user",
            object: "agent:platform-engineer",
          },
        ],
      },
    });
  });

  it("maps dynamic agent allowed_tools changes to agent-scoped MCP tool tuples", () => {
    const diff = buildAgentToolTupleDiff({
      agentId: "agent-test-april-2025",
      previousAllowedTools: {
        jira: ["get_issue"],
        github: [],
      },
      nextAllowedTools: {
        jira: ["search", "get_current_user_account_id"],
      },
      ownerSubject: "admin-sub",
    });

    expect(diff.writes).toEqual([
      {
        user: "user:admin-sub",
        relation: "owner",
        object: "agent:agent-test-april-2025",
      },
      {
        user: "agent:agent-test-april-2025",
        relation: "caller",
        object: "tool:jira/search",
      },
      {
        user: "agent:agent-test-april-2025",
        relation: "caller",
        object: "tool:jira/get_current_user_account_id",
      },
    ]);
    expect(diff.deletes).toEqual([
      {
        user: "agent:agent-test-april-2025",
        relation: "caller",
        object: "tool:jira/get_issue",
      },
      {
        user: "agent:agent-test-april-2025",
        relation: "caller",
        object: "tool:github/*",
      },
    ]);
  });

  it("maps dynamic agent ownership to creator, organization, team, and tool tuples", () => {
    const diff = buildAgentRelationshipTupleDiff({
      agentId: "agent-platform-helper",
      organizationId: "default",
      ownerTeamSlug: "platform",
      ownerSubject: "admin-sub",
      previousAllowedTools: {},
      nextAllowedTools: {
        jira: ["search"],
      },
    });

    expect(diff.writes).toEqual([
      { user: "user:admin-sub", relation: "owner", object: "agent:agent-platform-helper" },
      { user: "organization:default#admin", relation: "manager", object: "agent:agent-platform-helper" },
      { user: "team:platform#member", relation: "user", object: "agent:agent-platform-helper" },
      { user: "team:platform#admin", relation: "manager", object: "agent:agent-platform-helper" },
      // owner team members get full management access
      { user: "team:platform#member", relation: "manager", object: "agent:agent-platform-helper" },
      { user: "agent:agent-platform-helper", relation: "caller", object: "tool:jira/search" },
    ]);
    expect(diff.deletes).toEqual([
      { user: "team:platform#member", relation: "writer", object: "agent:agent-platform-helper" },
    ]);
  });

  it("deletes all agent relationships across paginated OpenFGA tuple reads", async () => {
    process.env.OPENFGA_RECONCILE_ENABLED = "true";
    process.env.OPENFGA_HTTP = "http://openfga:8080";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga";

    const listPages = [
      {
        tuples: [
          { key: { user: "agent:agent-platform-helper", relation: "caller", object: "tool:jira/search" } },
          { key: { user: "user:someone-else", relation: "owner", object: "agent:other" } },
        ],
        continuation_token: "page-2",
      },
      {
        tuples: [
          { key: { user: "team:platform#admin", relation: "manager", object: "agent:agent-platform-helper" } },
        ],
      },
    ];
    const writes: unknown[] = [];
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/stores")) {
        return { ok: true, json: async () => ({ stores: [{ id: "store-1", name: "caipe-openfga" }] }) };
      }
      if (url.endsWith("/read")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const tk = body?.tuple_key as
          | { user?: string; relation?: string; object?: string }
          | undefined;
        const isPagedList =
          !tk || (!tk.user?.trim() && !tk.relation?.trim() && !tk.object?.trim());
        if (isPagedList) {
          return { ok: true, json: async () => listPages.shift() ?? { tuples: [] } };
        }
        const match = [
          { user: "agent:agent-platform-helper", relation: "caller", object: "tool:jira/search" },
          { user: "team:platform#admin", relation: "manager", object: "agent:agent-platform-helper" },
        ].find(
          (tuple) =>
            tuple.user === body?.tuple_key?.user &&
            tuple.relation === body?.tuple_key?.relation &&
            tuple.object === body?.tuple_key?.object,
        );
        return {
          ok: true,
          json: async () => ({ tuples: match ? [{ key: match }] : [] }),
        };
      }
      if (url.endsWith("/write")) {
        writes.push(JSON.parse(String(init?.body)));
        return { ok: true, text: async () => "" };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(deleteAllAgentToolTuples("agent-platform-helper")).resolves.toMatchObject({
      enabled: true,
      deletes: 2,
    });
    expect(writes).toEqual([
      {
        deletes: {
          tuple_keys: [
            { user: "agent:agent-platform-helper", relation: "caller", object: "tool:jira/search" },
            { user: "team:platform#admin", relation: "manager", object: "agent:agent-platform-helper" },
          ],
        },
      },
    ]);
  });
});

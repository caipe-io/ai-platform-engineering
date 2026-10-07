/**
 * @jest-environment node
 *
 * Unit tests for the "Hello World" default-agent bootstrap in
 * `seed-config.ts`. The bootstrap is a first-run safety net that
 * provisions a minimal usable agent when the `dynamic_agents` collection
 * is empty after the YAML seed runs (or if the YAML seed was skipped).
 *
 * Behaviors under test:
 * 1. Inserts the Hello World agent when collection is empty.
 * 2. No-op when any agent already exists (YAML seed already populated).
 * 3. Returns false when MongoDB is not configured.
 * 4. Treats duplicate-key races as benign (returns false, no throw).
 *
 * assisted-by Cursor claude-opus-4-7
 */

const mockCollection = {
  countDocuments: jest.fn(),
  findOne: jest.fn(),
  insertOne: jest.fn(),
  updateOne: jest.fn(),
};
const mockReconcileAgentRelationships = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => mockCollection),
}));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  reconcileAgentRelationships: (...args: unknown[]) =>
    mockReconcileAgentRelationships(...args),
}));

import {
  bootstrapDefaultDynamicAgentIfEmpty,
  bootstrapDefaultIdentityGroupSyncRuleIfEmpty,
  buildAutoCreateTeamsBootstrapRule,
  buildHelloWorldAgentDoc,
  reconcileHelloWorldBootstrapAgent,
  AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID,
  HELLO_WORLD_AGENT_ID,
  HELLO_WORLD_BOOTSTRAP_REVISION,
} from "../seed-config";

describe("bootstrapDefaultDynamicAgentIfEmpty", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("provisions the Hello World agent when dynamic_agents is empty", async () => {
    mockCollection.countDocuments.mockResolvedValue(0);
    mockCollection.insertOne.mockResolvedValue({ insertedId: HELLO_WORLD_AGENT_ID });

    const created = await bootstrapDefaultDynamicAgentIfEmpty();

    expect(created).toBe(true);
    expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);

    const inserted = mockCollection.insertOne.mock.calls[0][0];
    expect(inserted._id).toBe(HELLO_WORLD_AGENT_ID);
    expect(inserted.name).toBe("Hello World");
    expect(inserted.enabled).toBe(true);
    expect(inserted.visibility).toBe("global");
    expect(inserted.owner_id).toBe("system");
    // Bootstrap-provisioned, not config-driven — admins must be able to
    // edit/delete it through the UI.
    expect(inserted.config_driven).toBe(false);
    // Built-in tools enabled, including workflow HITL.
    expect(inserted.builtin_tools.fetch_url).toEqual({
      enabled: true,
      allowed_domains: "*",
    });
    expect(inserted.builtin_tools.current_datetime).toEqual({ enabled: true });
    expect(inserted.builtin_tools.user_info).toEqual({ enabled: true });
    expect(inserted.builtin_tools.sleep).toEqual({
      enabled: true,
      max_seconds: 60,
    });
    expect(inserted.builtin_tools.request_user_input).toEqual({
      enabled: true,
    });
    expect(inserted.interrupt_on).toEqual({
      builtin: { request_user_input: true },
    });
    expect(inserted.hello_world_bootstrap_revision).toBe(
      HELLO_WORLD_BOOTSTRAP_REVISION,
    );
    // Empty model is intentional — backend default is used.
    expect(inserted.model).toEqual({ id: "", provider: "" });
    expect(inserted.subagents).toEqual([]);
    expect(inserted.skills).toEqual([]);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith({
      agentId: HELLO_WORLD_AGENT_ID,
      previousAllowedTools: {},
      nextAllowedTools: inserted.allowed_tools,
      ownerSubject: null,
      organizationId: "caipe",
      ownerTeamSlug: null,
      previousOwnerTeamSlug: null,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
      globalUserAccess: true,
      previousGlobalUserAccess: false,
      unlinkedServiceAccountSub: null,
      failClosed: false,
    });
  });

  it("is a no-op when any dynamic agent already exists", async () => {
    mockCollection.countDocuments.mockResolvedValue(1);

    const created = await bootstrapDefaultDynamicAgentIfEmpty();

    expect(created).toBe(false);
    expect(mockCollection.insertOne).not.toHaveBeenCalled();
  });

  it("treats a duplicate-key race as benign and returns false", async () => {
    mockCollection.countDocuments.mockResolvedValue(0);
    const dupErr = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
    });
    mockCollection.insertOne.mockRejectedValue(dupErr);

    await expect(bootstrapDefaultDynamicAgentIfEmpty()).resolves.toBe(false);
  });

  it("re-throws non-duplicate-key insert failures", async () => {
    mockCollection.countDocuments.mockResolvedValue(0);
    mockCollection.insertOne.mockRejectedValue(new Error("connection lost"));

    await expect(bootstrapDefaultDynamicAgentIfEmpty()).rejects.toThrow(
      "connection lost",
    );
  });
});

describe("buildHelloWorldAgentDoc", () => {
  it("includes request_user_input and workflow-oriented system prompt", () => {
    const doc = buildHelloWorldAgentDoc("2026-01-01T00:00:00Z");
    expect(doc.system_prompt).toContain("request_user_input");
    expect(doc.system_prompt).toContain("write_file");
  });
});

describe("reconcileHelloWorldBootstrapAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("updates system-owned hello-world when bootstrap revision is behind", async () => {
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const updated = await reconcileHelloWorldBootstrapAgent();

    expect(updated).toBe(true);
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: HELLO_WORLD_AGENT_ID, owner_id: "system" }),
      expect.objectContaining({
        $set: expect.objectContaining({
          hello_world_bootstrap_revision: HELLO_WORLD_BOOTSTRAP_REVISION,
          builtin_tools: expect.objectContaining({
            request_user_input: { enabled: true },
          }),
        }),
      }),
    );
  });

  it("repairs OpenFGA relationships for current system-owned hello-world", async () => {
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 0 });
    mockCollection.findOne.mockResolvedValue(buildHelloWorldAgentDoc("2026-01-01T00:00:00Z"));

    await expect(reconcileHelloWorldBootstrapAgent()).resolves.toBe(false);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith({
      agentId: HELLO_WORLD_AGENT_ID,
      previousAllowedTools: {},
      nextAllowedTools: {},
      ownerSubject: null,
      organizationId: "caipe",
      ownerTeamSlug: null,
      previousOwnerTeamSlug: null,
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: [],
      globalUserAccess: true,
      previousGlobalUserAccess: true,
      unlinkedServiceAccountSub: null,
      failClosed: false,
    });
  });

  it("returns false when no document matched", async () => {
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 0 });
    mockCollection.findOne.mockResolvedValue(null);

    await expect(reconcileHelloWorldBootstrapAgent()).resolves.toBe(false);
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });
});

describe("buildAutoCreateTeamsBootstrapRule", () => {
  it("returns a permissive default rule that matches every group claim", () => {
    const rule = buildAutoCreateTeamsBootstrapRule("2026-01-01T00:00:00Z");

    expect(rule.id).toBe(AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID);
    // Wildcard so the catch-all applies to every IdP (login claims + Okta sync).
    expect(rule.provider_id).toBe("*");
    // Catch-all regex with a `team` named capture; matcher uses RegExp().
    expect(rule.include_patterns).toEqual(["^(?<team>.+)$"]);
    // Templates use Handlebars-style refs that the renderer substitutes
    // from the named capture.
    expect(rule.team_name_template).toBe("{{team}}");
    expect(rule.team_slug_template).toBe("{{team}}");
    // High numeric priority = lowest precedence per matcher's ascending
    // sort, so admin-authored rules always win.
    expect(rule.priority).toBe(1000);
    expect(rule.enabled).toBe(true);
    expect(rule.review_status).toBe("enabled");
    expect(rule.auto_create_team).toBe(true);
    // Empty role_map: the matcher's roleFromCapture defaults unmapped
    // roles to "member" — admins still come from BOOTSTRAP_ADMIN_EMAILS.
    expect(rule.role_map).toEqual({});
    expect(rule.created_by).toBe("system:auto-create-teams-bootstrap");
  });
});

describe("bootstrapDefaultIdentityGroupSyncRuleIfEmpty", () => {
  const ORIGINAL_ENV = process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS;
    } else {
      process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = ORIGINAL_ENV;
    }
  });

  it("provisions the bootstrap rule when it does not exist", async () => {
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "true";
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.insertOne.mockResolvedValue({
      insertedId: AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID,
    });

    const created = await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();

    expect(created).toBe(true);
    expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
    const inserted = mockCollection.insertOne.mock.calls[0][0];
    expect(inserted.id).toBe(AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID);
    expect(inserted.provider_id).toBe("*");
    expect(inserted.auto_create_team).toBe(true);
    expect(inserted.enabled).toBe(true);
  });

  it("is a no-op when the env var is unset", async () => {
    delete process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS;

    const created = await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();

    expect(created).toBe(false);
    expect(mockCollection.findOne).not.toHaveBeenCalled();
    expect(mockCollection.insertOne).not.toHaveBeenCalled();
  });

  it("is a no-op when the env var is any non-true value", async () => {
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "1";

    const created = await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();

    expect(created).toBe(false);
    expect(mockCollection.findOne).not.toHaveBeenCalled();
  });

  it("updates a stale bootstrap rule with old provider_id", async () => {
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "true";
    mockCollection.findOne.mockResolvedValue({
      id: AUTO_CREATE_TEAMS_BOOTSTRAP_RULE_ID,
      provider_id: "oidc-claims",
      name: "Auto-create teams from OIDC group claims (bootstrap)",
    });
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const created = await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();

    expect(created).toBe(true);
    expect(mockCollection.insertOne).not.toHaveBeenCalled();
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const update = mockCollection.updateOne.mock.calls[0][1];
    expect(update.$set.provider_id).toBe("*");
  });

  it("is a no-op when the bootstrap rule is already up to date", async () => {
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "true";
    const rule = buildAutoCreateTeamsBootstrapRule("2026-01-01T00:00:00.000Z");
    mockCollection.findOne.mockResolvedValue(rule);

    const created = await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();

    expect(created).toBe(false);
    expect(mockCollection.insertOne).not.toHaveBeenCalled();
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  it("is a no-op when admin-curated rules exist but bootstrap rule is absent", async () => {
    // Admin-curated rules with different IDs are not touched; the bootstrap
    // rule itself is simply inserted since findOne returns null for its ID.
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "true";
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.insertOne.mockResolvedValue({ insertedId: "new-id" });

    const created = await bootstrapDefaultIdentityGroupSyncRuleIfEmpty();

    expect(created).toBe(true);
    expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
  });

  it("treats a duplicate-key race as benign", async () => {
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "true";
    mockCollection.findOne.mockResolvedValue(null);
    const dupErr = Object.assign(new Error("E11000"), { code: 11000 });
    mockCollection.insertOne.mockRejectedValue(dupErr);

    await expect(bootstrapDefaultIdentityGroupSyncRuleIfEmpty()).resolves.toBe(
      false,
    );
  });

  it("re-throws non-duplicate-key errors", async () => {
    process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = "true";
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.insertOne.mockRejectedValue(new Error("connection lost"));

    await expect(bootstrapDefaultIdentityGroupSyncRuleIfEmpty()).rejects.toThrow(
      "connection lost",
    );
  });
});

describe("bootstrapDefaultDynamicAgentIfEmpty when MongoDB is unconfigured", () => {
  it("returns false without touching the collection", async () => {
    jest.resetModules();
    jest.doMock("@/lib/mongodb", () => ({
      isMongoDBConfigured: false,
      getCollection: jest.fn(),
    }));
    const { bootstrapDefaultDynamicAgentIfEmpty: bootstrapNoMongo } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../seed-config");
    const { getCollection } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/lib/mongodb");

    await expect(bootstrapNoMongo()).resolves.toBe(false);
    expect(getCollection).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment node
 */

const mockWriteOpenFgaTuples = jest.fn();
const mockGetCollection = jest.fn();
const mockGetRbacCollection = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/mongo-collections", () => ({
  getRbacCollection: (...args: unknown[]) => mockGetRbacCollection(...args),
}));

/**
 * Stub a `team_membership_sources` collection driven by an in-memory
 * row array. Tests populate `rows` to simulate "the user is in these
 * teams with these roles". Empty array == user is in no teams.
 */
function stubTeamMembershipSources(rows: Record<string, unknown>[]) {
  return {
    find: jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue(rows),
    })),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

describe("login OpenFGA bootstrap", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CAIPE_ORG_KEY: "grid",
    };
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 8, deletes: 0 });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
    });
    // Default: no team-membership rows. Individual tests override.
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return stubTeamMembershipSources([]);
      throw new Error(`unexpected rbac collection ${key}`);
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("writes baseline product access for an admitted user", async () => {
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-user",
      email: "user@example.com",
      isAuthorized: true,
      isAdmin: false,
    });

    expect(result.status).toBe("completed");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        { user: "user:sub-user", relation: "member", object: "organization:grid" },
        { user: "user:sub-user", relation: "reader", object: "system_config:platform_settings" },
        { user: "user:sub-user", relation: "owner", object: "user_profile:sub-user" },
        { user: "user:sub-user", relation: "caller", object: "mcp_gateway:list" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:users" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:teams" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:skills" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:slack" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:webex" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:feedback" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:stats" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:health" },
        { user: "user:sub-user", relation: "reader", object: "admin_surface:credentials" },
      ],
      deletes: [],
    });
  });

  it("adds durable admin tuples only when the login is admin-eligible", async () => {
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-admin",
      email: "admin@example.com",
      isAuthorized: true,
      isAdmin: true,
    });

    expect(result.status).toBe("completed");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: "user:sub-admin", relation: "member", object: "organization:grid" },
        { user: "user:sub-admin", relation: "reader", object: "system_config:platform_settings" },
        { user: "user:sub-admin", relation: "owner", object: "user_profile:sub-admin" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:users" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:teams" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:skills" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:slack" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:webex" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:feedback" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:stats" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:health" },
        { user: "user:sub-admin", relation: "reader", object: "admin_surface:credentials" },
        { user: "user:sub-admin", relation: "admin", object: "organization:grid" },
        { user: "user:sub-admin", relation: "manager", object: "system_config:platform_settings" },
        { user: "user:sub-admin", relation: "manager", object: "mcp_server:agentgateway" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:users" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:teams" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:skills" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:slack" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:webex" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:feedback" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:stats" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:health" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:credentials" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:roles" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:identity_group_sync" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:metrics" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:audit_logs" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:action_audit" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:openfga" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:migrations" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:rag_datasources" },
      ]),
      deletes: [],
    });
  });

  it("does not race durable default-agent permission recovery during login", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "platform_config") {
        return { findOne: jest.fn().mockResolvedValue({ default_agent_id: "agent-default" }) };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-user",
      email: "user@example.com",
      isAuthorized: true,
      isAdmin: false,
    });

    expect(result.status).toBe("completed");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.not.arrayContaining([
        { user: "user:*", relation: "user", object: "agent:agent-default" },
      ]),
      deletes: [],
    });
    expect(mockGetCollection).not.toHaveBeenCalledWith("platform_config");
  });

  it("applies team profile overrides instead of the global member baseline on login", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "openfga_baseline_profiles") {
        return {
          findOne: jest.fn().mockImplementation(async (query: { _id: string }) =>
            query._id === "profiles_v2"
              ? {
                  _id: "profiles_v2",
                  global_member_profile_id: "org-member",
                  global_admin_profile_id: "org-admin",
                  profiles: [
                    {
                      id: "org-member",
                      name: "Organization member",
                      role: "member",
                      grants: ["organization-member", "own-profile-owner"],
                    },
                    {
                      id: "org-admin",
                      name: "Organization admin",
                      role: "admin",
                      grants: ["organization-admin"],
                    },
                    {
                      id: "support-member",
                      name: "Support member",
                      role: "member",
                      grants: ["admin-surface:feedback:read"],
                    },
                  ],
                }
              : null,
          ),
        };
      }
      if (name === "teams") {
        return {
          find: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([
              {
                _id: "team-1",
                slug: "support",
                name: "Support",
                // No `members[]` — the canonical reader looks up the user in
                // team_membership_sources via the rbac collection mock below.
                baseline_profile_overrides: { member_profile_id: "support-member" },
              },
            ]),
          }),
        };
      }
      if (name === "platform_config") {
        return { findOne: jest.fn().mockResolvedValue(null) };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") {
        return stubTeamMembershipSources([
          {
            team_id: "team-1",
            team_slug: "support",
            user_email: "user@example.com",
            relationship: "member",
            source_type: "manual",
            status: "active",
          },
        ]);
      }
      throw new Error(`unexpected rbac collection ${key}`);
    });
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-user",
      email: "user@example.com",
      isAuthorized: true,
      isAdmin: false,
    });

    expect(result.status).toBe("completed");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [{ user: "user:sub-user", relation: "reader", object: "admin_surface:feedback" }],
      deletes: [],
    });
  });

  it("ignores stale teams.members[] entries when the canonical store has no matching row (regression: post-canonical-membership migration)", async () => {
    // Models the bug we just fixed: a stale `team.members[]` entry must
    // NOT cause the override to apply if `team_membership_sources` has
    // no active row for the user.
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "openfga_baseline_profiles") {
        return {
          findOne: jest.fn().mockImplementation(async (query: { _id: string }) =>
            query._id === "profiles_v2"
              ? {
                  _id: "profiles_v2",
                  global_member_profile_id: "org-member",
                  global_admin_profile_id: "org-admin",
                  profiles: [
                    {
                      id: "org-member",
                      name: "Organization member",
                      role: "member",
                      grants: ["organization-member", "own-profile-owner"],
                    },
                    {
                      id: "support-member",
                      name: "Support member",
                      role: "member",
                      grants: ["admin-surface:feedback:read"],
                    },
                  ],
                }
              : null,
          ),
        };
      }
      if (name === "teams") {
        return {
          find: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([
              {
                _id: "team-1",
                slug: "support",
                name: "Support",
                // Stale embedded array — must be ignored.
                members: [{ user_id: "user@example.com", role: "member" }],
                baseline_profile_overrides: { member_profile_id: "support-member" },
              },
            ]),
          }),
        };
      }
      if (name === "platform_config") {
        return { findOne: jest.fn().mockResolvedValue(null) };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    // Canonical store: empty for this user.
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return stubTeamMembershipSources([]);
      throw new Error(`unexpected rbac collection ${key}`);
    });

    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-user",
      email: "user@example.com",
      isAuthorized: true,
      isAdmin: false,
    });

    expect(result.status).toBe("completed");
    // Falls back to the global member baseline (org-member), NOT the override.
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        { user: "user:sub-user", relation: "member", object: "organization:grid" },
        { user: "user:sub-user", relation: "owner", object: "user_profile:sub-user" },
      ],
      deletes: [],
    });
  });

  it("backfills new required grants into stored built-in admin profiles", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "openfga_baseline_profiles") {
        return {
          findOne: jest.fn().mockImplementation(async (query: { _id: string }) =>
            query._id === "profiles_v2"
              ? {
                  _id: "profiles_v2",
                  global_member_profile_id: "org-member",
                  global_admin_profile_id: "org-admin",
                  profiles: [
                    {
                      id: "org-member",
                      name: "Organization member",
                      role: "member",
                      built_in: true,
                      grants: ["organization-member", "own-profile-owner"],
                    },
                    {
                      id: "org-admin",
                      name: "Organization admin",
                      role: "admin",
                      built_in: true,
                      grants: ["organization-admin"],
                    },
                  ],
                }
              : null,
          ),
        };
      }
      if (name === "teams") {
        return {
          find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
          findOne: jest.fn().mockResolvedValue(null),
        };
      }
      if (name === "platform_config") {
        return { findOne: jest.fn().mockResolvedValue(null) };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-admin",
      email: "admin@example.com",
      isAuthorized: true,
      isAdmin: true,
    });

    expect(result.status).toBe("completed");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:teams" },
        { user: "user:sub-admin", relation: "manager", object: "admin_surface:credentials" },
      ]),
      deletes: [],
    });
  });

  it("adds admin user to super-admins team in OpenFGA and membership store on login", async () => {
    const mockSources = stubTeamMembershipSources([]);
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return mockSources;
      throw new Error(`unexpected rbac collection ${key}`);
    });

    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-admin",
      email: "admin@example.com",
      isAuthorized: true,
      isAdmin: true,
    });

    expect(result.status).toBe("completed");
    // assisted-by Codex Codex-sonnet-4-6
    // Super-admins team tuples written via writeTeamMembershipTuples.
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: "user:sub-admin", relation: "admin", object: "team:super-admins" },
        { user: "user:sub-admin", relation: "member", object: "team:super-admins" },
      ]),
      deletes: [],
    });
    // Membership source upserted
    expect(mockSources.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ team_slug: "super-admins", user_subject: "sub-admin" }),
      expect.objectContaining({ $set: expect.objectContaining({ relationship: "admin", status: "active" }) }),
      { upsert: true },
    );
  });

  it("does not add non-admin user to super-admins team", async () => {
    const mockSources = stubTeamMembershipSources([]);
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return mockSources;
      throw new Error(`unexpected rbac collection ${key}`);
    });

    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    await reconcileLoginOpenFgaAccess({
      subject: "sub-user",
      email: "user@example.com",
      isAuthorized: true,
      isAdmin: false,
    });

    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalledWith(
      expect.objectContaining({
        writes: expect.arrayContaining([
          expect.objectContaining({ object: "team:super-admins" }),
        ]),
      }),
    );
    expect(mockSources.updateOne).not.toHaveBeenCalled();
  });

  it("does not bootstrap users who failed the OIDC admission gate", async () => {
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-outsider",
      email: "outsider@example.com",
      isAuthorized: false,
      isAdmin: true,
    });

    expect(result.status).toBe("skipped");
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  describe("reconcileSyncedUsersBaselineAccess (directory-sync baseline bootstrap)", () => {
    it("writes the org-member baseline (incl. mcp_gateway:list) for each synced subject", async () => {
      mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 20, deletes: 0 });
      const { reconcileSyncedUsersBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await reconcileSyncedUsersBaselineAccess(["sub-a", "sub-b"]);

      expect(result.status).toBe("completed");
      expect(result.subject_count).toBe(2);
      // Member baseline only (no admin tuples), and it includes the coarse
      // gateway gate grant that AgentGateway's ext_authz requires.
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
        writes: expect.arrayContaining([
          { user: "user:sub-a", relation: "member", object: "organization:grid" },
          { user: "user:sub-a", relation: "caller", object: "mcp_gateway:list" },
          { user: "user:sub-b", relation: "member", object: "organization:grid" },
          { user: "user:sub-b", relation: "caller", object: "mcp_gateway:list" },
        ]),
        deletes: [],
      });
      // Never grants admin baselines from a directory sync.
      const writtenObjects = mockWriteOpenFgaTuples.mock.calls[0][0].writes.map(
        (t: { relation: string }) => t.relation
      );
      expect(writtenObjects).not.toContain("admin");
      expect(writtenObjects).not.toContain("manager");
    });

    it("dedupes repeated subjects and skips blank ones", async () => {
      const { reconcileSyncedUsersBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await reconcileSyncedUsersBaselineAccess(["sub-a", "sub-a", "  ", ""]);

      expect(result.subject_count).toBe(1);
      const users = new Set(
        mockWriteOpenFgaTuples.mock.calls[0][0].writes.map((t: { user: string }) => t.user)
      );
      expect(users).toEqual(new Set(["user:sub-a"]));
    });

    it("is a no-op with no resolved subjects", async () => {
      const { reconcileSyncedUsersBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await reconcileSyncedUsersBaselineAccess([]);

      expect(result.status).toBe("skipped");
      expect(result.subject_count).toBe(0);
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    });

    it("never throws — returns failed on OpenFGA write error", async () => {
      mockWriteOpenFgaTuples.mockRejectedValue(new Error("openfga down"));
      const { reconcileSyncedUsersBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await reconcileSyncedUsersBaselineAccess(["sub-a"]);

      expect(result.status).toBe("failed");
      expect(result.warning).toContain("openfga down");
    });
  });
});

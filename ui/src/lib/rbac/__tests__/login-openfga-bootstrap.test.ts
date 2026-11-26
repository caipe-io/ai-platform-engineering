/**
 * @jest-environment node
 */

const mockWriteOpenFgaTuples = jest.fn();
const mockGetCollection = jest.fn();
const mockGetRbacCollection = jest.fn();

jest.mock("@/lib/rbac/admin-grant-ownership", () => ({
  withAdminGrantLock: async (_subject: string, operation: () => Promise<unknown>) => operation(),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(args[0]),
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
    updateMany: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

/** Like stubTeamMembershipSources, but `find` applies the filter shapes the bearer lookup uses. */
function filteringTeamMembershipSources(rows: Record<string, unknown>[]) {
  const matchesField = (row: Record<string, unknown>, key: string, cond: unknown): boolean => {
    if (cond && typeof cond === "object" && "$in" in cond) {
      return (cond as { $in: unknown[] }).$in.includes(row[key] ?? null);
    }
    return row[key] === cond;
  };
  const matches = (row: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, cond]) =>
      key === "$or"
        ? (cond as Record<string, unknown>[]).some((branch) => matches(row, branch))
        : matchesField(row, key, cond)
    );
  return {
    ...stubTeamMembershipSources(rows),
    find: jest.fn((filter: Record<string, unknown>) => ({
      toArray: jest.fn().mockResolvedValue(rows.filter((row) => matches(row, filter))),
    })),
  };
}

function stubProfilesAndTeams(bundleDoc: Record<string, unknown> | null) {
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "openfga_baseline_profiles") {
      return {
        findOne: jest.fn().mockImplementation(async (query: { _id: string }) =>
          query._id === "profiles_v2" ? bundleDoc : null,
        ),
      };
    }
    if (name === "teams") {
      return {
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { _id: "team-1", slug: "support", name: "Support", baseline_profile_overrides: { member_profile_id: "support-member" } },
          ]),
        }),
      };
    }
    return { findOne: jest.fn().mockResolvedValue(null) };
  });
}

const VERIFIED_EMAIL = { email: "user@example.com", verified: true };

const SUPPORT_BUNDLE = {
  _id: "profiles_v2",
  global_member_profile_id: "org-member",
  global_admin_profile_id: "org-admin",
  profiles: [
    { id: "org-member", name: "Organization member", role: "member", grants: ["organization-member"] },
    { id: "org-admin", name: "Organization admin", role: "admin", grants: ["organization-admin"] },
    { id: "support-member", name: "Support member", role: "member", grants: ["admin-surface:feedback:read"] },
  ],
};

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

  it("repairs the all-users OpenFGA grant for the configured default dynamic agent on login", async () => {
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
      writes: expect.arrayContaining([
        { user: "user:*", relation: "user", object: "agent:agent-default" },
      ]),
      deletes: [],
    });
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
      expect.objectContaining({
        team_slug: "super-admins",
        user_subject: "sub-admin",
        source_type: "oidc_claim",
        provider_id: "oidc-claims",
        external_group_id: "configured-admin-group",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ relationship: "admin", managed: true, status: "active" }),
      }),
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

  it("revokes legacy login-bootstrap membership and requests ownership-filtered direct tuple cleanup", async () => {
    const mockSources = stubTeamMembershipSources([
      {
        team_id: "team-super-admins",
        team_slug: "super-admins",
        user_email: "former-admin@example.com",
        user_subject: "sub-former-admin",
        relationship: "admin",
        source_type: "manual",
        managed: false,
        status: "active",
        created_by: "login-bootstrap",
      },
    ]);
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return mockSources;
      throw new Error(`unexpected rbac collection ${key}`);
    });

    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");
    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-former-admin",
      email: "former-admin@example.com",
      isAuthorized: true,
      isAdmin: false,
      isBootstrapAdmin: false,
      isOidcAdmin: false,
    });

    expect(result.status).toBe("completed");
    expect(mockSources.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        team_slug: "super-admins",
        status: "active",
        created_by: { $in: ["oidc-admin-login-reconciliation", "login-bootstrap"] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "removed",
          removed_by: "oidc-admin-login-reconciliation",
        }),
      }),
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: expect.arrayContaining([
        { user: "user:sub-former-admin", relation: "admin", object: "team:super-admins" },
        { user: "user:sub-former-admin", relation: "member", object: "team:super-admins" },
      ]),
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: "user:sub-former-admin", relation: "member", object: "organization:grid" },
      ]),
      deletes: expect.arrayContaining([
        { user: "user:sub-former-admin", relation: "admin", object: "organization:grid" },
        { user: "user:sub-former-admin", relation: "manager", object: "admin_surface:rag_datasources" },
      ]),
    });
  });

  it("preserves independently recorded manual super-admin membership after OIDC demotion", async () => {
    const mockSources = stubTeamMembershipSources([
      {
        team_id: "team-super-admins",
        team_slug: "super-admins",
        user_email: "manual-admin@example.com",
        user_subject: "sub-manual-admin",
        relationship: "admin",
        source_type: "manual",
        managed: false,
        status: "active",
        created_by: "platform-owner@example.com",
      },
      {
        team_id: "team-super-admins",
        team_slug: "super-admins",
        user_email: "manual-admin@example.com",
        user_subject: "sub-manual-admin",
        relationship: "admin",
        source_type: "manual",
        managed: false,
        status: "active",
        created_by: "login-bootstrap",
      },
    ]);
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return mockSources;
      throw new Error(`unexpected rbac collection ${key}`);
    });

    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");
    await reconcileLoginOpenFgaAccess({
      subject: "sub-manual-admin",
      email: "manual-admin@example.com",
      isAuthorized: true,
      isAdmin: false,
      isBootstrapAdmin: false,
      isOidcAdmin: false,
    });

    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalledWith({
      writes: [],
      deletes: expect.arrayContaining([
        expect.objectContaining({ object: "team:super-admins" }),
      ]),
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.any(Array),
      deletes: [],
    });
  });

  it("preserves bootstrap-admin access while retiring absent OIDC provenance", async () => {
    const mockSources = stubTeamMembershipSources([
      {
        team_id: "team-super-admins",
        team_slug: "super-admins",
        user_email: "bootstrap-admin@example.com",
        user_subject: "sub-bootstrap-admin",
        relationship: "admin",
        source_type: "manual",
        managed: false,
        status: "active",
        created_by: "login-bootstrap",
      },
    ]);
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return mockSources;
      throw new Error(`unexpected rbac collection ${key}`);
    });

    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");
    await reconcileLoginOpenFgaAccess({
      subject: "sub-bootstrap-admin",
      email: "bootstrap-admin@example.com",
      isAuthorized: true,
      isAdmin: true,
      isBootstrapAdmin: true,
      isOidcAdmin: false,
    });

    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalledWith({
      writes: [],
      deletes: expect.arrayContaining([
        expect.objectContaining({ object: "team:super-admins" }),
      ]),
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: "user:sub-bootstrap-admin", relation: "admin", object: "organization:grid" },
      ]),
      deletes: [],
    });
  });

  it("revokes stale admin access even when the OIDC admission gate fails", async () => {
    const mockSources = stubTeamMembershipSources([
      {
        team_id: "team-super-admins",
        team_slug: "super-admins",
        user_email: "outsider@example.com",
        user_subject: "sub-outsider",
        relationship: "admin",
        source_type: "manual",
        managed: false,
        status: "active",
        created_by: "login-bootstrap",
      },
    ]);
    mockGetRbacCollection.mockImplementation(async (key: string) => {
      if (key === "teamMembershipSources") return mockSources;
      throw new Error(`unexpected rbac collection ${key}`);
    });
    const { reconcileLoginOpenFgaAccess } = await import("../login-openfga-bootstrap");

    const result = await reconcileLoginOpenFgaAccess({
      subject: "sub-outsider",
      email: "outsider@example.com",
      isAuthorized: false,
      isAdmin: true,
    });

    expect(result.status).toBe("completed");
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: expect.arrayContaining([
        { user: "user:sub-outsider", relation: "admin", object: "organization:grid" },
      ]),
    });
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

  describe("ensureBearerUserBaselineAccess (bot users without a web login)", () => {
    it("writes the member baseline once per subject across repeated requests", async () => {
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const first = await ensureBearerUserBaselineAccess("sub-bot-user");
      await ensureBearerUserBaselineAccess("sub-bot-user");

      expect(first.status).toBe("completed");
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledTimes(1);
      expect(mockWriteOpenFgaTuples.mock.calls[0][0].writes).toEqual(
        expect.arrayContaining([
          { user: "user:sub-bot-user", relation: "caller", object: "mcp_gateway:list" },
        ])
      );
    });

    it("retries on the next request after a failed write", async () => {
      mockWriteOpenFgaTuples.mockRejectedValueOnce(new Error("openfga down"));
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const failed = await ensureBearerUserBaselineAccess("sub-bot-user");
      const retried = await ensureBearerUserBaselineAccess("sub-bot-user");

      expect(failed.status).toBe("failed");
      expect(retried.status).toBe("completed");
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledTimes(2);
    });

    it("writes nothing and retries when the team override lookup fails", async () => {
      mockGetRbacCollection.mockRejectedValueOnce(new Error("mongo down"));
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const failed = await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);

      expect(failed.status).toBe("failed");
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
      const retried = await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);
      expect(retried.status).toBe("completed");
    });

    it("writes nothing when the grant profiles cannot be read", async () => {
      mockGetCollection.mockRejectedValue(new Error("mongo down"));
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);

      expect(result.status).toBe("failed");
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    });

    it("writes nothing when a team override names an undefined profile", async () => {
      mockGetCollection.mockImplementation(async (name: string) => {
        if (name === "teams") {
          return {
            find: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([
                { _id: "team-1", slug: "support", name: "Support", baseline_profile_overrides: { member_profile_id: "deleted-profile" } },
              ]),
            }),
          };
        }
        return { findOne: jest.fn().mockResolvedValue(null) };
      });
      const sources = stubTeamMembershipSources([
        { team_id: "team-1", team_slug: "support", user_subject: "sub-bot-user", relationship: "member", source_type: "manual", status: "active" },
      ]);
      mockGetRbacCollection.mockImplementation(async () => sources);
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);

      expect(result.status).toBe("failed");
      expect(sources.find).toHaveBeenCalledWith({
        status: "active",
        $or: [
          { user_subject: "sub-bot-user" },
          { user_email: "user@example.com", user_subject: { $in: [null, ""] } },
        ],
      });
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    });

    it("applies a team member-profile override instead of the global baseline", async () => {
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
                      { id: "org-member", name: "Organization member", role: "member", grants: ["organization-member"] },
                      { id: "org-admin", name: "Organization admin", role: "admin", grants: ["organization-admin"] },
                      { id: "support-member", name: "Support member", role: "member", grants: ["admin-surface:feedback:read"] },
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
                { _id: "team-1", slug: "support", name: "Support", baseline_profile_overrides: { member_profile_id: "support-member" } },
              ]),
            }),
          };
        }
        return { findOne: jest.fn().mockResolvedValue(null) };
      });
      mockGetRbacCollection.mockImplementation(async (key: string) => {
        if (key === "teamMembershipSources") {
          return stubTeamMembershipSources([
            { team_id: "team-1", team_slug: "support", user_email: "user@example.com", relationship: "member", source_type: "manual", status: "active" },
          ]);
        }
        throw new Error(`unexpected rbac collection ${key}`);
      });
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);

      expect(result.status).toBe("completed");
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
        writes: [{ user: "user:sub-bot-user", relation: "reader", object: "admin_surface:feedback" }],
        deletes: [],
      });
    });

    it("ignores a same-email membership row bound to a different subject", async () => {
      stubProfilesAndTeams(SUPPORT_BUNDLE);
      const sources = filteringTeamMembershipSources([
        { team_slug: "support", user_email: "user@example.com", user_subject: "sub-someone-else", relationship: "member", status: "active" },
      ]);
      mockGetRbacCollection.mockImplementation(async () => sources);
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);

      expect(result.status).toBe("completed");
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
        writes: [{ user: "user:sub-bot-user", relation: "member", object: "organization:grid" }],
        deletes: [],
      });
    });

    it("applies the override from an unbound same-email membership row", async () => {
      stubProfilesAndTeams(SUPPORT_BUNDLE);
      const sources = filteringTeamMembershipSources([
        { team_slug: "support", user_email: "user@example.com", relationship: "member", status: "active" },
      ]);
      mockGetRbacCollection.mockImplementation(async () => sources);
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      await ensureBearerUserBaselineAccess("sub-bot-user", VERIFIED_EMAIL);

      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
        writes: [{ user: "user:sub-bot-user", relation: "reader", object: "admin_surface:feedback" }],
        deletes: [],
      });
    });

    it("writes nothing when the configured global member profile is undefined", async () => {
      stubProfilesAndTeams({ ...SUPPORT_BUNDLE, global_member_profile_id: "deleted-profile" });
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user");

      expect(result.status).toBe("failed");
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    });

    it("uses a valid custom global member profile", async () => {
      stubProfilesAndTeams({ ...SUPPORT_BUNDLE, global_member_profile_id: "support-member" });
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user");

      expect(result.status).toBe("completed");
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
        writes: [{ user: "user:sub-bot-user", relation: "reader", object: "admin_surface:feedback" }],
        deletes: [],
      });
    });

    it("writes nothing when an unverified email matches an email-only membership", async () => {
      stubProfilesAndTeams(SUPPORT_BUNDLE);
      const sources = filteringTeamMembershipSources([
        { team_slug: "support", user_email: "user@example.com", relationship: "member", status: "active" },
      ]);
      mockGetRbacCollection.mockImplementation(async () => sources);
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user", { email: "user@example.com", verified: false });

      expect(result.status).toBe("failed");
      expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    });

    it("writes the global baseline for an unverified email with no email-only membership", async () => {
      stubProfilesAndTeams(SUPPORT_BUNDLE);
      const sources = filteringTeamMembershipSources([
        { team_slug: "support", user_email: "user@example.com", user_subject: "sub-someone-else", relationship: "member", status: "active" },
      ]);
      mockGetRbacCollection.mockImplementation(async () => sources);
      const { ensureBearerUserBaselineAccess } = await import("../login-openfga-bootstrap");

      const result = await ensureBearerUserBaselineAccess("sub-bot-user", { email: "user@example.com", verified: false });

      expect(result.status).toBe("completed");
      expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
        writes: [{ user: "user:sub-bot-user", relation: "member", object: "organization:grid" }],
        deletes: [],
      });
    });
  });
});

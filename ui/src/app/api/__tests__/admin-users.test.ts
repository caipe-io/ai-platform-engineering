/**
 * @jest-environment node
 */
/**
 * Tests for GET /api/admin/users — Keycloak realm user list (search + filters).
 */

import { NextRequest } from 'next/server';

const mockGetServerSession = jest.fn();
jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: '',
}));

jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => key === 'ssoEnabled',
}));

const mockCheckPermission = jest.fn();
jest.mock('@/lib/rbac/keycloak-authz', () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
}));

const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn();
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
}));

jest.mock('@/lib/rbac/audit', () => ({
  logAuthzDecision: jest.fn(),
}));

const mockCollections: Record<string, { find: jest.Mock; findOne: jest.Mock }> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      findOne: jest.fn().mockResolvedValue(null),
    };
  }
  return Promise.resolve(mockCollections[name]);
});

let mockIsMongoDBConfigured = true;
jest.mock('@/lib/mongodb', () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  get isMongoDBConfigured() {
    return mockIsMongoDBConfigured;
  },
}));

const mockSearchRealmUsers = jest.fn();
const mockCountRealmUsers = jest.fn();
const mockListUsersWithRole = jest.fn();
const mockListRealmRoleMappingsForUser = jest.fn();
const mockGetUserFederatedIdentities = jest.fn();
const mockGetRealmUserById = jest.fn();
const mockGetRealmUserByIdOrNull = jest.fn();
const mockIsValidTeamSlug = jest.fn();
const mockFindRealmUsersByExactEmail = jest.fn();

jest.mock('@/lib/rbac/keycloak-admin', () => ({
  searchRealmUsers: (...args: unknown[]) => mockSearchRealmUsers(...args),
  countRealmUsers: (...args: unknown[]) => mockCountRealmUsers(...args),
  listUsersWithRole: (...args: unknown[]) => mockListUsersWithRole(...args),
  listRealmRoleMappingsForUser: (...args: unknown[]) =>
    mockListRealmRoleMappingsForUser(...args),
  getUserFederatedIdentities: (...args: unknown[]) =>
    mockGetUserFederatedIdentities(...args),
  getRealmUserById: (...args: unknown[]) => mockGetRealmUserById(...args),
  getRealmUserByIdOrNull: (...args: unknown[]) => mockGetRealmUserByIdOrNull(...args),
  isValidTeamSlug: (...args: unknown[]) => mockIsValidTeamSlug(...args),
  findRealmUsersByExactEmail: (...args: unknown[]) =>
    mockFindRealmUsersByExactEmail(...args),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

function adminSession() {
  return {
    user: { email: 'admin@example.com', name: 'Admin' },
    role: 'admin' as const,
    sub: 'admin-sub',
    accessToken: 'admin-token',
  };
}

function userSession() {
  return {
    user: { email: 'user@example.com', name: 'User' },
    role: 'user' as const,
    sub: 'user-sub',
    accessToken: 'user-token',
  };
}

function resetMocks() {
  mockGetServerSession.mockReset();
  mockGetCollection.mockReset();
  mockIsMongoDBConfigured = true;
  Object.keys(mockCollections).forEach((k) => delete mockCollections[k]);
  mockGetCollection.mockImplementation((name: string) => {
    if (!mockCollections[name]) {
      mockCollections[name] = {
        find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        findOne: jest.fn().mockResolvedValue(null),
      };
    }
    return Promise.resolve(mockCollections[name]);
  });
  mockSearchRealmUsers.mockReset();
  mockCountRealmUsers.mockReset();
  mockListUsersWithRole.mockReset();
  mockListRealmRoleMappingsForUser.mockReset();
  mockGetUserFederatedIdentities.mockReset();
  mockGetRealmUserById.mockReset();
  mockGetRealmUserByIdOrNull.mockReset();
  mockIsValidTeamSlug.mockReset();
  mockFindRealmUsersByExactEmail.mockReset();
  mockFindRealmUsersByExactEmail.mockResolvedValue([]);
  mockCheckPermission.mockReset();
  mockCheckOpenFgaTuple.mockReset();
  mockListOpenFgaObjects.mockReset();
  mockCheckPermission.mockResolvedValue({ allowed: true, reason: 'OK' });
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true, reason: 'OK' });
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockListRealmRoleMappingsForUser.mockResolvedValue([{ name: 'user' }]);
  mockGetUserFederatedIdentities.mockResolvedValue([]);
  mockGetRealmUserByIdOrNull.mockResolvedValue(null);
  mockIsValidTeamSlug.mockReturnValue(true);
}

import { GET } from '../admin/users/route';

describe('GET /api/admin/users — Auth', () => {
  beforeEach(() => {
    resetMocks();
    mockSearchRealmUsers.mockResolvedValue([]);
    mockCountRealmUsers.mockResolvedValue(0);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(401);
  });

  it('returns 200 for authenticated non-admin', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns 503 when team filter set and MongoDB not configured', async () => {
    mockIsMongoDBConfigured = false;
    mockGetServerSession.mockResolvedValue(adminSession());
    const res = await GET(makeRequest('/api/admin/users?team=team1'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('MONGODB_NOT_CONFIGURED');
  });
});

describe('GET /api/admin/users — Keycloak list', () => {
  beforeEach(() => {
    resetMocks();
    mockSearchRealmUsers.mockResolvedValue([]);
    mockCountRealmUsers.mockResolvedValue(0);
  });

  it('returns users and total from searchRealmUsers / countRealmUsers', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const raw = [
      {
        id: 'u1',
        username: 'alice',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'A',
        enabled: true,
        attributes: {},
      },
    ];
    mockSearchRealmUsers.mockResolvedValue(raw);
    mockCountRealmUsers.mockResolvedValue(1);

    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: 'u1',
      email: 'alice@example.com',
      slack_link_status: 'unlinked',
      webex_link_status: 'unlinked',
    });
    // Roles are NOT included by default — `includeRoles=true` is opt-in.
    expect(body.users[0]).not.toHaveProperty('roles');
    expect(body.users[0]).not.toHaveProperty('raw_roles');
    expect(body.users[0]).not.toHaveProperty('role_classifications');
    expect(body.users[0]).not.toHaveProperty('hidden_role_count');
    expect(mockListRealmRoleMappingsForUser).not.toHaveBeenCalled();
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
  });

  it('includes curated role fields when includeRoles=true', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const raw = [
      {
        id: 'u1',
        username: 'alice',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'A',
        enabled: true,
        attributes: {},
      },
    ];
    mockSearchRealmUsers.mockResolvedValue(raw);
    mockCountRealmUsers.mockResolvedValue(1);
    mockListRealmRoleMappingsForUser.mockResolvedValue([
      { name: 'admin' },
      { name: 'offline_access' },
      { name: 'default-roles-caipe' },
      { name: 'team_member:manual-u2-1778604473704-qjkzq' },
      { name: 'agent_admin:1-april-2025' },
    ]);

    const res = await GET(makeRequest('/api/admin/users?includeRoles=true'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: 'u1',
      email: 'alice@example.com',
      roles: ['admin'],
      raw_roles: [
        'admin',
        'offline_access',
        'default-roles-caipe',
        'team_member:manual-u2-1778604473704-qjkzq',
        'agent_admin:1-april-2025',
      ],
      hidden_role_count: 4,
    });
    expect(body.users[0].role_classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'offline_access', kind: 'system' }),
        expect.objectContaining({
          role: 'team_member:manual-u2-1778604473704-qjkzq',
          kind: 'team',
          transition_state: 'transitional',
        }),
        expect.objectContaining({
          role: 'agent_admin:1-april-2025',
          kind: 'resource',
          resource_type: 'agent',
        }),
      ])
    );
    expect(mockListRealmRoleMappingsForUser).toHaveBeenCalledWith('u1');
  });

  it('returns empty list when role filter matches no users', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockListUsersWithRole.mockResolvedValue([]);
    const res = await GET(makeRequest('/api/admin/users?role=nobody'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toEqual([]);
    expect(body.total).toBe(0);
    expect(mockSearchRealmUsers).not.toHaveBeenCalled();
  });

  it('rejects an unknown slackStatus value', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const res = await GET(makeRequest('/api/admin/users?slackStatus=pending'));
    expect(res.status).toBe(400);
  });

  it('filters users by Slack link status from slack_user_id attribute', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const raw = [
      {
        id: 'u1',
        username: 'alice',
        email: 'alice@example.com',
        attributes: { slack_user_id: ['U012ABC'] },
      },
      {
        id: 'u2',
        username: 'bob',
        email: 'bob@example.com',
        attributes: {},
      },
    ];
    mockSearchRealmUsers
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce([]);
    mockListRealmRoleMappingsForUser.mockResolvedValue([]);

    const res = await GET(makeRequest('/api/admin/users?slackStatus=linked'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: 'u1',
      email: 'alice@example.com',
      slack_link_status: 'linked',
    });
    expect(body.total).toBe(1);
  });

  it('filters users by Webex link status from webex_user_id attribute', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const raw = [
      {
        id: 'u1',
        username: 'alice',
        email: 'alice@example.com',
        attributes: { webex_user_id: ['person-abc'] },
      },
      {
        id: 'u2',
        username: 'bob',
        email: 'bob@example.com',
        attributes: {},
      },
    ];
    mockSearchRealmUsers
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce([]);
    mockListRealmRoleMappingsForUser.mockResolvedValue([]);

    const res = await GET(makeRequest('/api/admin/users?webexStatus=linked'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: 'u1',
      email: 'alice@example.com',
      webex_link_status: 'linked',
    });
    expect(body.total).toBe(1);
  });
});

describe("GET /api/admin/users — non-admin team-scoped view", () => {
  // Mock pattern: baseline `admin_surface:users#can_read` allows; the
  // org-level `admin_ui#view` (relation `can_audit` on `organization:caipe`)
  // denies — so the route enters the `!hasAdminView` branch.
  function mockNonAdminAuth() {
    mockCheckOpenFgaTuple.mockImplementation(
      async (t: { user: string; relation: string; object: string }) => ({
        allowed: t.relation === 'can_read' && t.object === 'admin_surface:users',
      })
    );
  }

  function mockPreviewAuthorization(target: string, targetCanAudit = false) {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { user: string; relation: string; object: string }) => ({
        allowed:
          (tuple.user === "user:admin-sub"
            && tuple.relation === "can_read"
            && tuple.object === "admin_surface:users")
          || (tuple.user === "user:admin-sub"
            && tuple.relation === "can_manage"
            && tuple.object === "organization:caipe")
          || (targetCanAudit
            && tuple.user === `user:${target}`
            && tuple.relation === "can_audit"
            && tuple.object === "organization:caipe"),
      }),
    );
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: target,
      email: `${target}@example.com`,
    });
  }

  // The route probes OpenFGA twice: `team#admin` (to widen team admins to the
  // full-list view) and `team#member` (the plain-member self/team scope). These
  // tests exercise the plain-member path, so the caller administers no teams —
  // only the `member` probe returns the user's teams.
  function setMemberTeams(slugs: string[]) {
    mockListOpenFgaObjects.mockImplementation(
      async (q: { relation: string }) => ({
        objects: q.relation === 'member' ? slugs : [],
      })
    );
  }

  // Membership is resolved two ways against `team_membership_sources`:
  // `listActiveTeamMemberEmailsBySlugsPaged` (plain-member team scope) runs
  // two aggregations (`{ $match: { team_slug: { $in }, status: 'active' } }`
  // → dedupe/count, and → dedupe/sort/page), while
  // `listActiveTeamMembershipSourcesBySlug` (team-admin editable-emails scope)
  // still does a plain `.find({ team_slug, status: 'active' }).sort(...)`.
  // NOT a team_id lookup either way. Keying these mocks by slug guards the
  // prod bug where the slug from OpenFGA was passed to a team_id-keyed lookup
  // and matched nobody. The aggregate mock emulates Mongo's own dedupe + sort
  // + skip/limit so tests exercise the same pagination contract as the real
  // aggregation.
  function setMembershipBySlug(
    bySlug: Record<string, string[]>
  ) {
    mockGetCollection.mockImplementation((name: string) => {
      if (name === 'team_membership_sources') {
        return Promise.resolve({
          aggregate: jest.fn().mockImplementation((pipeline: Array<Record<string, unknown>>) => {
            const match = pipeline[0]?.$match as { team_slug?: { $in?: string[] } } | undefined;
            const slugs = match?.team_slug?.$in ?? [];
            const emails = [...new Set(slugs.flatMap((slug) => bySlug[slug] ?? []))]
              .map((e) => e.trim().toLowerCase())
              .sort();
            const isCount = pipeline.some((stage) => '$count' in stage);
            if (isCount) {
              return { toArray: jest.fn().mockResolvedValue([{ total: emails.length }]) };
            }
            const skipStage = pipeline.find((stage) => '$skip' in stage) as { $skip: number } | undefined;
            const limitStage = pipeline.find((stage) => '$limit' in stage) as { $limit: number } | undefined;
            const skip = skipStage?.$skip ?? 0;
            const limit = limitStage?.$limit ?? emails.length;
            const page = emails.slice(skip, skip + limit).map((email) => ({ _id: email }));
            return { toArray: jest.fn().mockResolvedValue(page) };
          }),
          find: jest.fn().mockImplementation((filter: { team_slug?: string }) => {
            const emails = bySlug[filter?.team_slug ?? ''] ?? [];
            const docs = emails.map((user_email) => ({ user_email, status: 'active' }));
            return { sort: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) }) };
          }),
        });
      }
      return Promise.resolve({
        find: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
          project: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        }),
        findOne: jest.fn().mockResolvedValue(null),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      });
    });
  }

  // Resolve each member email to a realm user via the indexed exact-email
  // lookup (mirrors prod, where we no longer scan the whole realm).
  function resolveUsersByEmail(byEmail: Record<string, { id: string }>) {
    mockFindRealmUsersByExactEmail.mockImplementation(async (email: string) => {
      const u = byEmail[email];
      return u ? [{ id: u.id, username: email.split('@')[0], email, attributes: {} }] : [];
    });
  }

  beforeEach(() => {
    resetMocks();
    mockGetServerSession.mockResolvedValue(userSession());
    mockNonAdminAuth();
  });

  it("returns scoped:'team' with the members of the user's team", async () => {
    setMemberTeams(['team:platform-eng']);
    setMembershipBySlug({
      'platform-eng': ['alice@example.com', 'bob@example.com'],
    });
    resolveUsersByEmail({
      'alice@example.com': { id: 'u-alice' },
      'bob@example.com': { id: 'u-bob' },
    });

    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scoped).toBe('team');
    const emails = body.users.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(body.total).toBe(2);
    // Perf contract: members are resolved by exact email, never by a full
    // realm scan.
    expect(mockFindRealmUsersByExactEmail).toHaveBeenCalledWith('alice@example.com');
    expect(mockSearchRealmUsers).not.toHaveBeenCalled();
  });

  it("returns scoped:'self' for non-admin with no team memberships", async () => {
    mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
    mockGetRealmUserById.mockResolvedValue({
      id: 'user-sub',
      email: 'user@example.com',
      username: 'user',
      enabled: true,
      attributes: {},
    });

    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scoped).toBe('self');
    expect(body.total).toBe(1);
    expect(body.users).toHaveLength(1);
    expect(body.users[0].email).toBe('user@example.com');
    expect(mockSearchRealmUsers).not.toHaveBeenCalled();
  });

  it("returns scoped:'self' when team memberships resolve to zero members", async () => {
    // OpenFGA reports a team, but the canonical store has no active members for
    // its slug (e.g. the slug→id keying bug, or all members deactivated). The
    // route must fall back to self rather than return an empty list.
    setMemberTeams(['team:ghost-team']);
    setMembershipBySlug({});
    mockGetRealmUserById.mockResolvedValue({
      id: 'user-sub',
      email: 'user@example.com',
      username: 'user',
      enabled: true,
      attributes: {},
    });

    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scoped).toBe('self');
    expect(body.users.map((u: { email: string }) => u.email)).toEqual(['user@example.com']);
  });

  it("unions members across teams and de-duplicates users in multiple teams", async () => {
    setMemberTeams(['team:team-a', 'team:team-b']);
    setMembershipBySlug({
      'team-a': ['alice@example.com', 'dave@example.com'],
      'team-b': ['alice@example.com', 'erin@example.com'],
    });
    resolveUsersByEmail({
      'alice@example.com': { id: 'u-alice' },
      'dave@example.com': { id: 'u-dave' },
      'erin@example.com': { id: 'u-erin' },
    });

    const res = await GET(makeRequest('/api/admin/users'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scoped).toBe('team');
    const emails = body.users.map((u: { email: string }) => u.email).sort();
    // alice is in both teams but appears once.
    expect(emails).toEqual(['alice@example.com', 'dave@example.com', 'erin@example.com']);
    expect(body.total).toBe(3);
  });

  // Regression test for the prod incident: a large (e.g. Okta-synced,
  // org-wide) team used to resolve every member's email via Keycloak in one
  // unbounded `Promise.all`, firing thousands of concurrent admin API calls
  // that OOMKilled the istio-proxy sidecar. This asserts the route now only
  // resolves the requested page's slice of members per request.
  it("pages large teams instead of resolving every member in one request", async () => {
    const emails = Array.from({ length: 45 }, (_, i) => `member${String(i).padStart(2, '0')}@example.com`);
    setMemberTeams(['team:org-wide']);
    setMembershipBySlug({ 'org-wide': emails });
    resolveUsersByEmail(
      Object.fromEntries(emails.map((email, i) => [email, { id: `u-${i}` }]))
    );

    const page1 = await GET(makeRequest('/api/admin/users?page=1&pageSize=20'));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.scoped).toBe('team');
    expect(body1.total).toBe(45);
    expect(body1.page).toBe(1);
    expect(body1.pageSize).toBe(20);
    expect(body1.users).toHaveLength(20);
    // Only this page's 20 emails were resolved via Keycloak, not all 45.
    expect(mockFindRealmUsersByExactEmail).toHaveBeenCalledTimes(20);
    expect(body1.users.map((u: { email: string }) => u.email).sort()).toEqual(
      emails.slice(0, 20).sort()
    );

    mockFindRealmUsersByExactEmail.mockClear();

    const page3 = await GET(makeRequest('/api/admin/users?page=3&pageSize=20'));
    const body3 = await page3.json();
    // Final page only has the remaining 5 members.
    expect(body3.users).toHaveLength(5);
    expect(mockFindRealmUsersByExactEmail).toHaveBeenCalledTimes(5);
    expect(body3.total).toBe(45);
  });

  it("uses the selected user's memberships instead of the viewing admin's", async () => {
    mockPreviewAuthorization("preview-user");
    setMemberTeams(["team:platform-eng"]);
    setMembershipBySlug({
      "platform-eng": ["preview@example.com", "teammate@example.com"],
    });
    resolveUsersByEmail({
      "preview@example.com": { id: "preview-user" },
      "teammate@example.com": { id: "teammate" },
    });

    const res = await GET(makeRequest(
      "/api/admin/users?simulate_type=user&simulate_id=preview-user",
    ));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scoped).toBe("team");
    expect(body.users.map((user: { id: string }) => user.id).sort()).toEqual([
      "preview-user",
      "teammate",
    ]);
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: "user:preview-user",
      relation: "member",
      type: "team",
    });
    expect(mockListOpenFgaObjects).not.toHaveBeenCalledWith(
      expect.objectContaining({ user: "user:admin-sub" }),
    );
  });

  it("returns the full user list for an organization-admin preview", async () => {
    mockPreviewAuthorization("target-admin", true);
    mockSearchRealmUsers.mockResolvedValue([
      { id: "u1", email: "one@example.com", username: "one", attributes: {} },
      { id: "u2", email: "two@example.com", username: "two", attributes: {} },
    ]);
    mockCountRealmUsers.mockResolvedValue(2);

    const res = await GET(makeRequest(
      "/api/admin/users?simulate_type=user&simulate_id=target-admin",
    ));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(2);
    expect(body.scoped).toBeUndefined();
    expect(mockSearchRealmUsers).toHaveBeenCalled();
  });

  it("applies the existing full-list policy for a team-admin preview", async () => {
    mockPreviewAuthorization("unused-user-id");
    setMembershipBySlug({
      platform: ["managed@example.com"],
    });
    mockSearchRealmUsers.mockResolvedValue([
      { id: "managed", email: "managed@example.com", username: "managed", attributes: {} },
      { id: "other", email: "other@example.com", username: "other", attributes: {} },
    ]);
    mockCountRealmUsers.mockResolvedValue(2);

    const res = await GET(makeRequest(
      "/api/admin/users?simulate_type=team&simulate_id=platform&simulate_relation=admin",
    ));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(2);
    expect(body.users.find((user: { id: string }) => user.id === "managed").can_edit).toBe(true);
    expect(body.users.find((user: { id: string }) => user.id === "other").can_edit).toBe(false);
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment node
 */
/**
 * Tests for Admin Team Management API Routes
 *
 * Covers:
 * - GET /api/admin/teams — list all teams
 * - POST /api/admin/teams — create a team
 * - GET /api/admin/teams/[id] — get team details
 * - PATCH /api/admin/teams/[id] — update team
 * - DELETE /api/admin/teams/[id] — delete team
 * - POST /api/admin/teams/[id]/members — add member
 * - DELETE /api/admin/teams/[id]/members — remove member
 *
 * Auth patterns tested:
 * - 401 when not authenticated
 * - 403 when not admin
 * - Success when admin
 */

import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';

// ============================================================================
// Mocks
// ============================================================================

// Mock NextAuth
const mockGetServerSession = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn(async () => ({ objects: [] as string[] }));
jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

// Mock auth config
jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: '',
}));

jest.mock('@/lib/rbac/keycloak-authz', () => ({
  checkPermission: jest.fn(),
}));
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  // Post 2026-05-26 canonical-membership refactor: GET
  // /api/admin/teams/[id] now decorates the response with an OpenFGA
  // sync report (`computeTeamMembershipSyncReport`) and therefore calls
  // `readTeamOpenFgaTuples` -> `isOpenFgaConfigured`/`readOpenFgaTuples`.
  // We treat OpenFGA as unconfigured in this admin-CRUD suite so the
  // route returns a null sync report instead of crashing on undefined
  // helpers. The dedicated team-openfga-sync-status.test.ts suite
  // exercises the configured path.
  isOpenFgaConfigured: jest.fn(() => false),
  readOpenFgaTuples: jest.fn(async () => ({ tuples: [], continuationToken: undefined })),
  writeOpenFgaTuples: jest.fn(async () => ({ enabled: false, writes: 0, deletes: 0 })),
  // FR-025 team-deletion guard: DELETE lists owned service accounts before
  // deleting. Also drives the live KB-count decoration on GET. Default returns
  // no objects; the kb_count test overrides it per (user, relation) tuple.
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...(args as [])),
  // `team-resource-listing` (the live KB + resource count helpers GET decorates
  // each row with) imports these from openfga; provide pass-through impls so the
  // batch helpers run against the mocked `listOpenFgaObjects` above.
  openFgaReadConcurrency: jest.fn(() => 8),
  mapWithConcurrency: jest.fn(
    async <T, R>(items: readonly T[], _limit: number, fn: (item: T, index: number) => Promise<R>) =>
      Promise.all(items.map((item, index) => fn(item, index))),
  ),
}));
jest.mock('@/lib/rbac/audit', () => ({
  logAuthzDecision: jest.fn(),
}));
// Phase 3 (spec 2026-05-24-derive-team-from-channel) removed
// `ensureTeamClientScope` / `deleteTeamClientScope` from
// `keycloak-admin.ts`. The team CRUD routes no longer import them,
// so the mock only needs `isValidTeamSlug`. The stale mock entries
// were leftovers from before the demolition.
jest.mock('@/lib/rbac/keycloak-admin', () => ({
  isValidTeamSlug: jest.fn((slug: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)),
}));

/** After resetModules(), re-require the mock so we configure the fresh jest.fn(). */
function setDefaultCheckPermissionMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { checkPermission } = require('@/lib/rbac/keycloak-authz') as {
    checkPermission: jest.Mock;
  };
  checkPermission.mockResolvedValue({
    allowed: false,
    reason: 'DENY_NO_CAPABILITY',
  });
}

function resetRouteModules() {
  jest.resetModules();
  setDefaultCheckPermissionMock();
}

jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => key === 'ssoEnabled',
}));

// Mock MongoDB
const mockCollections: Record<string, unknown> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = createMockCollection();
  }
  return Promise.resolve(mockCollections[name]);
});

jest.mock('@/lib/mongodb', () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockCollection() {
  // Cursor supports BOTH `find().toArray()` and `find().sort().toArray()`.
  // Post 2026-05-26 canonical-membership refactor, route handlers
  // query team_membership_sources via toArray() directly.
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    // `team-membership-source-store.upsertTeamMembershipSource()` now
    // calls `deleteMany` after `updateOne` to collapse stale
    // `status:"removed"` orphan rows (introduced together with the
    // OpenFGA admin-implies-member model change). Routes that create
    // teams hit that path indirectly through membership-source writes,
    // so the shared mock collection has to advertise `deleteMany` too
    // or the POST route fails with HTTP 500.
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    countDocuments: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), options);
}

function accessTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(
    JSON.stringify({ realm_access: { roles } }),
    'utf8'
  ).toString('base64url');
  return `h.${payload}.s`;
}

function adminSession() {
  return {
    user: { email: 'admin@example.com', name: 'Admin User' },
    role: 'admin',
    sub: 'admin-user-sub',
    accessToken: accessTokenWithRoles(['admin']),
  };
}

function userSession() {
  return {
    user: { email: 'user@example.com', name: 'Regular User' },
    role: 'user',
    sub: 'regular-user-sub',
    accessToken: accessTokenWithRoles(['chat_user']),
  };
}

const TEST_TEAM_ID = new ObjectId();
const TEST_TEAM_SLUG = 'platform-engineering';
const TEST_TEAM = {
  _id: TEST_TEAM_ID,
  name: 'Platform Engineering',
  // Required by the canonical-membership readers (post 2026-05-26
  // refactor). Older tests didn't need a slug because the route read
  // team.members[] directly.
  slug: TEST_TEAM_SLUG,
  description: 'The platform team',
  owner_id: 'admin@example.com',
  created_at: new Date(),
  updated_at: new Date(),
  members: [
    { user_id: 'admin@example.com', role: 'owner', added_at: new Date(), added_by: 'admin@example.com' },
    { user_id: 'member@example.com', role: 'member', added_at: new Date(), added_by: 'admin@example.com' },
  ],
};

/**
 * Seed `team_membership_sources` to mirror TEST_TEAM.members so route
 * handlers gating on canonical membership find the same identities.
 * Pre 2026-05-26 the routes read team.members[] directly.
 */
function seedTestTeamCanonicalMembers() {
  const sourcesCol = createMockCollection();
  const rows = [
    {
      team_slug: TEST_TEAM_SLUG,
      user_email: 'admin@example.com',
      user_subject: 'kc-admin',
      relationship: 'admin',
      source_type: 'manual',
      status: 'active',
    },
    {
      team_slug: TEST_TEAM_SLUG,
      user_email: 'member@example.com',
      user_subject: 'kc-member',
      relationship: 'member',
      source_type: 'manual',
      status: 'active',
    },
  ];
  function rowMatches(filter: Record<string, unknown>, row: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or' && Array.isArray(value)) {
        if (!value.some((c: Record<string, unknown>) => rowMatches(c, row))) return false;
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('$ne' in (value as object) && row[key] === (value as { $ne: unknown }).$ne) return false;
        if ('$in' in (value as object)) {
          const arr = ((value as { $in: unknown[] }).$in) ?? [];
          if (!arr.includes(row[key])) return false;
        }
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  }
  sourcesCol.find = jest.fn((filter: Record<string, unknown> = {}) => {
    const matched = rows.filter((r) => rowMatches(filter, r));
    return {
      sort: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(matched) }),
      toArray: jest.fn().mockResolvedValue(matched),
    };
  });
  mockCollections['team_membership_sources'] = sourcesCol;
}

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach(key => delete mockCollections[key]);
  mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user?: string }) => ({
    allowed: tuple.user === 'user:admin-user-sub',
  }));
  setDefaultCheckPermissionMock();
  // Default canonical seed mirrors TEST_TEAM.members; tests that need
  // a different roster override mockCollections.team_membership_sources
  // afterwards.
  seedTestTeamCanonicalMembers();
});

// ============================================================================
// GET /api/admin/teams — List teams
// ============================================================================

describe('GET /api/admin/teams', () => {
  let GET: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/route');
    GET = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/admin/teams');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks admin_ui#view', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    const req = makeRequest('/api/admin/teams');
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('You do not have permission');
  });

  it('returns teams list for admin', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([TEST_TEAM]),
      }),
    });
    mockCollections['teams'] = teamsCol;

    const req = makeRequest('/api/admin/teams');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.teams).toHaveLength(1);
    expect(body.data.teams[0].name).toBe('Platform Engineering');
  });

  it('marks team list responses as no-store so refreshes read MongoDB', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest('/api/admin/teams?fresh=123');

    const res = await GET(req);

    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('decorates each team with member_count derived from team_membership_sources, ignoring stale team.members[]', async () => {
    // Commit 4/8 of the canonical-team-membership refactor: the list
    // endpoint now reports `member_count` aggregated from the canonical
    // store. A team with a phantom legacy `team.members[]` array but
    // ZERO canonical rows must report `member_count: 0` — that's what
    // catches drift between the two stores in the Admin UI badge.
    mockGetServerSession.mockResolvedValue(adminSession());

    const ghostTeamSlug = 'ghost-team';
    const ghostTeam = {
      _id: new ObjectId(),
      name: 'Ghost Team',
      slug: ghostTeamSlug,
      members: [
        // Stale embedded array — UI used to read .length here.
        { user_id: 'phantom@example.com', role: 'member', added_at: new Date(), added_by: 'admin@example.com' },
        { user_id: 'phantom2@example.com', role: 'member', added_at: new Date(), added_by: 'admin@example.com' },
      ],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const teamsCol = createMockCollection();
    teamsCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([TEST_TEAM, ghostTeam]),
      }),
    });
    mockCollections['teams'] = teamsCol;

    // Wire the canonical store's aggregate() to return TEST_TEAM_SLUG=2,
    // ghost-team absent (=> defaults to 0). loadTeamMemberCounts seeds
    // counts to 0 for every requested slug before consulting the cursor.
    const sourcesCol = mockCollections['team_membership_sources'];
    sourcesCol.aggregate = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ _id: TEST_TEAM_SLUG, count: 2 }]),
    });

    const req = makeRequest('/api/admin/teams');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      body.data.teams.map((t: { name: string; member_count: number }) => [t.name, t.member_count]),
    );
    expect(byName['Platform Engineering']).toBe(2);
    expect(byName['Ghost Team']).toBe(0);
  });

  it('decorates each team with kb_count read live from OpenFGA (deduped), defaulting to 0', async () => {
    // OpenFGA is now the single source of truth for team↔KB grants (the
    // `team_kb_ownership` collection was dropped). The team-card "KBs" badge
    // counts distinct `knowledge_base:<id>` objects the team holds across the
    // reader/ingestor/manager relations; a team with no grants reports 0 so
    // the badge renders a number instead of hiding.
    mockGetServerSession.mockResolvedValue(adminSession());

    const kbTeam = {
      _id: new ObjectId(),
      name: 'KB Team',
      slug: 'kb-team',
      created_at: new Date(),
      updated_at: new Date(),
    };
    const noKbTeam = {
      _id: new ObjectId(),
      name: 'No KB Team',
      slug: 'no-kb-team',
      created_at: new Date(),
      updated_at: new Date(),
    };

    const teamsCol = createMockCollection();
    teamsCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([kbTeam, noKbTeam]),
      }),
    });
    mockCollections['teams'] = teamsCol;

    // Drive kb_count through OpenFGA list-objects. kb-team holds kb-a via
    // `reader` AND `ingestor`; the strongest-permission merge in
    // `listTeamKbGrants` collapses that to a single distinct KB, plus kb-b →
    // count 2. no-kb-team holds nothing → 0.
    mockListOpenFgaObjects.mockImplementation(
      (async (args: { user: string; relation: string; type: string }) => {
        if (args.type !== 'knowledge_base') return { objects: [] as string[] };
        if (args.user === 'team:kb-team#member' && args.relation === 'reader') {
          return { objects: ['knowledge_base:kb-a', 'knowledge_base:kb-b'] };
        }
        if (args.user === 'team:kb-team#member' && args.relation === 'ingestor') {
          return { objects: ['knowledge_base:kb-a'] };
        }
        return { objects: [] as string[] };
      }) as unknown as () => Promise<{ objects: string[] }>,
    );

    const req = makeRequest('/api/admin/teams');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      body.data.teams.map((t: { name: string; kb_count: number }) => [t.name, t.kb_count]),
    );
    expect(byName['KB Team']).toBe(2);
    expect(byName['No KB Team']).toBe(0);
  });
});

// ============================================================================
// POST /api/admin/teams — Create team
// ============================================================================

describe('POST /api/admin/teams', () => {
  let POST: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/route');
    POST = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/admin/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Team' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    const req = makeRequest('/api/admin/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Team' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest('/api/admin/teams', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('creates a team successfully', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null); // No duplicate
    mockCollections['teams'] = teamsCol;

    const req = makeRequest('/api/admin/teams', {
      method: 'POST',
      body: JSON.stringify({
        name: 'New Team',
        description: 'A new team',
        members: ['user1@example.com'],
      }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.message).toBe('Team created successfully');
    expect(teamsCol.insertOne).toHaveBeenCalledTimes(1);

    // Commit 6/8 of the canonical-team-membership refactor (spec
    // 2026-05-26-canonical-team-membership): the team document no
    // longer carries an embedded `members[]` array. Membership lives
    // exclusively in team_membership_sources (the upsert loop in the
    // route is covered by team-creation-openfga-sync.test.ts).
    const insertedTeam = teamsCol.insertOne.mock.calls[0][0];
    expect(insertedTeam.name).toBe('New Team');
    expect(insertedTeam.members).toBeUndefined();
    expect(insertedTeam.owner_id).toBe('admin@example.com');
  });

  it('rejects duplicate team name', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM); // Duplicate exists
    mockCollections['teams'] = teamsCol;

    const req = makeRequest('/api/admin/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Platform Engineering' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already exists');
  });

  // Phase 3 (spec 2026-05-24-derive-team-from-channel) removed the
  // `ensureTeamClientScope` call from team creation, so the 502
  // "identity setup failed" failure mode is no longer reachable: team
  // creation no longer touches Keycloak. Any test that injected
  // `ensureTeamClientScope.mockRejectedValueOnce(...)` was deleted with
  // the helper. OpenFGA tuple-write failures continue to be tolerated
  // (logged, not thrown) per the same comment in `route.ts`.
});

// ============================================================================
// GET /api/admin/teams/[id] — Get team details
// ============================================================================

describe('GET /api/admin/teams/[id]', () => {
  let GET: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/[id]/route');
    GET = mod.GET;
  });

  const makeContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`);
    const res = await GET(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`);
    const res = await GET(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid ID format', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest('/api/admin/teams/not-a-valid-id');
    const res = await GET(req, makeContext('not-a-valid-id'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when team not found', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`);
    const res = await GET(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(404);
  });

  it('returns team details for admin', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`);
    const res = await GET(req, makeContext(TEST_TEAM_ID.toString()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.team.name).toBe('Platform Engineering');
  });
});

// ============================================================================
// PATCH /api/admin/teams/[id] — Update team
// ============================================================================

describe('PATCH /api/admin/teams/[id]', () => {
  let PATCH: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/[id]/route');
    PATCH = mod.PATCH;
  });

  const makeContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  it('returns 404 when team not found', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    const res = await PATCH(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(404);
  });

  it('updates team name and description', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    // First findOne: team exists; second findOne (duplicate check): no dup; third findOne: return updated
    teamsCol.findOne
      .mockResolvedValueOnce(TEST_TEAM) // exists check
      .mockResolvedValueOnce(null)       // duplicate name check
      .mockResolvedValueOnce({ ...TEST_TEAM, name: 'Updated Team', description: 'New desc' }); // return updated
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated Team', description: 'New desc' }),
    });
    const res = await PATCH(req, makeContext(TEST_TEAM_ID.toString()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it('rejects empty team name', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '   ' }),
    });
    const res = await PATCH(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
  });

  it('rejects duplicate team name', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne
      .mockResolvedValueOnce(TEST_TEAM)                    // exists check
      .mockResolvedValueOnce({ ...TEST_TEAM, _id: new ObjectId() }); // duplicate found
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Existing Team' }),
    });
    const res = await PATCH(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already exists');
  });
});

// ============================================================================
// DELETE /api/admin/teams/[id] — Delete team
// ============================================================================

describe('DELETE /api/admin/teams/[id]', () => {
  let DELETE: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/[id]/route');
    DELETE = mod.DELETE;
  });

  const makeContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  it('returns 404 when team not found', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`, { method: 'DELETE' });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(404);
  });

  it('deletes team and cleans up conversation references', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const convsCol = createMockCollection();
    mockCollections['conversations'] = convsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}`, { method: 'DELETE' });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);
    expect(teamsCol.deleteOne).toHaveBeenCalledTimes(1);
    // Should clean up conversation shared_with_teams
    expect(convsCol.updateMany).toHaveBeenCalledWith(
      { 'sharing.shared_with_teams': TEST_TEAM_ID.toString() },
      { $pull: { 'sharing.shared_with_teams': TEST_TEAM_ID.toString() } },
    );
  });
});

// ============================================================================
// POST /api/admin/teams/[id]/members — Add member
// ============================================================================

describe('POST /api/admin/teams/[id]/members', () => {
  let POST: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/[id]/members/route');
    POST = mod.POST;
  });

  const makeContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'new@example.com' }),
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(401);
  });

  it('returns 400 when user_id is missing', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'not-an-email' }),
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid role', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'new@example.com', role: 'superadmin' }),
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
  });

  it('returns 404 when team not found', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'new@example.com' }),
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(404);
  });

  it('returns 400 when member already exists', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'member@example.com' }), // Already in TEST_TEAM
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already a member');
  });

  it('adds a new member successfully', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne
      .mockResolvedValueOnce(TEST_TEAM)  // team exists
      .mockResolvedValueOnce({ ...TEST_TEAM, members: [...TEST_TEAM.members, { user_id: 'new@example.com', role: 'member' }] }); // after update
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'new@example.com', role: 'admin' }),
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it('defaults role to member when not specified', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne
      .mockResolvedValueOnce(TEST_TEAM)
      .mockResolvedValueOnce(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    // Capture the canonical-store upsert so we can pin the resolved role.
    // Commit 6/8 of the canonical-team-membership refactor (spec
    // 2026-05-26-canonical-team-membership): role is now persisted onto
    // `team_membership_sources.relationship`, not into a $push on
    // teams.members[].
    const sourcesCol = createMockCollection();
    mockCollections['team_membership_sources'] = sourcesCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'new@example.com' }), // No role specified
    });
    const res = await POST(req, makeContext(TEST_TEAM_ID.toString()));

    expect(res.status).toBe(201);
    const updateCall = teamsCol.updateOne.mock.calls[0];
    expect(updateCall[1].$push).toBeUndefined();
    // The canonical upsert is the role-of-truth; verify the source row
    // was created with relationship: "member" (the default).
    const relationshipValues = sourcesCol.updateOne.mock.calls.map((call: unknown[]) => {
      const update = call[1] as { $set?: { relationship?: string } };
      return update?.$set?.relationship;
    });
    expect(relationshipValues).toContain('member');
  });
});

// ============================================================================
// DELETE /api/admin/teams/[id]/members — Remove member
// ============================================================================

describe('DELETE /api/admin/teams/[id]/members', () => {
  let DELETE: unknown;

  beforeEach(async () => {
    resetRouteModules();
    const mod = await import('@/app/api/admin/teams/[id]/members/route');
    DELETE = mod.DELETE;
  });

  const makeContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  it('returns 400 when user_id query param is missing', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('user_id');
  });

  it('returns 404 when team not found', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members?user_id=member@example.com`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(404);
  });

  it('returns 400 when trying to remove the owner', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members?user_id=admin@example.com`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('owner');
  });

  it('returns 404 when member does not exist in team', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(TEST_TEAM);
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members?user_id=nonexistent@example.com`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not a member');
  });

  it('removes a member successfully', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const teamsCol = createMockCollection();
    teamsCol.findOne
      .mockResolvedValueOnce(TEST_TEAM)  // team exists with member@example.com
      .mockResolvedValueOnce({ ...TEST_TEAM, members: [TEST_TEAM.members[0]] }); // after removal
    mockCollections['teams'] = teamsCol;

    const req = makeRequest(`/api/admin/teams/${TEST_TEAM_ID}/members?user_id=member@example.com`, {
      method: 'DELETE',
    });
    const res = await DELETE(req, makeContext(TEST_TEAM_ID.toString()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });
});

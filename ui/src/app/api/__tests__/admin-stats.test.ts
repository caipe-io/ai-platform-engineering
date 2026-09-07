/**
 * @jest-environment node
 */
/**
 * Tests for Admin Stats API Route
 *
 * Covers:
 * - GET /api/admin/stats — platform-wide usage statistics
 *
 * Features tested:
 * - Authentication: 401 when unauthenticated
 * - Authorization: 403 when non-admin (OIDC + MongoDB fallback)
 * - MongoDB guard: 503 when MongoDB is not configured
 * - Overview stats: total users, conversations, assistant messages, DAU, MAU,
 *   shared, avg assistant messages per conversation
 * - Daily activity: optimized 30-day aggregation (3 pipelines vs 90 queries)
 * - Top users by conversations: direct owner_id group
 * - Top users by messages: $lookup fallback for legacy messages without owner_id
 * - Top agents by usage
 * - Feedback summary: positive/negative counts
 * - Response time: avg/min/max latency_ms
 * - Hourly activity heatmap: all 24 hours, zero-filled
 * - Full response structure validation
 * - Edge case: empty database returns safe defaults
 */

import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';

// ============================================================================
// Mocks
// ============================================================================

const mockGetServerSession = jest.fn();
jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: '',
}));

jest.mock('@/lib/rbac/keycloak-authz', () => ({
  checkPermission: jest.fn(),
}));
jest.mock('@/lib/rbac/audit', () => ({
  logAuthzDecision: jest.fn(),
}));

// The OpenFGA gate (`requireAdminSurfaceManage`) calls `checkOpenFgaTuple` and
// rejects any session without `sub`. Mock it so tests can drive allow/deny per
// `tuple.user`.
const mockCheckOpenFgaTuple = jest.fn();
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

const mockGetRealmUserByIdOrNull = jest.fn();
jest.mock('@/lib/rbac/keycloak-admin', () => ({
  getRealmUserByIdOrNull: (...args: unknown[]) => mockGetRealmUserByIdOrNull(...args),
}));

// Non-admins are scoped via getReadableSlackChannelNames / getReadableWebexSpaceIds;
// mock so tests can drive which Slack channels / Webex spaces a non-admin can see.
const mockGetReadableSlackChannelNames = jest.fn<Promise<string[]>, [string]>();
const mockGetReadableWebexSpaceIds = jest.fn<Promise<string[]>, [string]>();
const mockGetOwnedAgents = jest.fn<Promise<Array<{ id: string; name: string }>>, [string]>();
const mockGetOwnedAgentConversationIds = jest.fn<
  Promise<{ ids: string[]; capped: boolean }>,
  [Array<{ id: string; name: string }>]
>();
const mockGetAllAgents = jest.fn<Promise<Array<{ id: string; name: string }>>, []>();
const mockGetAgentsByIds = jest.fn<Promise<Array<{ id: string; name: string }>>, [string[]]>();
jest.mock('@/lib/rbac/user-insights-scope', () => ({
  getReadableSlackChannelNames: (...args: unknown[]) =>
    mockGetReadableSlackChannelNames(...(args as [string])),
  getReadableWebexSpaceIds: (...args: unknown[]) =>
    mockGetReadableWebexSpaceIds(...(args as [string])),
  getOwnedAgents: (...args: unknown[]) =>
    mockGetOwnedAgents(...(args as [string])),
  getOwnedAgentConversationIds: (...args: unknown[]) =>
    mockGetOwnedAgentConversationIds(...(args as [Array<{ id: string; name: string }>])),
  getAllAgents: (...args: unknown[]) => mockGetAllAgents(...(args as [])),
  getAgentsByIds: (...args: unknown[]) => mockGetAgentsByIds(...(args as [string[]])),
}));

const mockLoadTeamMembersForSlugs = jest.fn();
jest.mock('@/lib/rbac/team-membership-store', () => ({
  loadTeamMembersForSlugs: (...args: unknown[]) => mockLoadTeamMembersForSlugs(...args),
}));

const mockCheckPermission = jest.requireMock<{ checkPermission: jest.Mock }>(
  '@/lib/rbac/keycloak-authz'
).checkPermission;

jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => key === 'ssoEnabled',
}));

const mockCollections: Record<string, unknown> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = createMockCollection();
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

// Direct MCP Activity queries the audit-service over HTTP (not Mongo). Every
// admin request exercises this (it's part of the default `section=all`
// response), so a default resolved value is required — otherwise every
// existing admin test in this file would issue a real network call to
// http://audit-service:8010.
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ============================================================================
// Helpers
// ============================================================================

function createMockCollection() {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([]),
          }),
        }),
        toArray: jest.fn().mockResolvedValue([]),
      }),
      // Real cursors expose toArray() at the top level too (e.g. the
      // workflow_runs owner-sub resolution does `find(...).toArray()`).
      toArray: jest.fn().mockResolvedValue([]),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
    distinct: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    }),
  };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

/** Minimal JWT body so requireRbacPermission can decode realm_access.roles. */
function accessTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(
    JSON.stringify({ realm_access: { roles } }),
    'utf8'
  ).toString('base64url');
  return `h.${payload}.s`;
}

/**
 * Admin session via OIDC role — getAuthenticatedUser sees session.role === 'admin'
 * and skips the MongoDB fallback check entirely.
 */
function adminSession() {
  return {
    user: { email: 'admin@example.com', name: 'Admin User' },
    role: 'admin',
    sub: 'admin-user-sub',
    accessToken: accessTokenWithRoles(['admin']),
  };
}

/**
 * Regular user session — getAuthenticatedUser will check MongoDB users
 * collection for metadata.role === 'admin' as a fallback.
 */
function userSession() {
  return {
    user: { email: 'user@example.com', name: 'Regular User' },
    role: 'user',
    sub: 'regular-user-sub',
    accessToken: accessTokenWithRoles(['chat_user']),
  };
}

function resetMocks() {
  mockGetServerSession.mockReset();
  mockGetCollection.mockClear();
  mockIsMongoDBConfigured = true;
  mockCheckPermission.mockReset();
  mockCheckPermission.mockResolvedValue({
    allowed: false,
    reason: 'DENY_NO_CAPABILITY',
  });
  // Default: only `user:admin-user-sub` passes the OpenFGA ReBAC gate.
  // Tests can override per-case with `mockCheckOpenFgaTuple.mockResolvedValueOnce(...)`.
  mockCheckOpenFgaTuple.mockReset();
  mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user?: string }) => ({
    allowed: tuple.user === 'user:admin-user-sub',
  }));
  mockGetReadableSlackChannelNames.mockReset();
  mockGetReadableSlackChannelNames.mockResolvedValue([]);
  mockGetReadableWebexSpaceIds.mockReset();
  mockGetReadableWebexSpaceIds.mockResolvedValue([]);
  mockGetRealmUserByIdOrNull.mockReset();
  mockGetRealmUserByIdOrNull.mockResolvedValue(null);
  mockGetOwnedAgents.mockReset();
  mockGetOwnedAgents.mockResolvedValue([]);
  mockGetOwnedAgentConversationIds.mockReset();
  mockGetOwnedAgentConversationIds.mockResolvedValue({ ids: [], capped: false });
  mockGetAllAgents.mockReset();
  mockGetAllAgents.mockResolvedValue([]);
  mockGetAgentsByIds.mockReset();
  mockGetAgentsByIds.mockResolvedValue([]);
  mockLoadTeamMembersForSlugs.mockReset();
  mockLoadTeamMembersForSlugs.mockResolvedValue(new Map());
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ records: [], total: 0 }),
  });
}

/**
 * Setup admin session with properly configured mock collections.
 * The admin route calls getCollection('users'), getCollection('conversations'),
 * getCollection('messages'), getCollection('feedback'), and optionally
 * getCollection('platform_config'). The auth middleware also calls
 * getCollection('users') for the MongoDB admin fallback (skipped for OIDC admins).
 */
function setupAdminWithCollections() {
  mockGetServerSession.mockResolvedValue(adminSession());

  // Users collection — no findOne needed for OIDC admin (session.role = 'admin')
  const usersCol = createMockCollection();
  usersCol.countDocuments.mockResolvedValue(0);
  mockCollections['users'] = usersCol;

  const convCol = createMockCollection();
  convCol.countDocuments.mockResolvedValue(0);
  mockCollections['conversations'] = convCol;

  const msgCol = createMockCollection();
  msgCol.countDocuments.mockResolvedValue(0);
  mockCollections['messages'] = msgCol;

  const feedbackCol = createMockCollection();
  feedbackCol.countDocuments.mockResolvedValue(0);
  mockCollections['feedback'] = feedbackCol;

  const platformConfigCol = createMockCollection();
  mockCollections['platform_config'] = platformConfigCol;

  return { usersCol, convCol, msgCol, feedbackCol };
}

/**
 * Setup non-admin collections — same shape as admin, but the caller (not us)
 * is responsible for setting `mockGetServerSession` / `mockCheckOpenFgaTuple`.
 */
function setupNonAdminCollections() {
  const usersCol = createMockCollection();
  usersCol.countDocuments.mockResolvedValue(0);
  mockCollections['users'] = usersCol;

  const convCol = createMockCollection();
  convCol.countDocuments.mockResolvedValue(0);
  mockCollections['conversations'] = convCol;

  const msgCol = createMockCollection();
  msgCol.countDocuments.mockResolvedValue(0);
  mockCollections['messages'] = msgCol;

  const feedbackCol = createMockCollection();
  feedbackCol.countDocuments.mockResolvedValue(0);
  mockCollections['feedback'] = feedbackCol;

  const platformConfigCol = createMockCollection();
  mockCollections['platform_config'] = platformConfigCol;

  return { usersCol, convCol, msgCol, feedbackCol };
}

// ============================================================================
// Test imports (after mocks)
// ============================================================================

import { GET } from '../admin/stats/route';

// ============================================================================
// Tests: Authentication & Authorization
// ============================================================================

describe('GET /api/admin/stats — Authentication & Authorization', () => {
  beforeEach(resetMocks);

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('non-admins are scoped, not denied — returns 200 even with no readable channels', async () => {
    // A non-admin (no admin_surface:stats#can_manage) is scoped rather than
    // 403'd. With no readable Slack channels but a session email present, the
    // view is scoped to that user's own web conversations.
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);

    setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // RBAC contract: full admin scope requires OpenFGA admin_surface:stats
  // #can_manage. Side-channels (`session.canViewAdmin`, the MongoDB
  // `metadata.role: 'admin'` fallback) must NOT grant admin scope — they only
  // ever yield the non-admin scoped view. The two tests below pin that.
  // ────────────────────────────────────────────────────────────────────────

  it('viewer-only OIDC session (canViewAdmin) gets scoped view — NOT full admin', async () => {
    mockGetServerSession.mockResolvedValue({ ...userSession(), canViewAdmin: true });
    mockGetReadableSlackChannelNames.mockResolvedValue([]);

    setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The OpenFGA gate must have been consulted (and denied) — proving we
    // didn't short-circuit on the side-channel.
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user:regular-user-sub', relation: 'can_manage' })
    );
    expect(body.success).toBe(true);
  });

  it('MongoDB admin-role fallback gets scoped view — NOT full admin', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);

    setupNonAdminCollections();
    const usersCol = mockCollections['users'];
    usersCol.findOne.mockResolvedValue({
      email: 'user@example.com',
      metadata: { role: 'admin' },
    });

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 503 when MongoDB is not configured', async () => {
    mockIsMongoDBConfigured = false;
    mockGetServerSession.mockResolvedValue(adminSession());
    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('MONGODB_NOT_CONFIGURED');
  });
});

// ============================================================================
// Tests: Overview Statistics
// ============================================================================

describe('GET /api/admin/stats — Overview', () => {
  beforeEach(resetMocks);

  it('returns overview with correct counts', async () => {
    const { usersCol, convCol, msgCol } = setupAdminWithCollections();

    // Promise.all order (no filters):
    // users: totalUsers, dau, mau
    // conversations: totalConversations, conversationsToday, sharedConversations
    // messages: totalMessages, messagesToday — assistant rows across every
    // metadata.source (not just 'web'/'slack').
    usersCol.countDocuments
      .mockResolvedValueOnce(15)   // totalUsers
      .mockResolvedValueOnce(3)    // dau
      .mockResolvedValueOnce(10);  // mau

    convCol.countDocuments
      .mockResolvedValueOnce(50)   // totalConversations
      .mockResolvedValueOnce(5)    // conversationsToday
      .mockResolvedValueOnce(2);   // sharedConversations

    msgCol.countDocuments
      .mockResolvedValueOnce(200)  // totalMessages
      .mockResolvedValueOnce(20);  // messagesToday

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.overview).toEqual(
      expect.objectContaining({
        total_users: 15,
        total_conversations: 50,
        total_messages: 200,
        dau: 3,
        mau: 10,
        conversations_today: 5,
        messages_today: 20,
        shared_conversations: 2,
      })
    );
    expect(usersCol.countDocuments).toHaveBeenNthCalledWith(1, {
      last_login: { $gte: expect.any(Date), $lte: expect.any(Date) },
    });
  });

  it('excludes human messages from overview and activity metrics', async () => {
    const { msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats'));

    // Overview total + today must both count only AI-platform output.
    expect(msgCol.countDocuments).toHaveBeenCalledTimes(2);
    for (const [filter] of msgCol.countDocuments.mock.calls) {
      expect(filter).toEqual(expect.objectContaining({ role: 'assistant' }));
    }

    // The daily activity and top-users aggregations share the same invariant.
    type PipelineStage = {
      $group?: Record<string, unknown>;
      $lookup?: { from?: string };
      $match?: Record<string, unknown>;
    };
    const pipelines = msgCol.aggregate.mock.calls.map(
      (call: unknown[]) => call[0] as PipelineStage[]
    );
    const dailyPipeline = pipelines.find((pipeline) =>
      pipeline.some((stage) => stage.$group?.messages)
    );
    const topUsersPipeline = pipelines.find((pipeline) =>
      pipeline.some((stage) => stage.$lookup?.from === 'conversations')
    );

    expect(dailyPipeline?.[0].$match).toEqual(
      expect.objectContaining({ role: 'assistant' })
    );
    expect(topUsersPipeline?.[0].$match).toEqual(
      expect.objectContaining({ role: 'assistant' })
    );
  });

  it('computes avg_messages_per_conversation correctly', async () => {
    const { usersCol, convCol, msgCol } = setupAdminWithCollections();

    usersCol.countDocuments.mockResolvedValue(5);
    convCol.countDocuments
      .mockResolvedValueOnce(4)   // totalConversations
      .mockResolvedValueOnce(0)   // conversationsToday
      .mockResolvedValueOnce(0);  // sharedConversations
    msgCol.countDocuments
      .mockResolvedValueOnce(10)  // totalMessages
      .mockResolvedValueOnce(0);  // messagesToday

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    // 10 / 4 = 2.5
    expect(body.data.overview.avg_messages_per_conversation).toBe(2.5);
  });

  it('returns avg_messages_per_conversation = 0 when no conversations', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.overview.avg_messages_per_conversation).toBe(0);
  });
});

// ============================================================================
// Tests: Rolling DAU/MAU windows (not calendar-aligned)
// ============================================================================

describe('GET /api/admin/stats — Rolling DAU/MAU windows', () => {
  beforeEach(resetMocks);

  afterEach(() => {
    jest.useRealTimers();
  });

  it('computes DAU/MAU as rolling last-24h/last-30d windows, not calendar-aligned', async () => {
    // Freeze time just after a day+month boundary. A calendar-aligned window
    // (midnight-to-now / 1st-of-month-to-now) would start only ~2 hours ago;
    // a rolling window (last 24h / last 30d) starts exactly 24h/30d before
    // "now" regardless of the boundary. Pins DAU/MAU to the rolling behavior
    // used by every other range-aware metric on this dashboard.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const frozenNow = new Date('2026-03-01T02:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(frozenNow);

    const { usersCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    const [, dauCall, mauCall] = usersCol.countDocuments.mock.calls as [
      unknown,
      [{ last_login: { $gte: Date } }],
      [{ last_login: { $gte: Date } }],
    ];
    const dauStart = dauCall[0].last_login.$gte;
    const mauStart = mauCall[0].last_login.$gte;

    expect(dauStart.getTime()).toBe(frozenNow.getTime() - DAY_MS);
    expect(mauStart.getTime()).toBe(frozenNow.getTime() - 30 * DAY_MS);
  });
});

// ============================================================================
// Tests: Daily Activity (30-day aggregation)
// ============================================================================

describe('GET /api/admin/stats — Daily Activity', () => {
  beforeEach(resetMocks);

  it('returns 30 days of daily activity', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.daily_activity).toHaveLength(30);
  });

  it('each day has correct structure', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    for (const day of body.data.daily_activity) {
      expect(day).toHaveProperty('date');
      expect(day).toHaveProperty('active_users');
      expect(day).toHaveProperty('conversations');
      expect(day).toHaveProperty('messages');
      expect(typeof day.date).toBe('string');
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.active_users).toBe('number');
      expect(typeof day.conversations).toBe('number');
      expect(typeof day.messages).toBe('number');
    }
  });

  it('fills missing days with zeros', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    // With empty aggregation results, all days should be 0
    for (const day of body.data.daily_activity) {
      expect(day.active_users).toBe(0);
      expect(day.conversations).toBe(0);
      expect(day.messages).toBe(0);
    }
  });

  it('uses aggregate instead of 90 individual countDocuments queries', async () => {
    const { usersCol, convCol, msgCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    // Each collection should have aggregate called (for daily activity)
    expect(usersCol.aggregate).toHaveBeenCalled();
    expect(convCol.aggregate).toHaveBeenCalled();
    expect(msgCol.aggregate).toHaveBeenCalled();
  });
});

// ============================================================================
// Tests: Top Users (the $lookup fix for messages)
// ============================================================================

describe('GET /api/admin/stats — Top Users', () => {
  beforeEach(resetMocks);

  it('includes both by_conversations and by_messages in response', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.top_users).toHaveProperty('by_conversations');
    expect(body.data.top_users).toHaveProperty('by_messages');
    expect(Array.isArray(body.data.top_users.by_conversations)).toBe(true);
    expect(Array.isArray(body.data.top_users.by_messages)).toBe(true);
  });

  it('paginates each leaderboard independently in stable groups of 10', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    convCol.aggregate.mockImplementation((pipeline: Record<string, unknown>[]) => ({
      toArray: async () => {
        if (!pipeline.some((stage) => stage.$group?._id === '$owner_id')) return [];
        if (pipeline.some((stage) => stage.$count === 'total')) {
          return [{ total: 23 }];
        }
        return [{ _id: 'conversation-user@example.com', count: 12 }];
      },
    }));
    msgCol.aggregate.mockImplementation((pipeline: Record<string, unknown>[]) => ({
      toArray: async () => {
        if (!pipeline.some((stage) => stage.$group?._id === '$_owner')) return [];
        if (pipeline.some((stage) => stage.$count === 'total')) {
          return [{ total: 31 }];
        }
        return [{ _id: 'message-user@example.com', count: 20 }];
      },
    }));

    const response = await GET(makeRequest(
      '/api/admin/stats?section=top_users&include_bots=true&top_conversations_page=2&top_messages_page=3',
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.top_users.pagination).toEqual({
      by_conversations: {
        page: 2,
        limit: 10,
        total: 23,
        total_pages: 3,
      },
      by_messages: {
        page: 3,
        limit: 10,
        total: 31,
        total_pages: 4,
      },
    });

    const conversationPagePipeline = convCol.aggregate.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>[])
      .find((pipeline) => pipeline.some((stage) => stage.$limit === 10));
    expect(conversationPagePipeline).toEqual(expect.arrayContaining([
      { $sort: { count: -1, _id: 1 } },
      { $skip: 10 },
      { $limit: 10 },
    ]));

    const messagePagePipeline = msgCol.aggregate.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>[])
      .find((pipeline) =>
        pipeline.some((stage) => stage.$group?._id === '$_owner') &&
        pipeline.some((stage) => stage.$limit === 10)
      );
    expect(messagePagePipeline).toEqual(expect.arrayContaining([
      { $sort: { count: -1, _id: 1 } },
      { $skip: 20 },
      { $limit: 10 },
    ]));
  });

  it('ignores legacy ownerless rows in a 90-day leaderboard', async () => {
    const { convCol } = setupAdminWithCollections();
    convCol.aggregate.mockImplementation((pipeline: Record<string, unknown>[]) => ({
      toArray: async () =>
        pipeline.some((stage) => stage.$group?._id === '$owner_id')
          ? [
              { _id: null, count: 4 },
              { _id: 'test-user@example.com', count: 2 },
            ]
          : [],
    }));

    const response = await GET(makeRequest('/api/admin/stats?range=90d'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.top_users.by_conversations).toEqual([
      expect.objectContaining({ _id: 'test-user@example.com', count: 2 }),
    ]);
  });

  it('labels a bot/app owner with its persisted owner_display_name', async () => {
    const { convCol, usersCol } = setupAdminWithCollections();

    // Leaderboard (group on $owner_id) returns the GitLab app's "U…" owner id.
    convCol.aggregate.mockImplementation((pipeline: Record<string, unknown>[]) => ({
      toArray: async () =>
        pipeline.some((s) => s.$group?._id === '$owner_id')
          ? [{ _id: 'U05LC2AV99N', count: 5 }]
          : [],
    }));
    // Not a row in the users collection → no name from there.
    usersCol.find.mockReturnValue({ toArray: async () => [] });
    // The thread is flagged owner_is_bot and carries the app's display name,
    // both persisted at ingestion.
    convCol.find.mockImplementation((filter: Record<string, unknown>) => ({
      toArray: async () =>
        (filter as { 'metadata.owner_is_bot'?: unknown })['metadata.owner_is_bot']
          ? [{ owner_id: 'U05LC2AV99N', metadata: { owner_display_name: 'GitLab' } }]
          : [],
    }));

    const res = await GET(makeRequest('/api/admin/stats?include_bots=true'));
    const body = await res.json();

    expect(body.data.top_users.by_conversations[0]).toMatchObject({
      _id: 'U05LC2AV99N',
      name: 'GitLab',
      owner_type: 'slack_bot',
    });
  });

  it('classifies leaderboard owners by identity type', async () => {
    const { convCol, usersCol } = setupAdminWithCollections();

    // Four owners: a linked user (email), an unlinked Slack user (raw "U…", not
    // flagged, no users row), a Slack bot/app (flagged owner_is_bot), and a
    // platform service account (service-account-* id — an API caller, not a bot).
    convCol.aggregate.mockImplementation((pipeline: Record<string, unknown>[]) => ({
      toArray: async () =>
        pipeline.some((s) => s.$group?._id === '$owner_id')
          ? [
              { _id: 'alice@example.com', count: 9 },
              { _id: 'U01HUMANXYZ', count: 7 },
              { _id: 'U05LC2AV99N', count: 5 },
              { _id: 'service-account-caipe-sa-forge-smoke-tests-5ccdf9', count: 3 },
            ]
          : [],
    }));
    usersCol.find.mockReturnValue({
      toArray: async () => [{ email: 'alice@example.com', name: 'Alice' }],
    });
    convCol.find.mockReturnValue({
      toArray: async () => [
        { owner_id: 'U05LC2AV99N', metadata: { owner_display_name: 'GitLab' } },
      ],
    });

    const res = await GET(makeRequest('/api/admin/stats?include_bots=true'));
    const body = await res.json();

    const byId = Object.fromEntries(
      body.data.top_users.by_conversations.map((u: { _id: string; owner_type: string }) => [u._id, u.owner_type]),
    );
    expect(byId['alice@example.com']).toBe('linked');
    expect(byId['U01HUMANXYZ']).toBe('unlinked_slack');
    expect(byId['U05LC2AV99N']).toBe('slack_bot');
    expect(byId['service-account-caipe-sa-forge-smoke-tests-5ccdf9']).toBe('service_account');
  });

  it('top users by messages uses $lookup through conversations', async () => {
    const { msgCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    // Verify at least one aggregate call on messages uses $lookup from conversations
    const aggregateCalls = msgCol.aggregate.mock.calls;
    const hasLookupPipeline = aggregateCalls.some((call: unknown[]) => {
      const pipeline = call[0];
      return (
        Array.isArray(pipeline) &&
        pipeline.some(
          (stage: Record<string, unknown>) =>
            stage.$lookup && stage.$lookup.from === 'conversations'
        )
      );
    });
    expect(hasLookupPipeline).toBe(true);
  });

  it('top users by messages pipeline uses $ifNull for backward compat', async () => {
    const { msgCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    // The pipeline should include $addFields with $ifNull to coalesce owner_id
    const aggregateCalls = msgCol.aggregate.mock.calls;
    const hasIfNull = aggregateCalls.some((call: unknown[]) => {
      const pipeline = call[0];
      return (
        Array.isArray(pipeline) &&
        pipeline.some(
          (stage: Record<string, unknown>) =>
            stage.$addFields && stage.$addFields._owner?.$ifNull
        )
      );
    });
    expect(hasIfNull).toBe(true);
  });

  it('returns empty arrays when no data exists', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.top_users.by_conversations).toEqual([]);
    expect(body.data.top_users.by_messages).toEqual([]);
  });

  // Detects a post-$group $match that strips bot/service-account ids
  // (unknown/USLACKBOT literals, B-prefixed bot ids, service-account-*).
  const hasHumanOwnerFilter = (calls: unknown[]) =>
    calls.some((call: unknown[]) => {
      const pipeline = call[0];
      if (!Array.isArray(pipeline)) return false;
      const groupIdx = pipeline.findIndex((s: Record<string, unknown>) => s.$group);
      if (groupIdx === -1) return false;
      return pipeline.slice(groupIdx + 1).some((stage: Record<string, unknown>) => {
        const and = stage.$match?.$and;
        if (!Array.isArray(and)) return false;
        const hasNin = and.some((c: Record<string, unknown>) => Array.isArray(c._id?.$nin));
        const hasBotRegex = and.some(
          (c: Record<string, unknown>) => c._id?.$not instanceof RegExp
        );
        return hasNin && hasBotRegex;
      });
    });

  it('filters bots out of both top-user rankings by default', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats'));

    expect(hasHumanOwnerFilter(convCol.aggregate.mock.calls)).toBe(true);
    expect(hasHumanOwnerFilter(msgCol.aggregate.mock.calls)).toBe(true);
  });

  it('keeps bots in both rankings when include_bots=true', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?include_bots=true'));

    // With the toggle on, no bot-stripping $match is appended.
    expect(hasHumanOwnerFilter(convCol.aggregate.mock.calls)).toBe(false);
    expect(hasHumanOwnerFilter(msgCol.aggregate.mock.calls)).toBe(false);
  });

  // Detects the extra `_id: { $nin: [...botOwnerIds] }` exclusion folded in
  // when Slack bot/app owners are flagged via metadata.owner_is_bot — their
  // "U…" user IDs pass the ID-pattern filter, so they're dropped by value.
  const excludesOwnerIds = (calls: unknown[], ids: string[]) =>
    calls.some((call: unknown[]) => {
      const pipeline = call[0];
      if (!Array.isArray(pipeline)) return false;
      const groupIdx = pipeline.findIndex((s: Record<string, unknown>) => s.$group);
      if (groupIdx === -1) return false;
      return pipeline.slice(groupIdx + 1).some((stage: Record<string, unknown>) => {
        const and = stage.$match?.$and;
        if (!Array.isArray(and)) return false;
        return and.some((c: Record<string, unknown>) => {
          const nin = c._id?.$nin;
          return Array.isArray(nin) && ids.every((id) => nin.includes(id));
        });
      });
    });

  it('excludes Slack bot/app owners flagged via owner_is_bot from both rankings', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();
    // The GitLab app owns threads under a human-looking "U…" id; ingestion
    // flagged its conversations owner_is_bot, so distinct() surfaces the id.
    convCol.distinct.mockResolvedValue(['U05LC2AV99N']);

    await GET(makeRequest('/api/admin/stats'));

    expect(convCol.distinct).toHaveBeenCalledWith('owner_id', { 'metadata.owner_is_bot': true });
    expect(excludesOwnerIds(convCol.aggregate.mock.calls, ['U05LC2AV99N'])).toBe(true);
    expect(excludesOwnerIds(msgCol.aggregate.mock.calls, ['U05LC2AV99N'])).toBe(true);
  });

  it('does not query owner_is_bot when include_bots=true', async () => {
    const { convCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?include_bots=true'));

    const flaggedBotQuery = convCol.distinct.mock.calls.some(
      (c: unknown[]) => (c[1] as Record<string, unknown>)?.['metadata.owner_is_bot'] === true,
    );
    expect(flaggedBotQuery).toBe(false);
  });

  // Detects the row-level (pre-$group) owner_id exclusion the section's
  // non-leaderboard aggregations (Top Agents, Response Time, Activity by Hour)
  // carry so the "Show bot users" toggle governs the whole Top Users section,
  // not just the two leaderboards. Matches an owner_id-keyed $nin/$not clause
  // in the FIRST $match stage (before any $group).
  const hasRowLevelOwnerExclusion = (calls: unknown[]) =>
    calls.some((call: unknown[]) => {
      const pipeline = call[0];
      if (!Array.isArray(pipeline)) return false;
      const first = pipeline.find((s: Record<string, unknown>) => s.$match) as
        | Record<string, unknown>
        | undefined;
      const and = (first?.$match as Record<string, unknown> | undefined)?.$and;
      if (!Array.isArray(and)) return false;
      return and.some((c: Record<string, unknown>) =>
        Array.isArray(c.owner_id?.$nin) || c.owner_id?.$not instanceof RegExp
      );
    });

  it('excludes bot owners from the non-leaderboard section stats by default', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();
    convCol.distinct.mockResolvedValue(['U05LC2AV99N']);

    await GET(makeRequest('/api/admin/stats'));

    // Top Agents (conversations side), Response Time + Activity by Hour (messages).
    expect(hasRowLevelOwnerExclusion(convCol.aggregate.mock.calls)).toBe(true);
    expect(hasRowLevelOwnerExclusion(msgCol.aggregate.mock.calls)).toBe(true);
  });

  it('does not row-level exclude section stats when include_bots=true', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?include_bots=true'));

    expect(hasRowLevelOwnerExclusion(convCol.aggregate.mock.calls)).toBe(false);
    expect(hasRowLevelOwnerExclusion(msgCol.aggregate.mock.calls)).toBe(false);
  });
});

// ============================================================================
// Tests: Enhanced Analytics — top agents, feedback, response time, heatmap
// ============================================================================

describe('GET /api/admin/stats — Top Agents', () => {
  beforeEach(resetMocks);

  it('derives top agents from Slack conversation thread_owner_agent_id', async () => {
    const { convCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    // Slack routes per-conversation: agent lives on
    // conversations.metadata.thread_owner_agent_id (fallbacks excluded).
    const aggregateCalls = convCol.aggregate.mock.calls;
    const hasAgentPipeline = aggregateCalls.some((call: unknown[]) => {
      const pipeline = call[0];
      return (
        Array.isArray(pipeline) &&
        pipeline.some(
          (stage: Record<string, unknown>) =>
            Array.isArray(stage.$match?.['metadata.thread_owner_agent_id']?.$nin)
        ) &&
        pipeline.some(
          (stage: Record<string, unknown>) =>
            stage.$group?._id === '$metadata.thread_owner_agent_id'
        )
      );
    });
    expect(hasAgentPipeline).toBe(true);
  });

  it('also derives top agents from web message agent_name', async () => {
    const { msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats'));

    // Web routes per-message: agent lives on messages.metadata.agent_name.
    // Count distinct conversations per agent, excluding only empty sentinels —
    // the "Default" agent is a real configured dynamic_agent and must count.
    const hasWebAgentPipeline = msgCol.aggregate.mock.calls.some((call: unknown[]) => {
      const pipeline = call[0];
      return (
        Array.isArray(pipeline) &&
        pipeline.some(
          (stage: Record<string, unknown>) => {
            const nin = stage.$match?.['metadata.agent_name']?.$nin;
            return Array.isArray(nin) && !nin.includes('Default') && !nin.includes('default');
          }
        ) &&
        // Distinct conversations per agent via a two-stage $group (DocumentDB
        // compatible — no $project/$size): first group by agent+conversation…
        pipeline.some(
          (stage: Record<string, unknown>) =>
            stage.$group?._id?.agent === '$metadata.agent_name' &&
            stage.$group?._id?.conv === '$conversation_id'
        ) &&
        // …then tally per agent.
        pipeline.some(
          (stage: Record<string, unknown>) =>
            stage.$group?._id === '$_id.agent' && stage.$group?.count?.$sum === 1
        )
      );
    });
    expect(hasWebAgentPipeline).toBe(true);
  });

  it('excludes Slack from the web-side top-agents count (no double-count)', async () => {
    const { msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats'));

    // Slack agent usage is counted from conversations.thread_owner_agent_id;
    // Slack messages now also carry metadata.agent_name, so the messages-side
    // agent aggregation MUST exclude Slack or the same conversation is counted
    // twice.
    const webAgentPipelineExcludesSlack = msgCol.aggregate.mock.calls.some((call: unknown[]) => {
      const pipeline = call[0];
      return (
        Array.isArray(pipeline) &&
        pipeline.some(
          (stage: Record<string, unknown>) =>
            Array.isArray(stage.$match?.['metadata.agent_name']?.$nin) &&
            (stage.$match['metadata.source'] as Record<string, unknown>)?.$ne === 'slack'
        )
      );
    });
    expect(webAgentPipelineExcludesSlack).toBe(true);
  });

  it('returns top_agents as an array', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(Array.isArray(body.data.top_agents)).toBe(true);
  });
});

describe('GET /api/admin/stats — Feedback Summary', () => {
  beforeEach(resetMocks);

  it('returns feedback_summary with positive, negative, total', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.feedback_summary).toHaveProperty('positive');
    expect(body.data.feedback_summary).toHaveProperty('negative');
    expect(body.data.feedback_summary).toHaveProperty('total');
    expect(typeof body.data.feedback_summary.positive).toBe('number');
    expect(typeof body.data.feedback_summary.negative).toBe('number');
    expect(typeof body.data.feedback_summary.total).toBe('number');
  });

  it('returns zeros when no feedback exists', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.feedback_summary).toEqual(
      expect.objectContaining({
        positive: 0,
        negative: 0,
        total: 0,
      })
    );
  });

  it('returns enhanced feedback with by_source and categories from unified feedback collection', async () => {
    const { usersCol, convCol, msgCol } = setupAdminWithCollections();
    usersCol.countDocuments.mockResolvedValue(1);
    convCol.countDocuments.mockResolvedValue(0);
    msgCol.countDocuments.mockResolvedValue(0);

    // Set up feedback collection with data
    const feedbackCol = createMockCollection();
    feedbackCol.countDocuments.mockResolvedValue(10); // non-zero triggers unified path
    feedbackCol.aggregate.mockReturnValue({
      toArray: jest.fn()
        .mockResolvedValueOnce([  // fbOverall
          { _id: 'positive', count: 7 },
          { _id: 'negative', count: 3 },
        ])
        .mockResolvedValueOnce([  // fbBySource
          { _id: { source: 'web', rating: 'positive' }, count: 5 },
          { _id: { source: 'web', rating: 'negative' }, count: 1 },
          { _id: { source: 'slack', rating: 'positive' }, count: 2 },
          { _id: { source: 'slack', rating: 'negative' }, count: 2 },
        ])
        .mockResolvedValueOnce([  // fbCategories
          { _id: 'wrong_answer', count: 2 },
          { _id: 'too_verbose', count: 1 },
        ])
        .mockResolvedValueOnce([  // fbDaily
        ]),
    });
    mockCollections['feedback'] = feedbackCol;

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    const fb = body.data.feedback_summary;
    expect(fb.positive).toBe(7);
    expect(fb.negative).toBe(3);
    expect(fb.total).toBe(10);
    expect(fb.satisfaction_rate).toBe(70);
    expect(fb.by_source.web).toEqual({ positive: 5, negative: 1 });
    expect(fb.by_source.slack).toEqual({ positive: 2, negative: 2 });
    expect(fb.categories).toEqual([
      { category: 'wrong_answer', count: 2 },
      { category: 'too_verbose', count: 1 },
    ]);
  });
});

describe('GET /api/admin/stats — Response Time', () => {
  beforeEach(resetMocks);

  it('returns response_time with avg/min/max/sample_count', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.response_time).toHaveProperty('avg_ms');
    expect(body.data.response_time).toHaveProperty('min_ms');
    expect(body.data.response_time).toHaveProperty('max_ms');
    expect(body.data.response_time).toHaveProperty('sample_count');
  });

  it('returns zeros when no latency data exists', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.response_time).toEqual({
      avg_ms: 0,
      min_ms: 0,
      max_ms: 0,
      sample_count: 0,
      samples: [],
    });
  });
});

describe('GET /api/admin/stats — Hourly Heatmap', () => {
  beforeEach(resetMocks);

  it('returns exactly 24 hour entries', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.hourly_heatmap).toHaveLength(24);
  });

  it('every hour has { hour, count } structure', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    for (let h = 0; h < 24; h++) {
      expect(body.data.hourly_heatmap[h]).toEqual({
        hour: h,
        count: expect.any(Number),
      });
    }
  });

  it('fills missing hours with 0', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    // All aggregate calls return [] by default → every hour = 0
    for (const entry of body.data.hourly_heatmap) {
      expect(entry.count).toBe(0);
    }
  });
});

// ============================================================================
// Tests: Complete response shape
// ============================================================================

describe('GET /api/admin/stats — Full Response Shape', () => {
  beforeEach(resetMocks);

  it('returns all expected top-level keys', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data).toHaveProperty('overview');
    expect(body.data).toHaveProperty('daily_activity');
    expect(body.data).toHaveProperty('top_users');
    expect(body.data).toHaveProperty('top_agents');
    expect(body.data).toHaveProperty('feedback_summary');
    expect(body.data).toHaveProperty('response_time');
    expect(body.data).toHaveProperty('hourly_heatmap');
    expect(body.data).toHaveProperty('platform_summary');
    expect(body.data).toHaveProperty('completed_workflows');
  });

  it('overview has all required sub-fields', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    const overview = body.data.overview;
    expect(overview).toHaveProperty('total_users');
    expect(overview).toHaveProperty('total_conversations');
    expect(overview).toHaveProperty('total_messages');
    expect(overview).toHaveProperty('shared_conversations');
    expect(overview).toHaveProperty('dau');
    expect(overview).toHaveProperty('mau');
    expect(overview).toHaveProperty('conversations_today');
    expect(overview).toHaveProperty('messages_today');
    expect(overview).toHaveProperty('avg_messages_per_conversation');
  });
});

// ============================================================================
// Tests: independently loadable sections
// ============================================================================

describe('GET /api/admin/stats — Section Responses', () => {
  beforeEach(resetMocks);

  it('returns only the requested section and skips unrelated database queries', async () => {
    const { feedbackCol } = setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=overview'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveProperty('overview');
    expect(body.data).not.toHaveProperty('daily_activity');
    expect(body.data).not.toHaveProperty('feedback_summary');
    expect(body.data).not.toHaveProperty('top_users');
    expect(feedbackCol.aggregate).not.toHaveBeenCalled();
    expect(mockGetAllAgents).not.toHaveBeenCalled();
  });

  it('isolates feedback queries and payload fields from the other cards', async () => {
    const { feedbackCol } = setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=feedback'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveProperty('feedback_summary');
    expect(body.data).toHaveProperty('platform_summary');
    expect(body.data).not.toHaveProperty('overview');
    expect(body.data).not.toHaveProperty('response_time');
    expect(feedbackCol.aggregate).toHaveBeenCalledTimes(4);
  });

  it('rejects unknown section names', async () => {
    setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=unknown'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('INVALID_STATS_SECTION');
  });
});

// ============================================================================
// Tests: parseRange — from/to support and sub-day presets
// ============================================================================

describe('GET /api/admin/stats — Custom Date Range (from/to)', () => {
  beforeEach(resetMocks);

  it('uses from/to ISO dates to compute the range instead of preset', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    // 10-day custom range
    const from = '2026-03-01T00:00:00.000Z';
    const to = '2026-03-11T00:00:00.000Z';
    const req = makeRequest(`/api/admin/stats?from=${from}&to=${to}`);
    const res = await GET(req);
    const body = await res.json();

    // daily_activity length should be 10 days
    expect(body.data.daily_activity).toHaveLength(10);
    expect(body.data.days).toBe(10);

    const expectedEnd = new Date(to);
    const conversationMatch = convCol.aggregate.mock.calls
      .flatMap((call: unknown[]) => call[0])
      .find((stage: Record<string, unknown>) => stage.$match?.created_at);
    expect(conversationMatch.$match.created_at.$lte).toEqual(expectedEnd);
    const messageMatch = msgCol.aggregate.mock.calls
      .flatMap((call: unknown[]) => call[0])
      .find((stage: Record<string, unknown>) => stage.$match?.created_at);
    expect(messageMatch.$match.created_at.$lte).toEqual(expectedEnd);
    expect(new Date(body.data.daily_activity.at(-1).date).getTime())
      .toBeLessThanOrEqual(expectedEnd.getTime());
  });

  it('supports sub-day presets like 1h and 12h (bucketed by 5-minute intervals)', async () => {
    const { usersCol, convCol, msgCol } = setupAdminWithCollections();
    const requestStartedAt = Date.now();

    const req = makeRequest('/api/admin/stats?range=1h');
    const res = await GET(req);
    const body = await res.json();

    // 1h range buckets by 5-minute steps so the chart isn't a single point.
    expect(body.data.daily_activity).toHaveLength(12);
    expect(body.data.days).toBe(1);

    // Calendar cards (DAU/MAU and "Today") must also honor the shorter
    // selected window instead of silently counting everything since midnight.
    const earliestAllowed = requestStartedAt - (60 * 60 * 1000) - 1_000;
    const lowerBounds = [
      ...usersCol.countDocuments.mock.calls.map((call: unknown[]) => (
        (call[0] as { last_login?: { $gte?: Date } })?.last_login?.$gte
      )),
      ...convCol.countDocuments.mock.calls.map((call: unknown[]) => (
        (call[0] as { created_at?: { $gte?: Date } })?.created_at?.$gte
      )),
      ...msgCol.countDocuments.mock.calls.map((call: unknown[]) => (
        (call[0] as { created_at?: { $gte?: Date } })?.created_at?.$gte
      )),
    ].filter((date): date is Date => date instanceof Date);
    expect(lowerBounds.length).toBeGreaterThan(0);
    expect(lowerBounds.every((date) => date.getTime() >= earliestAllowed)).toBe(true);
  });
});

// ============================================================================
// Tests: Platform Summary
// ============================================================================

describe('GET /api/admin/stats — Platform Summary', () => {
  beforeEach(resetMocks);

  it('includes platform_summary with satisfaction rate', async () => {
    setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.platform_summary).toBeDefined();
    expect(body.data.platform_summary).toHaveProperty('satisfaction_rate');
    expect(typeof body.data.platform_summary.satisfaction_rate).toBe('number');
  });
});

// ============================================================================
// Tests: Source/User Filtering
// ============================================================================

describe('GET /api/admin/stats — Source & User Filters', () => {
  beforeEach(resetMocks);

  it('applies source=slack filter to conversation queries', async () => {
    const { convCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats?source=slack');
    await GET(req);

    // When source=slack, conversations should be filtered with { $or: [{ source: 'slack' }, { client_type: 'slack' }] }
    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasSlackFilter = convCountCalls.some(
      (call: unknown[]) => {
        const filter = call[0];
        // The route uses SLACK_CONV_MATCH which is an $or filter supporting both legacy and new schemas
        return filter?.$or?.some((clause: unknown) => clause.source === 'slack' || clause.client_type === 'slack');
      }
    );
    expect(hasSlackFilter).toBe(true);

    // Web messages should be skipped (resolved to 0) — check that messages
    // countDocuments was called fewer times or with different filters
    // When source=slack, web message counts resolve to 0 without querying
  });

  it('applies user filter to owner_id on conversation and message queries', async () => {
    const { convCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats?user=alice@co.com,bob@co.com');
    await GET(req);

    // Conversations should include owner_id filter
    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasUserFilter = convCountCalls.some(
      (call: unknown[]) => call[0]?.owner_id?.$in?.includes('alice@co.com')
    );
    expect(hasUserFilter).toBe(true);
  });

  it('resolves canonical team members and applies them to conversation and message queries', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([
      ['platform-team', [
        { user_email: 'alice@example.com' },
        { user_email: 'bob@example.com' },
      ]],
    ]));

    await GET(makeRequest('/api/admin/stats?section=overview&team=platform-team'));

    expect(mockLoadTeamMembersForSlugs).toHaveBeenCalledWith(['platform-team']);
    const conversationFilters = convCol.countDocuments.mock.calls.map((call: unknown[]) => (
      JSON.stringify(call[0] ?? {})
    ));
    expect(conversationFilters.some((filter: string) => (
      filter.includes('alice@example.com') && filter.includes('bob@example.com')
    ))).toBe(true);
    const messageFilters = msgCol.countDocuments.mock.calls.map((call: unknown[]) => (
      JSON.stringify(call[0] ?? {})
    ));
    expect(messageFilters.some((filter: string) => (
      filter.includes('alice@example.com') && filter.includes('bob@example.com')
    ))).toBe(true);
  });

  it('fails closed when a selected team has no canonical members', async () => {
    const { convCol } = setupAdminWithCollections();
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([['empty-team', []]]));

    await GET(makeRequest('/api/admin/stats?section=overview&team=empty-team'));

    const conversationFilters = convCol.countDocuments.mock.calls.map((call: unknown[]) => call[0] ?? {});
    expect(conversationFilters.some((filter: { owner_id?: { $in?: unknown[] } }) => (
      Array.isArray(filter.owner_id?.$in) && filter.owner_id.$in.length === 0
    ))).toBe(true);
  });

  it('applies a Slack channel filter to conversation and message metrics', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?section=overview&source=slack&channel=primary-channel'));

    const conversationFilters = convCol.countDocuments.mock.calls.map((call: unknown[]) => (
      JSON.stringify(call[0] ?? {})
    ));
    expect(conversationFilters.some((filter: string) => filter.includes('primary-channel'))).toBe(true);

    const messageFilters = msgCol.countDocuments.mock.calls.map((call: unknown[]) => (
      JSON.stringify(call[0] ?? {})
    ));
    expect(messageFilters.length).toBeGreaterThan(0);
    expect(messageFilters.every((filter: string) => filter.includes('primary-channel'))).toBe(true);
  });

  it('omits the Slack-only section when source=web', async () => {
    const { convCol } = setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=slack&source=web'));
    const body = await res.json();

    expect(body.data).not.toHaveProperty('slack');
    const probeCalls = convCol.countDocuments.mock.calls.filter(
      (call: unknown[]) => call[1]?.limit === 1,
    );
    expect(probeCalls).toHaveLength(0);
  });

  it('applies a user filter to Slack interaction cards and omits userless configuration data', async () => {
    const { convCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);

    const res = await GET(makeRequest('/api/admin/stats?section=slack&user=person@example.com'));
    const body = await res.json();

    const slackPipelines = convCol.aggregate.mock.calls.map((call: unknown[]) => call[0]);
    expect(slackPipelines.length).toBeGreaterThan(0);
    expect(slackPipelines.every((pipeline: unknown) => (
      JSON.stringify(pipeline).includes('person@example.com')
    ))).toBe(true);
    expect(body.data.slack).not.toHaveProperty('configured_channels');
    expect(body.data.slack).not.toHaveProperty('configured_channels_daily');
  });

  it('applies source=webex filter to conversation and message queries', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?source=webex'));

    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasWebexFilter = convCountCalls.some(
      (call: unknown[]) => (call[0] as { client_type?: string })?.client_type === 'webex',
    );
    expect(hasWebexFilter).toBe(true);

    const msgCountCalls = msgCol.countDocuments.mock.calls;
    const hasWebexMsgFilter = msgCountCalls.some(
      (call: unknown[]) => (call[0] as { 'metadata.source'?: string })?.['metadata.source'] === 'webex',
    );
    expect(hasWebexMsgFilter).toBe(true);
  });

  it('source=web excludes both Slack and Webex conversations', async () => {
    const { convCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?source=web'));

    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasWebOnlyFilter = convCountCalls.some((call: unknown[]) => {
      const filter = call[0] as { client_type?: { $nin?: string[] }; source?: { $nin?: string[] } };
      return (
        Array.isArray(filter?.client_type?.$nin)
        && filter.client_type!.$nin!.includes('webex')
        && filter.client_type!.$nin!.includes('slack')
      );
    });
    expect(hasWebOnlyFilter).toBe(true);
  });

  it('omits the Webex-only section when source=web', async () => {
    const { convCol } = setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=webex&source=web'));
    const body = await res.json();

    expect(body.data).not.toHaveProperty('webex');
    const probeCalls = convCol.countDocuments.mock.calls.filter(
      (call: unknown[]) => call[1]?.limit === 1,
    );
    expect(probeCalls).toHaveLength(0);
  });

  it('applies a user filter to Webex interaction cards and omits userless configuration data', async () => {
    const { convCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);

    const res = await GET(makeRequest('/api/admin/stats?section=webex&user=person@example.com'));
    const body = await res.json();

    const webexPipelines = convCol.aggregate.mock.calls.map((call: unknown[]) => call[0]);
    expect(webexPipelines.length).toBeGreaterThan(0);
    expect(webexPipelines.every((pipeline: unknown) => (
      JSON.stringify(pipeline).includes('person@example.com')
    ))).toBe(true);
    expect(body.data.webex).not.toHaveProperty('configured_spaces');
    expect(body.data.webex).not.toHaveProperty('configured_spaces_daily');
  });
});

// ============================================================================
// Tests: Non-admin Scoping (visibility boundary)
// ============================================================================

describe('GET /api/admin/stats — non-admin scoping', () => {
  beforeEach(resetMocks);

  it('intersects a selected team with the existing non-admin visibility scope', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['primary-channel']);
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([
      ['platform-team', [{ user_email: 'teammate@example.com' }]],
    ]));
    const { convCol } = setupNonAdminCollections();

    await GET(makeRequest('/api/admin/stats?section=overview&team=platform-team'));

    const filters = convCol.countDocuments.mock.calls.map((call: unknown[]) => (
      JSON.stringify(call[0] ?? {})
    ));
    expect(filters.some((filter: string) => (
      filter.includes('teammate@example.com')
      && filter.includes('user@example.com')
      && filter.includes('primary-channel')
    ))).toBe(true);
  });

  it('non-admin with readable channels: convSourceFilter ANDs in the channel scope', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['ops-help', 'ai-support']);

    const { convCol } = setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(mockGetReadableSlackChannelNames).toHaveBeenCalledWith('user:regular-user-sub');

    // Every conversations.countDocuments call must include the scope ($and).
    // The scope clauses include $or with channel_name $in [readable channels]
    // OR owner_id == session email.
    const convCountCalls = convCol.countDocuments.mock.calls;
    expect(convCountCalls.length).toBeGreaterThan(0);
    const hasScope = convCountCalls.some((call: unknown[]) => {
      const filter = call[0];
      const inspect = JSON.stringify(filter ?? {});
      return inspect.includes('ops-help') && inspect.includes('user@example.com');
    });
    expect(hasScope).toBe(true);
  });

  it('non-admin with no readable channels but has email: scopes by owner_id only', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);

    const { convCol } = setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // owner_id scope must be applied to conversation queries
    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasOwnerScope = convCountCalls.some((call: unknown[]) => {
      const inspect = JSON.stringify(call[0] ?? {});
      return inspect.includes('user@example.com');
    });
    expect(hasOwnerScope).toBe(true);
  });

  it('non-admin with readable Webex spaces: convSourceFilter ANDs in the space scope', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableWebexSpaceIds.mockResolvedValue(['space-1', 'space-2']);

    const { convCol } = setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(mockGetReadableWebexSpaceIds).toHaveBeenCalledWith('user:regular-user-sub');

    const convCountCalls = convCol.countDocuments.mock.calls;
    expect(convCountCalls.length).toBeGreaterThan(0);
    const hasScope = convCountCalls.some((call: unknown[]) => {
      const inspect = JSON.stringify(call[0] ?? {});
      return inspect.includes('space-1') && inspect.includes('user@example.com');
    });
    expect(hasScope).toBe(true);
  });

  it('non-admin with no sub and no email: returns 401', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: '', name: '' },
      role: 'user',
      sub: '',
      accessToken: accessTokenWithRoles(['chat_user']),
    });

    setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('admin path is unaffected — no scope filter is applied', async () => {
    const { convCol } = setupAdminWithCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    expect(res.status).toBe(200);

    // Admin path must NOT call getReadableSlackChannelNames / getReadableWebexSpaceIds
    expect(mockGetReadableSlackChannelNames).not.toHaveBeenCalled();
    expect(mockGetReadableWebexSpaceIds).not.toHaveBeenCalled();

    // No conversation query should embed the user's email as a scope
    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasUserEmailScope = convCountCalls.some((call: unknown[]) => {
      const inspect = JSON.stringify(call[0] ?? {});
      return inspect.includes('admin@example.com');
    });
    expect(hasUserEmailScope).toBe(false);
  });

  it('scopes an admin access preview to the selected user rather than the admin session', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockGetRealmUserByIdOrNull.mockResolvedValue({
      id: 'target-sub',
      email: 'target@example.com',
    });
    mockGetReadableSlackChannelNames.mockResolvedValue(['target-channel']);
    const { convCol } = setupNonAdminCollections();

    const res = await GET(makeRequest(
      '/api/admin/stats?simulate_type=user&simulate_id=target-sub'
    ));

    expect(res.status).toBe(200);
    expect(mockGetRealmUserByIdOrNull).toHaveBeenCalledWith('target-sub');
    expect(mockGetReadableSlackChannelNames).toHaveBeenCalledWith('user:target-sub');
    const filters = convCol.countDocuments.mock.calls.map((call: unknown[]) => JSON.stringify(call[0] ?? {}));
    expect(filters.some((filter: string) => filter.includes('target@example.com'))).toBe(true);
    expect(filters.every((filter: string) => !filter.includes('admin@example.com'))).toBe(true);
  });

  it('rejects access-preview parameters from a non-admin caller', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    setupNonAdminCollections();

    const res = await GET(makeRequest(
      '/api/admin/stats?simulate_type=user&simulate_id=target-sub'
    ));

    expect(res.status).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Leak boundary: every aggregate in the payload must respect the scope, not
  // just the conversation counts. Each test below pins one query family that
  // would otherwise return platform-wide data to a non-admin.
  // ──────────────────────────────────────────────────────────────────────

  it('does not count platform-wide users — total_users derives from scoped conversations', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    const { usersCol } = setupNonAdminCollections();
    // If the route read the users collection for total_users it would report 999.
    usersCol.countDocuments.mockResolvedValue(999);

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();
    // Scoped conversations are empty in this fixture → 0, never the global 999.
    expect(body.data.overview.total_users).toBe(0);
    // The unscoped `users.countDocuments({})` headcount must not be used.
    expect(usersCol.countDocuments).not.toHaveBeenCalledWith({});
  });

  it('scopes message counts by owner_id / channel (messages carry no channel_name)', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['ops-help']);
    const { msgCol } = setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    // Every message count query must carry the caller's scope (their own
    // owner_id or their readable slack channel); none may run unscoped
    // across the whole platform.
    expect(msgCol.countDocuments.mock.calls.length).toBeGreaterThan(0);
    for (const call of msgCol.countDocuments.mock.calls) {
      const inspect = JSON.stringify(call[0] ?? {});
      expect(inspect.includes('user@example.com') || inspect.includes('ops-help')).toBe(true);
    }
  });

  it('scopes the feedback summary to readable channels OR own email', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['ops-help']);
    const { feedbackCol } = setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    await GET(req);

    // The feedback aggregations $match must embed the scope, not run globally.
    const fbAggCalls = feedbackCol.aggregate.mock.calls;
    expect(fbAggCalls.length).toBeGreaterThan(0);
    const matchStage = fbAggCalls[0][0].find((s: unknown) => s.$match);
    const inspect = JSON.stringify(matchStage);
    expect(inspect).toContain('ops-help');
    expect(inspect).toContain('user@example.com');
  });

  it('available_channels exposes only the readable set, never a platform-wide distinct', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['ops-help', 'ai-support']);
    const { convCol } = setupNonAdminCollections();

    const req = makeRequest('/api/admin/stats');
    const res = await GET(req);
    const body = await res.json();

    expect(body.data.available_channels.sort()).toEqual(['ai-support', 'ops-help']);
    // No distinct over the channel name fields (which would enumerate every
    // channel on the platform).
    const distinctFields = convCol.distinct.mock.calls.map((c: unknown[]) => c[0]);
    expect(distinctFields).not.toContain('slack_meta.channel_name');
    expect(distinctFields).not.toContain('metadata.channel_name');
  });

  it('skips the Slack-block probe query when a non-admin has no readable channels', async () => {
    // The Slack block is gated by a `countDocuments(SLACK_CONV_MATCH, {limit:1})`
    // probe. A channel-less non-admin can see no Slack data, so that probe (and
    // the whole block) must be skipped — never run platform-wide.
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    const { convCol } = setupNonAdminCollections();

    await GET(makeRequest('/api/admin/stats'));

    // The probe is the only countDocuments call that passes an options object
    // ({ limit: 1 }) as its second argument. Unlike Slack/Webex, the API block
    // has no channel/space concept to gate its own probe on, so it always
    // probes (any non-admin could have their own api conversations via the
    // owner_id scope) — exclude it here since this test is specifically about
    // the Slack block's channel-gated skip.
    const probeCalls = convCol.countDocuments.mock.calls.filter(
      (call: unknown[]) => call[1]?.limit === 1
        && (call[0] as { client_type?: string })?.client_type !== 'api'
    );
    expect(probeCalls).toHaveLength(0);
  });

  it('runs the Slack-block probe when a non-admin has readable channels', async () => {
    // Positive control for the test above — with at least one readable channel
    // the probe must run (bounded, via slackChannelScope downstream).
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['ops-help']);
    const { convCol } = setupNonAdminCollections();

    await GET(makeRequest('/api/admin/stats'));

    const probeCalls = convCol.countDocuments.mock.calls.filter(
      (call: unknown[]) => call[1]?.limit === 1
    );
    expect(probeCalls.length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Owned-agent axis: a non-admin who owns an agent must see its usage even in
  // channels they can't read / web chats that aren't theirs. Scope is keyed
  // per-collection (conv → agent id, msg → agent display name).
  // ──────────────────────────────────────────────────────────────────────

  it('non-admin: owned agents widen the scope by agent id (conv) and name (msg)', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    mockGetOwnedAgents.mockResolvedValue([{ id: 'agent-hello-agent', name: 'Hello Agent' }]);
    const { convCol, msgCol } = setupNonAdminCollections();

    await GET(makeRequest('/api/admin/stats'));

    // Conversations are keyed by the agent id.
    const convHasAgent = convCol.countDocuments.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call[0] ?? {}).includes('agent-hello-agent')
    );
    expect(convHasAgent).toBe(true);

    // Messages are keyed by the display name.
    const msgHasAgent = msgCol.countDocuments.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call[0] ?? {}).includes('Hello Agent')
    );
    expect(msgHasAgent).toBe(true);
  });

  it('non-admin: feedback is scoped to owned-agent conversation ids', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    mockGetOwnedAgents.mockResolvedValue([{ id: 'agent-hello-agent', name: 'Hello Agent' }]);
    mockGetOwnedAgentConversationIds.mockResolvedValue({ ids: ['conv-1', 'conv-2'], capped: false });
    const { feedbackCol } = setupNonAdminCollections();

    await GET(makeRequest('/api/admin/stats'));

    const matchStage = feedbackCol.aggregate.mock.calls[0][0].find((s: Record<string, unknown>) => s.$match);
    const inspect = JSON.stringify(matchStage);
    expect(inspect).toContain('conv-1');
    expect(inspect).toContain('conv-2');
  });

  it('available_agents exposes the caller owned set (non-admin)', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue(['ops-help']);
    mockGetOwnedAgents.mockResolvedValue([
      { id: 'agent-b', name: 'Beta Agent' },
      { id: 'agent-a', name: 'Alpha Agent' },
    ]);
    setupNonAdminCollections();

    const res = await GET(makeRequest('/api/admin/stats'));
    const body = await res.json();

    // Sorted by display name; ids preserved.
    expect(body.data.available_agents).toEqual([
      { id: 'agent-a', name: 'Alpha Agent' },
      { id: 'agent-b', name: 'Beta Agent' },
    ]);
    // A non-admin must never enumerate every platform agent.
    expect(mockGetAllAgents).not.toHaveBeenCalled();
  });

  it('non-admin: an agent filter cannot widen beyond owned agents', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    mockGetOwnedAgents.mockResolvedValue([{ id: 'agent-mine', name: 'Mine' }]);
    const { convCol } = setupNonAdminCollections();

    // Request an agent the caller does NOT own → must resolve to nothing.
    await GET(makeRequest('/api/admin/stats?agent=agent-not-mine'));

    const convHasUnowned = convCol.countDocuments.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call[0] ?? {}).includes('agent-not-mine')
    );
    expect(convHasUnowned).toBe(false);
    // getAgentsByIds is the admin-only resolver; a non-admin never calls it.
    expect(mockGetAgentsByIds).not.toHaveBeenCalled();
  });

  it('non-admin: an unowned agent filter also fails closed for feedback', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    mockGetOwnedAgents.mockResolvedValue([{ id: 'agent-owned', name: 'Owned Agent' }]);
    const { feedbackCol } = setupNonAdminCollections();

    await GET(makeRequest('/api/admin/stats?section=feedback&agent=agent-unowned'));

    expect(mockGetOwnedAgentConversationIds).toHaveBeenCalledWith([]);
    const feedbackQueries = JSON.stringify(feedbackCol.aggregate.mock.calls);
    expect(feedbackQueries).toContain('conversation_id');
    expect(feedbackQueries).toContain('[null]');
  });
});

describe('GET /api/admin/stats — agent filter (admin)', () => {
  beforeEach(resetMocks);

  it('admin: available_agents lists every dynamic agent', async () => {
    mockGetAllAgents.mockResolvedValue([{ id: 'agent-x', name: 'X Agent' }]);
    setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats'));
    const body = await res.json();

    expect(mockGetAllAgents).toHaveBeenCalled();
    expect(body.data.available_agents).toEqual([{ id: 'agent-x', name: 'X Agent' }]);
  });

  it('admin: agent filter narrows conv (id) and msg (name) queries', async () => {
    mockGetAgentsByIds.mockResolvedValue([{ id: 'agent-x', name: 'X Agent' }]);
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?agent=agent-x'));

    expect(mockGetAgentsByIds).toHaveBeenCalledWith(['agent-x']);
    const convHasAgent = convCol.countDocuments.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call[0] ?? {}).includes('agent-x')
    );
    expect(convHasAgent).toBe(true);
    const msgHasAgent = msgCol.countDocuments.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call[0] ?? {}).includes('X Agent')
    );
    expect(msgHasAgent).toBe(true);
  });

  it('admin: agent-filtered overview derives users from matching conversations', async () => {
    mockGetAgentsByIds.mockResolvedValue([{ id: 'agent-primary', name: 'Primary Agent' }]);
    const { usersCol, convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?section=overview&agent=agent-primary'));

    expect(usersCol.countDocuments).not.toHaveBeenCalled();
    const conversationQueries = JSON.stringify([
      ...convCol.countDocuments.mock.calls,
      ...convCol.aggregate.mock.calls,
    ]);
    expect(conversationQueries).toContain('participants');
    expect(conversationQueries).toContain('agent-primary');
    const messageQueries = JSON.stringify(msgCol.countDocuments.mock.calls);
    expect(messageQueries).toContain('Primary Agent');
  });

  it('admin: agent filter scopes completed workflows by step agent id', async () => {
    mockGetAgentsByIds.mockResolvedValue([{ id: 'agent-primary', name: 'Primary Agent' }]);
    setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?section=completed_workflows&agent=agent-primary'));

    const workflowCol = mockCollections.workflow_runs as ReturnType<typeof createMockCollection>;
    const workflowQueries = JSON.stringify([
      ...workflowCol.aggregate.mock.calls,
      ...workflowCol.countDocuments.mock.calls,
    ]);
    expect(workflowQueries).toContain('steps.agent_id');
    expect(workflowQueries).toContain('agent-primary');
  });

  it('admin: agent filter also scopes the Slack block by thread_owner_agent_id', async () => {
    mockGetAgentsByIds.mockResolvedValue([{ id: 'agent-x', name: 'X Agent' }]);
    const { convCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?agent=agent-x'));

    // The Slack aggregations run off slackFilter; the agent id must be merged
    // into its $and so Slack stats respect the filter too (not just web).
    const slackScoped = convCol.aggregate.mock.calls.some((call: unknown[]) => {
      const pipeline = call[0];
      return (
        Array.isArray(pipeline) &&
        JSON.stringify(pipeline).includes('metadata.thread_owner_agent_id') &&
        JSON.stringify(pipeline).includes('agent-x')
      );
    });
    expect(slackScoped).toBe(true);
  });
});

describe('GET /api/admin/stats — Configured Channels', () => {
  beforeEach(resetMocks);

  /** channel_team_mappings.find(query, opts).toArray() → docs. */
  function stubChannelMappings(docs: Record<string, unknown>[]) {
    const col = createMockCollection();
    col.find = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) });
    mockCollections['channel_team_mappings'] = col;
    return col;
  }

  /** Some queries in the Slack block call .find(...).toArray() directly. */
  function stubFindToArray(col: ReturnType<typeof createMockCollection>) {
    col.find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
  }

  it('reports configured_channels count (distinct active channel ids)', async () => {
    const { convCol, feedbackCol } = setupAdminWithCollections();
    // Slack block only builds when there is ≥1 Slack conversation.
    convCol.countDocuments.mockResolvedValue(1);
    stubFindToArray(convCol);
    stubFindToArray(feedbackCol);
    stubChannelMappings([
      { slack_channel_id: 'C1', channel_name: 'alpha', active: true },
      { slack_channel_id: 'C2', channel_name: 'beta', active: true },
      { slack_channel_id: 'C2', channel_name: 'beta-renamed', active: true },
      { slack_channel_id: 'C3', channel_name: 'gamma', active: false },
    ]);

    const res = await GET(makeRequest('/api/admin/stats'));
    const body = await res.json();

    // C1 + C2 (deduped) active; C3 inactive excluded.
    expect(body.data.slack.configured_channels).toBe(2);
    expect(Array.isArray(body.data.slack.configured_channels_daily)).toBe(true);
  });

  it('configured_channels_daily is a cumulative running total', async () => {
    const { convCol, feedbackCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);
    stubFindToArray(convCol);
    stubFindToArray(feedbackCol);
    stubChannelMappings([
      // No created_at → counted in the baseline before the range.
      { slack_channel_id: 'C0', channel_name: 'legacy', active: true },
    ]);

    const res = await GET(makeRequest('/api/admin/stats'));
    const body = await res.json();

    const daily = body.data.slack.configured_channels_daily as Array<{ total: number }>;
    expect(daily.length).toBeGreaterThan(0);
    // Baseline channel present from the first bucket; totals never decrease.
    expect(daily[0].total).toBe(1);
    for (let i = 1; i < daily.length; i++) {
      expect(daily[i].total).toBeGreaterThanOrEqual(daily[i - 1].total);
    }
  });

  it('filters configured channels by selected agent routes', async () => {
    mockGetAgentsByIds.mockResolvedValue([{ id: 'agent-primary', name: 'Primary Agent' }]);
    const { convCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);
    stubChannelMappings([
      { slack_channel_id: 'C1', channel_name: 'primary', active: true },
      { slack_channel_id: 'C2', channel_name: 'secondary', active: true },
    ]);
    const routeCol = createMockCollection();
    routeCol.find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ channel_id: 'C2' }]),
    });
    mockCollections.slack_channel_agent_routes = routeCol;

    const res = await GET(makeRequest('/api/admin/stats?section=slack&agent=agent-primary'));
    const body = await res.json();

    expect(body.data.slack.configured_channels).toBe(1);
    expect(routeCol.find).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: { $in: ['agent-primary'] } }),
      expect.any(Object),
    );
  });
});

describe('GET /api/admin/stats — Configured Spaces (Webex)', () => {
  beforeEach(resetMocks);

  /** webex_space_team_mappings.find(query, opts).toArray() → docs. */
  function stubSpaceMappings(docs: Record<string, unknown>[]) {
    const col = createMockCollection();
    col.find = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(docs) });
    mockCollections['webex_space_team_mappings'] = col;
    return col;
  }

  /** Some queries in the Webex block call .find(...).toArray() directly. */
  function stubFindToArray(col: ReturnType<typeof createMockCollection>) {
    col.find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
  }

  it('reports configured_spaces count (distinct active space ids)', async () => {
    const { convCol, feedbackCol } = setupAdminWithCollections();
    // Webex block only builds when there is ≥1 Webex conversation.
    convCol.countDocuments.mockResolvedValue(1);
    stubFindToArray(convCol);
    stubFindToArray(feedbackCol);
    stubSpaceMappings([
      { webex_space_id: 'S1', space_name: 'alpha', active: true },
      { webex_space_id: 'S2', space_name: 'beta', active: true },
      { webex_space_id: 'S2', space_name: 'beta-renamed', active: true },
      { webex_space_id: 'S3', space_name: 'gamma', active: false },
    ]);

    const res = await GET(makeRequest('/api/admin/stats'));
    const body = await res.json();

    // S1 + S2 (deduped) active; S3 inactive excluded.
    expect(body.data.webex.configured_spaces).toBe(2);
    expect(Array.isArray(body.data.webex.configured_spaces_daily)).toBe(true);
  });

  it('configured_spaces_daily is a cumulative running total', async () => {
    const { convCol, feedbackCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);
    stubFindToArray(convCol);
    stubFindToArray(feedbackCol);
    stubSpaceMappings([
      // No created_at → counted in the baseline before the range.
      { webex_space_id: 'S0', space_name: 'legacy', active: true },
    ]);

    const res = await GET(makeRequest('/api/admin/stats'));
    const body = await res.json();

    const daily = body.data.webex.configured_spaces_daily as Array<{ total: number }>;
    expect(daily.length).toBeGreaterThan(0);
    // Baseline space present from the first bucket; totals never decrease.
    expect(daily[0].total).toBe(1);
    for (let i = 1; i < daily.length; i++) {
      expect(daily[i].total).toBeGreaterThanOrEqual(daily[i - 1].total);
    }
  });

  it('filters configured spaces by selected agent routes', async () => {
    mockGetAgentsByIds.mockResolvedValue([{ id: 'agent-primary', name: 'Primary Agent' }]);
    const { convCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);
    stubSpaceMappings([
      { webex_space_id: 'S1', space_name: 'primary', active: true },
      { webex_space_id: 'S2', space_name: 'secondary', active: true },
    ]);
    const routeCol = createMockCollection();
    routeCol.find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ space_id: 'S2' }]),
    });
    mockCollections.webex_space_agent_routes = routeCol;

    const res = await GET(makeRequest('/api/admin/stats?section=webex&agent=agent-primary'));
    const body = await res.json();

    expect(body.data.webex.configured_spaces).toBe(1);
    expect(routeCol.find).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: { $in: ['agent-primary'] } }),
      expect.any(Object),
    );
  });

  it('resolves top space names from webex_space_team_mappings', async () => {
    const { convCol, feedbackCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);
    stubFindToArray(convCol);
    stubFindToArray(feedbackCol);
    stubSpaceMappings([
      { webex_space_id: 'S1', space_name: 'design-crit', active: true },
    ]);
    convCol.aggregate.mockImplementation((pipeline: unknown[]) => ({
      toArray: jest.fn().mockResolvedValue(
        JSON.stringify(pipeline).includes('metadata.webex_space_id')
          ? [{ _id: 'S1', interactions: 5 }]
          : [],
      ),
    }));

    const res = await GET(makeRequest('/api/admin/stats?section=webex'));
    const body = await res.json();

    expect(body.data.webex.top_spaces).toEqual([
      { space_name: 'design-crit', interactions: 5 },
    ]);
  });

  it('excludes 1:1 DM conversations from the Top Spaces ranking', async () => {
    const { convCol, feedbackCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(1);
    stubFindToArray(convCol);
    stubFindToArray(feedbackCol);
    stubSpaceMappings([]);

    // Simulate Mongo applying the query: a DM-flagged conversation (id "DM1")
    // is filtered out of the Top Spaces group-by because the pipeline's
    // $match must exclude metadata.webex_is_direct: true.
    const conversationDocs = [
      { metadata: { webex_space_id: 'S1', webex_is_direct: false } },
      { metadata: { webex_space_id: 'DM1', webex_is_direct: true } },
    ];
    convCol.aggregate.mockImplementation((pipeline: unknown[]) => {
      const stages = pipeline as Array<Record<string, unknown>>;
      const matchStage = stages.find((stage) => 'match' in stage || '$match' in stage) as
        | { $match?: Record<string, unknown> }
        | undefined;
      const groupStage = stages.find((stage) => '$group' in stage) as
        | { $group?: { _id?: string } }
        | undefined;
      const isTopSpacesPipeline = groupStage?.$group?._id === '$metadata.webex_space_id';
      if (!isTopSpacesPipeline) {
        return { toArray: jest.fn().mockResolvedValue([]) };
      }
      // Assert the DM exclusion clause is present on the Top Spaces $match.
      expect(matchStage?.$match?.['metadata.webex_is_direct']).toEqual({ $ne: true });
      const surviving = conversationDocs.filter(
        (doc) => doc.metadata.webex_is_direct !== true,
      );
      return {
        toArray: jest.fn().mockResolvedValue(
          surviving.map((doc) => ({ _id: doc.metadata.webex_space_id, interactions: 1 })),
        ),
      };
    });

    const res = await GET(makeRequest('/api/admin/stats?section=webex'));
    const body = await res.json();

    expect(body.data.webex.top_spaces).toEqual([{ space_name: 'S1', interactions: 1 }]);
    expect(body.data.webex.top_spaces).not.toContainEqual(
      expect.objectContaining({ space_name: 'DM1' }),
    );
    // The base webexFilter used for total_interactions/unique_users/daily
    // carries no is_direct exclusion, so DM activity is still counted in the
    // aggregate totals — only the space-specific breakdown excludes it.
    const countDocumentsFilters = convCol.countDocuments.mock.calls.map(
      (call: unknown[]) => call[0] as Record<string, unknown>,
    );
    for (const filter of countDocumentsFilters) {
      expect(filter['metadata.webex_is_direct']).toBeUndefined();
    }
    expect(body.data.webex.total_interactions).toBe(1);
  });
});

// ============================================================================
// Tests: API Activity (Mongo — conversations with client_type:"api")
// ============================================================================

describe('GET /api/admin/stats — API Activity', () => {
  beforeEach(resetMocks);

  it('applies source=api filter to conversation queries and scopes messages via a conversation_id join', async () => {
    const { convCol, msgCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?source=api'));

    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasApiFilter = convCountCalls.some(
      (call: unknown[]) => (call[0] as { client_type?: string })?.client_type === 'api',
    );
    expect(hasApiFilter).toBe(true);

    // Unlike Slack/Webex, messages are NOT filtered by metadata.source (that
    // field is not reliably stamped 'api') — they're scoped by conversation_id,
    // resolved from conversations.distinct('_id', API_CONV_MATCH).
    expect(convCol.distinct).toHaveBeenCalledWith('_id', { client_type: 'api' });
    const msgCountCalls = msgCol.countDocuments.mock.calls;
    const hasConversationIdJoin = msgCountCalls.some(
      (call: unknown[]) => Array.isArray((call[0] as { conversation_id?: { $in?: unknown[] } })?.conversation_id?.$in),
    );
    expect(hasConversationIdJoin).toBe(true);
  });

  it('source=web excludes API conversations too', async () => {
    const { convCol } = setupAdminWithCollections();

    await GET(makeRequest('/api/admin/stats?source=web'));

    const convCountCalls = convCol.countDocuments.mock.calls;
    const hasWebOnlyFilter = convCountCalls.some((call: unknown[]) => {
      const filter = call[0] as { client_type?: { $nin?: string[] } };
      return Array.isArray(filter?.client_type?.$nin) && filter.client_type!.$nin!.includes('api');
    });
    expect(hasWebOnlyFilter).toBe(true);
  });

  it('omits the API section when source=web', async () => {
    setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=api&source=web'));
    const body = await res.json();

    expect(body.data).not.toHaveProperty('api');
  });

  it('reports total_interactions/unique_users/daily from api-classified conversations', async () => {
    const { convCol } = setupAdminWithCollections();
    convCol.countDocuments.mockResolvedValue(3);
    convCol.aggregate.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { _id: '2026-08-01', interactions: 2, unique_users: ['a@example.com'] },
        { _id: '2026-08-02', interactions: 1, unique_users: ['a@example.com', 'b@example.com'] },
      ]),
    });

    const res = await GET(makeRequest('/api/admin/stats?section=api&source=api'));
    const body = await res.json();

    expect(body.data.api.total_interactions).toBe(3);
    expect(Array.isArray(body.data.api.daily)).toBe(true);
  });
});

// ============================================================================
// Tests: Direct MCP Activity (audit-service, not Mongo)
// ============================================================================

describe('GET /api/admin/stats — Direct MCP Activity', () => {
  beforeEach(resetMocks);

  it('queries the audit-service for OK_LOCAL_AGENT_CONTEXT events within the selected range', async () => {
    setupAdminWithCollections();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 2,
        records: [
          { ts: '2026-08-01T10:00:00Z', subject_ref: 'user:alice' },
          { ts: '2026-08-01T11:00:00Z', subject_ref: 'user:bob' },
        ],
      }),
    });

    const res = await GET(makeRequest('/api/admin/stats?section=api&range=7d'));
    const body = await res.json();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/v1/audit/events');
    expect(parsed.searchParams.get('reason_code')).toBe('OK_LOCAL_AGENT_CONTEXT');
    expect(parsed.searchParams.has('since')).toBe(true);
    expect(parsed.searchParams.has('until')).toBe(true);

    expect(body.data.api.mcp_activity.total_events).toBe(2);
    expect(body.data.api.mcp_activity.unique_users).toBe(2);
  });

  it('does not count a record with a missing subject_ref toward unique_users', async () => {
    setupAdminWithCollections();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 2,
        records: [
          { ts: '2026-08-01T10:00:00Z' },
          { ts: '2026-08-01T11:00:00Z', subject_ref: 'user:alice' },
        ],
      }),
    });

    const res = await GET(makeRequest('/api/admin/stats?section=api'));
    const body = await res.json();

    expect(body.data.api.mcp_activity.total_events).toBe(2);
    expect(body.data.api.mcp_activity.unique_users).toBe(1);
  });

  it('marks mcp_activity unavailable when the audit-service call fails, without failing the request', async () => {
    setupAdminWithCollections();
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await GET(makeRequest('/api/admin/stats?section=api'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.api.mcp_activity.unavailable).toBe(true);
    expect(body.data.api.mcp_activity.total_events).toBe(0);
  });

  it('marks mcp_activity unavailable when the audit-service responds with a non-2xx status', async () => {
    setupAdminWithCollections();
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const res = await GET(makeRequest('/api/admin/stats?section=api'));
    const body = await res.json();

    expect(body.data.api.mcp_activity.unavailable).toBe(true);
  });

  it('caps the queried range to 31 days and flags range_capped for a wider dashboard range', async () => {
    setupAdminWithCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=api&range=90d'));
    const body = await res.json();

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    const since = new Date(parsed.searchParams.get('since')!);
    const until = new Date(parsed.searchParams.get('until')!);
    const days = (until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(31.01);
    expect(body.data.api.mcp_activity.range_capped).toBe(true);
  });

  it('never includes mcp_activity for a non-admin caller', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    setupNonAdminCollections();

    const res = await GET(makeRequest('/api/admin/stats?section=api'));
    const body = await res.json();

    expect(mockFetch).not.toHaveBeenCalled();
    if (body.data.api) {
      expect(body.data.api).not.toHaveProperty('mcp_activity');
    }
  });
});

/**
 * @jest-environment node
 */
/**
 * Tests for Admin Feedback API Route
 *
 * Covers:
 * - GET /api/admin/feedback — paginated feedback entries for admin dashboard
 *
 * Features tested:
 * - Authentication: 401 when unauthenticated
 * - Authorization: 403 when non-admin
 * - MongoDB guard: 503 when MongoDB is not configured
 * - Pagination (page, limit, skip)
 * - Rating filter (positive, negative, all)
 * - Conversation title batch-fetching
 * - Content snippet truncation
 * - Response structure
 * - Empty database returns empty entries
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

// Spec 102 / T052 — mock the Keycloak PDP wrapper so requireRbacPermission
// resolves locally. Each test sets the response per persona.
jest.mock('@/lib/rbac/keycloak-authz', () => ({
  checkPermission: jest.fn(),
}));
jest.mock('@/lib/rbac/audit', () => ({
  logAuthzDecision: jest.fn(),
}));

const mockCheckPermission = jest.requireMock<{ checkPermission: jest.Mock }>(
  '@/lib/rbac/keycloak-authz'
).checkPermission;

const mockGetReadableSlackChannelNames = jest.fn<Promise<string[]>, [string]>();
const mockGetOwnedAgents = jest.fn<Promise<Array<{ id: string; name: string }>>, [string]>();
const mockGetOwnedAgentConversationIds = jest.fn<
  Promise<{ ids: string[]; capped: boolean }>,
  [Array<{ id: string; name: string }>]
>();
jest.mock('@/lib/rbac/user-insights-scope', () => ({
  getReadableSlackChannelNames: (...args: unknown[]) => mockGetReadableSlackChannelNames(...args),
  getOwnedAgents: (...args: unknown[]) => mockGetOwnedAgents(...args),
  getOwnedAgentConversationIds: (...args: unknown[]) => mockGetOwnedAgentConversationIds(...args),
}));

const mockLoadTeamMembersForSlugs = jest.fn();
jest.mock('@/lib/rbac/team-membership-store', () => ({
  loadTeamMembersForSlugs: (...args: unknown[]) => mockLoadTeamMembersForSlugs(...args),
}));

const mockCheckOpenFgaTuple = jest.fn();
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

let mockFeedbackEnabled = true;
jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => {
    if (key === 'feedbackEnabled') return mockFeedbackEnabled;
    return key === 'ssoEnabled';
  },
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

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

// ============================================================================
// Helpers
// ============================================================================

function createMockCollection() {
  const findReturnValue = {
    sort: jest.fn().mockReturnValue({
      skip: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    toArray: jest.fn().mockResolvedValue([]),
  };

  return {
    find: jest.fn().mockReturnValue(findReturnValue),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
    // The /api/admin/feedback route calls `feedbackColl.distinct(...)` to
    // populate the channels and users filter dropdowns. Without this in the
    // base shape, any test that doesn't go through `setupFeedbackCollection`
    // (which used to add it locally) hits a TypeError → 500.
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

function adminSession() {
  return {
    user: { email: 'admin@example.com', name: 'Admin' },
    role: 'admin',
    sub: 'admin-sub',
    accessToken: accessTokenWithRoles(['admin']),
  };
}

function userSession() {
  return {
    user: { email: 'user@example.com', name: 'User' },
    role: 'user',
    sub: 'user-sub',
    accessToken: accessTokenWithRoles(['chat_user']),
  };
}

function userSessionNoSub() {
  return {
    user: { email: 'user@example.com', name: 'User' },
    role: 'user',
    accessToken: accessTokenWithRoles(['chat_user']),
  };
}

/** Unified feedback doc (new schema) */
function makeFeedbackDoc(overrides: Partial<unknown> = {}) {
  return {
    _id: new ObjectId(),
    message_id: 'msg-1',
    conversation_id: 'conv-1',
    source: 'web',
    rating: 'positive',
    value: 'thumbs_up',
    comment: null,
    user_email: 'user@example.com',
    created_at: new Date('2026-03-15'),
    ...overrides,
  };
}

/** Setup feedback collection with chainable find mock */
function setupFeedbackCollection(docs: unknown[], totalCount: number) {
  const feedbackCol = createMockCollection();
  feedbackCol.find.mockReturnValue({
    sort: jest.fn().mockReturnValue({
      skip: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue(docs),
        }),
      }),
    }),
  });
  feedbackCol.countDocuments.mockResolvedValue(totalCount);
  feedbackCol.distinct = jest.fn().mockResolvedValue([]);
  mockCollections['feedback'] = feedbackCol;
  return feedbackCol;
}

// ============================================================================
// Tests
// ============================================================================

// Import after mocks are registered (cf. admin-stats.test.ts pattern). We
// intentionally do NOT call jest.resetModules() in beforeEach because that
// detaches our mock instance and triggers `Cannot read properties of undefined
// (reading 'allowed')` from requireRbacPermission's response unwrap.
 
import { GET } from '../admin/feedback/route';

describe('GET /api/admin/feedback', () => {
  beforeEach(() => {
    Object.keys(mockCollections).forEach((k) => delete mockCollections[k]);
    mockGetCollection.mockClear();
    mockCheckPermission.mockReset();
    // Default to allow — individual tests override for deny scenarios.
    mockCheckPermission.mockResolvedValue({ allowed: true, reason: 'OK' });
    mockGetReadableSlackChannelNames.mockReset();
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    mockCheckOpenFgaTuple.mockReset();
    mockCheckOpenFgaTuple.mockImplementation(async (tuple: { user?: string }) => ({
      allowed: tuple.user === 'user:admin-sub',
    }));
    mockGetOwnedAgents.mockReset();
    mockGetOwnedAgents.mockResolvedValue([]);
    mockGetOwnedAgentConversationIds.mockReset();
    mockGetOwnedAgentConversationIds.mockResolvedValue({ ids: [], capped: false });
    mockLoadTeamMembersForSlugs.mockReset();
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map());
    mockIsMongoDBConfigured = true;
    mockFeedbackEnabled = true;
  });

  it('returns 404 when feedback feature is disabled', async () => {
    mockFeedbackEnabled = false;
    mockGetServerSession.mockResolvedValue(adminSession);
    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('FEEDBACK_DISABLED');
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(401);
  });

  // Non-admins are scoped, not denied — but a non-admin with no `sub` claim
  // can't be scoped (no OpenFGA subject), so the route must 401 rather than
  // fall through to an unscoped query.
  it('returns 401 for non-admin users with no sub claim', async () => {
    mockGetServerSession.mockResolvedValue(userSessionNoSub());
    mockCheckPermission.mockResolvedValue({
      allowed: false,
      reason: 'DENY_NO_CAPABILITY',
    });
    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('scopes filter to user_email when non-admin has no readable channels', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockCheckPermission.mockResolvedValue({
      allowed: false,
      reason: 'DENY_NO_CAPABILITY',
    });
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    const feedbackCol = setupFeedbackCollection([], 0);

    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(200);
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.$or).toEqual([{ user_email: 'user@example.com' }]);
    expect(mockGetReadableSlackChannelNames).toHaveBeenCalledWith('user:user-sub');
  });

  it('scopes filter to readable channels OR own email when non-admin has channels', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockCheckPermission.mockResolvedValue({
      allowed: false,
      reason: 'DENY_NO_CAPABILITY',
    });
    mockGetReadableSlackChannelNames.mockResolvedValue(['general', 'random']);
    const feedbackCol = setupFeedbackCollection([], 0);

    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(200);
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { source: 'slack', channel_name: { $in: ['general', 'random'] } },
      { user_email: 'user@example.com' },
    ]);
  });

  it('does not inject scope filter for full admin', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.$or).toBeUndefined();
    expect(filter.$and).toBeUndefined();
    expect(mockGetReadableSlackChannelNames).not.toHaveBeenCalled();
  });

  it('scopes distinct channel/user dropdowns to filter for non-admin', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockCheckPermission.mockResolvedValue({
      allowed: false,
      reason: 'DENY_NO_CAPABILITY',
    });
    mockGetReadableSlackChannelNames.mockResolvedValue(['general']);
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback'));
    const channelDistinctArgs = feedbackCol.distinct.mock.calls.find(
      (call: unknown[]) => call[0] === 'channel_name'
    );
    const userDistinctArgs = feedbackCol.distinct.mock.calls.find(
      (call: unknown[]) => call[0] === 'user_email'
    );
    expect(channelDistinctArgs?.[1].$or).toBeDefined();
    expect(userDistinctArgs?.[1].$or).toBeDefined();
  });

  it('combines existing $or (search) with scope using $and for non-admin', async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockCheckPermission.mockResolvedValue({
      allowed: false,
      reason: 'DENY_NO_CAPABILITY',
    });
    mockGetReadableSlackChannelNames.mockResolvedValue([]);
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?search=wrong'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.$and).toBeDefined();
    expect(filter.$and).toHaveLength(2);
    expect(filter.$or).toBeUndefined();
  });

  it('returns 503 when MongoDB is not configured', async () => {
    mockIsMongoDBConfigured = false;
    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('MONGODB_NOT_CONFIGURED');
  });

  it('returns empty entries on fresh database', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setupFeedbackCollection([], 0);

    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.entries).toEqual([]);
    expect(body.data.pagination.total).toBe(0);
  });

  it('returns feedback entries with correct structure from unified collection', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());

    const doc = makeFeedbackDoc({
      conversation_id: 'conv-1',
      rating: 'positive',
      value: 'thumbs_up',
      comment: 'Very Helpful',
      user_email: 'user@example.com',
    });
    setupFeedbackCollection([doc], 1);

    const convCol = createMockCollection();
    convCol.find.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ _id: 'conv-1', title: 'My Chat' }]),
    });
    mockCollections['conversations'] = convCol;

    const res = await GET(makeRequest('/api/admin/feedback'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const entry = body.data.entries[0];
    expect(entry.message_id).toBe('msg-1');
    expect(entry.conversation_id).toBe('conv-1');
    expect(entry.conversation_title).toBe('My Chat');
    expect(entry.rating).toBe('positive');
    // thumbs_up is generic + has comment → reason = comment only
    expect(entry.reason).toBe('Very Helpful');
    expect(entry.submitted_by).toBe('user@example.com');
    expect(entry.source).toBe('web');
  });

  it('filters by positive rating on feedback collection', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?rating=positive'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.rating).toBe('positive');
  });

  it('filters by negative rating on feedback collection', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?rating=negative'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.rating).toBe('negative');
  });

  it('applies no rating filter when not specified', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.rating).toBeUndefined();
  });

  it('respects pagination parameters', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());

    const feedbackCol = setupFeedbackCollection([], 100);
    const mockSkip = jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    feedbackCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({ skip: mockSkip }),
    });

    const res = await GET(makeRequest('/api/admin/feedback?page=3&limit=10'));
    expect(mockSkip).toHaveBeenCalledWith(20); // (3-1)*10
    const body = await res.json();
    expect(body.data.pagination.page).toBe(3);
    expect(body.data.pagination.limit).toBe(10);
    expect(body.data.pagination.total).toBe(100);
    expect(body.data.pagination.total_pages).toBe(10);
  });

  // ════════════════════════════════════════════════════════════════════════
  // Unified feedback collection — source/channel/user/search/date filters
  // ════════════════════════════════════════════════════════════════════════

  it('filters by source=slack and channel name', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?source=slack&channel=general,random'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.source).toBe('slack');
    expect(filter.channel_name).toEqual({ $in: ['general', 'random'] });
  });

  it('filters by user email', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?user=alice@co.com'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.user_email).toBe('alice@co.com');
  });

  it('resolves a team filter from canonical membership records', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([
      ['platform-team', [
        { user_email: 'alice@example.com' },
        { user_email: 'bob@example.com' },
      ]],
    ]));
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?team=platform-team'));

    expect(mockLoadTeamMembersForSlugs).toHaveBeenCalledWith(['platform-team']);
    expect(feedbackCol.find.mock.calls[0][0].user_email).toEqual({
      $in: ['alice@example.com', 'bob@example.com'],
    });
  });

  it('fails closed when a selected team has no canonical members', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([['empty-team', []]]));
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?team=empty-team'));

    expect(feedbackCol.find.mock.calls[0][0].user_email).toEqual({ $in: [] });
  });

  it('filters by search terms as regex OR on comment and value', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?search=wrong,slow'));
    const filter = feedbackCol.find.mock.calls[0][0];
    // Each term produces 2 OR clauses (comment + value)
    expect(filter.$or).toHaveLength(4);
    expect(filter.$or[0]).toEqual({ comment: { $regex: 'wrong', $options: 'i' } });
    expect(filter.$or[1]).toEqual({ value: { $regex: 'wrong', $options: 'i' } });
  });

  it('filters by date range (from/to)', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const feedbackCol = setupFeedbackCollection([], 0);

    await GET(makeRequest('/api/admin/feedback?from=2026-03-01T00:00:00Z&to=2026-03-15T00:00:00Z'));
    const filter = feedbackCol.find.mock.calls[0][0];
    expect(filter.created_at.$gte).toEqual(new Date('2026-03-01T00:00:00Z'));
    expect(filter.created_at.$lte).toEqual(new Date('2026-03-15T00:00:00Z'));
  });

  // ════════════════════════════════════════════════════════════════════════
  // Reason combining logic (VALUE_LABELS)
  // ════════════════════════════════════════════════════════════════════════

  it('combines non-generic value label with comment as "Label; comment"', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());

    const doc = makeFeedbackDoc({
      rating: 'negative',
      value: 'wrong_answer',
      comment: 'the k8s docs were outdated',
    });
    setupFeedbackCollection([doc], 1);

    const res = await GET(makeRequest('/api/admin/feedback'));
    const body = await res.json();
    expect(body.data.entries[0].reason).toBe('Wrong answer; the k8s docs were outdated');
  });

  it('returns only the comment for generic thumbs_up/thumbs_down values', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());

    const doc = makeFeedbackDoc({
      value: 'thumbs_down',
      comment: 'not helpful at all',
    });
    setupFeedbackCollection([doc], 1);

    const res = await GET(makeRequest('/api/admin/feedback'));
    const body = await res.json();
    // Generic value should be suppressed; only comment shown
    expect(body.data.entries[0].reason).toBe('not helpful at all');
  });

  it('returns null reason when generic value has no comment', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());

    const doc = makeFeedbackDoc({ value: 'thumbs_up', comment: null });
    setupFeedbackCollection([doc], 1);

    const res = await GET(makeRequest('/api/admin/feedback'));
    const body = await res.json();
    expect(body.data.entries[0].reason).toBeNull();
  });

  it('returns value label as reason when non-generic with no comment', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());

    const doc = makeFeedbackDoc({ value: 'too_verbose', comment: null });
    setupFeedbackCollection([doc], 1);

    const res = await GET(makeRequest('/api/admin/feedback'));
    const body = await res.json();
    expect(body.data.entries[0].reason).toBe('Too verbose');
  });
});

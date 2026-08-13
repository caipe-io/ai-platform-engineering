/**
 * @jest-environment node
 */
/**
 * Tests for Read-Only Sharing Permissions
 *
 * Covers the sharing permission model:
 * - 'view' permission → shared_readonly access (cannot send messages)
 * - 'comment' permission → shared access (can send messages)
 * - Legacy public flags no longer grant access
 * - Team shares with per-team permissions
 * - Permission changes via PATCH
 * - Backward compatibility: legacy shares without permission records default to 'comment'
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

jest.mock('@/lib/mongodb', () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

jest.mock('@/lib/rbac/keycloak-authz', () => ({
  checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
}));

// `requireConversationResourcePermission` falls through to OpenFGA only
// when the session is NOT the implicit conversation owner. In this suite
// we want the route's own `access_level === 'shared_readonly'` check and
// owner-only branches in `share/route.ts` to drive the outcome, not the
// PDP. Default to allow non-privileged actions (`can_read`/`can_discover`/
// `can_write`) plus the `/api/chat/*` compatibility wrapper's org-level
// `can_chat` gate so the route reaches its own logic; deny `can_share` /
// `can_manage` / `can_delete` so non-owner privileged actions return 403.
const mockCheckOpenFgaTuple = jest.fn().mockImplementation(async (tuple: { relation?: string }) => {
  const allowed = new Set(['can_read', 'can_discover', 'can_write', 'can_use', 'can_chat']);
  return { allowed: allowed.has(tuple?.relation ?? '') };
});
const mockWriteOpenFgaTuples = jest.fn().mockResolvedValue({ enabled: true, writes: 0, deletes: 0 });
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock('@/lib/rbac/resource-authz', () => ({
  filterResourcesByPermission: jest.fn(async (_session, resources: unknown[]) => resources),
  requireResourcePermission: jest.fn(async (_session, target: { action: string; type: string }) => {
    const relation = target.action === 'list' || target.action === 'discover'
      ? 'can_discover'
      : `can_${target.action.replace('-', '_')}`;
    const result = await mockCheckOpenFgaTuple({ relation });
    if (result.allowed === true) return;
    const error = new Error('You do not have permission to access this resource.') as Error & {
      statusCode: number;
      code: string;
    };
    error.statusCode = 403;
    error.code = `${target.type}#${target.action}`;
    throw error;
  }),
}));

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockCollection() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 0 }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

const OWNER_EMAIL = 'owner@example.com';
const VIEWER_EMAIL = 'viewer@example.com';
const EDITOR_EMAIL = 'editor@example.com';
const TEAM_MEMBER_EMAIL = 'team-member@example.com';
const TEAM_ID = new ObjectId().toHexString();
const TEST_CONV_ID = '12345678-1234-1234-1234-123456789abc';

function makeConversation(overrides: unknown = {}) {
  return {
    _id: TEST_CONV_ID,
    title: 'Test Conversation',
    owner_id: OWNER_EMAIL,
    created_at: new Date(),
    updated_at: new Date(),
    metadata: { client_type: 'ui', total_messages: 0 },
    sharing: {
      is_public: false,
      shared_with: [],
      shared_with_teams: [],
      share_link_enabled: false,
      ...overrides.sharing,
    },
    tags: [],
    is_archived: false,
    is_pinned: false,
    ...overrides,
    // Keep sharing merge at top level
  };
}

function mockShareableUsers(
  users: Array<{ email: string; keycloak_sub?: string; metadata?: { keycloak_sub?: string } }>,
) {
  const usersCol = createMockCollection();
  usersCol.find.mockReturnValue({
    project: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(users),
    }),
  });
  mockCollections['users'] = usersCol;
  return usersCol;
}

// ============================================================================
// Import after mocks
// ============================================================================

import { requireConversationAccess } from '@/lib/api-middleware';

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 0, deletes: 0 });
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
});

describe('requireConversationAccess — readonly sharing permissions', () => {
  describe('direct user shares', () => {
    it('returns shared_readonly when user has view permission', async () => {
      const conv = makeConversation({
        sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const sharingAccessCol = createMockCollection();
      sharingAccessCol.findOne.mockResolvedValue({
        conversation_id: conv._id,
        granted_to: VIEWER_EMAIL,
        permission: 'view',
      });
      mockCollections['sharing_access'] = sharingAccessCol;

      const result = await requireConversationAccess(conv._id, VIEWER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared_readonly');
      expect(result.conversation._id).toBe(conv._id);
    });

    it('returns shared when user has comment permission', async () => {
      const conv = makeConversation({
        sharing: { shared_with: [EDITOR_EMAIL], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const sharingAccessCol = createMockCollection();
      sharingAccessCol.findOne.mockResolvedValue({
        conversation_id: conv._id,
        granted_to: EDITOR_EMAIL,
        permission: 'comment',
      });
      mockCollections['sharing_access'] = sharingAccessCol;

      const result = await requireConversationAccess(conv._id, EDITOR_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared');
    });

    it('defaults to shared (comment) for legacy shares without a SharingAccess record', async () => {
      const conv = makeConversation({
        sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const sharingAccessCol = createMockCollection();
      sharingAccessCol.findOne.mockResolvedValue(null);
      mockCollections['sharing_access'] = sharingAccessCol;

      const result = await requireConversationAccess(conv._id, VIEWER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared');
    });
  });

  describe('legacy public flags', () => {
    it('does not grant access to non-owners from is_public=true', async () => {
      const conv = makeConversation({
        sharing: { is_public: true, shared_with: [], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      await expect(requireConversationAccess(conv._id, VIEWER_EMAIL, mockGetCollection))
        .rejects.toThrow('You do not have access to this conversation.');
    });

    it('owner still gets owner access when old public state is present', async () => {
      const conv = makeConversation({
        sharing: { is_public: true, shared_with: [], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const result = await requireConversationAccess(conv._id, OWNER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('owner');
    });
  });

  describe('team shares with permissions', () => {
    it('returns shared_readonly when team has view permission', async () => {
      const conv = makeConversation({
        sharing: {
          shared_with: [],
          shared_with_teams: [TEAM_ID],
          team_permissions: { [TEAM_ID]: 'view' },
        },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const teamsCol = createMockCollection();
      teamsCol.find.mockReturnValue({
        project: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { _id: new ObjectId(TEAM_ID) },
          ]),
        }),
      });
      mockCollections['teams'] = teamsCol;

      const result = await requireConversationAccess(conv._id, TEAM_MEMBER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared_readonly');
    });

    it('returns shared when team has comment permission', async () => {
      const conv = makeConversation({
        sharing: {
          shared_with: [],
          shared_with_teams: [TEAM_ID],
          team_permissions: { [TEAM_ID]: 'comment' },
        },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const teamsCol = createMockCollection();
      teamsCol.find.mockReturnValue({
        project: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { _id: new ObjectId(TEAM_ID) },
          ]),
        }),
      });
      mockCollections['teams'] = teamsCol;

      const result = await requireConversationAccess(conv._id, TEAM_MEMBER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared');
    });

    it('defaults to shared (comment) for legacy team shares without team_permissions', async () => {
      const conv = makeConversation({
        sharing: {
          shared_with: [],
          shared_with_teams: [TEAM_ID],
        },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const teamsCol = createMockCollection();
      teamsCol.find.mockReturnValue({
        project: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([
            { _id: new ObjectId(TEAM_ID) },
          ]),
        }),
      });
      mockCollections['teams'] = teamsCol;

      const result = await requireConversationAccess(conv._id, TEAM_MEMBER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared');
    });
  });

  describe('sharing_access fallback', () => {
    it('returns shared_readonly when sharing_access record has view permission', async () => {
      const conv = makeConversation({
        sharing: { shared_with: [], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const sharingAccessCol = createMockCollection();
      sharingAccessCol.findOne.mockResolvedValue({
        conversation_id: conv._id,
        granted_to: VIEWER_EMAIL,
        permission: 'view',
      });
      mockCollections['sharing_access'] = sharingAccessCol;

      const result = await requireConversationAccess(conv._id, VIEWER_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared_readonly');
    });

    it('returns shared when sharing_access record has comment permission', async () => {
      const conv = makeConversation({
        sharing: { shared_with: [], shared_with_teams: [] },
      });
      const convsCol = createMockCollection();
      convsCol.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convsCol;

      const sharingAccessCol = createMockCollection();
      sharingAccessCol.findOne.mockResolvedValue({
        conversation_id: conv._id,
        granted_to: EDITOR_EMAIL,
        permission: 'comment',
      });
      mockCollections['sharing_access'] = sharingAccessCol;

      const result = await requireConversationAccess(conv._id, EDITOR_EMAIL, mockGetCollection);

      expect(result.access_level).toBe('shared');
    });
  });
});

describe('POST /api/chat/conversations/[id]/messages — readonly sharing', () => {
  it('blocks message creation for shared_readonly users', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue({
      conversation_id: conv._id,
      granted_to: VIEWER_EMAIL,
      permission: 'view',
    });
    mockCollections['sharing_access'] = sharingAccessCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: VIEWER_EMAIL, name: 'Viewer' },
      accessToken: 'test-access-token',
      sub: 'viewer-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/messages/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: 'test message' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Read-only');
  });

  it('allows message creation for shared (comment) users', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [EDITOR_EMAIL], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue({
      conversation_id: conv._id,
      granted_to: EDITOR_EMAIL,
      permission: 'comment',
    });
    mockCollections['sharing_access'] = sharingAccessCol;

    const msgCol = createMockCollection();
    mockCollections['messages'] = msgCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: EDITOR_EMAIL, name: 'Editor' },
      accessToken: 'test-access-token',
      sub: 'editor-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/messages/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: 'test message' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/chat/conversations/[id]/share — permission updates', () => {
  it('updates user permission via PATCH', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv });
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    mockCollections['sharing_access'] = sharingAccessCol;
    mockShareableUsers([{ email: VIEWER_EMAIL, keycloak_sub: 'viewer-sub' }]);

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { PATCH } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'PATCH',
      body: JSON.stringify({ email: VIEWER_EMAIL, permission: 'comment' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(sharingAccessCol.updateOne).toHaveBeenCalledWith(
      { conversation_id: conv._id, granted_to: { $in: [VIEWER_EMAIL] }, revoked_at: null },
      { $set: { permission: 'comment', granted_to: VIEWER_EMAIL } }
    );
  });

  it('updates team permission via PATCH', async () => {
    const conv = makeConversation({
      sharing: {
        shared_with: [],
        shared_with_teams: [TEAM_ID],
        team_permissions: { [TEAM_ID]: 'view' },
      },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv });
    mockCollections['conversations'] = convsCol;
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({ _id: TEAM_ID, slug: TEAM_ID, name: 'Test Team' });
    mockCollections['teams'] = teamsCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { PATCH } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'PATCH',
      body: JSON.stringify({ team_id: TEAM_ID, permission: 'comment' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(convsCol.updateOne).toHaveBeenCalledWith(
      { _id: conv._id },
      { $set: { 'sharing.team_permissions': { [TEAM_ID]: 'comment' } } }
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: `team:${TEAM_ID}#member`, relation: 'reader', object: `conversation:${conv._id}` },
        { user: `team:${TEAM_ID}#member`, relation: 'writer', object: `conversation:${conv._id}` },
      ]),
      deletes: [],
    });
  });

  it('removes the team writer grant when changing permission to view', async () => {
    const conv = makeConversation({
      sharing: {
        shared_with: [],
        shared_with_teams: [TEAM_ID],
        team_permissions: { [TEAM_ID]: 'comment' },
      },
    });
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValueOnce(conv).mockResolvedValue({ ...conv });
    mockCollections['conversations'] = convsCol;
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({ _id: new ObjectId(TEAM_ID), name: 'Example Team' });
    mockCollections['teams'] = teamsCol;
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { PATCH } = await import('@/app/api/chat/conversations/[id]/share/route');
    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'PATCH',
      body: JSON.stringify({ team_id: TEAM_ID, permission: 'view' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        { user: `team:${TEAM_ID}#member`, relation: 'reader', object: `conversation:${conv._id}` },
      ],
      deletes: [
        { user: `team:${TEAM_ID}#member`, relation: 'writer', object: `conversation:${conv._id}` },
      ],
    });
  });

  it('rejects PATCH with invalid permission value', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { PATCH } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'PATCH',
      body: JSON.stringify({ email: VIEWER_EMAIL, permission: 'admin' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: TEST_CONV_ID }) });

    expect(res.status).toBe(400);
  });

  it('rejects PATCH from non-owner', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: VIEWER_EMAIL, name: 'Viewer' },
      sub: 'viewer-sub',
    });

    const { PATCH } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'PATCH',
      body: JSON.stringify({ email: VIEWER_EMAIL, permission: 'comment' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/chat/conversations/[id]/share — permission storage', () => {
  it('stores permission in SharingAccess when sharing with users', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv, sharing: { ...conv.sharing, shared_with: [VIEWER_EMAIL] } });
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    mockCollections['sharing_access'] = sharingAccessCol;
    mockShareableUsers([{ email: VIEWER_EMAIL, keycloak_sub: 'viewer-sub' }]);

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({
        user_emails: [VIEWER_EMAIL],
        permission: 'view',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(sharingAccessCol.insertMany).toHaveBeenCalled();
    const insertedRecords = sharingAccessCol.insertMany.mock.calls[0][0];
    expect(insertedRecords[0].permission).toBe('view');
    expect(insertedRecords[0].granted_to).toBe(VIEWER_EMAIL);
  });

  it('writes OpenFGA user grants when a direct-share recipient has a stable subject', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv, sharing: { ...conv.sharing, shared_with: [VIEWER_EMAIL] } });
    mockCollections['conversations'] = convsCol;

    mockCollections['sharing_access'] = createMockCollection();
    const usersCol = createMockCollection();
    usersCol.find.mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { email: VIEWER_EMAIL, keycloak_sub: 'viewer-sub' },
        ]),
      }),
    });
    mockCollections['users'] = usersCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({
        user_emails: [VIEWER_EMAIL],
        permission: 'comment',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: 'user:viewer-sub', relation: 'reader', object: `conversation:${conv._id}` },
        { user: 'user:viewer-sub', relation: 'writer', object: `conversation:${conv._id}` },
      ]),
      deletes: [],
    });
  });

  it('does not persist a share when the OpenFGA grant fails', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;
    const sharingAccessCol = createMockCollection();
    mockCollections['sharing_access'] = sharingAccessCol;
    mockShareableUsers([{ email: VIEWER_EMAIL, keycloak_sub: 'viewer-sub' }]);
    mockWriteOpenFgaTuples.mockRejectedValueOnce(new Error('OpenFGA unavailable'));
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');
    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({ user_emails: [VIEWER_EMAIL], permission: 'view' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(500);
    expect(sharingAccessCol.insertMany).not.toHaveBeenCalled();
    expect(convsCol.updateOne).not.toHaveBeenCalled();
  });

  it('prevalidates all recipients before applying a mixed user and team share', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;
    const sharingAccessCol = createMockCollection();
    mockCollections['sharing_access'] = sharingAccessCol;
    mockShareableUsers([{ email: VIEWER_EMAIL, keycloak_sub: 'viewer-sub' }]);
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(null);
    mockCollections['teams'] = teamsCol;
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');
    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({
        user_emails: [VIEWER_EMAIL],
        team_ids: ['missing-team'],
        permission: 'view',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(404);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    expect(sharingAccessCol.insertMany).not.toHaveBeenCalled();
    expect(convsCol.updateOne).not.toHaveBeenCalled();
  });

  it('rejects a direct-share recipient who is not provisioned in Keycloak', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv, sharing: { ...conv.sharing, shared_with: [VIEWER_EMAIL] } });
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    mockCollections['sharing_access'] = sharingAccessCol;
    const usersCol = createMockCollection();
    usersCol.find.mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    mockCollections['users'] = usersCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({
        user_emails: [VIEWER_EMAIL],
        permission: 'view',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'SHARE_RECIPIENT_NOT_PROVISIONED',
    }));
    expect(sharingAccessCol.insertMany).not.toHaveBeenCalled();
    expect(convsCol.updateOne).not.toHaveBeenCalled();
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it('stores team_permissions when sharing with teams', async () => {
    const teamObjId = new ObjectId();
    const teamIdStr = teamObjId.toHexString();

    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv });
    mockCollections['conversations'] = convsCol;

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({ _id: teamObjId, name: 'Test Team' });
    mockCollections['teams'] = teamsCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({
        team_ids: [teamIdStr],
        permission: 'view',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    const updateCall = convsCol.updateOne.mock.calls[0][1];
    expect(updateCall.$set['sharing.team_permissions']).toEqual({ [teamIdStr]: 'view' });
  });

  it('stores canonical team slugs and writes team conversation grants', async () => {
    const teamObjId = new ObjectId();
    const teamIdStr = teamObjId.toHexString();

    const conv = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });

    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue({ ...conv });
    mockCollections['conversations'] = convsCol;

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({ _id: teamObjId, slug: 'platform', name: 'Platform' });
    mockCollections['teams'] = teamsCol;

    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');

    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'POST',
      body: JSON.stringify({
        team_ids: [teamIdStr],
        permission: 'comment',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    const updateCall = convsCol.updateOne.mock.calls[0][1];
    expect(updateCall.$set['sharing.shared_with_teams']).toEqual(['platform']);
    expect(updateCall.$set['sharing.team_permissions']).toEqual({ platform: 'comment' });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        { user: 'team:platform#member', relation: 'reader', object: `conversation:${conv._id}` },
        { user: 'team:platform#member', relation: 'writer', object: `conversation:${conv._id}` },
      ]),
      deletes: [],
    });
  });
});

describe('DELETE /api/chat/conversations/[id]/share — access revocation', () => {
  it('revokes direct user tuples and removes Mongo sharing state', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
    });
    const updated = makeConversation({
      sharing: { shared_with: [], shared_with_teams: [] },
    });
    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue(updated);
    mockCollections['conversations'] = convsCol;
    const sharingAccessCol = createMockCollection();
    mockCollections['sharing_access'] = sharingAccessCol;
    mockShareableUsers([{ email: VIEWER_EMAIL, keycloak_sub: 'viewer-sub' }]);
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { DELETE } = await import('@/app/api/chat/conversations/[id]/share/route');
    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'DELETE',
      body: JSON.stringify({ email: VIEWER_EMAIL }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: expect.arrayContaining([
        { user: 'user:viewer-sub', relation: 'reader', object: `conversation:${conv._id}` },
        { user: 'user:viewer-sub', relation: 'writer', object: `conversation:${conv._id}` },
      ]),
    });
    expect(sharingAccessCol.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: conv._id,
        granted_to: { $in: [VIEWER_EMAIL] },
        revoked_at: null,
      }),
      { $set: { revoked_at: expect.any(Date), revoked_by: OWNER_EMAIL } },
    );
    expect(convsCol.updateOne).toHaveBeenCalledWith(
      { _id: conv._id },
      { $set: { 'sharing.shared_with': [] } },
    );
  });

  it('cleans up a legacy unprovisioned direct share without requiring a tuple', async () => {
    const conv = makeConversation({
      sharing: { shared_with: [VIEWER_EMAIL], shared_with_teams: [] },
    });
    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue(makeConversation());
    mockCollections['conversations'] = convsCol;
    mockCollections['sharing_access'] = createMockCollection();
    mockShareableUsers([]);
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { DELETE } = await import('@/app/api/chat/conversations/[id]/share/route');
    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'DELETE',
      body: JSON.stringify({ email: VIEWER_EMAIL }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    expect(convsCol.updateOne).toHaveBeenCalled();
  });

  it('revokes observed team reader and writer tuples', async () => {
    const conv = makeConversation({
      sharing: {
        shared_with: [],
        shared_with_teams: ['platform'],
        team_permissions: { platform: 'comment' },
      },
    });
    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValue(makeConversation());
    mockCollections['conversations'] = convsCol;
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({ _id: new ObjectId(), slug: 'platform', name: 'Platform' });
    mockCollections['teams'] = teamsCol;
    mockGetServerSession.mockResolvedValue({
      user: { email: OWNER_EMAIL, name: 'Owner' },
      sub: 'owner-sub',
    });

    const { DELETE } = await import('@/app/api/chat/conversations/[id]/share/route');
    const req = new NextRequest(`http://localhost/api/chat/conversations/${TEST_CONV_ID}/share`, {
      method: 'DELETE',
      body: JSON.stringify({ team_id: 'platform' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: conv._id }) });

    expect(res.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: expect.arrayContaining([
        { user: 'team:platform#member', relation: 'reader', object: `conversation:${conv._id}` },
        { user: 'team:platform#member', relation: 'writer', object: `conversation:${conv._id}` },
      ]),
    });
    expect(convsCol.updateOne).toHaveBeenCalledWith(
      { _id: conv._id },
      {
        $set: {
          'sharing.shared_with_teams': [],
          'sharing.team_permissions': {},
        },
      },
    );
  });
});

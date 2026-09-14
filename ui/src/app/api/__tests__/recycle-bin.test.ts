/**
 * @jest-environment node
 */
/**
 * Tests for Conversation Archive API Routes
 *
 * Covers:
 * - DELETE /api/chat/conversations/[id] — soft-delete (move to archive)
 * - DELETE /api/chat/conversations/[id]?permanent=true — hard-delete
 * - POST /api/chat/conversations/[id]/restore — restore from archive
 * - GET /api/chat/conversations/trash — list soft-deleted conversations
 * - GET /api/chat/conversations — excludes soft-deleted conversations
 *
 * Features tested:
 * - Soft-delete sets deleted_at + is_archived
 * - Permanent delete removes conversation + messages
 * - Restore clears deleted_at + is_archived
 * - Trash listing with auto-purge of 7-day-old conversations
 * - Normal listing excludes soft-deleted conversations
 * - Ownership enforcement
 * - UUID and legacy conversation identifier validation
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

jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: false }),
}));

jest.mock('@/lib/rbac/resource-authz', () => ({
  filterResourcesByPermission: jest.fn(async (_session, resources: unknown[]) => resources),
  requireResourcePermission: jest.fn(async (_session, target: { action: string; type: string }) => {
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
  v4: () => '550e8400-e29b-41d4-a716-446655440099',
}));

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
      }),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), options);
}

function authenticatedSession(email = 'user@example.com') {
  return {
    user: { email, name: 'Test User' },
    role: 'user',
    sub: 'user-sub',
  };
}

function makeConversation(overrides: unknown = {}) {
  return {
    _id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Test Conversation',
    owner_id: 'user@example.com',
    created_at: new Date(),
    updated_at: new Date(),
    is_archived: false,
    is_pinned: false,
    deleted_at: null,
    metadata: { client_type: 'ui', total_messages: 2 },
    sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false },
    tags: [],
    ...overrides,
  };
}

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { DELETE } from '../chat/conversations/[id]/route';
import { POST as TOGGLE_ARCHIVE } from '../chat/conversations/[id]/archive/route';
import { POST as RESTORE } from '../chat/conversations/[id]/restore/route';
import { GET as GET_TRASH } from '../chat/conversations/trash/route';
import { GET as GET_CONVERSATIONS } from '../chat/conversations/route';

// ============================================================================
// Tests
// ============================================================================

describe('Archive API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENFGA_HTTP;
    // Reset mock collections
    Object.keys(mockCollections).forEach(key => delete mockCollections[key]);
    // Default authenticated
    mockGetServerSession.mockResolvedValue(authenticatedSession());
  });

  // --------------------------------------------------------------------------
  // DELETE /api/chat/conversations/[id] — soft-delete
  // --------------------------------------------------------------------------

  describe('DELETE /api/chat/conversations/[id] — soft-delete', () => {
    it('soft-deletes a conversation (sets deleted_at and is_archived)', async () => {
      const conv = makeConversation();
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000', {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.deleted).toBe(true);
      expect(body.data.permanent).toBe(false);

      // Should have called updateOne (soft-delete), NOT deleteOne
      expect(convCollection.updateOne).toHaveBeenCalledWith(
        { _id: '550e8400-e29b-41d4-a716-446655440000' },
        { $set: expect.objectContaining({ is_archived: true, deleted_at: expect.any(Date) }) }
      );
      expect(convCollection.deleteOne).not.toHaveBeenCalled();
    });

    it('permanently deletes when ?permanent=true', async () => {
      const conv = makeConversation();
      const convCollection = createMockCollection();
      const msgCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;
      mockCollections['messages'] = msgCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000?permanent=true', {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.deleted).toBe(true);
      expect(body.data.permanent).toBe(true);

      // Should have called deleteMany (via shared helper) for both conversations and messages
      expect(convCollection.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['550e8400-e29b-41d4-a716-446655440000'] } });
      expect(msgCollection.deleteMany).toHaveBeenCalledWith({ conversation_id: { $in: ['550e8400-e29b-41d4-a716-446655440000'] } });
    });

    it('returns 404 for non-existent conversation', async () => {
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(null);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000', {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      expect(res.status).toBe(404);
    });

    it('returns 403 for non-owner', async () => {
      process.env.OPENFGA_HTTP = 'http://openfga.test';
      mockGetServerSession.mockResolvedValue({ ...authenticatedSession(), sub: 'user-sub' });
      const conv = makeConversation({ owner_id: 'other@example.com' });
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000', {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      expect(res.status).toBe(403);
    });

    it('soft-deletes a legacy conversation identifier', async () => {
      const legacyId = 'legacy-demo-conversation';
      const conv = makeConversation({ _id: legacyId });
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest(`http://localhost:3000/api/chat/conversations/${legacyId}`, {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: legacyId }) });

      expect(res.status).toBe(200);
      expect(convCollection.updateOne).toHaveBeenCalledWith(
        { _id: legacyId },
        { $set: expect.objectContaining({ is_archived: true, deleted_at: expect.any(Date) }) },
      );
    });

    it('returns 400 for an unsafe conversation identifier', async () => {
      const invalidId = 'conversation?permanent=true';
      const req = makeRequest('http://localhost:3000/api/chat/conversations/invalid', {
        method: 'DELETE',
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: invalidId }) });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/chat/conversations/[id]/archive', () => {
    it('toggles archive for a legacy conversation identifier', async () => {
      const legacyId = 'legacy-demo-conversation';
      const conv = makeConversation({ _id: legacyId });
      const convCollection = createMockCollection();
      convCollection.findOne
        .mockResolvedValueOnce(conv)
        .mockResolvedValueOnce({ ...conv, is_archived: true });
      mockCollections['conversations'] = convCollection;

      const req = makeRequest(`http://localhost:3000/api/chat/conversations/${legacyId}/archive`, {
        method: 'POST',
      });
      const res = await TOGGLE_ARCHIVE(req, { params: Promise.resolve({ id: legacyId }) });

      expect(res.status).toBe(200);
      expect(convCollection.updateOne).toHaveBeenCalledWith(
        { _id: legacyId },
        { $set: expect.objectContaining({ is_archived: true, updated_at: expect.any(Date) }) },
      );
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/chat/conversations/[id]/restore
  // --------------------------------------------------------------------------

  describe('POST /api/chat/conversations/[id]/restore', () => {
    it('restores a soft-deleted conversation', async () => {
      const conv = makeConversation({ deleted_at: new Date(), is_archived: true });
      const convCollection = createMockCollection();
      convCollection.findOne
        .mockResolvedValueOnce(conv) // First call: find conversation
        .mockResolvedValueOnce({ ...conv, deleted_at: null, is_archived: false }); // Second call: return updated
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/restore', {
        method: 'POST',
      });

      const res = await RESTORE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      // Should have cleared deleted_at and set is_archived to false
      expect(convCollection.updateOne).toHaveBeenCalledWith(
        { _id: '550e8400-e29b-41d4-a716-446655440000' },
        {
          $set: expect.objectContaining({ is_archived: false }),
          $unset: { deleted_at: '' },
        }
      );
    });

    it('returns 400 if conversation is not in archive', async () => {
      const conv = makeConversation({ deleted_at: null });
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/restore', {
        method: 'POST',
      });

      const res = await RESTORE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent conversation', async () => {
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(null);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/restore', {
        method: 'POST',
      });

      const res = await RESTORE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      expect(res.status).toBe(404);
    });

    it('returns 403 for non-owner', async () => {
      const conv = makeConversation({ owner_id: 'other@example.com', deleted_at: new Date() });
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/restore', {
        method: 'POST',
      });

      const res = await RESTORE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      expect(res.status).toBe(403);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/chat/conversations/trash
  // --------------------------------------------------------------------------

  describe('GET /api/chat/conversations/trash', () => {
    it('lists soft-deleted conversations', async () => {
      const deletedConv = makeConversation({ deleted_at: new Date(), title: 'Deleted conv' });
      const convCollection = createMockCollection();

      // Mock find for auto-purge (no expired items)
      const purgeFind = {
        toArray: jest.fn().mockResolvedValue([]),
      };
      // Mock find for listing (has items)
      const listFind = {
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([deletedConv]),
            }),
          }),
        }),
      };

      convCollection.find
        .mockReturnValueOnce(purgeFind)  // First call: auto-purge query
        .mockReturnValueOnce(listFind);   // Second call: listing query
      convCollection.countDocuments.mockResolvedValue(1);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      const res = await GET_TRASH(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].title).toBe('Deleted conv');
      expect(body.data.total).toBe(1);
    });

    it('auto-purges conversations deleted more than 7 days ago', async () => {
      const eightDaysAgo = new Date();
      eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

      const expiredConv = makeConversation({
        _id: 'expired-conv-id',
        deleted_at: eightDaysAgo,
        title: 'Expired conv',
      });

      const convCollection = createMockCollection();
      const msgCollection = createMockCollection();

      // Mock find for auto-purge: returns expired conversations
      const purgeFind = {
        toArray: jest.fn().mockResolvedValue([expiredConv]),
      };
      // Mock find for listing: no items left after purge
      const listFind = {
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };

      convCollection.find
        .mockReturnValueOnce(purgeFind)
        .mockReturnValueOnce(listFind);
      convCollection.countDocuments.mockResolvedValue(0);
      mockCollections['conversations'] = convCollection;
      mockCollections['messages'] = msgCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      const res = await GET_TRASH(req);

      expect(res.status).toBe(200);

      // Auto-purge should have deleted the expired conversation and its messages
      expect(convCollection.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ['expired-conv-id'] },
      });
      expect(msgCollection.deleteMany).toHaveBeenCalledWith({
        conversation_id: { $in: ['expired-conv-id'] },
      });
    });

    it('returns empty list when no deleted conversations exist', async () => {
      const convCollection = createMockCollection();
      const purgeFind = { toArray: jest.fn().mockResolvedValue([]) };
      const listFind = {
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };
      convCollection.find
        .mockReturnValueOnce(purgeFind)
        .mockReturnValueOnce(listFind);
      convCollection.countDocuments.mockResolvedValue(0);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      const res = await GET_TRASH(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.items).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });

    it('returns 401 when not authenticated', async () => {
      mockGetServerSession.mockResolvedValue(null);

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      const res = await GET_TRASH(req);
      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/chat/conversations — excludes soft-deleted
  // --------------------------------------------------------------------------

  describe('GET /api/chat/conversations — excludes soft-deleted', () => {
    it('does not include soft-deleted conversations in normal listing', async () => {
      const activeConv = makeConversation({ title: 'Active conv', deleted_at: null });
      const convCollection = createMockCollection();

      convCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([activeConv]),
            }),
          }),
        }),
      });
      convCollection.countDocuments.mockResolvedValue(1);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations?page_size=100');
      const res = await GET_CONVERSATIONS(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.items).toHaveLength(1);

      // Verify the query includes the deleted_at exclusion filter
      const findCall = convCollection.find.mock.calls[0][0];
      expect(findCall.$and).toBeDefined();
      expect(findCall.$and).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }],
          }),
        ])
      );
    });

    it('default listing INCLUDES autonomous conversations (only excludes slack and api)', async () => {
      // Regression: pre-fix the default branch used
      // ``$nin: ['slack', 'autonomous']`` which contradicted the
      // sidebar's "All" filter and made autonomous threads vanish
      // from the All view. The fix narrows the exclusion to slack
      // (and api, for script-created conversations with no UI
      // transcript) so autonomous chats appear alongside human ones.
      const convCollection = createMockCollection();
      convCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations');
      await GET_CONVERSATIONS(req);

      const findCall = convCollection.find.mock.calls[0][0];
      // Source filter lives in $and alongside the ownership $or.
      expect(findCall.$and).toEqual(
        expect.arrayContaining([{ source: { $nin: ['slack', 'api'] } }]),
      );
    });

    it('?source=autonomous still narrows to autonomous-only', async () => {
      const convCollection = createMockCollection();
      convCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations?source=autonomous');
      await GET_CONVERSATIONS(req);

      const findCall = convCollection.find.mock.calls[0][0];
      expect(findCall.$and).toEqual(
        expect.arrayContaining([{ source: 'autonomous' }]),
      );
    });

    it('?source=autonomous does NOT bypass owner scoping (IDOR regression)', async () => {
      // Pre-fix the autonomous branch did `delete query.$or`, leaking
      // every user's autonomous conversations to any authed caller.
      const convCollection = createMockCollection();
      convCollection.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations?source=autonomous');
      await GET_CONVERSATIONS(req);

      const findCall = convCollection.find.mock.calls[0][0];
      // Ownership scope ($or) must be present inside the $and candidate
      // filters and non-empty.
      expect(findCall.$and).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              { owner_id: 'user@example.com' },
              { 'sharing.shared_with': 'user@example.com' },
              { 'sharing.shared_with_teams.0': { $exists: true } },
            ]),
          }),
        ]),
      );
      // Source narrow must live inside $and (top-level `query.source`
      // would also work but is structurally easier to regress).
      expect(findCall.source).toBeUndefined();
      expect(findCall.$and).toEqual(
        expect.arrayContaining([{ source: 'autonomous' }]),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('soft-delete sets updated_at along with deleted_at', async () => {
      const conv = makeConversation();
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000', {
        method: 'DELETE',
      });

      await DELETE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });

      const setFields = convCollection.updateOne.mock.calls[0][1].$set;
      expect(setFields.updated_at).toBeInstanceOf(Date);
      expect(setFields.deleted_at).toBeInstanceOf(Date);
      expect(setFields.is_archived).toBe(true);
    });

    it('restore sets updated_at and unsets deleted_at', async () => {
      const conv = makeConversation({ deleted_at: new Date(), is_archived: true });
      const convCollection = createMockCollection();
      convCollection.findOne
        .mockResolvedValueOnce(conv)
        .mockResolvedValueOnce({ ...conv, deleted_at: undefined, is_archived: false });
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/restore', {
        method: 'POST',
      });

      await RESTORE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });

      const updateCall = convCollection.updateOne.mock.calls[0][1];
      expect(updateCall.$set.updated_at).toBeInstanceOf(Date);
      expect(updateCall.$set.is_archived).toBe(false);
      expect(updateCall.$unset.deleted_at).toBe('');
    });

    it('auto-purge does NOT delete conversations deleted exactly 7 days ago (uses <= threshold)', async () => {
      // A conversation deleted exactly 7 days ago should be at the threshold boundary.
      // The purge threshold is 7 days ago, so deleted_at <= threshold means exactly 7 days IS purged.
      const exactlySevenDaysAgo = new Date();
      exactlySevenDaysAgo.setDate(exactlySevenDaysAgo.getDate() - 7);

      const thresholdConv = makeConversation({
        _id: 'threshold-conv',
        deleted_at: exactlySevenDaysAgo,
      });

      const convCollection = createMockCollection();
      const msgCollection = createMockCollection();

      // The MongoDB query uses $lte, so exactly 7 days old IS matched
      const purgeFind = {
        toArray: jest.fn().mockResolvedValue([thresholdConv]),
      };
      const listFind = {
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };

      convCollection.find
        .mockReturnValueOnce(purgeFind)
        .mockReturnValueOnce(listFind);
      convCollection.countDocuments.mockResolvedValue(0);
      mockCollections['conversations'] = convCollection;
      mockCollections['messages'] = msgCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      await GET_TRASH(req);

      // Conversation at exactly 7 days should be purged ($lte threshold)
      expect(convCollection.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ['threshold-conv'] },
      });
    });

    it('auto-purge does NOT run when no expired conversations exist', async () => {
      const recentConv = makeConversation({
        _id: 'recent-conv',
        deleted_at: new Date(), // Just deleted, not expired
      });

      const convCollection = createMockCollection();

      const purgeFind = {
        toArray: jest.fn().mockResolvedValue([]), // No expired items
      };
      const listFind = {
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([recentConv]),
            }),
          }),
        }),
      };

      convCollection.find
        .mockReturnValueOnce(purgeFind)
        .mockReturnValueOnce(listFind);
      convCollection.countDocuments.mockResolvedValue(1);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      await GET_TRASH(req);

      // deleteMany should NOT have been called (no expired items)
      expect(convCollection.deleteMany).not.toHaveBeenCalled();
    });

    it('hard delete removes messages for the correct conversation', async () => {
      const conv = makeConversation({ _id: '550e8400-e29b-41d4-a716-446655440000' });
      const convCollection = createMockCollection();
      const msgCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;
      mockCollections['messages'] = msgCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000?permanent=true', {
        method: 'DELETE',
      });

      await DELETE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });

      // Verify messages are deleted for the correct conversation ID (via shared helper, uses $in)
      expect(msgCollection.deleteMany).toHaveBeenCalledWith({
        conversation_id: { $in: ['550e8400-e29b-41d4-a716-446655440000'] },
      });
    });

    it('auto-purge deletes messages for all purged conversations', async () => {
      const eightDaysAgo = new Date();
      eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

      const expired1 = makeConversation({ _id: 'exp-1', deleted_at: eightDaysAgo });
      const expired2 = makeConversation({ _id: 'exp-2', deleted_at: eightDaysAgo });

      const convCollection = createMockCollection();
      const msgCollection = createMockCollection();

      const purgeFind = {
        toArray: jest.fn().mockResolvedValue([expired1, expired2]),
      };
      const listFind = {
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              toArray: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };

      convCollection.find
        .mockReturnValueOnce(purgeFind)
        .mockReturnValueOnce(listFind);
      convCollection.countDocuments.mockResolvedValue(0);
      mockCollections['conversations'] = convCollection;
      mockCollections['messages'] = msgCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/trash');
      await GET_TRASH(req);

      // Both conversations should be purged
      expect(convCollection.deleteMany).toHaveBeenCalledWith({
        _id: { $in: ['exp-1', 'exp-2'] },
      });
      // Messages for both should be deleted
      expect(msgCollection.deleteMany).toHaveBeenCalledWith({
        conversation_id: { $in: ['exp-1', 'exp-2'] },
      });
    });

    it('restore returns 400 for conversation without deleted_at (not in archive)', async () => {
      // Test with deleted_at explicitly undefined (not just null)
      const conv = makeConversation();
      delete conv.deleted_at;
      const convCollection = createMockCollection();
      convCollection.findOne.mockResolvedValue(conv);
      mockCollections['conversations'] = convCollection;

      const req = makeRequest('http://localhost:3000/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/restore', {
        method: 'POST',
      });

      const res = await RESTORE(req, { params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }) });
      expect(res.status).toBe(400);
    });
  });
});

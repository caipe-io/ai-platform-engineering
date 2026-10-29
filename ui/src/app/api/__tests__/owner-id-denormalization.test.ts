/**
 * @jest-environment node
 */
/**
 * Tests for owner_id Denormalization on Messages
 *
 * Covers:
 * - POST /api/chat/conversations/[id]/messages — verifies owner_id is written
 *
 * Features tested:
 * - owner_id is denormalized from conversation to message document
 * - owner_id is set to conversation's owner_id (primary)
 * - owner_id falls back to current user when conversation has no owner_id
 * - owner_id is persisted in MongoDB for analytics query optimization
 * - Backward compatibility: response still works when conversation.owner_id is null
 */

import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';

// ============================================================================
// Mocks
// ============================================================================

const mockGetServerSession = jest.fn();
const mockRequireConversationResourcePermission = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
jest.mock('@/lib/chat-message-persistence', () => ({
  upsertChatMessage: async (messages, input) => {
    const filter = { message_id: input.messageId, conversation_id: input.conversationId };
    const result = await messages.updateOne(filter, { $set: input.fields, $setOnInsert: input.insert }, { upsert: true });
    return { result, message: await messages.findOne(filter) };
  },
}));

jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: '',
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

jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock('@/lib/rbac/conversation-implicit-authz', () => ({
  requireConversationResourcePermission: (...args: unknown[]) =>
    mockRequireConversationResourcePermission(...args),
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
    updateOne: jest.fn().mockResolvedValue({
      upsertedId: new ObjectId(),
      upsertedCount: 1,
      matchedCount: 1,
      modifiedCount: 0,
      acknowledged: true,
    }),
    insertOne: jest.fn().mockResolvedValue({ acknowledged: true, insertedId: new ObjectId() }),
    countDocuments: jest.fn().mockResolvedValue(0),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), options);
}

function authenticatedSession(email = 'user@example.com') {
  return {
    user: { email, name: 'Test User' },
    role: 'user',
    accessToken: 'test-access-token',
    sub: 'test-sub',
  };
}

const testConversationId = '12345678-1234-1234-1234-123456789012';

function resetMocks() {
  mockGetServerSession.mockReset();
  mockRequireConversationResourcePermission.mockReset();
  mockRequireConversationResourcePermission.mockResolvedValue(undefined);
  mockCheckOpenFgaTuple.mockReset();
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  mockGetCollection.mockClear();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
}

// ============================================================================
// Test imports (after mocks)
// ============================================================================

import { POST } from '../chat/conversations/[id]/messages/route';

// ============================================================================
// Tests: owner_id denormalization on POST
// ============================================================================

describe('POST /api/chat/conversations/[id]/messages — owner_id', () => {
  beforeEach(resetMocks);

  it('writes owner_id from conversation to message document', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const convCol = createMockCollection();
    convCol.findOne.mockResolvedValue({
      _id: testConversationId,
      owner_id: 'user@example.com',
    });
    mockCollections['conversations'] = convCol;

    const msgCol = createMockCollection();
    const upsertedId = new ObjectId();
    msgCol.updateOne.mockResolvedValue({
      upsertedId,
      upsertedCount: 1,
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
    });
    msgCol.findOne.mockResolvedValue({
      _id: upsertedId,
      message_id: 'msg-1',
      conversation_id: testConversationId,
      owner_id: 'user@example.com',
      role: 'user',
      content: 'Test message',
      created_at: new Date(),
    });
    mockCollections['messages'] = msgCol;

    const sharingCol = createMockCollection();
    mockCollections['sharing_access'] = sharingCol;

    const req = makeRequest(`/api/chat/conversations/${testConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'msg-1',
        role: 'user',
        content: 'Test message',
        metadata: { turn_id: 'turn-1' },
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: testConversationId }) });
    expect(res.status).toBe(201);
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'test-sub',
        user: expect.objectContaining({ email: 'user@example.com' }),
      }),
      'user@example.com',
      expect.objectContaining({ _id: testConversationId, owner_id: 'user@example.com' }),
      'write'
    );

    // Verify $setOnInsert includes owner_id (upsert-based API)
    const updateDoc = msgCol.updateOne.mock.calls[0][1];
    expect(updateDoc.$setOnInsert.owner_id).toBe('user@example.com');
  });

  it('does not write message rows when conversation write access is denied', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    mockRequireConversationResourcePermission.mockRejectedValue(
      Object.assign(new Error('conversation denied'), {
        statusCode: 403,
        code: 'conversation#write',
      })
    );

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const convCol = createMockCollection();
    convCol.findOne.mockResolvedValue({
      _id: testConversationId,
      owner_id: 'user@example.com',
      owner_subject: 'test-sub',
    });
    mockCollections['conversations'] = convCol;

    const msgCol = createMockCollection();
    mockCollections['messages'] = msgCol;

    const req = makeRequest(`/api/chat/conversations/${testConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'msg-denied',
        role: 'user',
        content: 'Test message',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: testConversationId }) });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      error: 'conversation denied',
      code: 'conversation#write',
    });
    expect(msgCol.updateOne).not.toHaveBeenCalled();
  });

  it('denormalizes conversation owner even when different from requester', async () => {
    // Scenario: shared user (bob) posts to alice's conversation
    mockGetServerSession.mockResolvedValue(authenticatedSession('bob@example.com'));

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    // Conversation belongs to alice
    const convCol = createMockCollection();
    convCol.findOne.mockResolvedValue({
      _id: testConversationId,
      owner_id: 'alice@example.com',
      sharing: { shared_with: [{ email: 'bob@example.com' }] },
    });
    mockCollections['conversations'] = convCol;

    // Sharing access allows bob
    const sharingCol = createMockCollection();
    sharingCol.findOne.mockResolvedValue({
      conversation_id: testConversationId,
      email: 'bob@example.com',
    });
    mockCollections['sharing_access'] = sharingCol;

    const msgCol = createMockCollection();
    const upsertedId = new ObjectId();
    msgCol.updateOne.mockResolvedValue({
      upsertedId,
      upsertedCount: 1,
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
    });
    msgCol.findOne.mockResolvedValue({
      _id: upsertedId,
      owner_id: 'alice@example.com',
      role: 'user',
      content: 'Message from shared user',
    });
    mockCollections['messages'] = msgCol;

    const req = makeRequest(`/api/chat/conversations/${testConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        role: 'user',
        content: 'Message from shared user',
        metadata: { turn_id: 'turn-1' },
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: testConversationId }) });
    expect(res.status).toBe(201);

    // owner_id should be alice (conversation owner), not bob (requester)
    const updateDoc = msgCol.updateOne.mock.calls[0][1];
    expect(updateDoc.$setOnInsert.owner_id).toBe('alice@example.com');
  });

  it('falls back to current user email when conversation has no owner_id', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession('carol@example.com'));

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    // Legacy conversation without owner_id — access granted via sharing_access.
    // requireConversationAccess is called first, then the route calls
    // conversations.findOne again to read owner_id. Both calls go through
    // the same mock collection, so findOne must return the legacy doc for both.
    const convCol = createMockCollection();
    convCol.findOne.mockResolvedValue({
      _id: testConversationId,
      // owner_id is absent (legacy data)
    });
    mockCollections['conversations'] = convCol;

    // Grant access via sharing_access since owner_id doesn't match
    const sharingCol = createMockCollection();
    sharingCol.findOne.mockResolvedValue({
      conversation_id: testConversationId,
      granted_to: 'carol@example.com',
      revoked_at: null,
    });
    mockCollections['sharing_access'] = sharingCol;

    const msgCol = createMockCollection();
    const upsertedId = new ObjectId();
    msgCol.updateOne.mockResolvedValue({
      upsertedId,
      upsertedCount: 1,
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
    });
    msgCol.findOne.mockResolvedValue({
      _id: upsertedId,
      owner_id: 'carol@example.com',
      role: 'user',
      content: 'Legacy conversation message',
    });
    mockCollections['messages'] = msgCol;

    const req = makeRequest(`/api/chat/conversations/${testConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        role: 'user',
        content: 'Legacy conversation message',
        metadata: { turn_id: 'turn-1' },
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: testConversationId }) });
    expect(res.status).toBe(201);

    // Fallback: owner_id = current user (conversation.owner_id is undefined)
    const updateDoc = msgCol.updateOne.mock.calls[0][1];
    expect(updateDoc.$setOnInsert.owner_id).toBe('carol@example.com');
  });

  it('persists owner_id on assistant messages too', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const convCol = createMockCollection();
    convCol.findOne.mockResolvedValue({
      _id: testConversationId,
      owner_id: 'user@example.com',
    });
    mockCollections['conversations'] = convCol;

    const sharingCol = createMockCollection();
    mockCollections['sharing_access'] = sharingCol;

    const msgCol = createMockCollection();
    const upsertedId = new ObjectId();
    msgCol.updateOne.mockResolvedValue({
      upsertedId,
      upsertedCount: 1,
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
    });
    msgCol.findOne.mockResolvedValue({
      _id: upsertedId,
      owner_id: 'user@example.com',
      role: 'assistant',
      content: 'Here is your answer.',
    });
    mockCollections['messages'] = msgCol;

    const req = makeRequest(`/api/chat/conversations/${testConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'assistant-msg-1',
        role: 'assistant',
        content: 'Here is your answer.',
        metadata: {
          turn_id: 'turn-1',
          is_final: true,
          agent_name: 'argocd',
          latency_ms: 1200,
        },
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: testConversationId }) });
    expect(res.status).toBe(201);

    const updateDoc = msgCol.updateOne.mock.calls[0][1];
    expect(updateDoc.$setOnInsert.owner_id).toBe('user@example.com');
    expect(updateDoc.$setOnInsert.role).toBe('assistant');
    expect(updateDoc.$set.metadata.agent_name).toBe('argocd');
    expect(updateDoc.$set.metadata.latency_ms).toBe(1200);
  });

  it('persists metadata fields alongside owner_id correctly', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const convCol = createMockCollection();
    convCol.findOne.mockResolvedValue({
      _id: testConversationId,
      owner_id: 'user@example.com',
    });
    mockCollections['conversations'] = convCol;

    const sharingCol = createMockCollection();
    mockCollections['sharing_access'] = sharingCol;

    const msgCol = createMockCollection();
    const upsertedId = new ObjectId();
    msgCol.updateOne.mockResolvedValue({
      upsertedId,
      upsertedCount: 1,
      matchedCount: 0,
      modifiedCount: 0,
      acknowledged: true,
    });
    msgCol.findOne.mockResolvedValue({
      _id: upsertedId,
      owner_id: 'user@example.com',
      role: 'assistant',
      content: 'Result',
    });
    mockCollections['messages'] = msgCol;

    const req = makeRequest(`/api/chat/conversations/${testConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'msg-meta-test',
        role: 'assistant',
        content: 'Result',
        metadata: {
          turn_id: 'turn-meta',
          is_final: true,
          model: 'gpt-4o',
          latency_ms: 800,
          agent_name: 'aws',
        },
        stream_events: [
          { id: 'e1', type: 'tool_start', toolName: 'cost_explorer' },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: testConversationId }) });
    expect(res.status).toBe(201);

    const updateDoc = msgCol.updateOne.mock.calls[0][1];
    expect(updateDoc.$setOnInsert.owner_id).toBe('user@example.com');
    expect(updateDoc.$set.metadata.latency_ms).toBe(800);
    expect(updateDoc.$set.metadata.agent_name).toBe('aws');
    expect(updateDoc.$set.metadata.is_final).toBe(true);
    expect(updateDoc.$set.stream_events).toHaveLength(1);
  });
});

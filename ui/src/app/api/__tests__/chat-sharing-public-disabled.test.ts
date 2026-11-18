/**
 * @jest-environment node
 */

import { ObjectId } from 'mongodb';
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

jest.mock('uuid', () => ({
  v4: () => '550e8400-e29b-41d4-a716-446655440000',
}));

jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: false }),
  writeOpenFgaTuples: jest.fn().mockResolvedValue({ writes: 0, deletes: 0 }),
}));

jest.mock('@/lib/rbac/resource-authz', () => ({
  filterResourcesByPermission: jest.fn(async (_session, resources: unknown[]) => resources),
  requireResourcePermission: jest.fn(async () => undefined),
}));

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

function createMockCollection() {
  const findReturnValue = {
    project: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    }),
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
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 0 }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), options);
}

function userSession(email = 'user@example.com') {
  return {
    user: { email, name: 'Test User' },
    role: 'user',
    sub: `sub-${email}`,
  };
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const OWNER_EMAIL = 'owner@example.com';
const STRANGER_EMAIL = 'stranger@example.com';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: VALID_UUID,
    title: 'Test Conversation',
    owner_id: OWNER_EMAIL,
    created_at: new Date(),
    updated_at: new Date(),
    metadata: { client_type: 'ui', ui_version: '0.2.0', total_messages: 0 },
    sharing: {
      is_public: false,
      shared_with: [],
      shared_with_teams: [],
      share_link_enabled: false,
    },
    tags: [],
    is_archived: false,
    is_pinned: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
});

describe('disabled public conversation sharing', () => {
  it('does not grant conversation access from legacy is_public=true', async () => {
    const { requireConversationAccess } = await import('@/lib/api-middleware');
    const conv = makeConversation({
      sharing: { is_public: true, shared_with: [], shared_with_teams: [] },
    });
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections.conversations = convsCol;
    mockCollections.sharing_access = createMockCollection();

    await expect(
      requireConversationAccess(conv._id, STRANGER_EMAIL, mockGetCollection),
    ).rejects.toThrow('You do not have access to this conversation.');
  });

  it('rejects attempts to enable sharing with everyone', async () => {
    mockGetServerSession.mockResolvedValue(userSession(OWNER_EMAIL));
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(makeConversation());
    mockCollections.conversations = convsCol;

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');
    const response = await POST(
      makeRequest(`/api/chat/conversations/${VALID_UUID}/share`, {
        method: 'POST',
        body: JSON.stringify({ is_public: true }),
      }),
      { params: Promise.resolve({ id: VALID_UUID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('PUBLIC_CONVERSATION_SHARING_DISABLED');
    expect(convsCol.updateOne).not.toHaveBeenCalled();
  });

  it('rejects public permissions even when direct recipients are provided', async () => {
    mockGetServerSession.mockResolvedValue(userSession(OWNER_EMAIL));
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(makeConversation());
    mockCollections.conversations = convsCol;

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');
    const response = await POST(
      makeRequest(`/api/chat/conversations/${VALID_UUID}/share`, {
        method: 'POST',
        body: JSON.stringify({
          user_emails: ['viewer@example.com'],
          permission: 'view',
          public_permission: 'view',
        }),
      }),
      { params: Promise.resolve({ id: VALID_UUID }) },
    );

    expect(response.status).toBe(400);
    expect(convsCol.updateOne).not.toHaveBeenCalled();
  });

  it('allows clearing legacy public state with is_public=false', async () => {
    mockGetServerSession.mockResolvedValue(userSession(OWNER_EMAIL));
    const conv = makeConversation({
      sharing: { ...makeConversation().sharing, is_public: true },
    });
    const convsCol = createMockCollection();
    convsCol.findOne
      .mockResolvedValueOnce(conv)
      .mockResolvedValueOnce({ ...conv, sharing: { ...conv.sharing, is_public: false } });
    mockCollections.conversations = convsCol;

    const { POST } = await import('@/app/api/chat/conversations/[id]/share/route');
    const response = await POST(
      makeRequest(`/api/chat/conversations/${VALID_UUID}/share`, {
        method: 'POST',
        body: JSON.stringify({ is_public: false }),
      }),
      { params: Promise.resolve({ id: VALID_UUID }) },
    );

    expect(response.status).toBe(200);
    expect(convsCol.updateOne).toHaveBeenCalledWith(
      { _id: VALID_UUID },
      { $set: { 'sharing.is_public': false } },
    );
  });
});

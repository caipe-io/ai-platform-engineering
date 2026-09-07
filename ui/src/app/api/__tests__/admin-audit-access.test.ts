/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';

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
  if (!mockCollections[name]) mockCollections[name] = createMockCollection();
  return Promise.resolve(mockCollections[name]);
});
jest.mock('@/lib/mongodb', () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

// 098-enterprise-rbac introduced an OpenFGA PDP gate on the chat read
// route via `requireConversationResourcePermission`. Mock it so admin
// auditors can access non-owned conversations without a live OpenFGA.
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock('@/lib/rbac/resource-authz', () => ({
  requireResourcePermission: jest.fn().mockResolvedValue(undefined),
  filterResourcesByPermission: jest.fn(async (_session, resources: unknown[]) => resources),
}));

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

function createMockCollection() {
  const findReturnValue = {
    project: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    sort: jest.fn().mockReturnValue({
      skip: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    skip: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    }),
    limit: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([]),
    }),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    find: jest.fn().mockReturnValue(findReturnValue),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 0 }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

const CONV_ID = 'conv-123';
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((k) => delete mockCollections[k]);
});

describe('requireConversationAccess — admin audit', () => {
  let requireConversationAccess: unknown;
  let ApiError: unknown;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('@/lib/api-middleware');
    requireConversationAccess = mod.requireConversationAccess;
    ApiError = mod.ApiError;
  });

  it('returns access_level owner when user is the conversation owner', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'owner@example.com',
      mockGetCollection
    );

    expect(result.access_level).toBe('owner');
    expect(result.conversation).toEqual(conv);
  });

  it('returns access_level owner for case-insensitive owner email matches', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'Owner@Example.com',
      title: 'Test',
      sharing: { shared_with: ['owner@example.com'], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue({ permission: 'view' });
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'owner@example.com',
      mockGetCollection
    );

    expect(result.access_level).toBe('owner');
    expect(sharingAccessCol.findOne).not.toHaveBeenCalled();
  });

  it('returns access_level owner when owner_subject matches the session subject', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'legacy-owner@example.com',
      owner_subject: 'owner-subject',
      title: 'Test',
      sharing: { shared_with: ['viewer@example.com'], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue({ permission: 'view' });
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'viewer@example.com',
      mockGetCollection,
      { sub: 'owner-subject' }
    );

    expect(result.access_level).toBe('owner');
    expect(sharingAccessCol.findOne).not.toHaveBeenCalled();
  });

  it('returns access_level shared when user is in shared_with', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: ['shared@example.com'], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'shared@example.com',
      mockGetCollection
    );

    expect(result.access_level).toBe('shared');
    expect(result.conversation).toEqual(conv);
  });

  it('returns access_level admin_audit when admin session is provided and user is not owner/shared', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'admin@example.com',
      mockGetCollection,
      { role: 'admin' }
    );

    expect(result.access_level).toBe('admin_audit');
    expect(result.conversation).toEqual(conv);
  });

  it('returns access_level admin_audit when canViewAdmin=true session is provided', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'auditor@example.com',
      mockGetCollection,
      { role: 'user', canViewAdmin: true }
    );

    expect(result.access_level).toBe('admin_audit');
    expect(result.conversation).toEqual(conv);
  });

  it('throws 403 when non-admin non-shared non-owner user without session', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const err = requireConversationAccess(CONV_ID, 'other@example.com', mockGetCollection);
    await expect(err).rejects.toThrow(ApiError);
    await expect(err).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws 403 when non-admin user with session (role=user)', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const err = requireConversationAccess(CONV_ID, 'other@example.com', mockGetCollection, {
      role: 'user',
    });
    await expect(err).rejects.toThrow(ApiError);
    await expect(err).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws 404 when conversation not found', async () => {
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(null);
    mockCollections['conversations'] = convsCol;

    const err = requireConversationAccess(
      'non-existent',
      'owner@example.com',
      mockGetCollection
    );
    await expect(err).rejects.toThrow(ApiError);
    await expect(err).rejects.toMatchObject({
      statusCode: 404,
      message: 'Conversation not found',
    });
  });

  it('returns { conversation, access_level } instead of raw conversation', async () => {
    const conv = {
      _id: CONV_ID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const result = await requireConversationAccess(
      CONV_ID,
      'owner@example.com',
      mockGetCollection
    );

    expect(result).toHaveProperty('conversation');
    expect(result).toHaveProperty('access_level');
    expect(result.conversation).toEqual(conv);
    expect(result.access_level).toBe('owner');
  });
});

describe('GET /api/chat/conversations/[id] — access_level in response', () => {
  let GET: unknown;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('@/app/api/chat/conversations/[id]/route');
    GET = mod.GET;
  });

  it('returns access_level owner when user is the owner', async () => {
    const conv = {
      _id: VALID_UUID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    mockGetServerSession.mockResolvedValue({
      user: { email: 'owner@example.com', name: 'Owner' },
      role: 'user',
    });

    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const req = makeRequest(`/api/chat/conversations/${VALID_UUID}`);
    const res = await GET(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.access_level).toBe('owner');
    expect(body.data._id).toBe(VALID_UUID);
  });

  it('returns access_level admin_audit when admin accesses another user conversation', async () => {
    const conv = {
      _id: VALID_UUID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    mockGetServerSession.mockResolvedValue({
      user: { email: 'admin@example.com', name: 'Admin' },
      role: 'admin',
      // 098-enterprise-rbac: OpenFGA gates require a stable subject id.
      sub: 'admin-sub',
    });

    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const req = makeRequest(`/api/chat/conversations/${VALID_UUID}`);
    const res = await GET(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.access_level).toBe('admin_audit');
    expect(body.data.owner_id).toBe('owner@example.com');
  });

  it('non-admin non-owner user gets 403', async () => {
    const conv = {
      _id: VALID_UUID,
      owner_id: 'owner@example.com',
      title: 'Test',
      sharing: { shared_with: [], shared_with_teams: [] },
    };
    mockGetServerSession.mockResolvedValue({
      user: { email: 'other@example.com', name: 'Other' },
      role: 'user',
    });

    const convsCol = createMockCollection();
    convsCol.findOne.mockResolvedValue(conv);
    mockCollections['conversations'] = convsCol;

    const sharingAccessCol = createMockCollection();
    sharingAccessCol.findOne.mockResolvedValue(null);
    mockCollections['sharing_access'] = sharingAccessCol;

    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;

    const req = makeRequest(`/api/chat/conversations/${VALID_UUID}`);
    const res = await GET(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('You do not have access to this conversation.');
  });
});

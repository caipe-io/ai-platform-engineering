/**
 * @jest-environment node
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

jest.mock('@/lib/authz', () => ({
  authorize: jest.fn().mockResolvedValue({ decision: 'DENY' }),
  authorizeMany: jest.fn().mockResolvedValue(new Map()),
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

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

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
  };
}

function resetMocks() {
  mockGetServerSession.mockReset();
  authorizeMany.mockReset();
  authorizeMany.mockResolvedValue(new Map());
  mockGetCollection.mockClear();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
}

import { GET } from '../chat/conversations/route';

const { authorizeMany } = jest.requireMock('@/lib/authz') as {
  authorizeMany: jest.Mock;
};

describe('GET /api/chat/conversations — client_type filtering', () => {
  beforeEach(resetMocks);

  it('treats legacy conversations without client_type as webui when filtering for webui', async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const conversationsCol = createMockCollection();
    conversationsCol.countDocuments.mockResolvedValue(2);
    conversationsCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([
              {
                _id: 'legacy-webui-conv',
                title: 'Legacy conversation',
                owner_id: 'user@example.com',
                created_at: new Date(),
                updated_at: new Date(),
                metadata: { total_messages: 0 },
                sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false },
                tags: [],
                is_archived: false,
                is_pinned: false,
              },
              {
                _id: 'explicit-webui-conv',
                title: 'Explicit webui conversation',
                client_type: 'webui',
                owner_id: 'user@example.com',
                created_at: new Date(),
                updated_at: new Date(),
                metadata: { total_messages: 0 },
                sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false },
                tags: [],
                is_archived: false,
                is_pinned: false,
              },
            ]),
          }),
        }),
      }),
    });
    mockCollections['conversations'] = conversationsCol;

    const teamsCol = createMockCollection();
    teamsCol.find.mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    mockCollections['teams'] = teamsCol;

    const req = makeRequest('/api/chat/conversations?client_type=webui&page_size=100');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(conversationsCol.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: [{ client_type: 'webui' }, { client_type: { $exists: false } }],
          }),
        ]),
      }),
    );

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(2);
  });

  it('returns 400 for an unsupported client_type value', async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const req = makeRequest('/api/chat/conversations?client_type=desktop');
    const res = await GET(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Invalid client_type'),
    });
  });

  it('marks shared recipient rows in the conversations list response', async () => {
    mockGetServerSession.mockResolvedValue({
      ...userSession('viewer@example.com'),
      sub: 'viewer-sub',
    });
    authorizeMany.mockResolvedValue(new Map([
      ['shared-recipient-conv', { decision: 'ALLOW' }],
    ]));

    const conversationsCol = createMockCollection();
    conversationsCol.countDocuments.mockResolvedValue(2);
    conversationsCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([
              {
                _id: 'owned-conv',
                title: 'Owned conversation',
                owner_id: 'viewer@example.com',
                created_at: new Date(),
                updated_at: new Date(),
                metadata: { total_messages: 0 },
                sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false },
                tags: [],
                is_archived: false,
                is_pinned: false,
              },
              {
                _id: 'shared-recipient-conv',
                title: 'Shared recipient conversation',
                owner_id: 'owner@example.com',
                created_at: new Date(),
                updated_at: new Date(),
                metadata: { total_messages: 0 },
                sharing: {
                  is_public: false,
                  shared_with: ['viewer@example.com'],
                  shared_with_teams: [],
                  share_link_enabled: false,
                },
                tags: [],
                is_archived: false,
                is_pinned: false,
              },
            ]),
          }),
        }),
      }),
    });
    mockCollections['conversations'] = conversationsCol;

    const req = makeRequest('/api/chat/conversations?page_size=100');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _id: 'owned-conv',
        viewer_has_shared_access: false,
      }),
      expect.objectContaining({
        _id: 'shared-recipient-conv',
        viewer_has_shared_access: true,
      }),
    ]));
  });

  it('excludes api-origin conversations from the default listing', async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const conversationsCol = createMockCollection();
    mockCollections['conversations'] = conversationsCol;

    const req = makeRequest('/api/chat/conversations?page_size=100');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(conversationsCol.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({ source: { $nin: ['slack', 'api'] } }),
        ]),
      }),
    );
  });

  it('excludes webex conversations from the default listing', async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const conversationsCol = createMockCollection();
    mockCollections['conversations'] = conversationsCol;

    const req = makeRequest('/api/chat/conversations?page_size=100');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(conversationsCol.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({ client_type: { $nin: ['slack', 'webex'] } }),
        ]),
      }),
    );
  });

  it('does not exclude webex when explicitly filtering for client_type=webex', async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const conversationsCol = createMockCollection();
    mockCollections['conversations'] = conversationsCol;

    const req = makeRequest('/api/chat/conversations?client_type=webex&page_size=100');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const calledQuery = conversationsCol.countDocuments.mock.calls[0][0];
    expect(calledQuery.$and).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_type: { $nin: ['slack', 'webex'] } }),
      ]),
    );
    expect(calledQuery.$and).toEqual(
      expect.arrayContaining([{ client_type: 'webex' }]),
    );
  });

  it('enriches conversation agent participants with display names', async () => {
    mockGetServerSession.mockResolvedValue(userSession());

    const conversationsCol = createMockCollection();
    conversationsCol.countDocuments.mockResolvedValue(1);
    conversationsCol.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockResolvedValue([
              {
                _id: 'agent-conv',
                title: 'Agent conversation',
                client_type: 'webui',
                owner_id: 'user@example.com',
                participants: [
                  { type: 'user', id: 'user@example.com' },
                  { type: 'agent', id: 'agent-123' },
                ],
                created_at: new Date(),
                updated_at: new Date(),
                metadata: { total_messages: 0 },
                sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false },
                tags: [],
                is_archived: false,
                is_pinned: false,
              },
            ]),
          }),
        }),
      }),
    });
    mockCollections['conversations'] = conversationsCol;

    const teamsCol = createMockCollection();
    teamsCol.find.mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    });
    mockCollections['teams'] = teamsCol;

    const agentsCol = createMockCollection();
    agentsCol.find.mockReturnValue({
      project: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([{ _id: 'agent-123', name: 'Incident Commander' }]),
      }),
    });
    mockCollections['dynamic_agents'] = agentsCol;

    const req = makeRequest('/api/chat/conversations?client_type=webui&page_size=100');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(agentsCol.find).toHaveBeenCalledWith({ _id: { $in: ['agent-123'] } });
    expect(body.data.items[0]).toMatchObject({
      agent_id: 'agent-123',
      agent_name: 'Incident Commander',
    });
  });
});

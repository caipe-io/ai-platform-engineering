/**
 * @jest-environment node
 */
/**
 * Verifies that the autonomous proxy injects X-Authenticated-User-Email
 * and X-Authenticated-User-Is-Admin headers when forwarding requests to
 * the autonomous-agents service.
 *
 * After the per-user-ownership migration (plan section 4.1) the proxy
 * injects these headers on EVERY method (not just GET), so the backend
 * `_assert_task_access` has the identity it needs to apply per-task
 * ownership checks for write paths too.
 */

jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));

jest.mock('@/lib/auth-config', () => ({ authOptions: {} }));

// Feature on, admin-only gate OFF: this suite verifies header forwarding for
// ordinary (non-admin) callers. The admin-only gate has its own coverage in
// route.test.ts, so keep it disabled here or every non-admin request 403s
// before any header is forwarded.
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn((key: string) =>
    key === 'autonomousAgentsAdminOnly' ? false : true,
  ),
  getServerConfig: jest.fn().mockReturnValue({ autonomousAgentsEnabled: true }),
}));

const mockCheckOpenFgaTuple = jest.fn();
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));
jest.mock('@/lib/rbac/organization', () => ({
  organizationObjectId: () => 'organization:caipe',
}));

// Default Mongo mock: getCollection resolves to a collection whose findOne
// returns null. Individual tests can override this via
// `(getCollection as jest.Mock).mockResolvedValueOnce(...)` to simulate a
// MongoDB-promoted admin (`metadata.role === 'admin'`).
// The collection is built lazily inside an async getCollection so the
// factory never dereferences `mockUsersFindOne` at registration time (which
// upstream's eager api-middleware import would otherwise hit before the const
// initialises -- a TDZ error). The `mock` prefix is required by jest's
// out-of-scope rule for factory references.
const mockUsersFindOne = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/mongodb', () => ({
  getCollection: jest.fn(async () => ({ findOne: mockUsersFindOne })),
  isMongoDBConfigured: false,
}));

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { NextRequest } from 'next/server';
import { GET, POST, PUT, PATCH, DELETE } from '../[...path]/route';
import { getCollection as mockedGetCollection } from '@/lib/mongodb';

const mockGetServerSession = jest.requireMock<{ getServerSession: jest.Mock }>('next-auth').getServerSession;

function makeRequest(method: string, path: string, body?: unknown): NextRequest {
  const url = new URL(`http://localhost:3000/api/autonomous/${path}`);
  const init: RequestInit & { duplex?: string } = { method };
  if (body !== undefined) {
    const serialized = JSON.stringify(body);
    init.headers = {
      'Content-Type': 'application/json',
      'content-length': Buffer.byteLength(serialized).toString(),
    };
    init.body = serialized;
    init.duplex = 'half';
  }
  return new NextRequest(url, init as RequestInit);
}

function paramsFor(path: string) {
  return { params: Promise.resolve({ path: path.split('/') }) };
}

describe('Autonomous proxy header injection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsersFindOne.mockReset();
    mockUsersFindOne.mockResolvedValue(null);
    mockGetServerSession.mockResolvedValue({
      user: { email: 'alice@example.com', name: 'Alice' },
      sub: 'alice-sub',
      role: 'admin',
      canViewAdmin: true,
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('injects X-Authenticated-User-Email on GET /tasks', async () => {
    const req = makeRequest('GET', 'tasks');
    await GET(req, paramsFor('tasks'));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['X-Authenticated-User-Email']).toBe('alice@example.com');
  });

  it('injects X-Authenticated-User-Is-Admin=true when session role is admin', async () => {
    const req = makeRequest('GET', 'tasks');
    await GET(req, paramsFor('tasks'));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['X-Authenticated-User-Is-Admin']).toBe('true');
  });

  it('injects X-Authenticated-User-Is-Admin=false for non-admin sessions', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'bob@example.com', name: 'Bob' },
      sub: 'bob-sub',
      role: 'user',
      canViewAdmin: true,
    });

    const req = makeRequest('GET', 'tasks');
    await GET(req, paramsFor('tasks'));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['X-Authenticated-User-Email']).toBe('bob@example.com');
    expect(fetchInit.headers['X-Authenticated-User-Is-Admin']).toBe('false');
  });

  it('injects X-Authenticated-User-Sub when the session carries a sub', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'alice@example.com', name: 'Alice' },
      role: 'user',
      sub: 'alice-uuid',
      canViewAdmin: false,
    });

    const req = makeRequest('POST', 'tasks', { id: 'x', name: 'X' });
    await POST(req, paramsFor('tasks'));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['X-Authenticated-User-Sub']).toBe('alice-uuid');
  });

  it('rejects the request when the session has no resolvable sub', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'bob@example.com', name: 'Bob' },
      role: 'user',
      canViewAdmin: false,
    });

    const req = makeRequest('POST', 'tasks', { id: 'x', name: 'X' });
    const response = await POST(req, paramsFor('tasks'));

    expect(response.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe.each([
    { name: 'POST', handler: POST, body: { id: 'x', name: 'X' } },
    { name: 'PUT', handler: PUT, body: { id: 'x', name: 'X' } },
    { name: 'PATCH', handler: PATCH, body: { enabled: false } },
    { name: 'DELETE', handler: DELETE, body: undefined },
  ])('$name', ({ name, handler, body }) => {
    it(`injects X-Authenticated-User-* on ${name} (non-admin)`, async () => {
      mockGetServerSession.mockResolvedValue({
        user: { email: 'carol@example.com', name: 'Carol' },
        sub: 'carol-sub',
        role: 'user',
        canViewAdmin: false,
      });

      const req = makeRequest(name, 'tasks/x', body);
      await handler(req, paramsFor('tasks/x'));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Authenticated-User-Email']).toBe('carol@example.com');
      expect(fetchInit.headers['X-Authenticated-User-Is-Admin']).toBe('false');
    });

    it(`injects X-Authenticated-User-Is-Admin=true on ${name} (admin)`, async () => {
      const req = makeRequest(name, 'tasks/x', body);
      await handler(req, paramsFor('tasks/x'));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Authenticated-User-Is-Admin']).toBe('true');
    });
  });

  // Plan section 10: regression case for MongoDB-promoted admins. In this
  // codebase, MongoDB role-promotion happens via the NextAuth jwt/session
  // callback (which feeds session.role) — the proxy itself reads
  // session.role from the post-promotion session, so a "Mongo-promoted"
  // admin reaches the proxy with session.role === 'admin'. We assert the
  // proxy forwards X-Authenticated-User-Is-Admin=true even when the OIDC
  // view-group claim (canViewAdmin) is missing, which is the situation a
  // Mongo-only admin escalation produces.
  it('forwards X-Authenticated-User-Is-Admin=true for Mongo-promoted admin (canViewAdmin=false)', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'mongo-admin@example.com', name: 'Mongo Admin' },
      sub: 'mongo-admin-sub',
      role: 'admin',
      canViewAdmin: false,
    });
    // Simulate the Mongo lookup that promoted the user: users collection
    // returns metadata.role === 'admin'. We override the default null mock
    // so it does NOT mask the in-session promotion.
    (mockedGetCollection as jest.Mock).mockResolvedValueOnce({
      findOne: jest.fn().mockResolvedValue({ metadata: { role: 'admin' } }),
    });

    const req = makeRequest('POST', 'tasks', { id: 'x', name: 'X' });
    await POST(req, paramsFor('tasks'));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers['X-Authenticated-User-Email']).toBe('mongo-admin@example.com');
    expect(fetchInit.headers['X-Authenticated-User-Is-Admin']).toBe('true');
  });
});

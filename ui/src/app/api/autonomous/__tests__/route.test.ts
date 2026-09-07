/**
 * @jest-environment node
 */
// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the /api/autonomous/[...path] proxy under the per-user
 * ownership model (plan section 4.1).
 *
 * The proxy gates on user-level Autonomous team entitlement, then the
 * autonomous-agents FastAPI service decides per-task ownership using the injected
 * `X-Authenticated-User-Email` / `X-Authenticated-User-Is-Admin` headers.
 *
 * What we assert here:
 *  - No session  -> 401, no upstream call (auth still enforced).
 *  - Feature flag off -> 404, no upstream call (deployment gate).
 *  - Authenticated non-admin / admin on every verb -> request is forwarded,
 *    backend decides on ownership.
 *  - Manual trigger (`POST /tasks/{id}/run`) is forwarded for every
 *    authenticated user (the backend's `_assert_task_access` is now
 *    the load-bearing 403 path, not the proxy).
 */

import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
const mockGetServerSession = jest.requireMock<{ getServerSession: jest.Mock }>(
  'next-auth',
).getServerSession;

jest.mock('@/lib/auth-config', () => ({ authOptions: {} }));

// MongoDB fallback inside `getAuthenticatedUser` -- not relevant for the proxy,
// but the helper still runs through `withAuth`, so we keep the mock null.
jest.mock('@/lib/mongodb', () => ({
  getCollection: jest.fn().mockResolvedValue({
    findOne: jest.fn().mockResolvedValue(null),
  }),
}));

// `getConfig('ssoEnabled')` controls the anonymous fallback inside
// `withAuth`. Force SSO=on so missing sessions reliably 401, mirroring
// production.
let mockAutonomousAgentsEnabled = true;
jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => {
    if (key === 'ssoEnabled') return true;
    if (key === 'autonomousAgentsEnabled') return mockAutonomousAgentsEnabled;
    return undefined;
  },
}));

const mockCheckOpenFgaTuple = jest.fn();
jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));
jest.mock('@/lib/rbac/organization', () => ({
  organizationObjectId: () => 'organization:caipe',
}));

// Upstream HTTP client -- the proxy uses global `fetch`. We replace it
// per-test so we can assert it was (or was not) called.
const mockFetch = jest.fn();
beforeAll(() => {
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});

// Quiet expected error logs from the proxy's catch path.
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import {
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
} from '../[...path]/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): NextRequest {
  const url = new URL(`/api/autonomous/${path}`, 'http://localhost:3000');
  const init: RequestInit & { duplex?: string } = { method };
  if (body !== undefined) {
    const serializedBody = JSON.stringify(body);
    init.headers = {
      'Content-Type': 'application/json',
      'content-length': Buffer.byteLength(serializedBody).toString(),
    };
    init.body = serializedBody;
    init.duplex = 'half';
  }
  return new NextRequest(url, init as RequestInit);
}

function paramsFor(path: string) {
  return { params: Promise.resolve({ path: path.split('/') }) };
}

function adminSession() {
  return {
    user: { email: 'admin@example.com', name: 'Admin' },
    sub: 'admin-sub',
    role: 'admin',
    canViewAdmin: true,
  };
}

function plainUserSession() {
  return {
    user: { email: 'user@example.com', name: 'User' },
    sub: 'user-sub',
    role: 'user',
    canViewAdmin: false,
  };
}

function okJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAutonomousAgentsEnabled = true;
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
});

// ---------------------------------------------------------------------------
// Feature flag / anonymous guards (kept verbatim)
// ---------------------------------------------------------------------------

describe('GET /api/autonomous/[...path] — deployment + auth guards', () => {
  it('404 when the autonomous agents feature flag is disabled', async () => {
    mockAutonomousAgentsEnabled = false;
    mockGetServerSession.mockResolvedValue(adminSession());
    const res = await GET(makeRequest('GET', 'tasks'), paramsFor('tasks'));
    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('401 when there is no session', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest('GET', 'tasks'), paramsFor('tasks'));
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('403 when the caller belongs to no Autonomous-enabled team', async () => {
    mockGetServerSession.mockResolvedValue(plainUserSession());
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    const res = await GET(makeRequest('GET', 'tasks'), paramsFor('tasks'));

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-user model: every authenticated user is forwarded; backend decides.
// ---------------------------------------------------------------------------

describe.each([
  { name: 'GET', handler: GET, body: undefined },
  { name: 'POST', handler: POST, body: { id: 'x', name: 'X' } },
  { name: 'PUT', handler: PUT, body: { id: 'x', name: 'X' } },
  { name: 'PATCH', handler: PATCH, body: { enabled: false } },
  { name: 'DELETE', handler: DELETE, body: undefined },
])('$name /api/autonomous/[...path] — per-user forwarding', ({ name, handler, body }) => {
  it('401 when there is no session', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await handler(
      makeRequest(name, 'tasks/x', body),
      paramsFor('tasks/x'),
    );
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards authenticated non-admin requests upstream (backend decides ownership)', async () => {
    mockGetServerSession.mockResolvedValue(plainUserSession());
    mockFetch.mockResolvedValue(okJsonResponse({ ok: true }));

    const res = await handler(
      makeRequest(name, 'tasks/x', body),
      paramsFor('tasks/x'),
    );

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/tasks/x');
    expect(options.method).toBe(name);
    const headers = options.headers as Record<string, string>;
    expect(headers['X-Authenticated-User-Email']).toBe('user@example.com');
    expect(headers['X-Authenticated-User-Is-Admin']).toBe('false');
  });

  it('forwards admin requests upstream with X-Authenticated-User-Is-Admin=true', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockFetch.mockResolvedValue(okJsonResponse({ ok: true }));

    const res = await handler(
      makeRequest(name, 'tasks/x', body),
      paramsFor('tasks/x'),
    );

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/tasks/x');
    expect(options.method).toBe(name);
    const headers = options.headers as Record<string, string>;
    expect(headers['X-Authenticated-User-Email']).toBe('admin@example.com');
    expect(headers['X-Authenticated-User-Is-Admin']).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Manual trigger -- a POST to /tasks/{id}/run is forwarded for every
// authenticated caller now; ownership lives downstream.
// ---------------------------------------------------------------------------

describe('POST /tasks/:id/run', () => {
  it('forwards non-admin trigger requests (backend enforces ownership)', async () => {
    mockGetServerSession.mockResolvedValue(plainUserSession());
    mockFetch.mockResolvedValue(
      okJsonResponse({ status: 'queued', task_id: 'demo' }),
    );
    const res = await POST(
      makeRequest('POST', 'tasks/demo/run'),
      paramsFor('tasks/demo/run'),
    );
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('forwards admin trigger requests', async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockFetch.mockResolvedValue(
      okJsonResponse({ status: 'queued', task_id: 'demo' }),
    );
    const res = await POST(
      makeRequest('POST', 'tasks/demo/run'),
      paramsFor('tasks/demo/run'),
    );
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

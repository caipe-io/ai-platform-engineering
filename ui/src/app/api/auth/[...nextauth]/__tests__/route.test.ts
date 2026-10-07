/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';
const mockRevoke = jest.fn();
let mockCsrfValid = true;
jest.mock('@/lib/auth-config', () => ({ authOptions: { events: { signOut: (...args: unknown[]) => mockRevoke(...args) } } }));
jest.mock('next-auth', () => ({
  __esModule: true,
  default: (options: { events: { signOut: (value: unknown) => Promise<void> } }) => async () => {
    if (!mockCsrfValid) return NextResponse.json({ error: 'CSRF' }, { status: 403 });
    await options.events.signOut({ token: { sessionId: 'test-login', sub: 'test-user' } });
    return NextResponse.json({ url: '/login' }, { headers: { 'Set-Cookie': 'next-auth.session-token=; Max-Age=0' } });
  },
}));
import { POST } from '../route';
const request = () => new NextRequest('http://localhost/api/auth/signout', { method: 'POST' });
const context = () => ({ params: Promise.resolve({ nextauth: ['signout'] }) });
beforeEach(() => { mockRevoke.mockReset(); mockCsrfValid = true; });

it('only clears the cookie when durable revocation succeeds', async () => {
  const response = await POST(request(), context());
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});
it('returns a retryable error without clearing the cookie when revocation fails', async () => {
  mockRevoke.mockRejectedValueOnce(new Error('database unavailable'));
  const response = await POST(request(), context());
  expect(response.status).toBe(503);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.json()).toMatchObject({ code: 'SESSION_UNAVAILABLE', action: 'retry' });
});
it('does not revoke ahead of NextAuth CSRF enforcement', async () => {
  mockCsrfValid = false;
  expect((await POST(request(), context())).status).toBe(403);
  expect(mockRevoke).not.toHaveBeenCalled();
});

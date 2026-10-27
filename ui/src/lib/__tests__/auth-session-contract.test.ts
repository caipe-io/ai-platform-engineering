/** @jest-environment node */
import type { JWT } from 'next-auth/jwt';
import type { Session } from 'next-auth';

jest.mock('../mongodb', () => ({ isMongoDBConfigured: true }));
jest.mock('next-auth/jwt', () => ({ encode: jest.fn(async () => 'cookie'), decode: jest.fn() }));
jest.mock('../auth-token-store', () => ({
  ...jest.requireActual('../auth-token-store'),
  createSession: jest.fn(), getStoredSession: jest.fn(), refreshSession: jest.fn(), revokeSession: jest.fn(),
}));
import { encode, decode } from 'next-auth/jwt';
import { authOptions } from '../auth-config';
import { createSession, getStoredSession, refreshSession, revokeSession, SessionExpiredError, SessionUnavailableError } from '../auth-token-store';

const cookie: JWT = { sub: 'test-user', sessionId: 'test-login', sessionFormat: 2,
  role: 'admin', email: 'user@example.test', isAuthorized: true };
const record = { accessToken: 'current', refreshToken: 'refresh', expiresAt: 9999999999,
  sessionId: 'test-login', sessionVersion: 2, sessionExpiresAt: 9999999999 };
const sessionCallback = authOptions.callbacks!.session! as (args: { session: Session; token: JWT }) => Promise<Session>;
const jwtCallback = authOptions.callbacks!.jwt! as (args: Record<string, unknown>) => Promise<JWT>;
beforeEach(() => {
  jest.clearAllMocks();
  jest.requireMock('../mongodb').isMongoDBConfigured = true;
  jest.mocked(decode).mockResolvedValue({ ...cookie });
  jest.mocked(getStoredSession).mockResolvedValue(record);
});

it('requires shared storage for SSO login', async () => {
  const signIn = authOptions.callbacks!.signIn! as () => Promise<boolean | string>;
  expect(await signIn()).toBe(true);
  jest.requireMock('../mongodb').isMongoDBConfigured = false;
  expect(await signIn()).toBe('/login?error=SessionStorageRequired');
});

it('reports the absolute shared-session deadline rather than rolling cookie expiry', async () => {
  const result = await sessionCallback({ token: { ...cookie, ...record }, session: { expires: 'later' } });
  expect(result.expires).toBe(new Date(record.sessionExpiresAt * 1000).toISOString());
});

it('hydrates token and expiry from the same record, ignoring stale embedded credentials', async () => {
  jest.mocked(decode).mockResolvedValue({ ...cookie, accessToken: 'old', expiresAt: 100, error: 'SessionUnavailable' });
  expect(await authOptions.jwt!.decode!({ token: 'cookie', secret: 'test' })).toMatchObject(record);
  expect(getStoredSession).toHaveBeenCalledWith('test-login', 'test-user');
});

it('rejects old cookies rather than falling back to embedded tokens or user-keyed records', async () => {
  jest.mocked(decode).mockResolvedValue({ sub: 'test-user', accessToken: 'old', expiresAt: 9999999999 });
  const result = await authOptions.jwt!.decode!({ token: 'cookie', secret: 'test' });
  expect(result).toMatchObject({ error: 'SessionExpired' });
  expect(result?.accessToken).toBeUndefined();
  expect(getStoredSession).not.toHaveBeenCalled();
});

it.each([new SessionExpiredError(), new SessionUnavailableError()])('does not leak an identity on decode failure: %s', async error => {
  jest.mocked(getStoredSession).mockRejectedValueOnce(error);
  const token = await authOptions.jwt!.decode!({ token: 'cookie', secret: 'test' });
  const expected = error instanceof SessionExpiredError ? 'SessionExpired' : 'SessionUnavailable';
  expect(token?.error).toBe(expected);
  const jwt = await jwtCallback({ token });
  expect(refreshSession).not.toHaveBeenCalled();
  const session = await sessionCallback({ token: jwt, session: { user: { email: 'user@example.test' }, expires: 'later' } });
  expect(session).toEqual({ error: expected, expires: 'later' });
});

it('encoding never writes stale credentials or resurrects a deleted session', async () => {
  await authOptions.jwt!.encode!({ secret: 'test', token: { ...cookie, ...record, error: 'SessionUnavailable' } });
  expect(createSession).not.toHaveBeenCalled();
  expect(refreshSession).not.toHaveBeenCalled();
  const encoded = jest.mocked(encode).mock.calls[0][0].token!;
  expect(encoded).toMatchObject(cookie);
  for (const field of ['accessToken', 'refreshToken', 'expiresAt', 'sessionVersion', 'error']) expect(encoded[field]).toBeUndefined();
});

it('initial login cannot succeed when durable persistence fails', async () => {
  jest.mocked(createSession).mockRejectedValueOnce(new SessionUnavailableError());
  await expect(jwtCallback({ token: { sub: 'test-user' }, account: {
    access_token: 'new', expires_at: 9999999999,
  } })).rejects.toBeInstanceOf(SessionUnavailableError);
  expect(encode).not.toHaveBeenCalled();
});

it('does not expose an expired token even when refresh is unavailable', async () => {
  const result = await sessionCallback({ token: { ...cookie, ...record, expiresAt: 1 }, session: { expires: 'later' } });
  expect(result).toEqual({ error: 'SessionExpired', expires: 'later' });
});

it('logout revokes this login, not all sessions for the same user', async () => {
  await authOptions.events!.signOut!({ token: cookie });
  expect(revokeSession).toHaveBeenCalledWith('test-login', 'test-user');
});

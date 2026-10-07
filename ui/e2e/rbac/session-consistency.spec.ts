import crypto from 'crypto';
import { test, expect, type BrowserContext } from '@playwright/test';
import { decode } from 'next-auth/jwt';
import { encodeTestSession } from './_session-cookie';
import { refreshSession } from '../../src/lib/auth-token-store';

const base = process.env.CAIPE_UI_BASE_URL || 'http://localhost:3000';
const peer = process.env.SESSION_TEST_PEER_URL;
const secret = process.env.NEXTAUTH_SECRET;
test.skip(!process.env.RUN_RBAC_REGRESSION || !peer || !secret, 'Requires the isolated two-replica regression environment');

async function login(context: BrowserContext, sub: string, accessToken: string): Promise<string> {
  const cookie = await encodeTestSession({ secret: secret!, maxAge: 3600, token: {
    sub, email: `${sub}@example.test`, name: 'Test user', isAuthorized: true,
    role: 'user', accessToken, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  } });
  await context.addCookies([{ name: 'next-auth.session-token', value: cookie, url: base,
    httpOnly: true, sameSite: 'Lax' }]);
  return cookie;
}

test('both replicas immediately observe login and refreshed credentials with matching expiry', async ({ context }) => {
  const sub = `test-${crypto.randomUUID()}`;
  const cookie = await login(context, sub, 'old-test-token');
  expect(await (await context.request.get(`${peer}/api/auth/session`)).json()).toMatchObject({ accessToken: 'old-test-token' });
  const decoded = await decode({ token: cookie, secret: secret! });
  const expiresAt = Math.floor(Date.now() / 1000) + 7200;
  await refreshSession(decoded!.sessionId!, sub, 1, async () => ({ accessToken: 'fresh-test-token', expiresAt }));
  for (const origin of [base, peer]) {
    expect(await (await context.request.get(`${origin}/api/auth/session`)).json()).toMatchObject({ accessToken: 'fresh-test-token', expiresAt });
  }
});

test('logout rejects replay on the other replica but leaves the second browser signed in', async ({ context, browser, playwright }) => {
  const sub = `test-${crypto.randomUUID()}`;
  const originalCookie = await login(context, sub, 'browser-one');
  const other = await browser.newContext();
  try {
    await login(other, sub, 'browser-two');
    // Missing CSRF must not invoke revocation.
    await context.request.post(`${base}/api/auth/signout`, { form: { json: 'true' }, maxRedirects: 0 });
    expect(await (await context.request.get(`${peer}/api/auth/session`)).json()).toMatchObject({ accessToken: 'browser-one' });
    const { csrfToken } = await (await context.request.get(`${base}/api/auth/csrf`)).json();
    const signedOut = await context.request.post(`${base}/api/auth/signout`, {
      form: { csrfToken, callbackUrl: `${base}/login`, json: 'true' }, maxRedirects: 0,
    });
    expect(signedOut.ok()).toBe(true);
    const replay = await playwright.request.newContext({ extraHTTPHeaders: { cookie: `next-auth.session-token=${originalCookie}` } });
    try {
      const denied = await (await replay.get(`${peer}/api/auth/session`)).json();
      expect(denied.error).toBe('SessionExpired');
      expect(denied.user).toBeUndefined();
      expect(denied.accessToken).toBeUndefined();
    } finally { await replay.dispose(); }
    expect(await (await other.request.get(`${peer}/api/auth/session`)).json()).toMatchObject({ accessToken: 'browser-two' });
  } finally { await other.close(); }
});

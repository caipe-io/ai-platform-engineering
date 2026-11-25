import { expect, test } from '@playwright/test';
import { fulfillJson, installMockedRbacApp, mockedRbacEnabled, mockSessionBody } from './_mocked-rbac';

test('expired browser session shows the modal and countdown before redirecting to login', async ({ page }) => {
  test.skip(!mockedRbacEnabled() || !process.env.NEXTAUTH_SECRET, 'Requires mocked-browser session fixtures');
  test.setTimeout(130_000);
  const session = { email: 'user@example.test', name: 'Example User' };
  const expired = { ...mockSessionBody({ session }),
    expiresAt: Math.floor(Date.now() / 1000) - 60, hasRefreshToken: true };
  // Seed a valid server-side session; only the client response is expired.
  await installMockedRbacApp(page, { session, handlers: [async ({ path, route }) => {
    if (path === '/api/auth/session') {
      await fulfillJson(route, expired);
      return true;
    }
    if (path === '/api/auth/csrf' || path === '/api/auth/signout') {
      await route.continue();
      return true;
    }
    return false;
  }] });
  // Isolate the global expiry guard from the home page's separate AuthGuard.
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Session Expired', { exact: true })).toBeVisible({ timeout: 110_000 });
  await expect(page.getByText(/redirecting to login in/i)).toBeVisible();
  await page.waitForURL(url => url.pathname === '/login' && url.searchParams.get('session_expired') === 'true',
    { timeout: 15_000 });
});

test('signing in from the expiry dialog restores the current page after a sign-out retry', async ({ page }) => {
  test.skip(!mockedRbacEnabled() || !process.env.NEXTAUTH_SECRET, 'Requires mocked-browser session fixtures');
  const session = { email: 'user@example.test', name: 'Example User' };
  const healthy = mockSessionBody({ session });
  let browserSession: (typeof healthy & { error?: string }) | Record<string, never> = {
    ...healthy, error: 'RefreshTokenExpired',
  };
  const target = '/settings/appearance?view=example';
  let signOutAttempts = 0;
  await installMockedRbacApp(page, { session, handlers: [async ({ path, route, url }) => {
    if (path === '/api/auth/session') {
      await fulfillJson(route, browserSession);
      return true;
    }
    if (path === '/api/auth/csrf') {
      await fulfillJson(route, { csrfToken: 'test-csrf-token' });
      return true;
    }
    if (path === '/api/auth/signout') {
      signOutAttempts += 1;
      if (signOutAttempts === 1) {
        // NextAuth responds with a sign-out confirmation page when CSRF verification fails.
        await fulfillJson(route, { url: new URL('/api/auth/signout?csrf=true', url).href });
        return true;
      }
      browserSession = {};
      await fulfillJson(route, { url: new URL('/login?session_expired=true', url).href });
      return true;
    }
    if (path === '/api/auth/providers') {
      await fulfillJson(route, { oidc: { id: 'oidc', type: 'oauth' } });
      return true;
    }
    if (path === '/api/auth/signin/oidc') {
      const callback = new URLSearchParams(route.request().postData() ?? '').get('callbackUrl');
      browserSession = healthy;
      await fulfillJson(route, { url: new URL(callback ?? '/', url).href });
      return true;
    }
    return false;
  }] });

  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Sign-in Needed' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign In Again' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with SSO' })).toBeVisible();
  expect(signOutAttempts).toBe(2);
  expect(new URL(page.url()).searchParams.get('callbackUrl')).toBe(target);

  const signInRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/signin/oidc');
  await page.getByRole('button', { name: 'Sign in with SSO' }).click();
  expect(new URLSearchParams((await signInRequest).postData() ?? '').get('callbackUrl')).toBe(target);
  await expect(page).toHaveURL(new URL(target, page.url()).href);
});
